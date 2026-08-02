import { bus } from "./events.ts";
import { redactSecrets } from "./agents.ts";
import * as linear from "./linear.ts";
import { mergePr as realMergePr, prHeadSha as realPrHeadSha } from "./repos.ts";
import { postMergeTick } from "./postmerge.ts";
import { notifyApproval, type ApprovalNotice } from "./notify.ts";
import {
  insertApproval, pendingApprovalsPage, getApproval,
  claimApproval, finalizeApproval, recordPushbackFeedback,
  type ApprovalItem, type ApprovalGateTests, type ApprovalStatus,
} from "./db.ts";

// Approvals inbox — the server side of the human review lane (stream:
// inbox-backend). A run that ends ROUTED TO A HUMAN with an open PR becomes
// one actionable item; the two actions a human can take on it are:
//
//   approve  → the ONE new merge authority this feature adds. It still merges
//              through the EXISTING mergePr path, squash, pinned with
//              --match-head-commit to the gated head SHA — the exact commit
//              the evidence ran against. Freshness is re-verified first
//              (gh pr view headRefOid); a branch that moved since gating is
//              REFUSED and the item marked stale ("needs re-gate"), never
//              merged. GitHub's atomic pin is the backstop for the TOCTOU
//              window between the check and the merge.
//   pushback → never merges anything. Posts the owner's feedback onto the
//              Linear ticket (clearly marked OWNER FEEDBACK), stores it for
//              the issue's next run (loop.ts injects it into the
//              implementer/fixer prompts as untrusted-but-authoritative
//              direction), and requeues the issue through the EXISTING
//              mechanism (drop the hold labels, transition back to queue) so
//              the pipeline runs a full fix round. The feedback is prompt
//              text only — it never touches the issue DESCRIPTION, so
//              parseFactoryMeta / GATE_STAGES model+effort pinning (meta.ts)
//              cannot be altered by it.
//
// TIGHTEN-ONLY invariants (pinned in tests/approvals.test.ts):
//   - approve NEVER merges when the PR head != the gated SHA (or when no
//     gated SHA was recorded at all);
//   - approve NEVER merges evidence the caller did not see: the request
//     carries the gated SHA its card rendered, and a row that has since been
//     superseded (a re-run files a fresh one) refuses with "card out of date";
//   - pushback has no merge dep — it structurally cannot merge;
//   - both actions act only on a `pending` row claimed via ONE atomic
//     conditional UPDATE (db.ts claimApproval), so a double-click cannot
//     double-merge and a run outside the human lane (merged / parked / no PR
//     — which never files a row) cannot be flipped by any endpoint;
//   - self-repo items ARE approvable — that is precisely "a human merging" —
//     but the merge still goes through mergePr pinned like every other;
//   - decideMerge / merge-ladder.ts are never consulted or modified here:
//     human approval is a parallel authority over the human lane only, not a
//     tier change.
//
// Deps are injectable (postmerge.ts DeployDeps pattern) so every decision
// sequence is unit-testable without gh/Linear; production wires the real
// modules below. Endpoint results are { status, json } like catalog-manager's
// saveCatalogEntry so server.ts stays a thin router.

const FEEDBACK_MAX_CHARS = 4000;
const HOLD_REASONS_MAX_CHARS = 1500;
const FINDINGS_MAX_CHARS = 1500;

export type { ApprovalItem, ApprovalStatus };

export interface ApprovalActionResult { status: number; json: Record<string, unknown> }

// ---------------------------------------------------------------------------
// Filing (called from loop.ts at delivery).
// ---------------------------------------------------------------------------

/** The human-lane rule, kept pure so a test pins it: an approval item exists
 *  exactly when a run left a PR OPEN that no auto-merge closed — outcome
 *  needs_human or pr_open. Merged runs, parks/aborts/stales (no PR) file
 *  nothing, which is the first half of the "no endpoint can flip a
 *  non-human-lane run" invariant (the second half is the pending-row claim). */
export function shouldFileApproval(prUrl: string | null, mergedOk: boolean): boolean {
  return prUrl !== null && prUrl !== "" && !mergedOk;
}

