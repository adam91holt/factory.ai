import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { ensureWorkspace, repoFromTicket, commitAll, hasCommitsAheadOfBase, diffAgainstBase, guardedPathsTouched, uiFilesTouched, testFilesRemoved, pushBranch, createPr, mergePr, DIFF_FAILED, type Workspace } from "./repos.ts";
import { ensureDeps, detectGates, baseline, verify, gateSummary, hasPlaywright, requiresBrowserEvidence } from "./verify.ts";
import { runStage, untrusted, redactSecrets, type StageResult } from "./agents.ts";
import { isDraining } from "./control.ts";
import { parseFactoryMeta } from "./meta.ts";
import { checkFreshness } from "./precondition.ts";
import { getStageSession, recordStageSession, clearStageSession, getLadderState, recordShadowDecision } from "./db.ts";
import { decideMerge, effectiveMergeTier, buildMergeEvidence, type BrowserEvidence, type MergeDecision } from "./merge-ladder.ts";
import { renderPrompt } from "./catalog.ts";
import { buildReport, type ReportInput } from "./report.ts";
import { bus, toStageMeta, type AgentStreamEvent } from "./events.ts";
import { captureLesson, buildLessonsBlock, lessonsForRepo } from "./lessons.ts";

// Per-issue pipeline, hardened per code-review verdict 2026-07-20:
// budget threaded cumulatively (C11), deadline before every stage + abort (C12),
// park/needs-human are labeled terminal states (C6), release is guaranteed
// (C9/C10), guarded paths and test deletions stop auto-advance (C17),
// stillOurs before deliver (C26), reviewer output re-delimited for the fixer (M6).

const REQUIRED_SECTIONS = ["## Goal", "## Outcomes", "## Repo", "## Verifications"];

// Interim Bash scoping for write-capable roles (C19; full OS sandbox is backlog).
const WRITER_BASH = ["Bash(bun:*)", "Bash(bunx:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git rm:*)", "Bash(ls:*)", "Bash(cat:*)"];

export function missingSections(issue: linear.Issue): string[] {
  return REQUIRED_SECTIONS.filter((s) => !issue.description.includes(s));
}

export function isEligible(issue: linear.Issue): boolean {
  return missingSections(issue).length === 0 && repoFromTicket(issue.description) !== null;
}

/** Tester trigger: the ticket asks for a browser check explicitly (needs:browser-test)
 * OR its ## Verifications section names a Visual item. Gated again on hasPlaywright. */
