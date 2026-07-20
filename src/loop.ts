import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { ensureWorkspace, repoFromTicket, commitAll, diffAgainstBase, guardedPathsTouched, testFilesRemoved, pushBranch, createPr, DIFF_FAILED, type Workspace } from "./repos.ts";
import { ensureDeps, detectGates, baseline, verify, gateSummary } from "./verify.ts";
import { runStage, untrusted, redactSecrets, type StageResult } from "./agents.ts";
import { buildReport, type ReportInput } from "./report.ts";

// Per-issue pipeline, hardened per code-review verdict 2026-07-20:
// budget threaded cumulatively (C11), deadline before every stage + abort (C12),
// park/needs-human are labeled terminal states (C6), release is guaranteed
// (C9/C10), guarded paths and test deletions stop auto-advance (C17),
// stillOurs before deliver (C26), reviewer output re-delimited for the fixer (M6).

const REQUIRED_SECTIONS = ["## Goal", "## Outcomes", "## Repo", "## Verifications"];

// Interim Bash scoping for write-capable roles (C19; full OS sandbox is backlog).
const WRITER_BASH = ["Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ls:*)", "Bash(cat:*)"];

export function missingSections(issue: linear.Issue): string[] {
  return REQUIRED_SECTIONS.filter((s) => !issue.description.includes(s));
}

export function isEligible(issue: linear.Issue): boolean {
  return missingSections(issue).length === 0 && repoFromTicket(issue.description) !== null;
}

async function post(issue: linear.Issue, body: string): Promise<void> {
  const { clean, found } = redactSecrets(body);
  if (found > 0) console.error(`[${issue.identifier}] redacted ${found} secret-like strings from outbound comment`);
  if (config.dryRun) { console.log(`[dry-run] would comment on ${issue.identifier}:\n${clean.slice(0, 500)}`); return; }
  await linear.postComment(issue, clean);
}

/** Terminal "needs human" — labeled so it can never loop or spam (C6). */
export async function markNeedsHuman(issue: linear.Issue, reason: string): Promise<void> {
  await post(issue, `${linear.SENTINEL}\n\n**needs human** — ${reason}\n\nRemove the \`${linear.NEEDS_HUMAN_LABEL}\` label after fixing to requeue.`);
  if (!config.dryRun) {
    await linear.addLabel(issue, linear.NEEDS_HUMAN_LABEL).catch((e) => console.error(`[${issue.identifier}] label failed: ${e}`));
  }
}

/** Re-check claim before every mutating side effect. */
async function stillOurs(issue: linear.Issue): Promise<boolean> {
  const fresh = await linear.getIssue(issue.id);
  return fresh.labels.includes(linear.EXECUTING_LABEL) && fresh.stateType === "started";
}

/** External transition detected → abandon cleanly: release + short note (C9). */
async function abortExternal(issue: linear.Issue, where: string): Promise<void> {
  console.error(`[${issue.identifier}] externally transitioned during ${where} — abandoning`);
  try { await post(issue, `${linear.SENTINEL}\n\n**Outcome:** aborted — issue was moved externally during ${where}; factory abandoned its attempt (worktree kept).`); }
  catch (e) { console.error(`[${issue.identifier}] abort note failed: ${e}`); }
  if (!config.dryRun) await linear.release(issue);
}

class Budget {
  constructor(private stages: StageResult[], private deadline: number) {}
  get spent(): number { return this.stages.reduce((s, x) => s + x.costUsd, 0); }
  get remainingUsd(): number { return config.caps.budgetUsdPerIssue - this.spent; }
  get deadlineMs(): number { return this.deadline; }
  get expired(): boolean { return Date.now() > this.deadline || this.remainingUsd <= 0; }
  get expiredReason(): string { return Date.now() > this.deadline ? "wall-clock cap reached" : "issue budget exhausted"; }
}

