import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { ensureWorkspace, repoFromTicket } from "./repos.ts";
import { runStage, untrusted, type StageResult } from "./agents.ts";
import { bus, toStageMeta, type AgentStreamEvent } from "./events.ts";

// PLAN stage (plan v1.1, promoted 2026-07-20 by owner decision): Factory-Epic
// tickets route here instead of the implementer pipeline.
//   scout (read-only repo + WebSearch/WebFetch, no Bash/no writes)
//     → decomposer (JSON list of contract-conforming children, non-overlapping
//       file areas, all safely parallelizable)
//     → sub-issues created under the parent; parent labeled Factory-Planned
//       (tracking-only, filtered from the queue forever).

interface ChildSpec {
  title: string;
  description: string;
}

function parseChildren(text: string): ChildSpec[] {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  const raw = match?.[1] ?? text;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("decomposer returned no JSON array");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("decomposer JSON is not an array");
  const children = parsed.filter((c): c is ChildSpec =>
    typeof (c as ChildSpec).title === "string" && typeof (c as ChildSpec).description === "string");
  if (children.length < 2 || children.length > 6) throw new Error(`decomposer produced ${children.length} children (expected 2-6)`);
  return children;
}

function forwardStage(issueKey: string): (e: AgentStreamEvent) => void {
  return (e) => {
    if (e.kind === "stage_started") bus.emit({ type: "run_stage_started", issueKey, stage: e.stage, model: e.model, viaProxy: e.viaProxy });
    else if (e.kind === "tool_use") bus.emit({ type: "run_tool_use", issueKey, stage: e.stage, tool: e.tool, detail: e.detail });
    else if (e.kind === "assistant_text") bus.emit({ type: "run_assistant_text", issueKey, stage: e.stage, text: e.text });
    else bus.emit({ type: "run_stage_finished", issueKey, stage: e.stage, costUsd: e.costUsd, turns: e.turns, wallSeconds: e.wallSeconds, resultText: e.resultText, ...(e.error ? { error: e.error } : {}) });
  };
}

export async function planIssue(issue: linear.Issue): Promise<void> {
  const repo = repoFromTicket(issue.description);
  if (!repo) {
    await linear.postComment(issue, `${linear.SENTINEL}\n\n**needs human** — epic has no parseable "## Repo" section; the planner needs a repo to research.`).catch(() => {});
    if (!config.dryRun) await linear.addLabel(issue, linear.NEEDS_HUMAN_LABEL).catch(() => {});
    return;
  }
  bus.emit({ type: "run_started", issueKey: issue.identifier, title: `[plan] ${issue.title}`, repo, dryRun: config.dryRun });
  const deadline = Date.now() + config.caps.wallMinutesPerIssue * 60_000;
  const spec = untrusted(`# ${issue.title}\n\n${issue.description}`);
  const onEvent = forwardStage(issue.identifier);
  const stages: StageResult[] = [];

  const finish = (outcome: "pr_open" | "parked", reason: string): void => {
    bus.emit({ type: "run_finished", issueKey: issue.identifier, outcome, reason, prUrl: null,
      costUsd: stages.reduce((s, x) => s + x.costUsd, 0), stages: stages.map(toStageMeta),
      gateStrength: "none", guardedPaths: [], dryRun: config.dryRun });
  };

  try {
    const ws = await ensureWorkspace(repo, `${issue.identifier}-plan`);

    // ---- scout: research only. Read-only repo tools + web. No Bash, no writes.
    const scout = await runStage("scout",
      `You are the research scout in a software factory's planning stage. Investigate everything needed to break the epic below into parallel implementation tickets: read the repo in the current directory (structure, stack, conventions, reference/ material if present), and use WebSearch/WebFetch for anything external the epic depends on. Return a dense research brief: what exists, what must be built, data sources/APIs with concrete endpoints or file paths, risks, and a suggested split into independent work areas.\n\n${spec}`,
      { model: config.models.scout, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"], maxTurns: config.caps.turnsImplementer, budgetUsd: config.caps.budgetUsdPerIssue, deadlineMs: deadline, onEvent });
    stages.push(scout);
    if (scout.error) throw new Error(`scout: ${scout.error}`);

    // ---- decomposer: children as JSON, every child a full ticket contract.
    const decomposer = await runStage("decomposer",
      [
        "You are the decomposer in a software factory's planning stage. Using the epic and the scout's research brief, produce 2-6 child tickets that TOGETHER deliver the epic. HARD RULES:",
        '- Every child MUST be independently implementable and ALL children may run IN PARALLEL — declare a "## Area" section listing the file paths/directories that child owns, and areas MUST NOT overlap. Anything inherently sequential belongs merged into one child.',
        `- Every child description MUST contain exactly these sections: ## Goal, ## Why, ## Outcomes (checkbox list), ## Repo (${repo}), ## Verifications (Automated/Manual/Visual), ## Area, and optionally ## Implementation approach.`,
        "- Size each child to fit one implementer session (~40 turns / 45 min).",
        'Return ONLY a JSON array in a ```json fence: [{"title": "...", "description": "..."}]',
        "", spec, "", untrusted(`SCOUT RESEARCH BRIEF:\n${scout.text}`),
      ].join("\n"),
      { model: config.models.planner, maxTurns: 4, budgetUsd: config.caps.budgetUsdPerIssue, deadlineMs: deadline, onEvent });
    stages.push(decomposer);
    if (decomposer.error) throw new Error(`decomposer: ${decomposer.error}`);

    const children = parseChildren(decomposer.text);
    if (config.dryRun) {
      console.log(`[${issue.identifier}] dry-run: would create ${children.length} children: ${children.map((c) => c.title).join(" | ")}`);
      finish("pr_open", `dry-run: planned ${children.length} children`);
      return;
    }
    const created: string[] = [];
    for (const child of children) {
      created.push(await linear.createSubIssue(issue, child.title, child.description));
    }

    await linear.postComment(issue, [
      linear.SENTINEL, "",
      `**Planned** — epic decomposed into ${created.length} parallel child tickets: ${created.join(", ")}.`,
      "", "Children flow through the normal pipeline; this parent is tracking-only now.",
      "", "```yaml", "meta:", "  outcome: planned", `  children: [${created.join(", ")}]`,
      `  cost_usd: ${stages.reduce((s, x) => s + x.costUsd, 0).toFixed(4)}`, "```",
    ].join("\n")).catch((e) => console.error(`[${issue.identifier}] plan comment failed: ${e}`));
    await linear.addLabel(issue, linear.PLANNED_LABEL);
    await linear.transition(issue, "working").catch(() => {});
    finish("pr_open", `planned: ${created.length} children (${created.join(", ")})`);
    console.log(`[${issue.identifier}] planned → ${created.join(", ")}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await linear.postComment(issue, `${linear.SENTINEL}\n\n**Outcome:** parked — planner failed: ${reason.slice(0, 300)}`).catch(() => {});
    if (!config.dryRun) await linear.addLabel(issue, linear.PARKED_LABEL).catch(() => {});
    finish("parked", reason.slice(0, 200));
    console.error(`[${issue.identifier}] planner parked: ${reason}`);
  }
}