export function wantsBrowserVerification(description: string): boolean {
  if (/needs:browser-test/i.test(description)) return true;
  const idx = description.search(/##\s*Verifications/i);
  return idx >= 0 && /visual/i.test(description.slice(idx));
}

// Non-trivial diff threshold for the security-review stage — a one-line tweak
// isn't worth a cross-vendor security pass; anything larger gets reviewed.
const SECURITY_REVIEW_MIN_DIFF_LINES = 20;

/** Count of added/removed source lines in a unified diff (excludes the +++/---
 * file headers). Feeds low-risk merge classification and the security-stage gate. */
export function countDiffLines(diff: string): number {
  return diff.split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")).length;
}

/** Map the tester stage's outcome to browser evidence (Gap 2). `testerText` is
 * null when the tester never ran: that is "missing" for a repo that REQUIRES
 * browser evidence (blocks auto-merge, PR still opens) and "not-required" for a
 * repo with no UI surface / no Playwright. A ran-but-verdict-less tester is
 * treated the same as not-run. Ticket text is not consulted here. */
export function mapBrowserEvidence(requiresBrowser: boolean, testerText: string | null): BrowserEvidence {
  if (testerText !== null) {
    if (/VERDICT:\s*fail/i.test(testerText)) return "fail";
    if (/VERDICT:\s*partial/i.test(testerText)) return "partial";
    if (/VERDICT:\s*pass/i.test(testerText)) return "pass";
  }
  return requiresBrowser ? "missing" : "not-required";
}

/** Parse the security-review stage's mandated final line. Anything that is not an
 * explicit "SECURITY: fail" is treated as pass (the stage only ran because a diff
 * was non-trivial; a missing verdict must not silently block, but a fail must). */
export function parseSecurityVerdict(text: string): "pass" | "fail" {
  return /SECURITY:\s*fail/i.test(text) ? "fail" : "pass";
}

/** A security review was WARRANTED (the diff is non-trivial) but no verdict exists
 * — the stage was skipped by budget/deadline expiry, or it errored. This is the
 * fail-open hole Gap 2 must close: decideMerge blocks only on an explicit "fail",
 * so a null verdict would otherwise let an earned auto tier merge a large diff with
 * the security gate silently skipped. The loop folds a true result into needsHuman
 * (fail-closed for the merge ACTION), degrading the PR to human review — it never
 * parks the pipeline on this alone. */
export function securityReviewOutstanding(diffLines: number, securityVerdict: "pass" | "fail" | null): boolean {
  return diffLines >= SECURITY_REVIEW_MIN_DIFF_LINES && securityVerdict === null;
}

async function post(issue: linear.Issue, body: string): Promise<void> {
  const { clean, found } = redactSecrets(body);
  if (found > 0) console.error(`[${issue.identifier}] redacted ${found} secret-like strings from outbound comment`);
  if (config.dryRun) { console.log(`[dry-run] would comment on ${issue.identifier}:\n${clean.slice(0, 500)}`); return; }
  await linear.postComment(issue, clean);
}

/** Per-issue AgentStreamEvent → FactoryEvent forwarder (UI observes only). */
function forwardStage(issueKey: string): (e: AgentStreamEvent) => void {
  return (e) => {
    if (e.kind === "stage_started") bus.emit({ type: "run_stage_started", issueKey, stage: e.stage, model: e.model, viaProxy: e.viaProxy });
    else if (e.kind === "tool_use") bus.emit({ type: "run_tool_use", issueKey, stage: e.stage, tool: e.tool, detail: e.detail });
    else if (e.kind === "assistant_text") bus.emit({ type: "run_assistant_text", issueKey, stage: e.stage, text: e.text });
    // "reviewer-fallback" only runs when the Codex leg failed — mark it degraded
    // live (loop.ts sets StageResult.degraded after runStage already emitted).
    else bus.emit({ type: "run_stage_finished", issueKey, stage: e.stage, costUsd: e.costUsd, turns: e.turns, wallSeconds: e.wallSeconds, resultText: e.resultText, ...(e.error ? { error: e.error } : {}), ...(e.degraded || e.stage === "reviewer-fallback" ? { degraded: true } : {}), ...(e.modelUsage ? { modelUsage: e.modelUsage } : {}) });
  };
}

/** Terminal "needs human" — labeled so it can never loop or spam (C6).
 *  The reason comment is best-effort but the LABEL is guaranteed: a Linear
 *  comment failure must never leave the ticket unlabeled (it would requeue and
 *  loop), and a labeled ticket without its reason comment is the FAC-14 failure
 *  mode — so the comment is retried once in minimal form before giving up.
 *  `repo` (when the caller knows it) scopes the distilled lesson; contract
 *  failures before repo parsing pass nothing and the lesson stays repo-less. */
export async function markNeedsHuman(issue: linear.Issue, reason: string, repo?: string): Promise<void> {
  bus.emit({ type: "issue_needs_human", issueKey: issue.identifier, reason: redactSecrets(reason).clean.slice(0, 500) });
  try {
    await post(issue, `${linear.SENTINEL}\n\n**needs human** — ${reason}\n\nRemove the \`${linear.NEEDS_HUMAN_LABEL}\` label after fixing to requeue.`);
  } catch (e) {
    console.error(`[${issue.identifier}] needs-human comment failed: ${e}`);
    // Redact the FULL reason before truncating — slicing first can cut a
    // secret in half so post()'s exact-value scrub no longer matches it.
    await post(issue, `${linear.SENTINEL}\n\n**needs human** — ${redactSecrets(reason).clean.slice(0, 500)}`).catch((e2) => console.error(`[${issue.identifier}] minimal needs-human comment failed too: ${e2}`));
  }
  if (!config.dryRun) {
    await linear.addLabel(issue, linear.NEEDS_HUMAN_LABEL).catch((e) => console.error(`[${issue.identifier}] label failed: ${e}`));
  }
  // Distill the intervention into a durable lesson (best-effort, never throws;
  // no-op on dry-run / closed store).
  await captureLesson({ repo: repo ?? "", stage: "triage", issueKey: issue.identifier,
    outcome: "needs_human", reason });
}

/** Post a stage's final output onto the ticket as an audit-trail comment. */
export async function postStageComment(issue: linear.Issue, stage: StageResult): Promise<void> {
  const body = [`\u{1F916} **Stage: ${stage.label}** \u00b7 ${stage.turns} turns \u00b7 ${stage.wallSeconds}s \u00b7 $${stage.costUsd.toFixed(4)}${stage.degraded ? " \u00b7 DEGRADED" : ""}${stage.error ? ` \u00b7 ERROR: ${stage.error.slice(0, 200)}` : ""}`,
    "", stage.text.slice(0, 3000) || "_(no text output)_"].join("\n");
  await post(issue, body).catch((e) => console.error(`[${issue.identifier}] stage comment failed: ${e}`));
}

/** Re-check claim before every mutating side effect. */
async function stillOurs(issue: linear.Issue): Promise<boolean> {
  const fresh = await linear.getIssue(issue.id);
  return fresh.labels.includes(linear.EXECUTING_LABEL) && fresh.stateType === "started";
}

/** External transition detected → abandon cleanly: release + short note (C9). */
async function abortExternal(issue: linear.Issue, stages: StageResult[], where: string): Promise<void> {
  bus.emit({ type: "run_finished", issueKey: issue.identifier, outcome: "aborted",
    reason: `moved externally during ${where}`, prUrl: null,
    costUsd: stages.reduce((s, x) => s + x.costUsd, 0), stages: stages.map(toStageMeta),
    gateStrength: "none", guardedPaths: [], dryRun: config.dryRun });
  console.error(`[${issue.identifier}] externally transitioned during ${where} — abandoning`);
  try { await post(issue, `${linear.SENTINEL}\n\n**Outcome:** aborted — issue was moved externally during ${where}; factory abandoned its attempt (worktree kept).`); }
  catch (e) { console.error(`[${issue.identifier}] abort note failed: ${e}`); }
  if (!config.dryRun) await linear.release(issue);
}

/** Freshness gate verdict "cancel": the ticket's premise is already satisfied —
 *  its goal EXISTS in the world (a merged/closed PR, a path now present, a needle
 *  already gone), so the work is moot. Unlike park (retry later, worktree kept)
 *  this is a terminal RESOLUTION: it comments the flipped premise + evidence,
 *  emits a "stale" outcome, labels Factory-Stale (keeps it out of every fetch
 *  skip-set so it never requeues), moves the ticket to Done, and releases the
 *  claim. Reversible by construction — a human removes the label / reopens to
 *  requeue. NOT park: the goal already exists, so there is nothing for a human
 *  to unblock. */
async function resolveStale(issue: linear.Issue, repo: string, stages: StageResult[], reason: string): Promise<void> {
  void repo; // (kept in the signature for symmetry with park/abortExternal; no repo-scoped lesson — a clean idempotent no-op is not a failure to learn from)
  bus.emit({ type: "run_finished", issueKey: issue.identifier, outcome: "stale",
    reason: redactSecrets(reason).clean.slice(0, 500), prUrl: null,
    costUsd: stages.reduce((s, x) => s + x.costUsd, 0), stages: stages.map(toStageMeta),
    gateStrength: "none", guardedPaths: [], dryRun: config.dryRun });
  console.log(`[${issue.identifier}] stale — freshness premise already satisfied: ${reason}`);
  try {
    await post(issue, `${linear.SENTINEL}\n\n**Outcome:** stale — the ticket's goal already exists in the world; no work was needed.\n\nWhich premise flipped: ${reason}\n\nRemove the \`${linear.STALE_LABEL}\` label (and reopen) to requeue.`);
  } catch (e) {
    console.error(`[${issue.identifier}] stale note failed: ${e}`);
  }
  if (!config.dryRun) {
    await linear.addLabel(issue, linear.STALE_LABEL).catch((e) => console.error(`[${issue.identifier}] stale label failed: ${e}`));
    const moved = await linear.transition(issue, "done");
    if (!moved) await linear.transition(issue, "review").catch(() => {});
    await linear.release(issue);
  }
}

// G2-prereq0: pure decision logic factored out of Budget so it's unit-testable
// without touching control.ts's module-level drain flag. `draining` folds into
// both so every "if (budget.expired) park+return" guard and every
// "!budget.expired" loop/gate condition ALREADY sprinkled through processIssue
// also halts on drain — a human's ONE button must stop spend on an
// already-claimed issue at the next stage boundary, not just stop index.ts
// from claiming new work. Draining is checked first: it always wins over budget.
export function budgetExpired(now: number, deadlineMs: number, remainingUsd: number, draining: boolean): boolean {
  return draining || now > deadlineMs || remainingUsd <= 0;
}
export function budgetExpiredReason(now: number, deadlineMs: number, draining: boolean): string {
  return draining ? "factory is draining (kill switch or spend cap) — halting before the next stage"
    : now > deadlineMs ? "wall-clock cap reached" : "issue budget exhausted";
}

class Budget {
  constructor(private stages: StageResult[], private deadline: number) {}
  get spent(): number { return this.stages.reduce((s, x) => s + x.costUsd, 0); }
  get remainingUsd(): number { return config.caps.budgetUsdPerIssue - this.spent; }
  get deadlineMs(): number { return this.deadline; }
  get expired(): boolean { return budgetExpired(Date.now(), this.deadline, this.remainingUsd, isDraining()); }
  get expiredReason(): string { return budgetExpiredReason(Date.now(), this.deadline, isDraining()); }
}

export async function processIssue(issue: linear.Issue): Promise<void> {
  const missing = missingSections(issue);
  if (missing.length > 0) {
    // Repo may still be parseable even though other required sections are
    // missing (e.g. "## Repo" present, "## Verifications" absent) — thread it
    // through so the lesson stays repo-scoped instead of falling into "".
    await markNeedsHuman(issue, `ticket is missing required sections: ${missing.join(", ")} (see factory docs/ticket-contract.md)`, repoFromTicket(issue.description) ?? undefined);
    return;
  }
  // Per-ticket model override from the factory metadata block (e.g. an epic
  // pins model: claude-fable-5 and the decomposer copies it to each child).
  const ovr = parseFactoryMeta(issue.description).model;
  const implModel = ovr || config.models.implementer;
  const fixModel = ovr || config.models.fixer;
  const repo = repoFromTicket(issue.description);
  if (!repo) {
    await markNeedsHuman(issue, `could not parse a single org/name from the "## Repo" section — never guessing (ROUTE failure contract)`);
    return;
  }

  // Defensive: an issue that became a Factory-Epic between fetchQueue and now
  // (create-then-label race) must go to the planner, never the implementer.
  const preCheck = await linear.getIssue(issue.id).catch(() => null);
  if (preCheck?.labels.includes(linear.EPIC_LABEL)) {
    console.error(`[${issue.identifier}] is a Factory-Epic — skipping implement path (planner will take it)`);
    return;
  }
  if (!config.dryRun && !(await linear.claim(issue))) {
    console.error(`[${issue.identifier}] claim failed or lost race — skipping`);
    return;
  }

  const onEvent = forwardStage(issue.identifier);
  bus.emit({ type: "run_started", issueKey: issue.identifier, title: issue.title, repo, dryRun: config.dryRun });

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
      await park(issue, repo, stages, `workspace: ${error instanceof Error ? error.message : error}`);
      return;
    }

    const deps = ensureDeps(ws);
    if (!deps.ok) { await park(issue, repo, stages, `dependency install failed: ${deps.detail.slice(0, 300)}`); return; }
    const gates = detectGates(ws);
    const baselines = baseline(ws, gates);

    // ---- freshness / idempotency gate (Gap 4): re-validate the ticket's premise
    // against the real world BEFORE the implementer builds — the stillOurs()
    // pattern generalized from claim-freshness to WORLD-freshness. The implicit
    // `undelivered factory/<key>` check stops the FAC-20 shape (grinding on an
    // already merged/closed PR); steward-authored preconditions self-cancel when
    // their premise is already satisfied. Runs against the FRESH base worktree
    // (before any edit), so it tests the real pre-work world. Skipped on dry-run
    // like every other gh/side-effecting gate. cancel → resolveStale (goal
    // already exists → Done); park → human decides (premise can't be confirmed,
    // or is only partially stale). A gh outage on the implicit check fails OPEN
    // (rebuilds), so this can never wrongly freeze the queue.
    if (!config.dryRun) {
      const decision = await checkFreshness(issue.identifier, issue.description, { repo, worktreeDir: ws.dir });
      if (decision.action === "cancel") { await resolveStale(issue, repo, stages, decision.reason); return; }
      if (decision.action === "park") { await park(issue, repo, stages, `freshness: ${decision.reason}`); return; }
    }

    // G2-prereq0: a drain entered while claim/workspace-setup/freshness ran
    // above must stop BEFORE the first (most expensive) stage spends anything —
    // mirrors every other "if (budget.expired) park+return" boundary below.
    if (budget.expired) { await park(issue, repo, stages, budget.expiredReason); return; }

    // ---- implementer
    // Feed-forward lessons: bounded, newest-first heuristics for this repo,
    // prepended to stage prompts as non-authoritative DATA (caps in lessons.ts:
    // ≤5 lessons / ≤1000 chars; "" when none, so prompts are unchanged).
    const lessonsBlock = buildLessonsBlock(lessonsForRepo(repo).map((r) => r.lesson));
    const implPrompt = lessonsBlock + renderPrompt("implementer", { repo, spec },
        `You are the implementer in an automated software factory. Work ONLY inside the current directory (a fresh git worktree of ${repo}). Implement the ticket below. Follow the repo's existing conventions. Sanity-check your work with the repo's own scripts where cheap. Do not create unrelated files; do not touch tests/CI/workflows unless the ticket explicitly asks. When done, reply with a one-paragraph summary of the change.\n\n${spec}`);
    const implOpts = { model: implModel, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", ...WRITER_BASH], maxTurns: config.caps.turnsImplementer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent,
      onSessionId: (id: string) => recordStageSession(issue.identifier, "implementer", id) };
    // Resume an interrupted implementer: a lingering session row means the prior
    // run was cut off mid-build (process killed) — pick up its actual conversation
    // rather than starting over. Falls back to a fresh session if resume fails
    // (e.g. an evicted session or the proxy-resume path).
    const priorSession = getStageSession(issue.identifier, "implementer");
    if (priorSession) console.log(`[${issue.identifier}] resuming interrupted implementer session`);
    let implementer = await runStage("implementer", implPrompt, { ...implOpts, ...(priorSession ? { resume: priorSession } : {}) });
    if (priorSession && implementer.error) {
      console.error(`[${issue.identifier}] resume failed (${implementer.error}); retrying fresh`);
      implementer = await runStage("implementer", implPrompt, implOpts);
    }
    clearStageSession(issue.identifier, "implementer"); // stage returned → not cut off
    stages.push(implementer);
    await postStageComment(issue, implementer);
    if (implementer.error) { await park(issue, repo, stages, `implementer: ${implementer.error}`); return; }
    // Resume-safe: a prior attempt may have committed the work before failing a
    // later step (e.g. transient diff). Only park if there is genuinely nothing
    // — neither a fresh commit this run nor prior commits ahead of base.
    if (!commitAll(ws, `${issue.identifier}: implement ${issue.title}`) && !hasCommitsAheadOfBase(ws)) { await park(issue, repo, stages, "implementer produced no committable changes"); return; }
    if (budget.expired) { await park(issue, repo, stages, budget.expiredReason); return; }
    if (!config.dryRun && !(await stillOurs(issue))) { await abortExternal(issue, stages, "implementation"); return; }

    // ---- adversarial review: framing-stripped (spec + diff ONLY), tool-less
    let diff: string;
    try { diff = diffAgainstBase(ws); }
    catch (error) { await park(issue, repo, stages, `diff failed: ${error instanceof Error ? error.message : error}`); return; }

    const reviewPrompt = (lens: string) =>
      `You are an adversarial code reviewer in an automated pipeline. Assume the change is BROKEN until proven otherwise. Lens: ${lens}. You get ONLY the ticket and the diff — no author reasoning. For each real problem: exact input/scenario that fails, expected vs actual, responsible hunk. No praise. If nothing after genuine effort: NO-FINDINGS.\n\n${spec}\n\n<diff>\n${diff.slice(0, 180_000)}\n</diff>`;

    const clampedDiff = diff.slice(0, 180_000);
    const repoLens = "blast radius and integration — you have READ-ONLY access to the full repo worktree (Read/Glob/Grep): hunt for callers this diff breaks, dependencies and imports it misses, existing utilities it needlessly duplicates, repo conventions it violates, and tests that should exist for it. Verify suspicions against the actual code, never guess";
    const [reviewClaude, reviewCodexTry] = await Promise.all([
      runStage("reviewer-claude", lessonsBlock + renderPrompt("reviewer-spec", { spec, diff: clampedDiff }, reviewPrompt("spec compliance and correctness — walk every ticket requirement")),
        { model: config.models.reviewerClaude, cwd: reviewerScratch, maxTurns: config.caps.turnsReviewer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent }),
      runStage("reviewer-repo", lessonsBlock + renderPrompt("reviewer-repo", { spec, diff: clampedDiff }, reviewPrompt(repoLens)),
        { model: config.models.reviewerCodex, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git show:*)"], maxTurns: config.caps.turnsReviewer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent }),
    ]);
    let reviewCodex = reviewCodexTry;
    if (reviewCodex.error || !reviewCodex.text.trim()) {
      reviewCodex = await runStage("reviewer-fallback", lessonsBlock + renderPrompt("reviewer-repo", { spec, diff: clampedDiff }, reviewPrompt(repoLens)),
        { model: config.models.reviewerClaude, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git show:*)"], maxTurns: config.caps.turnsReviewer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent });
      reviewCodex.degraded = true;
    }
    stages.push(reviewClaude, reviewCodex);
    await postStageComment(issue, reviewClaude);
    await postStageComment(issue, reviewCodex);
    if (budget.expired) { await park(issue, repo, stages, budget.expiredReason); return; }

    // ---- fixer (fresh context; reviewer output is untrusted too — M6)
    const fixer = await runStage("fixer",
      renderPrompt("fixer", { spec, reviews: untrusted(`REVIEW 1:\n${reviewClaude.text}\n\nREVIEW 2:\n${reviewCodex.text}`) },
        `You are the fixer in an automated pipeline. Two independent reviewers examined the latest change in this worktree against the ticket. Evaluate each finding, fix the real ones, reject ones that contradict the ticket. Never weaken or delete tests. Sanity-check with the repo's own scripts. Reply with one line per finding: fixed / rejected (why).\n\n${spec}\n\n${untrusted(`REVIEW 1:\n${reviewClaude.text}\n\nREVIEW 2:\n${reviewCodex.text}`)}`),
      { model: fixModel, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Edit", ...WRITER_BASH], maxTurns: config.caps.turnsFixer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent });
    stages.push(fixer);
    await postStageComment(issue, fixer);
    if (fixer.error) { await park(issue, repo, stages, `fixer: ${fixer.error}`); return; }
    commitAll(ws, `${issue.identifier}: apply review feedback`);
    if (budget.expired) { await park(issue, repo, stages, budget.expiredReason); return; }
    if (!config.dryRun && !(await stillOurs(issue))) { await abortExternal(issue, stages, "review"); return; }

    // ---- design review (taste gate): UI diffs are held to a taste bar, not
    // just correctness. Read-only reviewer against docs/design-language.md + the
    // juice rubric; a persistent TASTE: fail forces human review and is NEVER
    // auto-merged, even on allowlisted repos (tasteFindings folds into needsHuman).
    let tasteFindings: string | null = null;
    if (uiFilesTouched(ws).length > 0 && !budget.expired) {
      let designDiff = "";
      try { designDiff = diffAgainstBase(ws); } catch { designDiff = ""; }
      const designReviewPrompt = () => renderPrompt("design-reviewer", { spec, diff: designDiff.slice(0, 180_000) },
        `You are the design reviewer — the taste gate — with READ-ONLY worktree access (Read/Glob/Grep). Judge this UI change against docs/design-language.md and (for interactive/game-like work) skills/game-feel/SKILL.md. Reject template-default soup and any interactive screen that could be a plain form or list with no loss. For each problem: a numbered finding with the exact file and a concrete fix. End with exactly one line — "TASTE: pass" or "TASTE: fail" — followed by a one-sentence reason.\n\n${spec}\n\n<diff>\n${designDiff.slice(0, 180_000)}\n</diff>`);
      const tastePasses = (r: StageResult): boolean => r.error !== undefined || !/TASTE:\s*fail/i.test(r.text);
      // Up to caps.tasteRounds review passes (labels design-reviewer, design-reviewer-2, …);
      // a design-fixer round runs between failing passes (design-fixer, design-fixer-2, …).
      // Budget/deadline is checked before each stage and each iteration; when the rounds
      // are exhausted still failing, tasteFindings folds into the needsHuman path below.
      const maxTasteRounds = Math.max(1, config.caps.tasteRounds);
      let design = await runStage("design-reviewer", designReviewPrompt(),
        { model: config.models.designReviewer, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git show:*)"], maxTurns: config.caps.turnsReviewer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent });
      stages.push(design);
      await postStageComment(issue, design);
      for (let round = 1; round < maxTasteRounds && !tastePasses(design) && !budget.expired; round++) {
        const designFix = await runStage(round === 1 ? "design-fixer" : `design-fixer-${round}`,
          `You are the fixer in an automated pipeline, addressing the design/taste review of a UI change in this worktree. Apply the findings below as real moves — motion, feedback, density, distinctiveness — not renames. Follow docs/design-language.md and skills/game-feel/SKILL.md. Never weaken or delete tests. Sanity-check with the repo's own scripts. Reply with one line per finding: fixed / rejected (why).\n\n${spec}\n\n${untrusted(`DESIGN REVIEW (taste gate) — address these:\n${design.text}`)}`,
          { model: fixModel, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Edit", ...WRITER_BASH], maxTurns: config.caps.turnsFixer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent });
        stages.push(designFix);
        await postStageComment(issue, designFix);
        commitAll(ws, `${issue.identifier}: apply design-review feedback (round ${round})`);
        try { designDiff = diffAgainstBase(ws); } catch { /* keep prior diff */ }
        if (budget.expired) break;
        design = await runStage(`design-reviewer-${round + 1}`, designReviewPrompt(),
          { model: config.models.designReviewer, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git show:*)"], maxTurns: config.caps.turnsReviewer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent });
        stages.push(design);
        await postStageComment(issue, design);
      }
      if (!tastePasses(design)) tasteFindings = design.text.slice(0, 1500);
      if (!config.dryRun && !(await stillOurs(issue))) { await abortExternal(issue, stages, "design review"); return; }
    }

    // ---- verify (baselined) with bounded, budgeted, deadlined repair rounds
    let results = verify(ws, gates, baselines);
    let summary = gateSummary(results);
    bus.emit({ type: "run_gates", issueKey: issue.identifier, round: 0,
      green: summary.green, strength: summary.strength,
      gates: results.map((g) => ({ name: g.name, baselinePassed: g.baselinePassed, passed: g.passed,
        outputTail: g.passed === false ? redactSecrets(g.output).clean.slice(-400) : "" })) });
    for (let i = 0; !summary.green && i < config.caps.verifierIterations && !budget.expired; i++) {
      const repair = await runStage(`verify-repair-${i + 1}`,
        `Gates are failing in this worktree. Fix ONLY what the failures indicate — never weaken or delete tests (that requires a human). Failures:\n${summary.failures.map((f) => `## ${f.name}\n${f.output}`).join("\n")}`,
        { model: fixModel, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", "Edit", ...WRITER_BASH], maxTurns: config.caps.turnsFixer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent });
      stages.push(repair);
    await postStageComment(issue, repair);
      commitAll(ws, `${issue.identifier}: fix gate failures (round ${i + 1})`);
      results = verify(ws, gates, baselines);
      summary = gateSummary(results);
      bus.emit({ type: "run_gates", issueKey: issue.identifier, round: i + 1,
        green: summary.green, strength: summary.strength,
        gates: results.map((g) => ({ name: g.name, baselinePassed: g.baselinePassed, passed: g.passed,
          outputTail: g.passed === false ? redactSecrets(g.output).clean.slice(-400) : "" })) });
    }
    if (!summary.green) { await park(issue, repo, stages, budget.expired ? budget.expiredReason : `gates still failing after ${config.caps.verifierIterations} repair rounds`); return; }

    // ---- tester (after gates): executes the ticket's ## Verifications and drives
    // the app in a browser. Gap 2 makes this REQUIRED, not just ticket-opt-in:
    // whenever the REPO has a UI surface it can drive with Playwright, browser
    // evidence must exist or the merge ladder sees "missing" and blocks auto-merge
    // (a PR still opens for a human — it degrades, never parks). An explicit
    // VERDICT: fail folds into needsHuman below.
    let verificationReport: string | null = null;
    let browser: BrowserEvidence = requiresBrowserEvidence(ws) ? "missing" : "not-required";
    if ((requiresBrowserEvidence(ws) || wantsBrowserVerification(issue.description)) && hasPlaywright(ws) && !budget.expired) {
      const tester = await runStage("tester",
        renderPrompt("tester", { spec, playwright: "Playwright IS installed in this repo — use it for browser/visual items." },
          `You are the verification agent. Execute the ticket's ## Verifications section against this worktree and report what actually happened (evidence, not opinion); do not edit source. Automated items: run the repo's own scripts via Bash. Visual/browser items: Playwright IS installed — drive the screen(s) and report what you observe. Manual items: state they need a human. End with exactly one line: "VERDICT: pass", "VERDICT: partial", or "VERDICT: fail".\n\n${spec}`),
        { model: config.models.tester, cwd: ws.dir, allowedTools: ["Read", "Glob", "Grep", ...WRITER_BASH], maxTurns: config.caps.turnsFixer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent });
      stages.push(tester);
      await postStageComment(issue, tester);
      verificationReport = tester.text.slice(0, 2000);
      browser = mapBrowserEvidence(requiresBrowserEvidence(ws), tester.text);
    }
    const testerFail = browser === "fail";

    // ---- security review (Gap 2): a read-only, cross-vendor pass over the FINAL
    // diff + ticket (both untrusted — no author reasoning, no merge authority
    // from ticket text) on non-trivial changes. Ends "SECURITY: pass|fail"; a
    // fail folds into needsHuman below and blocks auto-merge. The stage can leave
    // securityVerdict null when it was WARRANTED but never completed — budget
    // expiry in this window, or a stage error. A null verdict must NOT reach the
    // merge decision as "not a fail" and slip past decideMerge (which only blocks
    // on "fail"): a warranted-but-absent security pass folds into needsHuman below
    // (fail-closed for the merge ACTION), so the PR still opens for a human rather
    // than auto-merging a large diff with the gate silently skipped. The pipeline
    // itself degrades (PR opens), never parks, on an absent verdict.
    let finalDiff = "";
    try { finalDiff = diffAgainstBase(ws); } catch { finalDiff = ""; }
    const diffLines = countDiffLines(finalDiff);
    let securityVerdict: "pass" | "fail" | null = null;
    if (diffLines >= SECURITY_REVIEW_MIN_DIFF_LINES && !budget.expired) {
      const clampedSecDiff = untrusted(finalDiff.slice(0, 180_000));
      const security = await runStage("security-reviewer",
        renderPrompt("security-reviewer", { spec, diff: clampedSecDiff },
          `You are a security reviewer in an automated pipeline. You get ONLY the ticket and the diff — assume nothing about author intent. Hunt ONLY for vulnerabilities THIS diff introduces: injection (SQL/command/prompt), secret or credential leakage, auth/authz bypass, path traversal, SSRF, unsafe deserialization, and privilege escalation. For each real issue: the exact scenario, the impact, the responsible hunk. No praise; if nothing after genuine effort, say so. End with exactly one line — "SECURITY: pass" or "SECURITY: fail".\n\n${spec}\n\n<diff>\n${clampedSecDiff}\n</diff>`),
        { model: config.models.securityReviewer, cwd: reviewerScratch, maxTurns: config.caps.turnsReviewer, budgetUsd: budget.remainingUsd, deadlineMs: budget.deadlineMs, onEvent });
      stages.push(security);
      await postStageComment(issue, security);
      securityVerdict = security.error ? null : parseSecurityVerdict(security.text);
    }

    // ---- deliver (guarded paths / test deletion stop auto-advance — C17)
    const removedTests = testFilesRemoved(ws);
    if (removedTests.length > 0) { await park(issue, repo, stages, `change DELETES test files (${removedTests.join(", ")}) — categorical human review`); return; }
    const guarded = guardedPathsTouched(ws);
    if (!config.dryRun && !(await stillOurs(issue))) { await abortExternal(issue, stages, "delivery"); return; }

    let prUrl: string | null = null;
    if (!config.dryRun) {
      pushBranch(ws);
      const prBody = redactSecrets(`Closes ${issue.identifier} — ${issue.url}\n\n${implementer.text}\n\n🤖 Generated by the software factory; every PR is human-merged (plan v0.2).`).clean;
      prUrl = createPr(ws, `${issue.identifier}: ${issue.title}`, prBody);
    }

    // needsHuman folds every "PR opens but a human must advance it" cause into
    // one gate: guarded paths (C17), a persistent taste-gate fail, an explicit
    // tester FAIL, a security-review FAIL, or a WARRANTED-but-absent security pass
    // (a non-trivial diff whose security review never completed — budget expiry or
    // stage error left securityVerdict null). Any of them blocks auto-merge even
    // on enrolled repos. The security-absent fold is fail-closed for the merge
    // action: without it, a null verdict slips past decideMerge (which blocks only
    // on "fail"), letting an earned auto tier merge a large diff with the security
    // gate silently skipped — the exact gate Gap 2 introduced.
    const guardedStop = guarded.length > 0 || guarded.includes(DIFF_FAILED);
    const securityWarrantedButAbsent = securityReviewOutstanding(diffLines, securityVerdict);
    const holdReasons: string[] = [];
    if (guardedStop) holdReasons.push(`guarded paths touched: ${guarded.join(", ")}`);
    if (tasteFindings) holdReasons.push("design taste gate failed (see design review)");
    if (testerFail) holdReasons.push("verification agent returned an explicit FAIL verdict");
    if (securityVerdict === "fail") holdReasons.push("security review returned a FAIL verdict");
    if (securityWarrantedButAbsent) holdReasons.push(`security review did not complete on a ${diffLines}-line diff (${budget.expired ? budget.expiredReason : "stage error"}) — cannot auto-merge unreviewed`);
    const needsHuman = holdReasons.length > 0;
    const holdReason = holdReasons.join("; ");

    // ---- evidence-gated merge decision (Gap 2). Built from VERIFICATION
    // EVIDENCE only — gate summary, guarded paths, needsHuman folds, security and
    // browser signals, diff size. issue.description is NOT an input, so untrusted
    // ticket text can never grant merge authority. The effective tier is the
    // repo's EARNED tier capped by config/self-repo (factory.ai → human always).
    const tier = effectiveMergeTier(repo, getLadderState(repo));
    const ev = buildMergeEvidence({ summary, guarded, needsHuman, security: securityVerdict, browser, diffLines });
    const baseDecision = decideMerge(tier, ev, { lowRiskMaxDiff: config.mergeLadder.lowRiskMaxDiff });
    // Gap-1 interaction: a child that declares dependencies must NOT auto-merge
    // out of order — the steward owns epic merge ordering. Standalone tickets only.
    const hasDeps = (parseFactoryMeta(issue.description).depends_on ?? []).length > 0;
    const deferForDeps = hasDeps && baseDecision.act;
    const decision: MergeDecision = {
      wouldMerge: baseDecision.wouldMerge, tier: baseDecision.tier,
      act: baseDecision.act && !hasDeps && prUrl !== null,
      reasons: deferForDeps ? [...baseDecision.reasons, "deferred: ticket declares depends_on (steward owns epic merge ordering)"] : baseDecision.reasons,
    };

    const report = buildReport({
      issueKey: issue.identifier, prUrl,
      outcome: needsHuman ? "needs_human" : "pr_open",
      reason: needsHuman ? holdReason : undefined,
      stages, gates: results, gateStrength: summary.strength, guardedPaths: guarded,
      reviewFindingsSummary: fixer.text.slice(0, 1500),
      ...(tasteFindings ? { designReview: tasteFindings } : {}),
      ...(verificationReport ? { verification: verificationReport } : {}),
    });

    // Gap-4: re-validate the premise before recording an earning decision or
    // merging — a PR a human closed/merged since createPr must never advance the
    // streak or be re-merged. Runs before the single run_finished emit so a stale
    // premise yields exactly one (aborted) terminal event, not two.
    if (!config.dryRun && !(await stillOurs(issue))) { await abortExternal(issue, stages, "merge decision"); return; }

    bus.emit({ type: "run_finished", issueKey: issue.identifier,
      outcome: needsHuman ? "needs_human" : "pr_open",
      ...(needsHuman ? { reason: holdReason.slice(0, 500) } : {}),
      prUrl, costUsd: stages.reduce((s, x) => s + x.costUsd, 0),
      stages: stages.map(toStageMeta), gateStrength: summary.strength, guardedPaths: guarded,
      dryRun: config.dryRun, securityVerdict, browser });

    // Distill the human-gate fold into a durable lesson (best-effort, never
    // throws; no-op on dry-run / closed store). A persistent taste-gate fail is
    // its own outcome so the lesson names the design failure, not just "held".
    if (needsHuman) {
      await captureLesson({ repo, issueKey: issue.identifier,
        stage: tasteFindings ? "design-reviewer" : "deliver",
        outcome: tasteFindings ? "taste_fail" : "needs_human",
        reason: holdReason,
        ...(tasteFindings ? { tasteFindings } : {}) });
    }

    // Comment is best-effort; transition/release are guaranteed (C10). On a
    // needs_human hold, a failed report still gets a minimal reason-only
    // fallback comment — the label must never appear without its WHY (FAC-14).
    try { await post(issue, report); } catch (e) {
      console.error(`[${issue.identifier}] report post failed: ${e}`);
      // Redact the FULL reason before truncating (see markNeedsHuman above).
      if (needsHuman) await post(issue, `${linear.SENTINEL}\n\n**needs human** — ${redactSecrets(holdReason).clean.slice(0, 500)}`).catch((e2) => console.error(`[${issue.identifier}] minimal needs-human comment failed too: ${e2}`));
    }
    if (!config.dryRun) {
      // ALWAYS record the shadow decision (audit + earning) — a dirty run resets
      // the clean streak, so this must run even on the needs_human path.
      const state = recordShadowDecision(repo, issue.identifier, decision, ev);
      bus.emit({ type: "merge_decision", issueKey: issue.identifier, repo, tier,
        wouldMerge: decision.wouldMerge, acted: decision.act, strength: ev.strength,
        browser, security: securityVerdict, cleanStreak: state.cleanStreak, reasons: decision.reasons });
      if (needsHuman) {
        await linear.addLabel(issue, linear.NEEDS_HUMAN_LABEL).catch(() => {});
      } else if (decision.act && prUrl) {
        // The repo has EARNED an auto-merge tier and every gate is strong+clean.
        const merged = mergePr(repo, prUrl);
        if (merged.ok) {
          await post(issue, `${linear.SENTINEL}\n\n**Auto-merged** (merge ladder · tier ${tier}): ${prUrl}`).catch(() => {});
          const moved = await linear.transition(issue, "done");
          if (!moved) await linear.transition(issue, "review").catch(() => {});
        } else {
          await post(issue, `${linear.SENTINEL}\n\n**Auto-merge failed** (${merged.out}) — falling back to human review: ${prUrl}`).catch(() => {});
          await linear.transition(issue, "review").catch(() => {});
        }
      } else {
        const moved = await linear.transition(issue, "review");
        if (!moved) console.error(`[${issue.identifier}] no review-type state on team — left in working state`);
        // Shadow tier: the repo is still EARNING — surface the would-merge note so
        // the owner can watch the streak build toward auto-low-risk.
        if (tier === "shadow" && prUrl) {
          await post(issue, `${linear.SENTINEL}\n\n**Shadow merge decision** — would-merge=${decision.wouldMerge}${decision.reasons.length ? ` (${decision.reasons.join("; ")})` : ""}. This repo is EARNING auto-merge: clean streak ${state.cleanStreak}/${config.mergeLadder.promoteAfter}. A human merges ${prUrl}.`).catch(() => {});
        }
      }
      await linear.release(issue);
    }
    console.log(`[${issue.identifier}] ${needsHuman ? `needs_human (${holdReason})` : "pr_open"} ${prUrl ?? "(dry-run)"}`);
  } catch (error) {
    await park(issue, repo, stages, error instanceof Error ? error.message : String(error));
  }
}

/** Bounded retry with exponential backoff for a single side-effecting mutation.
 *  B3: a Linear outage mid-run must not strand a ticket — park()'s own
 *  mutations (label / transition / release) used to be one-shot `.catch(() =>
 *  {})`, so an outage that lines up with the SAME park() call that reports it
 *  also swallows every attempt to record the park, leaving the ticket
 *  Executing-labeled and invisible until a human notices or the daemon
 *  restarts. `sleep` is injectable so tests never wait on a real timer; the
 *  default schedule (3 attempts, 1s/2s backoff) absorbs a transient blip
 *  without holding up the pipeline for long. Never throws — total exhaustion
 *  is reported via the returned `ok:false`, not an exception, so callers
 *  decide how loudly to surface it. */
export async function retryMutation(
  fn: () => Promise<unknown>,
  opts: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError = "unknown error";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fn();
      return { ok: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts - 1) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  return { ok: false, error: lastError };
}

async function park(issue: linear.Issue, repo: string, stages: StageResult[], reason: string): Promise<void> {
  // Caps and failures PARK, never destroy: worktree kept, Factory-Parked label
  // keeps it out of the queue until a human clears it (C6); comment best-effort,
  // label/release guaranteed (C10). `repo` is threaded in from processIssue so
  // the distilled lesson is repo-scoped (run_finished doesn't carry repo).
  const input: ReportInput = {
    issueKey: issue.identifier, prUrl: null, outcome: "parked", reason,
    stages, gates: [], gateStrength: "none", guardedPaths: [],
  };
  bus.emit({ type: "run_finished", issueKey: issue.identifier, outcome: "parked",
    reason: redactSecrets(reason).clean.slice(0, 500), prUrl: null,
    costUsd: stages.reduce((s, x) => s + x.costUsd, 0), stages: stages.map(toStageMeta),
    gateStrength: "none", guardedPaths: [], dryRun: config.dryRun });
  // The full report carries the park reason onto the ticket. If it fails to
  // post, fall back to a minimal reason-only comment — a Factory-Parked label
  // with no visible WHY is the FAC-14 failure mode (reason stranded in SQLite).
  try { await post(issue, buildReport(input)); } catch (e) {
    console.error(`[${issue.identifier}] park report failed: ${e}`);
    // Redact the FULL reason before truncating (see markNeedsHuman above).
    await post(issue, `${linear.SENTINEL}\n\n**Outcome:** parked — ${redactSecrets(reason).clean.slice(0, 500)}`).catch((e2) => console.error(`[${issue.identifier}] minimal park comment failed too: ${e2}`));
  }
  if (!config.dryRun) {
    // B3: retry each mutation with bounded backoff before giving up — an outage
    // that swallows all three .catch(()=>{})s used to strand the ticket
    // Executing-labeled with no Parked label, invisible until a restart.
    const labelResult = await retryMutation(() => linear.addLabel(issue, linear.PARKED_LABEL));
    const transitionResult = await retryMutation(() => linear.transition(issue, "queue"));
    const releaseResult = await retryMutation(() => linear.removeLabel(issue, linear.EXECUTING_LABEL));
    const failures = [
      ...(labelResult.ok ? [] : [`Parked label: ${labelResult.error}`]),
      ...(transitionResult.ok ? [] : [`queue transition: ${transitionResult.error}`]),
      ...(releaseResult.ok ? [] : [`Executing-label release: ${releaseResult.error}`]),
    ];
    if (failures.length > 0) {
      // Every retry was exhausted — the ticket may be STRANDED (still
      // Executing-labeled and/or not visibly Parked). Log loudly with a
      // greppable prefix AND put it on the bus (alerts.ts always alerts on
      // this) so it is observable instead of silently lost — the runtime
      // orphan sweep (index.ts) and startup recoverOrphanedClaims are the
      // eventual self-heal for the Executing-label half of this.
      const redactedFailures = failures.map((f) => redactSecrets(f).clean.slice(0, 300));
      console.error(`[${issue.identifier}] STRANDED: park mutations failed after retries — ${redactedFailures.join("; ")}`);
      bus.emit({ type: "park_mutation_failed", issueKey: issue.identifier, failures: redactedFailures });
    }
  }
  console.error(`[${issue.identifier}] parked: ${reason}`);
  // Distill the park into a durable, repo-scoped lesson (best-effort, never
  // throws; no-op on dry-run / closed store).
  const failed = stages.filter((s) => s.error !== undefined);
  await captureLesson({ repo, stage: stages.at(-1)?.label ?? "pipeline",
    issueKey: issue.identifier, outcome: "parked", reason,
    ...(failed.length > 0 ? { stageErrors: failed.map((s) => `${s.label}: ${s.error}`) } : {}) });
}
