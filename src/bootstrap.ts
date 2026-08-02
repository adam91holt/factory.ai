import { join } from "node:path";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { repoFromTicket, initScaffoldRepo, ghRepoCreate, commitAll, pushBranch, type Workspace } from "./repos.ts";
import { ensureDeps, detectGates, baseline } from "./verify.ts";
import { runStage, untrusted, redactSecrets, type StageResult } from "./agents.ts";
import { renderPrompt, cardPin, listRoutableCards } from "./catalog.ts";
import type { StagePin } from "./skills.ts";
import { roleTools } from "./routing.ts";
import { markNeedsHuman, postStageComment } from "./loop.ts";
import { withFactoryMeta } from "./meta.ts";
import { bus, toStageMeta, type AgentStreamEvent } from "./events.ts";

// BOOTSTRAP (Gap 5): idea → private repo → green-gated scaffold → register.
// The other bookend to intake authoring: turn a "start a new project" ticket
// into a real, buildable repo the factory can then build into.
//
// SAFETY ENVELOPE (non-negotiable):
//   (a) PRIVATE-BY-DEFAULT — the repo is created via ghRepoCreate({private:true}),
//       which hard-refuses anything else; visibility is the literal "private" in
//       BootstrapPlan, unrepresentable as public (a regression leaks source).
//   (b) GREEN GATES ARE REAL — the scaffold MUST ship a passing typecheck+build+
//       test on a clean baseline (scaffoldGatesGreen). A repo that starts life
//       unable to prove itself would begin reward-hacking to green (Gap-2
//       envelope). A gate failure PARKS: the repo is left private and empty
//       (unpushed), nothing is registered.
//   (c) REGISTRATION IS HUMAN-GATED — projects/ is a guarded path, so bootstrap
//       does NOT auto-commit a registry card; it posts the proposed card for a
//       human to add via review, and files the build epic parked behind it.

export interface BootstrapPlan {
  org: string;
  slug: string;
  stack: string;
  visibility: "private"; // HARD — there is no other representable value
}

/** Lowercase, dash-separated, alnum-only slug (repo-name-safe), capped. Empty
 * input yields "project" so a repo name is always well-formed. */
export function slugify(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return out || "project";
}

