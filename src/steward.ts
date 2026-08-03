import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { roleTools } from "./routing.ts";
import * as linear from "./linear.ts";
import { repoFromTicket } from "./repos.ts";
import { runStage, untrusted, redactSecrets } from "./agents.ts";
import { parseFactoryMeta, withFactoryMeta, resolveModel, resolveEffort } from "./meta.ts";
import { liftPreconditions } from "./precondition.ts";
import { renderPrompt, cardEffort, cardPin, listRoutableCards } from "./catalog.ts";
import { bus, toStageMeta } from "./events.ts";
import { lastParkReasonForIssue } from "./db.ts";
import { projectModelOverrides } from "./project-config.ts";

// Steward (owner request 2026-07-20): when all children of a planned epic reach
// terminal state, a Fable session reviews the whole outcome — PR mergeability
// prefetched by the daemon — and DECIDES: merge order, follow-up tickets,
// parent summary. It writes decisions as files; the daemon executes them.
// The steward never merges — that stays human.

/** Pre-fetch everything the steward needs to reason about a PR — mergeability,
 * review decision, merge-state, and CI check rollup — via `gh` (the steward has
 * NO network/web access, so if this doesn't carry it the steward can't get it).
 * Returns a compact human-readable line, not raw JSON, so the model doesn't try
 * to "open" the URL to learn what's already stated here. */
function ghPr(repo: string, branch: string): string {
  const r = spawnSync("gh",
    ["pr", "view", branch, "--repo", repo, "--json", "url,state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,title"],
    { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) return "(no PR found)";
  try {
    const p = JSON.parse(r.stdout) as {
      url: string; state: string; mergeable: string; mergeStateStatus?: string;
      reviewDecision?: string; statusCheckRollup?: Array<{ conclusion?: string; status?: string; name?: string }>;
    };
    const checks = p.statusCheckRollup ?? [];
    const failing = checks.filter((c) => c.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)).map((c) => c.name).filter(Boolean);
    const pending = checks.filter((c) => c.status && c.status !== "COMPLETED").length;
    const ci = checks.length === 0 ? "no checks"
      : failing.length > 0 ? `FAILING (${failing.join(", ")})`
      : pending > 0 ? `${pending} pending` : "all green";
    return `${p.state} · mergeable=${p.mergeable}${p.mergeStateStatus ? `/${p.mergeStateStatus}` : ""} · review=${p.reviewDecision || "none"} · CI: ${ci} · ${p.url}`;
  } catch {
    return r.stdout.trim(); // malformed JSON — pass raw rather than lose the data
  }
}

// Read-only gh: the steward investigates PRs (view/diff/checks/list/status)
// but cannot mutate — merge/close/comment/push verbs are simply not granted,
// so "the human merges" holds by construction, not by prompt discipline.
// Every gh entry here must stay within agents.ts's READONLY_GH_PREFIXES or
// runStage refuses to run the stage at all; tests/tool-allowlist.test.ts pins
// the shape (hence the export). Write is scratch-dir output (summary.md,
// tickets/) — the daemon, not the steward, executes anything written there.
// The array itself now lives in routing.ts (agent routing) as the code-defined
// CEILING that agents/steward.md's `tools:` frontmatter may only SELECT from;
// re-exported here unchanged so every existing importer (and
// tests/tool-allowlist.test.ts) is unaffected.
export { STEWARD_TOOLS } from "./routing.ts";

export function childrenAllTerminal(detail: Awaited<ReturnType<typeof linear.getIssueDetail>>): boolean {
  if (detail.children.length === 0) return false;
  return detail.children.every((c) => {
    const labels = c.labels ?? [];
    if (labels.includes(linear.EXECUTING_LABEL)) return false;
    if (labels.includes(linear.PARKED_LABEL) || labels.includes(linear.NEEDS_HUMAN_LABEL)) return true;
    if (c.stateType === "completed" || c.stateType === "canceled") return true;
    // PR open. isReviewLane with no state description degrades to the pre-WP3
    // /review/i name match — getIssueDetail's child nodes carry no state
    // description, so this is the untagged path by construction; routing it
    // through the shared helper keeps the review-lane definition in ONE place.
    if (c.stateType === "started" && linear.isReviewLane(c.stateName)) return true;
    return false; // queued or actively being worked
  });
}

/** One child's closeout status block. Exported pure (reason lookup injectable)
 *  so the smoke test can assert the FAC-14 contract without Linear/gh.
 *  FAC-14 lesson: a parked/needs-human child MUST carry its recorded WHY into
 *  closeout — "state: Todo · labels: Factory-Needs-Human" with no reason forces
 *  a blind human escalation. Reason strings were redacted at emit, but they
 *  outlive daemon versions in the durable log — redact again at this outbound
 *  seam (§2.2), and say "(no reason recorded)" out loud for legacy rows rather
 *  than silently omitting the field. */
