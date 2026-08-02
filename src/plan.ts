import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { ensureWorkspace, repoFromTicket } from "./repos.ts";
import { runStage, untrusted, redactSecrets, type StageResult } from "./agents.ts";
import { parseFactoryMeta, withFactoryMeta, resolveModel, resolveEffort } from "./meta.ts";
import { renderPrompt, cardEffort, listRoutableCards } from "./catalog.ts";
import { roleTools } from "./routing.ts";
import { postStageComment, markNeedsHuman } from "./loop.ts";
import { globsOverlap } from "./dag.ts";
import { bus, toStageMeta, type AgentStreamEvent } from "./events.ts";

// PLAN stage (plan v1.1, promoted 2026-07-20 by owner decision): Factory-Epic
// tickets route here instead of the implementer pipeline.
//   scout (read-only repo + WebSearch/WebFetch, no Bash/no writes)
//     → decomposer (JSON list of contract-conforming children, non-overlapping
//       file areas, all safely parallelizable)
//     → sub-issues created under the parent; parent labeled Factory-Planned
//       (tracking-only, filtered from the queue forever).

export interface ChildSpec {
  title: string;
  description: string;
  ordinal: number;        // NN from the filename — dependency edges are by ordinal
  dependsOn: number[];    // ordinals of siblings this child must follow (## Depends-on)
  touches: string[];      // path globs this child will modify (## Touches) — the mutex key
}

/** Extract the body of a "## <heading>" section (case-insensitive) up to the
 * next "## " heading. Returns "" when the section is absent — the DAG sections
 * are optional, so old decomposer output (no ## Depends-on / ## Touches) parses
 * to empty, keeping the change backward-compatible. */
function extractSection(body: string, heading: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out.join("\n").trim();
}

/** Children are read from files the decomposer WROTE (one .md per child,
 * first line "# Title") — no giant-JSON-in-result-text to truncate. Each file
 * is named <NN>-<slug>.md; NN is the build-order ordinal that ## Depends-on
 * edges reference. */