/** Does this run's hold record a FAILED pre-merge re-gate against the combined
 *  head? loop.ts preMergeIntegrity updates a behind-main branch with main and
 *  re-runs the gates; when that combination comes back red the branch is never
 *  pushed, so the PR head is still the ORIGINAL gated commit — approve's
 *  freshness check passes and the card's stored gateSummary still reads green.
 *  It is green: against an obsolete main. A human reading only that strip would
 *  merge a combination the factory already proved broken, so the item carries
 *  this as its own flag and the card shouts it. Matched on loop.ts's phrasing —
 *  the same marker-string coupling ui/src/lib/history.ts classifyOutcome uses;
 *  rewording the hold there means updating the marker here (pinned by a test
 *  that quotes the live string). */
export function regateFailedAgainstMain(holdReasons: string): boolean {
  return holdReasons.includes("gates FAILED against the combined head");
}

export interface ApprovalInput {
  issueKey: string;
  title: string;
  repo: string;
  prUrl: string;
  gatedHeadSha: string | null;
  holdReasons: string;
  gateSummary: { green: boolean; strength: string; tests: ApprovalGateTests[] } | null;
  securityVerdict: string;
  tasteVerdict: string;
  findingsDigest: string;
  diffStat: string;
  costUsd: number;
  turns: number;
}

/** Persist one approval item (superseding a prior pending one for the same
 *  issue), emit approval_created, and fire the one-per-item owner
 *  notification. Best-effort by contract: a closed store or notify failure
 *  must never throw into the delivery path — the PR and Linear comment remain
 *  the fallback surface. Every free-text field is redacted+capped HERE, the
 *  one write seam, even though holdReasons/findings arrive pre-redacted from
 *  loop.ts (defence in depth — same posture as post()). `notify` is injectable
 *  (the DeployDeps pattern) so tests can assert what leaves for the desktop
 *  without spawning osascript. */