export async function childStatusBlock(
  c: { identifier: string; title: string; stateName: string; labels?: string[] },
  pr: string,
  reasonLookup: (issueKey: string) => Promise<string | null> = lastParkReasonForIssue,
): Promise<string> {
  const labels = c.labels ?? [];
  const lines = [`### ${c.identifier} — ${c.title}`,
    `state: ${c.stateName} · labels: ${labels.join(", ") || "none"}`];
  if (labels.includes(linear.PARKED_LABEL) || labels.includes(linear.NEEDS_HUMAN_LABEL)) {
    const reason = await reasonLookup(c.identifier);
    lines.push(`reason: ${reason ? redactSecrets(reason).clean.replace(/\s+/g, " ").slice(0, 300) : "(no reason recorded)"}`);
  }
  lines.push(`PR: ${pr}`);
  return lines.join("\n");
}

export async function stewardEpic(epic: linear.Issue): Promise<void> {
  const detail = await linear.getIssueDetail(epic.identifier);
  if (!childrenAllTerminal(detail)) return;
  const repo = repoFromTicket(epic.description) ?? "";
  // Per-epic model routing (execution-profiles): an epic's `model`/`models:`
  // meta can route the steward stage itself, same precedence as every other
  // stage now uses.
  const epicMeta = parseFactoryMeta(epic.description);
  const { models: projModels, efforts: projEfforts } = await projectModelOverrides(repo);
  bus.emit({ type: "run_started", issueKey: epic.identifier, title: `[steward] ${epic.title}`, repo, dryRun: config.dryRun });

  const childReports = (await Promise.all(detail.children.map((c) =>
    childStatusBlock(c, repo ? ghPr(repo, `factory/${c.identifier.toLowerCase()}`) : "(no repo)"),
  ))).join("\n\n");

  const scratch = join(config.workRoot, ".steward-scratch", epic.identifier);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "tickets"), { recursive: true });

  const deadline = Date.now() + config.caps.wallMinutesPerIssue * 60_000;
  const stewardTools = roleTools("steward", listRoutableCards());
  if (stewardTools.unknown.length > 0) console.error(`[${epic.identifier}] agents/steward.md declares unknown tool selector(s) [${stewardTools.unknown.join(", ")}] — they grant nothing`);
  const steward = await runStage("steward",
    renderPrompt("steward",
      { epic: untrusted(`EPIC: ${epic.identifier} — ${epic.title}\n\n${epic.description}`), children: untrusted(`CHILDREN STATUS + PRS:\n${childReports}`) },
      [
        "You are the steward of a software factory — the closeout brain. An epic's children have all reached terminal state. Review the situation and DECIDE what happens next. The human performs the final merge; you orchestrate everything else and give the human a decision they can act on in one click.",
        "You have read-only GitHub access via the `gh` CLI — use it to investigate as deeply as you need. `gh pr view <url|branch>`, `gh pr diff <url>`, `gh pr checks <url>`, `gh pr list`. The CHILDREN block below already summarizes each PR's state/mergeability/review/CI as a starting point, but you are NOT limited to it: pull the diff to judge conflict risk between siblings, read the checks to see WHY CI failed, whatever the decision needs. You cannot merge, close, comment, or push — those `gh` verbs are unavailable to you by design; investigation is yours, mutation stays with the human.",
        "Consider: which PRs are mergeable and in what order (shared files = order matters — pull the diffs to confirm overlap rather than guessing); whether an integration/conflict-resolution follow-up ticket is needed; whether parked/needs-human children need a retry ticket or human escalation; what the parent's status summary should say.",
        "OUTPUT PROTOCOL (files in your working directory):",
        "- summary.md (REQUIRED): the parent-ticket comment — outcome overview, recommended merge order with reasoning, what you decided and why, what the human must do. Write for a busy human.",
        "- tickets/<NN>-<slug>.md (OPTIONAL, 0-3): follow-up tickets you decided to file. First line '# <title>' — NEVER include an issue identifier (FAC-12 etc.) in the title, Linear assigns those; body MUST follow the factory ticket contract (## Goal, ## Why, ## Outcomes, ## Repo, ## Verifications; add ## Area).",
        "  Each follow-up SHOULD carry a '## Precondition' line stating the machine-checkable premise under which it is worth running, so the factory self-cancels it if the premise is already satisfied by the time it's picked up. One per line, from this vocabulary: `pr-open <url|org/repo#N|#N>` (worth running only while that PR is still open — self-cancels once it closes; NEVER use this for work that only makes sense AFTER a PR merges, it cancels the ticket the moment that happens, backwards), `pr-merged <url|org/repo#N|#N>` (the ticket's work depends on that PR having landed — held out of the queue while it's still open, runs once it's merged, self-cancels if it closes without merging; use this for any 'verify/build on top of X once #N lands' follow-up), `path-missing <relpath>` (only while that file is still absent), `path-exists <relpath>`, `text-present <relpath>::<needle>` (only while the file still contains the needle — e.g. the bug is still there), `text-absent <relpath>::<needle>`. Omit the section if no liveness premise fits — never invent one.",
        "Reply with one line: what you decided.",
        "",
        untrusted(`EPIC: ${epic.identifier} — ${epic.title}\n\n${epic.description}`),
        "",
        untrusted(`CHILDREN STATUS + PRS:\n${childReports}`),
      ].join("\n")),
    { model: resolveModel("steward", epicMeta, projModels), effort: resolveEffort("steward", epicMeta, cardEffort("steward"), projEfforts), cwd: scratch,
      // Agent routing: agents/steward.md's `tools:` selection over the
      // STEWARD_TOOLS ceiling. No specialist exists for this role (it is not
      // in SPECIALIST_ROLES), so this is tool resolution only — and it is
      // subtractive, so it can never grant a verb the ceiling above lacks.
      allowedTools: stewardTools.tools,
      maxTurns: config.caps.turnsFixer, budgetUsd: config.caps.budgetUsdPerIssue, deadlineMs: deadline,
      onEvent: (e) => {
        // Version pins (issue #16 WP2): the steward always runs its own card;
        // no skills are carried outside the pipeline's repo-facts context.
        if (e.kind === "stage_started") bus.emit({ type: "run_stage_started", issueKey: epic.identifier, stage: e.stage, model: e.model, viaProxy: e.viaProxy, card: cardPin("steward"), skills: [] });
        else if (e.kind === "tool_use") bus.emit({ type: "run_tool_use", issueKey: epic.identifier, stage: e.stage, tool: e.tool, detail: e.detail });
        else if (e.kind === "assistant_text") bus.emit({ type: "run_assistant_text", issueKey: epic.identifier, stage: e.stage, text: e.text });
        else bus.emit({ type: "run_stage_finished", issueKey: epic.identifier, stage: e.stage, costUsd: e.costUsd, turns: e.turns, wallSeconds: e.wallSeconds, resultText: e.resultText, ...(e.error ? { error: e.error } : {}), ...(e.modelUsage ? { modelUsage: e.modelUsage } : {}) });
      } });

  const finish = (outcome: "planned" | "parked", reason: string): void => {
    // Redact at the emit seam like loop.ts / groundskeepers.ts (§2.2) — error
    // reasons can interpolate HTTP bodies and land verbatim in the durable log.
    bus.emit({ type: "run_finished", issueKey: epic.identifier, outcome, reason: redactSecrets(reason).clean.slice(0, 300), prUrl: null,
      costUsd: steward.costUsd, stages: [toStageMeta(steward)], gateStrength: "none", guardedPaths: [], dryRun: config.dryRun });
  };

  try {
    if (steward.error) throw new Error(`steward: ${steward.error}`);
    let summary = "";
    try { summary = readFileSync(join(scratch, "summary.md"), "utf8"); } catch { throw new Error("steward wrote no summary.md"); }
    const ticketFiles = readdirSync(join(scratch, "tickets")).filter((f) => f.endsWith(".md")).sort();
    const created: string[] = [];
    if (!config.dryRun) {
      for (const f of ticketFiles.slice(0, 3)) {
        const body = readFileSync(join(scratch, "tickets", f), "utf8").trim();
        const lines = body.split("\n");
        const title = sanitizeFollowUpTitle((lines[0] ?? "").replace(/^#\s*/, "").trim());
        const description = lines.slice(1).join("\n").trim();
        // Stamp factory-authored follow-ups with a TRUSTED block at offset 0
        // (and strip any block the model embedded after reading untrusted epic/
        // child inputs) so an injected repo/type/model can never be honored —
        // the same defense plan.ts gives decomposer children.
        if (title && description.length > 50) {
          // Gap-4: lift any model-authored "## Precondition"/"Precondition:" lines
          // into VALIDATED DSL strings (parsePrecondition allowlist — non-DSL
          // prose is dropped) and stamp them into the TRUSTED, start-anchored
          // block. The loop re-checks the premise when the follow-up is later
          // picked up and self-cancels if it's already satisfied — the race-guard
          // that makes the steward filing a "make PR #N mergeable" follow-up safe
          // even after a human/steward already merged it (the FAC-20 shape).
          const preconditions = liftPreconditions(description);
          const stamped = withFactoryMeta(description, { type: "task", ...(repo ? { repo } : {}), ...(preconditions.length ? { preconditions } : {}) });
          created.push(await linear.createSubIssue(epic, title, stamped));
        }
      }
      await linear.postComment(epic, [
        linear.SENTINEL, "", "**Steward closeout**", "", summary.slice(0, 8000),
        created.length > 0 ? `\nFollow-up tickets filed: ${created.join(", ")}` : "",
        "", "```yaml", "meta:", "  outcome: stewarded", `  followups: [${created.join(", ")}]`, `  cost_usd: ${steward.costUsd.toFixed(4)}`, "```",
      ].join("\n"));
      await linear.addLabel(epic, linear.STEWARDED_LABEL);
    }
    finish("planned", `stewarded: ${created.length} follow-ups`);
    console.log(`[${epic.identifier}] stewarded (${created.length} follow-up tickets)`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!config.dryRun) {
      await linear.addLabel(epic, linear.STEWARDED_LABEL).catch(() => {}); // don't loop a broken steward
      await linear.addLabel(epic, linear.NEEDS_HUMAN_LABEL).catch(() => {}); // surface the failed closeout; reconcile must not auto-close over it
      // WP3 board stage: the factory STOPPED on this epic → Needs Human column,
      // so a broken closeout is visible on the board and not just in the label
      // list (degrades to the queue state on a board without the column).
      await linear.transition(epic, "needs_human").catch(() => {});
    }
    // Error strings can interpolate HTTP bodies — redact at the outbound seam
    // (§2.2) so the Needs-Human label always ships with a safe, visible WHY.
    await linear.postComment(epic, `${linear.SENTINEL}\n\n**Steward failed:** ${redactSecrets(reason).clean.slice(0, 300)} — human review needed.`).catch(() => {});
    // Pass the FULL reason — finish() redacts before its own truncation, and
    // pre-slicing here would cut a secret in half, defeating the exact-value
    // scrub (redactSecrets matches whole values only).
    finish("parked", reason);
    console.error(`[${epic.identifier}] steward failed: ${reason}`);
  }
}

/** Called each tick: steward at most one completed epic. */
/** Pure closeout-eligibility gate for one Factory-Planned epic. Exported for
 *  tests (decision logic stays pure and I/O-free — CLAUDE.md).
 *
 *  A CANCELED epic is a human saying "don't": it keeps its Factory-Planned
 *  label, and childrenAllTerminal counts canceled children as terminal, so
 *  without this gate the steward "closes out" killed work — observed live
 *  2026-08-02: canceled FAC-42 got stewarded and spawned follow-up tickets
 *  (one literally titled "Rebuild missing FAC-42 scope") that resurrected
 *  scope the owner had explicitly canceled, then competed with real work in
 *  the queue. Cancellation is a terminal HUMAN decision, not a closeout
 *  trigger — skip entirely: no steward run, no follow-ups, no comment. */
export function stewardEligible(epic: { labels: readonly string[]; stateType: string }): boolean {
  if (epic.labels.includes(linear.STEWARDED_LABEL)) return false;
  if (epic.stateType === "canceled") return false;
  return true;
}

/** Strip model-GUESSED issue identifiers from a follow-up title's front.
 *  Live 2026-08-02: the steward predicted its follow-ups would be FAC-49/50
 *  and baked those into the titles — the canaries already owned those
 *  numbers, so the board showed two tickets cross-referencing unrelated
 *  work. Linear assigns identifiers; a title never carries one. Deliberately
 *  ONLY strips the leading prefix — a genuine mid-title reference to an
 *  EXISTING ticket ("clean up after FAC-42") is legitimate context. */
export function sanitizeFollowUpTitle(raw: string): string {
  let title = raw.trim();
  for (;;) {
    const next = title.replace(/^\[?[A-Z][A-Z0-9]*-\d+\]?\s*(?:[—–:-]\s*)?/, "");
    if (next === title) break;
    title = next.trim();
  }
  return title;
}

export async function stewardTick(): Promise<void> {
  const planned = await linear.fetchByLabel(linear.PLANNED_LABEL);
  for (const epic of planned) {
    if (!stewardEligible(epic)) continue;
    const detail = await linear.getIssueDetail(epic.identifier);
    if (childrenAllTerminal(detail)) { await stewardEpic(epic); return; }
  }
}