export function readChildren(dir: string): ChildSpec[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const children = files.map((f, i) => {
    const body = readFileSync(join(dir, f), "utf8").trim();
    const lines = body.split("\n");
    const title = (lines[0] ?? "").replace(/^#\s*/, "").trim();
    const description = lines.slice(1).join("\n").trim();
    // Ordinal from the NN filename prefix (build order); fall back to sorted
    // position when a file lacks a numeric prefix so ordinals stay unique.
    const prefix = f.match(/^0*(\d+)/);
    const ordinal = prefix ? Number(prefix[1]) : i + 1;
    // ## Depends-on: any digit runs are ordinals (tolerant of "01, 02", bullets,
    // spaces). ## Touches: comma/newline/bullet-separated globs.
    const dependsOn = (extractSection(description, "Depends-on").match(/\d+/g) ?? []).map(Number);
    const touches = extractSection(description, "Touches")
      .split(/[\n,]/).map((s) => s.replace(/^[-*]\s*/, "").replace(/^`|`$/g, "").trim()).filter((s) => s.length > 0);
    return { title, description, ordinal, dependsOn, touches };
  }).filter((c) => c.title.length > 0 && c.description.length > 50);
  if (children.length < 2 || children.length > 6) throw new Error(`decomposer produced ${children.length} valid child files (expected 2-6)`);
  // Validate the DAG fail-closed: every edge must point to an EXISTING,
  // STRICTLY-LOWER ordinal (no self-ref, no forward-ref, no missing ref).
  // Backward-only edges are acyclic by construction. A violation throws → the
  // planner's catch parks the epic rather than creating a broken dependency web.
  const ordinals = new Set(children.map((c) => c.ordinal));
  for (const c of children) {
    for (const dep of c.dependsOn) {
      if (dep === c.ordinal) throw new Error(`child ${c.ordinal} depends on itself`);
      if (dep >= c.ordinal) throw new Error(`child ${c.ordinal} has a forward/equal dependency on ${dep} (edges must reference lower-numbered files)`);
      if (!ordinals.has(dep)) throw new Error(`child ${c.ordinal} depends on missing ordinal ${dep}`);
    }
  }
  return children;
}

// Gap 9: parallel siblings collided on undeclared SHARED/GLUE files (global
// stylesheet, app layout/shell, package.json, the router) because a child
// edited one without declaring it in ## Touches, so the DAG never serialized
// the collision. Matched by basename (not full path) since repos name these
// differently — the goal is visibility, not precision.
const KNOWN_GLUE_BASENAMES = [
  "index.css", "app.css", "global.css", "globals.css", "styles.css",
  "package.json", "package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml",
  "layout.tsx", "layout.jsx", "layout.ts", "_layout.tsx", "root.tsx", "app.tsx",
  "router.tsx", "router.ts", "routes.tsx", "routes.ts",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Advisory static check (Gap 9): for each child, scan its FULL description
 * text (not just ## Touches) for a mention of a well-known shared/glue file
 * by basename. If the file is named in the body but the child's DECLARED
 * ## Touches never included it (by basename), the decomposer likely missed
 * declaring a real edit — this is exactly the undeclared-collision shape
 * (index.css / layout / package.json / router) that let parallel siblings
 * conflict. Cheap (regex over already-parsed text, no repo access) and
 * PURELY ADVISORY: it returns warning strings for the caller to log, never
 * throws and never blocks planning — a false positive costs a log line, a
 * false negative silently reintroduces the sibling file-race this exists to
 * surface, so it deliberately errs toward flagging. */
export function findUndeclaredGlueTouches(children: ChildSpec[]): string[] {
  const warnings: string[] = [];
  for (const child of children) {
    const declared = new Set(child.touches.map((t) => (t.split("/").pop() ?? "").toLowerCase()));
    for (const glue of KNOWN_GLUE_BASENAMES) {
      if (declared.has(glue)) continue;
      const mentioned = new RegExp(`\\b${escapeRegExp(glue)}\\b`, "i").test(child.description);
      if (mentioned) {
        warnings.push(`child ${child.ordinal} ("${child.title}") mentions shared/glue file "${glue}" but does not declare it in ## Touches`);
      }
    }
  }
  return warnings;
}

/** Create the children in ascending ordinal order, resolving each child's
 * ordinal dependencies to the Linear identifiers of the already-created lower
 * ordinals, and stamping the factory meta block (repo, type:task, optional
 * model/depends_on/touches). Pure over the `create` callback so the
 * ordinal→identifier resolution and DAG-aware stamping are unit-testable
 * without Linear. Because edges only ever point to strictly-lower ordinals,
 * every dependency is already in byOrdinal when its dependent is stamped —
 * single-pass, no create-then-update window. Returns the created identifiers in
 * creation (ascending-ordinal) order.
 *
 * Gap 1 merge-race fix: the scheduler's file-mutex (busyTouches/globsOverlap)
 * only defers overlapping siblings while they are concurrently in `inFlight`. A
 * child leaves inFlight the moment it opens a PR, but on a human-merge repo
 * (autoMergeRepos is empty by default, incl. factory.ai) that PR sits UNMERGED
 * in review — so an overlapping sibling admitted on a later tick would branch
 * from an origin/main that lacks its work, re-opening the very duplicate-file
 * race (FAC-15/16/18) the mutex exists to kill, merely deferred from session-
 * time to merge-time. So we serialize overlap at the DAG layer too: any child
 * whose ## Touches overlap an EARLIER-ordinal sibling's gains an implicit
 * depends_on edge to it. The completion-gated frontier then holds the later
 * child until the earlier one reaches a terminal state (merged=completed, or
 * canceled), not merely until it leaves inFlight. Edges still point only to
 * strictly-lower ordinals, so acyclicity is preserved. */
export async function createChildren(
  children: ChildSpec[],
  base: { repo: string; model?: string; models?: Record<string, string>; effort?: Record<string, string> | string; merge?: "auto" | "shadow" | "review" },
  create: (child: ChildSpec, stampedDescription: string) => Promise<string>,
): Promise<string[]> {
  const created: string[] = [];
  const byOrdinal = new Map<number, string>();
  const sorted = [...children].sort((a, b) => a.ordinal - b.ordinal);
  for (const child of sorted) {
    // Union the declared edges with implicit overlap edges to lower-ordinal
    // siblings (globsOverlap is empty-list-safe, so a child with no ## Touches
    // adds none and attracts none — unchanged behavior). De-dup and sort so a
    // sibling that is BOTH an explicit dep and an overlap dep is listed once.
    const overlapOrdinals = sorted
      .filter((s) => s.ordinal < child.ordinal && globsOverlap(child.touches, s.touches))
      .map((s) => s.ordinal);
    const depOrdinals = [...new Set([...child.dependsOn, ...overlapOrdinals])].sort((a, b) => a - b);
    const dependsIds = depOrdinals.map((o) => byOrdinal.get(o)!); // all lower ordinals already created
    const stamped = withFactoryMeta(child.description, {
      repo: base.repo, type: "task",
      ...(base.model ? { model: base.model } : {}),
      // Propagate the epic's WHOLE per-stage models map to every child so a
      // per-epic roster (e.g. reviewers on a different provider than the
      // implementer) reaches the pipeline for each child too, not just the
      // legacy single-`model` override.
      ...(base.models && Object.keys(base.models).length > 0 ? { models: base.models } : {}),
      // Propagate the epic's effort the same way models is propagated above —
      // a per-epic effort override (single default or per-stage map) reaches
      // every child's pipeline run, not just this planning stage's own.
      ...(base.effort && (typeof base.effort === "string" ? base.effort !== "" : Object.keys(base.effort).length > 0) ? { effort: base.effort } : {}),
      // Propagate the epic's merge policy so a per-epic human-review opt-in
      // (merge:review) reaches every child — the loop reads the CHILD's meta for
      // the auto-merge decision, so without this an epic's opt-out would not stick.
      ...(base.merge ? { merge: base.merge } : {}),
      ...(dependsIds.length ? { depends_on: dependsIds } : {}),
      ...(child.touches.length ? { touches: child.touches } : {}),
    });
    const id = await create(child, stamped);
    byOrdinal.set(child.ordinal, id);
    created.push(id);
  }
  return created;
}

function forwardStage(issueKey: string): (e: AgentStreamEvent) => void {
  return (e) => {
    if (e.kind === "stage_started") bus.emit({ type: "run_stage_started", issueKey, stage: e.stage, model: e.model, viaProxy: e.viaProxy });
    else if (e.kind === "tool_use") bus.emit({ type: "run_tool_use", issueKey, stage: e.stage, tool: e.tool, detail: e.detail });
    else if (e.kind === "assistant_text") bus.emit({ type: "run_assistant_text", issueKey, stage: e.stage, text: e.text });
    else bus.emit({ type: "run_stage_finished", issueKey, stage: e.stage, costUsd: e.costUsd, turns: e.turns, wallSeconds: e.wallSeconds, resultText: e.resultText, ...(e.error ? { error: e.error } : {}), ...(e.modelUsage ? { modelUsage: e.modelUsage } : {}) });
  };
}

export async function planIssue(issue: linear.Issue): Promise<void> {
  const repo = repoFromTicket(issue.description);
  if (!repo) {
    // Route through markNeedsHuman() rather than duplicating its comment/label
    // logic — it also emits the durable issue_needs_human event that
    // lastParkReasonForIssue reads, so this reason reaches steward closeout
    // (FAC-14 lesson) instead of surfacing as "(no reason recorded)".
    await markNeedsHuman(issue, `epic has no parseable "## Repo" section; the planner needs a repo to research.`);
    return;
  }
  bus.emit({ type: "run_started", issueKey: issue.identifier, title: `[plan] ${issue.title}`, repo, dryRun: config.dryRun });
  const deadline = Date.now() + config.caps.wallMinutesPerIssue * 60_000;
  const spec = untrusted(`# ${issue.title}\n\n${issue.description}`);
  const onEvent = forwardStage(issue.identifier);
  const stages: StageResult[] = [];
  // Per-epic model routing (execution-profiles): an epic's `model`/`models:`
  // meta overrides which model the scout/decomposer run on, resolved through
  // the same precedence every pipeline stage now uses.
  const epicMeta = parseFactoryMeta(issue.description);

  const finish = (outcome: "planned" | "parked", reason: string): void => {
    // Redact at the emit seam like loop.ts / groundskeepers.ts (§2.2) — error
    // reasons can interpolate HTTP bodies and land verbatim in the durable log.
    bus.emit({ type: "run_finished", issueKey: issue.identifier, outcome, reason: redactSecrets(reason).clean.slice(0, 300), prUrl: null,
      costUsd: stages.reduce((s, x) => s + x.costUsd, 0), stages: stages.map(toStageMeta),
      gateStrength: "none", guardedPaths: [], dryRun: config.dryRun });
  };

  try {
    const ws = await ensureWorkspace(repo, `${issue.identifier}-plan`);

    // ---- scout: research only. Read-only repo tools + web. No Bash, no writes.
    const scout = await runStage("scout",
      renderPrompt("scout", { spec },
        `You are the research scout in a software factory's planning stage. Investigate everything needed to break the epic below into parallel implementation tickets: read the repo in the current directory (structure, stack, conventions, reference/ material if present), and use WebSearch/WebFetch for anything external the epic depends on. Return a dense research brief: what exists, what must be built, data sources/APIs with concrete endpoints or file paths, risks, and a suggested split into independent work areas.\n\n${spec}`),
      { model: resolveModel("scout", epicMeta), effort: resolveEffort("scout", epicMeta, cardEffort("scout")), cwd: ws.dir, allowedTools: roleTools("scout", listRoutableCards()).tools, maxTurns: config.caps.turnsImplementer, budgetUsd: config.caps.budgetUsdPerIssue, deadlineMs: deadline, onEvent });
    stages.push(scout);
    await postStageComment(issue, scout);
    if (scout.error) throw new Error(`scout: ${scout.error}`);

    // ---- decomposer: children as FILES, every child a full ticket contract.
    const scratch = join(config.workRoot, ".plan-scratch", issue.identifier);
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(join(scratch, "children"), { recursive: true });
    const decomposer = await runStage("decomposer",
      renderPrompt("decomposer", { repo, spec, brief: untrusted(`SCOUT RESEARCH BRIEF:\n${scout.text}`) },
        [
          "You are the decomposer in a software factory's planning stage. Using the epic and the scout's research brief, produce 2-6 child tickets that TOGETHER deliver the epic. HARD RULES:",
          '- The children form a DAG, not a flat parallel list. For any child that MUST follow another, declare a "## Depends-on" section listing the ordinals of the files it depends on (reference LOWER-NUMBERED files only, e.g. "01, 02"). A child with no ## Depends-on runs as soon as capacity allows.',
          '- Declare a "## Touches" section listing EVERY path glob the child will modify (e.g. "src/foo/**, src/bar.ts"). Any child whose ## Touches overlap an EARLIER-numbered sibling\'s is given an implicit build-order dependency on it: the later child does not start until the earlier one has MERGED, so overlap costs parallelism (not correctness) — number overlapping children in the order they should build. You MUST declare touches honestly and completely: an omitted path reintroduces the sibling file-race. Prefer honest overlap (safe, serialized) over false independence.',
          '- SHARED/GLUE files are the most common place touches go undeclared: if a child adds a dependency, a global style, a shared layout change, or a route, it is touching a file OTHER children also touch, and that file MUST be named in ## Touches even if the child\'s "main" work is elsewhere. Call out by name whenever they are edited: the global stylesheet (e.g. index.css), the app layout/shell, package.json (or the lockfile), and the router. Two siblings that both silently edit the same shared file and never declare it will run in parallel and conflict — the DAG can only serialize collisions it is TOLD about.',
          `- Every child description MUST contain exactly these sections: ## Goal, ## Why, ## Outcomes (checkbox list), ## Repo (${repo}), ## Verifications (Automated/Manual/Visual), ## Touches, optionally ## Depends-on, and optionally ## Implementation approach.`,
          "- Size each child to fit one implementer session (~40 turns / 45 min).",
          'OUTPUT PROTOCOL: write each child as a separate file children/<NN>-<slug>.md in your working directory (NN = 01, 02, ... in build order — a ## Depends-on edge always points to a lower NN). First line: "# <title>". Rest of file: the full description (the sections above). Write the files, then reply with just the list of filenames.',
          "", spec, "", untrusted(`SCOUT RESEARCH BRIEF:\n${scout.text}`),
        ].join("\n")),
      { model: resolveModel("planner", epicMeta), effort: resolveEffort("planner", epicMeta, cardEffort("decomposer")), cwd: scratch, allowedTools: roleTools("decomposer", listRoutableCards()).tools, maxTurns: 16, budgetUsd: config.caps.budgetUsdPerIssue, deadlineMs: deadline, onEvent });
    stages.push(decomposer);
    await postStageComment(issue, decomposer);
    if (decomposer.error) throw new Error(`decomposer: ${decomposer.error}`);

    const children = readChildren(join(scratch, "children"));
    // Gap 9 (advisory only — never blocks planning): log a visible warning for
    // any child that mentions a well-known shared/glue file in its body without
    // declaring it in ## Touches, so an undeclared-collision risk is caught
    // before the DAG runs siblings in parallel.
    for (const w of findUndeclaredGlueTouches(children)) console.warn(`[${issue.identifier}] ${w}`);
    if (config.dryRun) {
      console.log(`[${issue.identifier}] dry-run: would create ${children.length} children: ${children.map((c) => c.title).join(" | ")}`);
      finish("planned", `dry-run: planned ${children.length} children`);
      return;
    }
    // Stamp every child with the atomic factory metadata block: the exact repo,
    // type:task, and the epic's model/models (per-epic override propagates to
    // children). This is why children can never fail repo-parse or the epic-race
    // again.
    const created = await createChildren(children, { repo, model: epicMeta.model, models: epicMeta.models, effort: epicMeta.effort, merge: epicMeta.merge },
      (child, stamped) => linear.createSubIssue(issue, child.title, stamped));

    await linear.postComment(issue, [
      linear.SENTINEL, "",
      `**Planned** — epic decomposed into ${created.length} parallel child tickets: ${created.join(", ")}.`,
      "", "Children flow through the normal pipeline; this parent is tracking-only now.",
      "", "```yaml", "meta:", "  outcome: planned", `  children: [${created.join(", ")}]`,
      `  cost_usd: ${stages.reduce((s, x) => s + x.costUsd, 0).toFixed(4)}`, "```",
    ].join("\n")).catch((e) => console.error(`[${issue.identifier}] plan comment failed: ${e}`));
    await linear.addLabel(issue, linear.PLANNED_LABEL);
    await linear.transition(issue, "working").catch(() => {});
    finish("planned", `planned: ${created.length} children (${created.join(", ")})`);
    console.log(`[${issue.identifier}] planned → ${created.join(", ")}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Error strings can interpolate HTTP bodies — redact at the outbound seam
    // (§2.2) so the ticket comment carries the WHY without carrying a secret.
    await linear.postComment(issue, `${linear.SENTINEL}\n\n**Outcome:** parked — planner failed: ${redactSecrets(reason).clean.slice(0, 300)}`).catch(() => {});
    if (!config.dryRun) {
      await linear.addLabel(issue, linear.PARKED_LABEL).catch(() => {});
      // WP3 board stage: a failed decomposition is paused-and-retryable, so it
      // lands in the Blocked column (unstarted — the Factory-Parked label is
      // still what holds it out of the queue; degrades to the queue state on a
      // board without the column).
      await linear.transition(issue, "blocked").catch(() => {});
    }
    // Pass the FULL reason — finish() redacts before its own truncation, and
    // pre-slicing here would cut a secret in half, defeating the exact-value
    // scrub (redactSecrets matches whole values only).
    finish("parked", reason);
    console.error(`[${issue.identifier}] planner parked: ${reason}`);
  }
}