/** Extract a "## Stack" section body (first non-empty line), else "". */
function extractStack(description: string): string {
  const m = description.match(/##\s*Stack\b([\s\S]*?)(?:\n##\s|$)/i);
  const line = m?.[1]?.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.replace(/^[-*]\s*/, "").slice(0, 80) : "";
}

/** Pure: derive the bootstrap plan. If the ticket names a full org/name (## Repo
 * or the factory meta block), that org + name win; otherwise the title is
 * slugified and `defaultOrg` (config.bootstrapOrg) is used. visibility is ALWAYS
 * "private" — there is no code path that produces a public repo. */
export function parseBootstrapPlan(issue: linear.Issue, defaultOrg: string): BootstrapPlan {
  let org = defaultOrg.trim();
  let slug = slugify(issue.title);
  const full = repoFromTicket(issue.description);
  if (full) {
    const [o, n] = full.split("/");
    if (o) org = o;
    if (n) slug = slugify(n);
  }
  return { org, slug, stack: extractStack(issue.description) || "bun-typescript", visibility: "private" };
}

// A bootstrapped repo MUST ship these green on a clean baseline — real gates so
// the project does not start life gaming a weak "green" (Gap-2 un-gameable-gates
// envelope). typecheck+build+test is the minimum evidence bar.
const REQUIRED_SCAFFOLD_GATES = ["typecheck", "build", "test"];

/** Pure: did the fresh scaffold ship REAL green gates? Every required gate must
 * be present AND pass on the pristine baseline. Not-green → the caller parks and
 * never pushes/registers. Unit-testable without git/gh/model. */
export function scaffoldGatesGreen(detected: string[], baselines: Map<string, boolean>): { green: boolean; reason: string } {
  const missing = REQUIRED_SCAFFOLD_GATES.filter((g) => !detected.includes(g));
  if (missing.length > 0) return { green: false, reason: `scaffold is missing required gate script(s): ${missing.join(", ")}` };
  const failing = REQUIRED_SCAFFOLD_GATES.filter((g) => baselines.get(g) !== true);
  if (failing.length > 0) return { green: false, reason: `scaffold gate(s) not green on a clean baseline: ${failing.join(", ")}` };
  return { green: true, reason: "typecheck + build + test all green on the fresh scaffold" };
}

/** Pure: the proposed projects/<slug>.md registry card a human reviews and adds.
 * Ships merge:"review" (a bootstrapped repo must EARN auto-merge through the
 * Gap-2 ladder, never start there) and deployEnabled:false (deploy is opt-in per
 * card AND behind the global kill-switch). deploy/smoke are left as TODO
 * placeholders — a human fills in the trusted shell, never the factory from
 * ticket text. */
export function buildProjectCard(plan: BootstrapPlan): string {
  const repo = `${plan.org}/${plan.slug}`;
  return [
    "---",
    `name: ${plan.slug}`,
    `team: FAC`,
    `repos: [${repo}]`,
    `merge: review`,
    `deployEnabled: false`,
    `# deploy: <fill in the trusted deploy command — human-reviewed only>`,
    `# smoke: <fill in the trusted smoke command>`,
    "---",
    "",
    `# ${plan.slug}`,
    "",
    `Bootstrapped ${new Date().toISOString().slice(0, 10)} (stack: ${plan.stack}). Repo is PRIVATE.`,
    "Merge policy starts at review; it earns auto-merge through the evidence ladder.",
    "Deploy is OFF until a human fills in deploy/smoke and flips deployEnabled: true (and DEPLOY_ENABLED is set).",
  ].join("\n");
}

/** The build-epic contract filed under the freshly-bootstrapped repo, stamped
 * type:epic so the planner takes over. */
export function buildBootstrapEpic(plan: BootstrapPlan, issue: linear.Issue): { title: string; description: string } {
  const repo = `${plan.org}/${plan.slug}`;
  const description = withFactoryMeta([
    "## Goal",
    `Build out the newly-bootstrapped project ${repo} per the original idea.`,
    "",
    "## Why",
    `Bootstrapped from ${issue.identifier}. The repo exists (private) with green gates; this epic delivers the actual product.`,
    "",
    "## Repo",
    repo,
    "",
    "## Original idea",
    untrusted(issue.description).slice(0, 6000),
  ].join("\n"), { type: "epic", repo });
  return { title: `Build ${plan.slug}`, description };
}

// `pins` (issue #16 WP2): stage label → version pins so run_stage_started
// records the scaffolder card version; no skills outside a repo-facts context.
function forwardStage(issueKey: string, pins?: ReadonlyMap<string, StagePin>): (e: AgentStreamEvent) => void {
  return (e) => {
    if (e.kind === "stage_started") {
      const pin = pins?.get(e.stage);
      bus.emit({ type: "run_stage_started", issueKey, stage: e.stage, model: e.model, viaProxy: e.viaProxy,
        ...(pin ? { card: pin.card, skills: pin.skills } : {}) });
    }
    else if (e.kind === "tool_use") bus.emit({ type: "run_tool_use", issueKey, stage: e.stage, tool: e.tool, detail: e.detail });
    else if (e.kind === "assistant_text") bus.emit({ type: "run_assistant_text", issueKey, stage: e.stage, text: e.text });
    else bus.emit({ type: "run_stage_finished", issueKey, stage: e.stage, costUsd: e.costUsd, turns: e.turns, wallSeconds: e.wallSeconds, resultText: e.resultText, ...(e.error ? { error: e.error } : {}), ...(e.modelUsage ? { modelUsage: e.modelUsage } : {}) });
  };
}

/** idea → private repo → green scaffold → register (human-gated). One terminal
 * event per tick. Does not claim the ticket (upgrades it to Planned in place). */
export async function bootstrapProject(issue: linear.Issue): Promise<void> {
  const plan = parseBootstrapPlan(issue, config.bootstrapOrg);
  const repo = `${plan.org}/${plan.slug}`;
  const stages: StageResult[] = [];
  const onEvent = forwardStage(issue.identifier, new Map<string, StagePin>([
    ["scaffolder", { card: cardPin("scaffolder"), skills: [] }],
  ]));

  const bootstrapFinished = (ok: boolean, r: string | null, reason: string): void => {
    bus.emit({ type: "bootstrap_finished", issueKey: issue.identifier, repo: r, ok, reason: redactSecrets(reason).clean.slice(0, 300) });
    bus.emit({ type: "run_finished", issueKey: issue.identifier, outcome: ok ? "bootstrapped" : "parked",
      reason: redactSecrets(reason).clean.slice(0, 300), prUrl: null,
      costUsd: stages.reduce((s, x) => s + x.costUsd, 0), stages: stages.map(toStageMeta),
      gateStrength: "none", guardedPaths: [], dryRun: config.dryRun });
  };

  if (!plan.org) {
    await markNeedsHuman(issue, `bootstrap needs a GitHub org: none in the ticket and FACTORY_BOOTSTRAP_ORG is unset. Name the repo as "## Repo\norg/name" or set the org.`);
    bootstrapFinished(false, null, "no org configured");
    return;
  }

  bus.emit({ type: "run_started", issueKey: issue.identifier, title: `[bootstrap] ${issue.title}`, repo, dryRun: config.dryRun });

  if (config.dryRun) {
    console.log(`[${issue.identifier}] dry-run bootstrap: would create PRIVATE ${repo} and scaffold green gates`);
    bootstrapFinished(true, repo, `dry-run: would bootstrap ${repo}`);
    return;
  }

  const deadline = Date.now() + config.caps.wallMinutesPerIssue * 60_000;

  const park = async (reason: string): Promise<void> => {
    await linear.postComment(issue, `${linear.SENTINEL}\n\n**Outcome:** parked — bootstrap of ${repo} failed: ${redactSecrets(reason).clean.slice(0, 300)}`).catch(() => {});
    await linear.addLabel(issue, linear.PARKED_LABEL).catch(() => {});
    // WP3 board stage: a failed bootstrap is paused-and-retryable → Blocked
    // column (same unstarted type, label still owns queue exclusion; degrades to
    // the queue state on a board without the column).
    await linear.transition(issue, "blocked").catch(() => {});
    bootstrapFinished(false, repo, reason);
    console.error(`[${issue.identifier}] bootstrap parked: ${reason}`);
  };

  try {
    // (a) PRIVATE repo — ghRepoCreate refuses anything else.
    const created = ghRepoCreate(repo, { private: true });
    if (!created.ok) { await park(`gh repo create failed: ${created.out}`); return; }

    let ws: Workspace;
    try { ws = initScaffoldRepo(repo); }
    catch (error) { await park(`scaffold clone failed: ${error instanceof Error ? error.message : error}`); return; }

    // ---- scaffolder: seed CLAUDE.md + a ticket-contract + package.json whose
    // typecheck/build/test pass green out of the box.
    const spec = untrusted(`# ${issue.title}\n\n${issue.description}`);
    const scaffolder = await runStage("scaffolder",
      renderPrompt("scaffolder", { repo, stack: plan.stack, spec },
        [
          `You are the scaffolder in a software factory. Seed a NEW, EMPTY private repo (${repo}, stack: ${plan.stack}) in the current directory so the factory can build into it.`,
          "HARD REQUIREMENT: the repo MUST have package.json scripts `typecheck`, `build`, and `test`, and ALL THREE must pass on a clean checkout (real, honest gates — a trivial passing test is fine, but the scripts must genuinely run and exit 0). Include a CLAUDE.md describing the project and conventions, a README, and a sensible .gitignore that excludes .env and secrets.",
          "Do NOT add heavy dependencies; keep it minimal so `install` is fast. Do NOT write any secrets. When done, reply with a one-paragraph summary.",
          "", spec,
        ].join("\n")),
      { model: config.models.implementer, cwd: ws.dir, allowedTools: roleTools("scaffolder", listRoutableCards()).tools, maxTurns: config.caps.turnsImplementer, budgetUsd: config.caps.budgetUsdPerIssue, deadlineMs: deadline, onEvent });
    stages.push(scaffolder);
    await postStageComment(issue, scaffolder);
    if (scaffolder.error) { await park(`scaffolder: ${scaffolder.error}`); return; }

    // (b) REAL green gates on a clean baseline — else park (repo left empty).
    const deps = await ensureDeps(ws);
    if (!deps.ok) { await park(`scaffold dependency install failed: ${deps.detail.slice(0, 200)}`); return; }
    const gates = detectGates(ws);
    // baseline() carries per-gate test counts for the ratchet (verify.ts) —
    // scaffold only needs the green/red verdicts, so project down to those.
    const baselines = await baseline(ws, gates);
    const green = scaffoldGatesGreen(gates, new Map(Array.from(baselines, ([g, b]) => [g, b.ok])));
    if (!green.green) { await park(`green-gate check failed — ${green.reason}. Repo left private and empty (nothing pushed/registered).`); return; }

    // Push the green scaffold to main.
    if (!commitAll(ws, `${issue.identifier}: scaffold ${repo} (green gates)`)) { await park("scaffold produced no committable files"); return; }
    pushBranch(ws);

    // (c) Register HUMAN-GATED: file the build epic (parked pending the card) and
    // post the proposed projects/<slug>.md card for a human to add via review.
    const epic = buildBootstrapEpic(plan, issue);
    // The epic embeds the human idea text — redact at the outbound seam like
    // every other Linear write (the idea is untrusted-delimited AND scrubbed).
    const epicDesc = redactSecrets(epic.description).clean.slice(0, 40_000);
    const epicId = await linear.createIssue(issue.teamKey, epic.title, epicDesc).catch((e) => { console.error(`[${issue.identifier}] build-epic create failed: ${e}`); return null; });
    const card = buildProjectCard(plan);
    await linear.postComment(issue, [
      linear.SENTINEL, "",
      `**Bootstrapped** — created PRIVATE repo \`${repo}\` with green gates (typecheck+build+test) and pushed the scaffold.`,
      epicId ? `Build epic filed: ${epicId} (it will build once the project is registered).` : "Build epic could not be filed automatically — file it manually.",
      "",
      "**Register it (human-gated):** add this card as `projects/" + plan.slug + ".md` in the factory repo via a reviewed PR (projects/ is a guarded path). Fill in the trusted deploy/smoke commands yourself; never let ticket text set them.",
      "", "```md", card, "```",
    ].join("\n")).catch((e) => console.error(`[${issue.identifier}] bootstrap comment failed: ${e}`));
    await linear.addLabel(issue, linear.PLANNED_LABEL).catch(() => {});
    await linear.removeLabel(issue, linear.BOOTSTRAP_LABEL).catch(() => {});
    await linear.transition(issue, "working").catch(() => {});
    bootstrapFinished(true, repo, `bootstrapped ${repo}${epicId ? ` (build epic ${epicId})` : ""}`);
    console.log(`[${issue.identifier}] bootstrapped ${repo}${epicId ? ` → ${epicId}` : ""}`);
  } catch (error) {
    await park(error instanceof Error ? error.message : String(error));
  }
}