export async function processIssue(issue: linear.Issue): Promise<void> {
  const missing = missingSections(issue);
  if (missing.length > 0) {
    await markNeedsHuman(issue, `ticket is missing required sections: ${missing.join(", ")} (see factory docs/ticket-contract.md)`);
    return;
  }
  const repo = repoFromTicket(issue.description);
  if (!repo) {
    await markNeedsHuman(issue, `could not parse a single org/name from the "## Repo" section — never guessing (ROUTE failure contract)`);
    return;
  }

  if (!config.dryRun && !(await linear.claim(issue))) {
    console.error(`[${issue.identifier}] claim failed or lost race — skipping`);
    return;
  }

  const stages: StageResult[] = [];
  const budget = new Budget(stages, Date.now() + config.caps.wallMinutesPerIssue * 60_000);
  const spec = untrusted(`# ${issue.title}\n\n${issue.description}`);
  const reviewerScratch = join(config.workRoot, ".reviewer-scratch");
  mkdirSync(reviewerScratch, { recursive: true });

  try {
    let ws: Workspace;
    try {
      ws = await ensureWorkspace(repo, issue.identifier);
    } catch (error) {
      await park(issue, stages, `workspace: ${error instanceof Error ? error.message : error}`);
      return;
    }

    const deps = ensureDeps(ws);
    if (!deps.ok) { await park(issue, stages, `dependency install failed: ${deps.detail.slice(0, 300)}`); return; }
    const gates = detectGates(ws);
    const baselines = baseline(ws, gates);

    // ---- implementer
    const implementer = await runStage("implementer",
      `You are the implementer in an automated software factory. Work ONLY inside the current directory (a fresh git worktree of ${repo}). Implement the ticket below. Follow the repo's existing conventions. Sanity-check your work with the repo's own scripts where cheap. Do not create unrelated files; do not touch tests/CI/workflows unless the ticket explicitly asks. When done, reply with a one-paragraph summary of the change.\n\n${spec}`,
      { model: config.models.implementer, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", ...WRITER_BASH], maxTurns: config.caps.turnsImplementer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs });
    stages.push(implementer);
    if (implementer.error) { await park(issue, stages, `implementer: ${implementer.error}`); return; }
    if (!commitAll(ws, `${issue.identifier}: implement ${issue.title}`)) { await park(issue, stages, "implementer produced no committable changes"); return; }
    if (budget.expired) { await park(issue, stages, budget.expiredReason); return; }
    if (!config.dryRun && !(await stillOurs(issue))) { await abortExternal(issue, "implementation"); return; }

    // ---- adversarial review: framing-stripped (spec + diff ONLY), tool-less
    let diff: string;
    try { diff = diffAgainstBase(ws); }
    catch (error) { await park(issue, stages, `diff failed: ${error instanceof Error ? error.message : error}`); return; }

    const reviewPrompt = (lens: string) =>
      `You are an adversarial code reviewer in an automated pipeline. Assume the change is BROKEN until proven otherwise. Lens: ${lens}. You get ONLY the ticket and the diff — no author reasoning. For each real problem: exact input/scenario that fails, expected vs actual, responsible hunk. No praise. If nothing after genuine effort: NO-FINDINGS.\n\n${spec}\n\n<diff>\n${diff.slice(0, 180_000)}\n</diff>`;

    const [reviewClaude, reviewCodexTry] = await Promise.all([
      runStage("reviewer-claude", reviewPrompt("spec compliance and correctness — walk every ticket requirement"),
        { model: config.models.reviewerClaude, cwd: reviewerScratch, maxTurns: config.caps.turnsReviewer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs }),
      runStage("reviewer-codex", reviewPrompt("hostile edge cases, regressions, and unstated assumptions"),
        { model: config.models.reviewerCodex, cwd: reviewerScratch, maxTurns: config.caps.turnsReviewer, viaProxy: true, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs }),
    ]);
    let reviewCodex = reviewCodexTry;
    if (reviewCodex.error || !reviewCodex.text.trim()) {
      reviewCodex = await runStage("reviewer-fallback", reviewPrompt("hostile edge cases, regressions, and unstated assumptions"),
        { model: config.models.reviewerClaude, cwd: reviewerScratch, maxTurns: config.caps.turnsReviewer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs });
      reviewCodex.degraded = true;
    }
    stages.push(reviewClaude, reviewCodex);
    if (budget.expired) { await park(issue, stages, budget.expiredReason); return; }

    // ---- fixer (fresh context; reviewer output is untrusted too — M6)
    const fixer = await runStage("fixer",
      `You are the fixer in an automated pipeline. Two independent reviewers examined the latest change in this worktree against the ticket. Evaluate each finding, fix the real ones, reject ones that contradict the ticket. Never weaken or delete tests. Sanity-check with the repo's own scripts. Reply with one line per finding: fixed / rejected (why).\n\n${spec}\n\n${untrusted(`REVIEW 1:\n${reviewClaude.text}\n\nREVIEW 2:\n${reviewCodex.text}`)}`,
      { model: config.models.fixer, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Edit", ...WRITER_BASH], maxTurns: config.caps.turnsFixer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs });
    stages.push(fixer);
    if (fixer.error) { await park(issue, stages, `fixer: ${fixer.error}`); return; }
    commitAll(ws, `${issue.identifier}: apply review feedback`);
    if (budget.expired) { await park(issue, stages, budget.expiredReason); return; }
    if (!config.dryRun && !(await stillOurs(issue))) { await abortExternal(issue, "review"); return; }

    // ---- verify (baselined) with bounded, budgeted, deadlined repair rounds
    let results = verify(ws, gates, baselines);
    let summary = gateSummary(results);
    for (let i = 0; !summary.green && i < config.caps.verifierIterations && !budget.expired; i++) {
      const repair = await runStage(`verify-repair-${i + 1}`,
        `Gates are failing in this worktree. Fix ONLY what the failures indicate — never weaken or delete tests (that requires a human). Failures:\n${summary.failures.map((f) => `## ${f.name}\n${f.output}`).join("\n")}`,
        { model: config.models.fixer, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Edit", ...WRITER_BASH], maxTurns: config.caps.turnsFixer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs });
      stages.push(repair);
      commitAll(ws, `${issue.identifier}: fix gate failures (round ${i + 1})`);
      results = verify(ws, gates, baselines);
      summary = gateSummary(results);
    }
    if (!summary.green) { await park(issue, stages, budget.expired ? budget.expiredReason : `gates still failing after ${config.caps.verifierIterations} repair rounds`); return; }

    // ---- deliver (guarded paths / test deletion stop auto-advance — C17)
    const removedTests = testFilesRemoved(ws);
    if (removedTests.length > 0) { await park(issue, stages, `change DELETES test files (${removedTests.join(", ")}) — categorical human review`); return; }
    const guarded = guardedPathsTouched(ws);
    if (!config.dryRun && !(await stillOurs(issue))) { await abortExternal(issue, "delivery"); return; }

    let prUrl: string | null = null;
    if (!config.dryRun) {
      pushBranch(ws);
      const prBody = redactSecrets(`Closes ${issue.identifier} — ${issue.url}\n\n${implementer.text}\n\n🤖 Generated by the software factory; every PR is human-merged (plan v0.2).`).clean;
      prUrl = createPr(ws, `${issue.identifier}: ${issue.title}`, prBody);
    }

    const guardedStop = guarded.length > 0 || guarded.includes(DIFF_FAILED);
    const report = buildReport({
      issueKey: issue.identifier, prUrl,
      outcome: guardedStop ? "needs_human" : "pr_open",
      reason: guardedStop ? `guarded paths touched: ${guarded.join(", ")}` : undefined,
      stages, gates: results, gateStrength: summary.strength, guardedPaths: guarded,
      reviewFindingsSummary: fixer.text.slice(0, 1500),
    });

    // Comment is best-effort; transition/release are guaranteed (C10).
    try { await post(issue, report); } catch (e) { console.error(`[${issue.identifier}] report post failed: ${e}`); }
    if (!config.dryRun) {
      if (guardedStop) {
        await linear.addLabel(issue, linear.NEEDS_HUMAN_LABEL).catch(() => {});
      } else {
        const moved = await linear.transition(issue, "review");
        if (!moved) console.error(`[${issue.identifier}] no review-type state on team — left in working state`);
      }
      await linear.release(issue);
    }
    console.log(`[${issue.identifier}] ${guardedStop ? "needs_human (guarded)" : "pr_open"} ${prUrl ?? "(dry-run)"}`);
  } catch (error) {
    await park(issue, stages, error instanceof Error ? error.message : String(error));
  }
}

async function park(issue: linear.Issue, stages: StageResult[], reason: string): Promise<void> {
  // Caps and failures PARK, never destroy: worktree kept, Factory-Parked label
  // keeps it out of the queue until a human clears it (C6); comment best-effort,
  // label/release guaranteed (C10).
  const input: ReportInput = {
    issueKey: issue.identifier, prUrl: null, outcome: "parked", reason,
    stages, gates: [], gateStrength: "none", guardedPaths: [],
  };
  try { await post(issue, buildReport(input)); } catch (e) { console.error(`[${issue.identifier}] park report failed: ${e}`); }
  if (!config.dryRun) {
    await linear.addLabel(issue, linear.PARKED_LABEL).catch((e) => console.error(`[${issue.identifier}] park label failed: ${e}`));
    await linear.transition(issue, "queue").catch(() => {});
    await linear.release(issue);
  }
  console.error(`[${issue.identifier}] parked: ${reason}`);
}