export async function fileApproval(input: ApprovalInput, notify: (notice: ApprovalNotice) => void = notifyApproval): Promise<number | null> {
  try {
    const clean = (s: string, cap: number): string => redactSecrets(s).clean.slice(0, cap);
    const title = clean(input.title, 300);
    const id = await insertApproval({
      issueKey: input.issueKey,
      title,
      repo: input.repo,
      prUrl: input.prUrl,
      gatedHeadSha: input.gatedHeadSha,
      holdReasons: clean(input.holdReasons, HOLD_REASONS_MAX_CHARS),
      gateSummary: input.gateSummary,
      securityVerdict: input.securityVerdict,
      tasteVerdict: input.tasteVerdict,
      findingsDigest: clean(input.findingsDigest, FINDINGS_MAX_CHARS),
      diffStat: clean(input.diffStat, 200),
      costUsd: input.costUsd,
      turns: input.turns,
      // Derived from the hold text at the single write seam, so ANY caller that
      // files this hold gets the flag — no second place to keep in sync.
      regateFailed: regateFailedAgainstMain(input.holdReasons),
    });
    if (id === null) return null; // store closed (--once) — nothing durable to act on later
    const holdReasons = clean(input.holdReasons, 300);
    bus.emit({ type: "approval_created", issueKey: input.issueKey, approvalId: id, prUrl: input.prUrl, holdReasons });
    // The REDACTED/clamped title, like holdReasons: a ticket title is untrusted
    // Linear text on its way into an AppleScript literal, and notify.ts's own
    // sanitizer neutralizes syntax, not secrets.
    notify({ id, issueKey: input.issueKey, title, holdReasons });
    return id;
  } catch (error) {
    console.error(`[approvals] filing item for ${input.issueKey} failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/** GET /approvals payload: full pending cards + the nav-badge count. ONE query
 *  (db.ts pendingApprovalsPage) rather than a list read plus a count read, so
 *  the badge can never disagree with the rows next to it. */
export async function approvalsView(): Promise<{ pending: ApprovalItem[]; count: number }> {
  return pendingApprovalsPage();
}

// ---------------------------------------------------------------------------
// Approve — the human merge authority.
// ---------------------------------------------------------------------------

export interface ApproveDeps {
  getApproval: (id: number) => Promise<ApprovalItem | null>;
  claimApproval: (id: number, to: Exclude<ApprovalStatus, "pending">) => Promise<boolean>;
  finalizeApproval: (id: number, status: ApprovalStatus, resolution: string) => Promise<void>;
  prHeadSha: (repo: string, prUrl: string) => string | null;
  mergePr: (repo: string, prUrl: string, matchHeadSha: string) => { ok: boolean; out: string; headMoved: boolean };
  getIssue: (key: string) => Promise<linear.Issue>;
  postComment: (issue: linear.Issue, body: string) => Promise<void>;
  /** The SAME closeout the auto-merge path runs (linear.ts
   *  transitionAfterMerge: done, review fallback) — shared, not duplicated. */
  transitionAfterMerge: (issue: linear.Issue) => Promise<void>;
  removeLabel: (issue: linear.Issue, name: string) => Promise<void>;
  /** The normal post-merge handling (deploy/smoke/revert tick) — exactly-once
   *  guarded internally by claimDeploy's atomic INSERT, so calling it right after
   *  a human merge is safe and just makes the deploy prompt instead of next-tick. */
  postMerge: () => Promise<void>;
}

const STALE_BRANCH_MOVED = "branch moved since gating — needs re-gate";
const CARD_OUT_OF_DATE = "this card is out of date — the evidence shown was filed against a different gated head SHA than the item now carries; refresh the queue and re-read it before approving";

/** Normalize a gated head SHA for comparison: absent/blank/non-string → null,
 *  otherwise lowercased and trimmed (GitHub and git print different cases). */
function normalizeSha(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return s === "" ? null : s;
}

/** Is the SHA the human's card RENDERED still the one the item carries?
 *
 *  An approve request is consent to merge SPECIFIC EVIDENCE, not consent to
 *  merge whatever row id 41 happens to hold now. A re-run supersedes the row
 *  and files a fresh one (db.ts insertApproval), so a card left open in a tab
 *  can name a commit and a hold reason that no longer describe the item behind
 *  the button. Binding the request to the rendered SHA makes that a refusal
 *  instead of a merge of unread evidence. Absent on ONE side only is a mismatch
 *  too (tighten-only: ambiguity resolves toward refusing); absent on BOTH is
 *  the no-gated-SHA item, which approve refuses further down anyway. */
export function approvalEvidenceMatches(requested: unknown, current: string | null): boolean {
  return normalizeSha(requested) === normalizeSha(current);
}

const defaultApproveDeps: ApproveDeps = {
  getApproval, claimApproval, finalizeApproval,
  prHeadSha: realPrHeadSha,
  mergePr: realMergePr,
  getIssue: (key) => linear.getIssue(key),
  postComment: (issue, body) => linear.postComment(issue, body),
  transitionAfterMerge: (issue) => linear.transitionAfterMerge(issue),
  removeLabel: (issue, name) => linear.removeLabel(issue, name),
  postMerge: () => postMergeTick(),
};

/** POST /approvals/:id/approve {gatedHeadSha}. Sequence (each step fails CLOSED
 *  — there is no path from any failure to a merge):
 *    0. evidence binding: the SHA the caller's card rendered must still be the
 *       item's. A mismatch is refused BEFORE the claim, so a stale tab costs a
 *       refresh, not the row — the item stays pending and approvable;
 *    1. atomic pending→approved claim (double-click / concurrent-request guard);
 *    2. refuse outright if the item recorded no gated SHA (nothing to pin to);
 *    3. freshness: current PR head (GitHub's view) must EQUAL the gated SHA —
 *       moved or unreadable ⇒ item goes stale with the exact reason, no merge;
 *    4. mergePr — the existing squash + --match-head-commit path (GitHub
 *       re-checks the pin atomically); a headMoved refusal ⇒ stale, any other
 *       refusal ⇒ item rolls BACK to pending (retryable) with the reason;
 *    5. on success: announce + transition the Linear ticket exactly as the
 *       auto-merge path does (loop.ts: comment → done, fallback review),
 *       drop the needs-human hold label, emit approval_granted, run normal
 *       post-merge handling. Linear/postmerge failures after the merge are
 *       reported but the action is still a 200 — the merge HAPPENED. */
export async function approveItem(id: number, requestedHeadSha: unknown, deps: ApproveDeps = defaultApproveDeps): Promise<ApprovalActionResult> {
  const item = await deps.getApproval(id);
  if (!item) return { status: 404, json: { error: "no approval item with that id" } };
  if (!approvalEvidenceMatches(requestedHeadSha, item.gatedHeadSha)) {
    return { status: 409, json: { error: CARD_OUT_OF_DATE, item } };
  }
  if (!(await deps.claimApproval(id, "approved"))) {
    // Not pending (already decided, superseded, or a concurrent click won).
    const now = await deps.getApproval(id);
    return { status: 409, json: { error: `item is ${now?.status ?? "gone"}, not pending`, item: now } };
  }

  const stale = async (reason: string): Promise<ApprovalActionResult> => {
    await deps.finalizeApproval(id, "stale", reason);
    bus.emit({ type: "approval_stale", issueKey: item.issueKey, approvalId: id, reason });
    return { status: 409, json: { error: reason, item: await deps.getApproval(id) } };
  };

  if (!item.gatedHeadSha) {
    return await stale("no gated head SHA was recorded for this run — cannot pin the merge to gated evidence; needs re-gate");
  }
  const head = deps.prHeadSha(item.repo, item.prUrl);
  if (!head) {
    // Can't PROVE freshness — refuse, but keep the item retryable (a gh blip
    // must not permanently strand an approvable PR).
    await deps.finalizeApproval(id, "pending", "could not read the PR head from GitHub — freshness unproven, merge refused; retry");
    return { status: 502, json: { error: "could not read the PR head from GitHub — merge refused (retryable)" } };
  }
  if (head.toLowerCase() !== item.gatedHeadSha.toLowerCase()) {
    return await stale(STALE_BRANCH_MOVED);
  }

  const merged = deps.mergePr(item.repo, item.prUrl, item.gatedHeadSha);
  if (!merged.ok) {
    if (merged.headMoved) return await stale(STALE_BRANCH_MOVED);
    const out = redactSecrets(merged.out).clean.slice(0, 300);
    await deps.finalizeApproval(id, "pending", `merge failed (not a head mismatch): ${out} — retryable`);
    return { status: 502, json: { error: `merge failed: ${out}` } };
  }

  await deps.finalizeApproval(id, "approved", `merged by human approval, pinned to ${item.gatedHeadSha.slice(0, 12)}`);
  bus.emit({ type: "approval_granted", issueKey: item.issueKey, approvalId: id, prUrl: item.prUrl, sha: item.gatedHeadSha });

  // Linear closeout — mirrors loop.ts's post-mergePr announce/transition
  // sequence (comment, then done with review fallback), plus dropping the
  // needs-human hold label the delivery path applied. Best-effort AFTER the
  // merge: a Linear outage must not un-merge anything or fail the action.
  const linearIssues: string[] = [];
  try {
    const issue = await deps.getIssue(item.issueKey);
    await deps.postComment(issue, `${linear.SENTINEL}\n\n**Merged via approvals inbox** (human approval, pinned to gated \`${item.gatedHeadSha.slice(0, 12)}\`): ${item.prUrl}`)
      .catch((e) => { linearIssues.push(`comment: ${e instanceof Error ? e.message : e}`); });
    await deps.transitionAfterMerge(issue).catch((e) => { linearIssues.push(`transition: ${e instanceof Error ? e.message : e}`); });
    await deps.removeLabel(issue, linear.NEEDS_HUMAN_LABEL).catch(() => { /* label may not be present (pr_open lane) */ });
  } catch (error) {
    linearIssues.push(`issue lookup: ${error instanceof Error ? error.message : error}`);
  }
  await deps.postMerge().catch((e) => { linearIssues.push(`postmerge: ${e instanceof Error ? e.message : e}`); });

  return {
    status: 200,
    json: {
      ok: true, merged: true, sha: item.gatedHeadSha, prUrl: item.prUrl,
      ...(linearIssues.length > 0 ? { warnings: linearIssues.map((w) => redactSecrets(w).clean.slice(0, 200)) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Pushback — the feedback loop. No merge dep exists in this type at all.
// ---------------------------------------------------------------------------

export interface PushbackDeps {
  getApproval: (id: number) => Promise<ApprovalItem | null>;
  claimApproval: (id: number, to: Exclude<ApprovalStatus, "pending">) => Promise<boolean>;
  finalizeApproval: (id: number, status: ApprovalStatus, resolution: string) => Promise<void>;
  recordFeedback: (issueKey: string, feedback: string) => Promise<boolean>;
  getIssue: (key: string) => Promise<linear.Issue>;
  postComment: (issue: linear.Issue, body: string) => Promise<void>;
  transition: (issue: linear.Issue, kind: linear.StateKind) => Promise<boolean>;
  removeLabel: (issue: linear.Issue, name: string) => Promise<void>;
}

const defaultPushbackDeps: PushbackDeps = {
  getApproval, claimApproval, finalizeApproval,
  recordFeedback: recordPushbackFeedback,
  getIssue: (key) => linear.getIssue(key),
  postComment: (issue, body) => linear.postComment(issue, body),
  transition: (issue, kind) => linear.transition(issue, kind),
  removeLabel: (issue, name) => linear.removeLabel(issue, name),
};

/** Validate + normalize the owner's feedback: must be a non-empty string;
 *  redact-scanned (it travels to Linear and into prompts) and length-capped.
 *  It IS from the human owner via localhost, but the same seam discipline
 *  applies as everywhere else. Exported for the cap/redaction test. */
export function normalizeFeedback(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return redactSecrets(raw.trim()).clean.slice(0, FEEDBACK_MAX_CHARS);
}

/** POST /approvals/:id/pushback {feedback}. Never merges anything (no merge
 *  dep exists). Sequence: atomic pending→pushed_back claim → post the
 *  feedback on the Linear ticket as clearly-marked OWNER FEEDBACK → store it
 *  for the next run's prompts (loop.ts takePushbackFeedback) → requeue via
 *  the EXISTING mechanism (drop Factory-Needs-Human / Factory-Parked,
 *  transition back to queue — exactly what a human doing it by hand in
 *  Linear does, so the daemon's next tick claims it like any ticket). A
 *  failed requeue rolls the item back to pending so the button is retryable
 *  instead of silently stranding the issue in the review state. */
export async function pushbackItem(id: number, feedbackRaw: unknown, deps: PushbackDeps = defaultPushbackDeps): Promise<ApprovalActionResult> {
  const feedback = normalizeFeedback(feedbackRaw);
  if (feedback === null) {
    return { status: 400, json: { error: `body must be {"feedback": <non-empty string>} (capped at ${FEEDBACK_MAX_CHARS} chars)` } };
  }
  const item = await deps.getApproval(id);
  if (!item) return { status: 404, json: { error: "no approval item with that id" } };
  if (!(await deps.claimApproval(id, "pushed_back"))) {
    const now = await deps.getApproval(id);
    return { status: 409, json: { error: `item is ${now?.status ?? "gone"}, not pending`, item: now } };
  }

  try {
    const issue = await deps.getIssue(item.issueKey);
    // Comment FIRST so the directive is durably visible on the ticket even if
    // the requeue below fails; the pipeline copy is the DB row, not this text.
    await deps.postComment(issue,
      `${linear.SENTINEL}\n\n**OWNER FEEDBACK** — pushed back from the approvals inbox; the pipeline will run a fix round with this directive:\n\n> ${feedback.split("\n").join("\n> ")}`);
    await deps.recordFeedback(item.issueKey, feedback);
    await deps.removeLabel(issue, linear.NEEDS_HUMAN_LABEL).catch(() => { /* may not be present */ });
    await deps.removeLabel(issue, linear.PARKED_LABEL).catch(() => { /* may not be present */ });
    const moved = await deps.transition(issue, "queue");
    if (!moved) throw new Error("no queue (unstarted) state reachable on the team");
  } catch (error) {
    const why = redactSecrets(error instanceof Error ? error.message : String(error)).clean.slice(0, 300);
    await deps.finalizeApproval(id, "pending", `pushback failed (${why}) — rolled back to pending; retry`);
    return { status: 502, json: { error: `pushback failed: ${why} (item back to pending — retry)` } };
  }

  await deps.finalizeApproval(id, "pushed_back", "owner feedback posted and issue requeued for a fix round");
  bus.emit({ type: "approval_pushed_back", issueKey: item.issueKey, approvalId: id, feedback: feedback.slice(0, 500) });
  return { status: 200, json: { ok: true, requeued: true, issueKey: item.issueKey } };
}
