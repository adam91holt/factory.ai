import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { repoFromTicket } from "./repos.ts";
import { runStage, untrusted, redactSecrets } from "./agents.ts";
import { renderPrompt } from "./catalog.ts";
import { bus, toStageMeta } from "./events.ts";
import { lastParkReasonForIssue } from "./db.ts";

// Steward (owner request 2026-07-20): when all children of a planned epic reach
// terminal state, a Fable session reviews the whole outcome — PR mergeability
// prefetched by the daemon — and DECIDES: merge order, follow-up tickets,
// parent summary. It writes decisions as files; the daemon executes them.
// The steward never merges — that stays human.

function ghPr(repo: string, branch: string): string {
  const r = spawnSync("gh", ["pr", "view", branch, "--repo", repo, "--json", "url,state,mergeable,title"],
    { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : "(no PR found)";
}

export function childrenAllTerminal(detail: Awaited<ReturnType<typeof linear.getIssueDetail>>): boolean {
  if (detail.children.length === 0) return false;
  return detail.children.every((c) => {
    const labels = c.labels ?? [];
    if (labels.includes(linear.EXECUTING_LABEL)) return false;
    if (labels.includes(linear.PARKED_LABEL) || labels.includes(linear.NEEDS_HUMAN_LABEL)) return true;
    if (c.stateType === "completed" || c.stateType === "canceled") return true;
    if (c.stateType === "started" && /review/i.test(c.stateName)) return true; // PR open
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
export function childStatusBlock(
  c: { identifier: string; title: string; stateName: string; labels?: string[] },
  pr: string,
  reasonLookup: (issueKey: string) => string | null = lastParkReasonForIssue,
): string {
  const labels = c.labels ?? [];
  const lines = [`### ${c.identifier} — ${c.title}`,
    `state: ${c.stateName} · labels: ${labels.join(", ") || "none"}`];
  if (labels.includes(linear.PARKED_LABEL) || labels.includes(linear.NEEDS_HUMAN_LABEL)) {
    const reason = reasonLookup(c.identifier);
    lines.push(`reason: ${reason ? redactSecrets(reason).clean.replace(/\s+/g, " ").slice(0, 300) : "(no reason recorded)"}`);
  }
  lines.push(`PR: ${pr}`);
  return lines.join("\n");
}

export async function stewardEpic(epic: linear.Issue): Promise<void> {
  const detail = await linear.getIssueDetail(epic.identifier);
  if (!childrenAllTerminal(detail)) return;
  const repo = repoFromTicket(epic.description) ?? "";
  bus.emit({ type: "run_started", issueKey: epic.identifier, title: `[steward] ${epic.title}`, repo, dryRun: config.dryRun });

  const childReports = detail.children.map((c) =>
    childStatusBlock(c, repo ? ghPr(repo, `factory/${c.identifier.toLowerCase()}`) : "(no repo)"),
  ).join("\n\n");

  const scratch = join(config.workRoot, ".steward-scratch", epic.identifier);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "tickets"), { recursive: true });

  const deadline = Date.now() + config.caps.wallMinutesPerIssue * 60_000;
  const steward = await runStage("steward",
    renderPrompt("steward",
      { epic: untrusted(`EPIC: ${epic.identifier} — ${epic.title}\n\n${epic.description}`), children: untrusted(`CHILDREN STATUS + PRS:\n${childReports}`) },
      [
        "You are the steward of a software factory — the closeout brain. An epic's children have all reached terminal state. Review the situation and DECIDE what happens next. The human merges PRs; you orchestrate everything else.",
        "Consider: which PRs are mergeable and in what order (shared files = order matters); whether an integration/conflict-resolution follow-up ticket is needed; whether parked/needs-human children need a retry ticket or human escalation; what the parent's status summary should say.",
        "OUTPUT PROTOCOL (files in your working directory):",
        "- summary.md (REQUIRED): the parent-ticket comment — outcome overview, recommended merge order with reasoning, what you decided and why, what the human must do. Write for a busy human.",
        "- tickets/<NN>-<slug>.md (OPTIONAL, 0-3): follow-up tickets you decided to file. First line '# <title>'; body MUST follow the factory ticket contract (## Goal, ## Why, ## Outcomes, ## Repo, ## Verifications; add ## Area).",
        "Reply with one line: what you decided.",
        "",
        untrusted(`EPIC: ${epic.identifier} — ${epic.title}\n\n${epic.description}`),
        "",
        untrusted(`CHILDREN STATUS + PRS:\n${childReports}`),
      ].join("\n")),
    { model: config.models.steward, cwd: scratch, allowedTools: ["Write", "Read"], maxTurns: config.caps.turnsFixer, budgetUsd: config.caps.budgetUsdPerIssue, deadlineMs: deadline,
      onEvent: (e) => {
        if (e.kind === "stage_started") bus.emit({ type: "run_stage_started", issueKey: epic.identifier, stage: e.stage, model: e.model, viaProxy: e.viaProxy });
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
        const title = (lines[0] ?? "").replace(/^#\s*/, "").trim();
        const description = lines.slice(1).join("\n").trim();
        if (title && description.length > 50) created.push(await linear.createSubIssue(epic, title, description));
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
    }
    // Error strings can interpolate HTTP bodies — redact at the outbound seam
    // (§2.2) so the Needs-Human label always ships with a safe, visible WHY.
    await linear.postComment(epic, `${linear.SENTINEL}\n\n**Steward failed:** ${redactSecrets(reason).clean.slice(0, 300)} — human review needed.`).catch(() => {});
    finish("parked", reason.slice(0, 200));
    console.error(`[${epic.identifier}] steward failed: ${reason}`);
  }
}

/** Called each tick: steward at most one completed epic. */
export async function stewardTick(): Promise<void> {
  const planned = await linear.fetchByLabel(linear.PLANNED_LABEL);
  for (const epic of planned) {
    if (epic.labels.includes(linear.STEWARDED_LABEL)) continue;
    const detail = await linear.getIssueDetail(epic.identifier);
    if (childrenAllTerminal(detail)) { await stewardEpic(epic); return; }
  }
}
