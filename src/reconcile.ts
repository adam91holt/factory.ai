import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { repoFromTicket, prState } from "./repos.ts";
import { childrenAllTerminal } from "./steward.ts";
import { abortIssueStages, redactSecrets } from "./agents.ts";
import { listPendingApprovals, finalizeApproval } from "./db.ts";
import { bus } from "./events.ts";

const execFileP = promisify(execFile);

// Reconcile tick (owner request 2026-07-21): close the two edges the pipeline
// left open, so the board never drifts regardless of who merges.
//   (1) An In-Review ticket whose PR is merged → Done. The factory transitions
//       to In-Review when it opens a PR and then waits for a human; when the
//       human merges on GitHub, nothing told Linear. This links merge→Done.
//   (2) A Stewarded epic whose children are all terminal → Done. The steward
//       posts its closeout but never closed the parent.
// Read-only against GitHub, idempotent, cheap. Non-blocking (async execFile) so
// a growing review backlog never freezes the daemon thread; dry-run safe.

/** True iff a MERGED PR exists for `branch` in `repo`. `gh pr list --head`
 * resolves merged PRs even after the head branch is deleted (the factory merges
 * with --delete-branch). Exit 0 + [] = no merged PR (benign, silent); a non-zero
 * exit is a real gh failure (auth/network/rate-limit) — logged redacted so a
 * stalled reconcile is observable, and fail-safe (treated as not-merged, so the
 * tick never wrongly closes on a gh error). */
async function prMerged(repo: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("gh",
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "merged", "--json", "state", "--limit", "1"],
      { encoding: "utf8", timeout: 30_000 });
    return (JSON.parse(stdout || "[]") as Array<{ state: string }>).some((p) => p.state === "MERGED");
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    const detail = e.stderr || e.message || String(error);
    console.error(`[reconcile] gh pr list ${repo} ${branch} failed: ${redactSecrets(detail).clean.slice(0, 200)}`);
    return false; // fail-safe: a gh outage stalls reconcile but never mis-closes
  }
}


// ---------------------------------------------------------------------------
// (3) Mid-stage claim re-verification (fix-list #6, live 2026-08-02: FAC-64
// was moved to Done mid-implementer and the stage kept burning until its next
// mutating-step stillOurs check). Each reconcile pass compares the daemon's
// in-flight set against the live board — an issue that no longer carries the
// executing label, or is no longer in a started-type state, has been taken
// away by a human, so its in-flight stages are aborted (abortIssueStages →
// the CLAIM_LOST error → park() routes to abortExternal's quiet abandon).
//
// DEBOUNCED over two consecutive passes: Linear reads can be briefly stale
// (a just-claimed issue's label/state may lag the claim mutation), and a
// false positive here kills a legitimate paid-for run. One suspicious pass
// warns; two in a row abort. In-code constant by design.
// ---------------------------------------------------------------------------

export interface LiveClaimView { labels: readonly string[]; stateType: string }

/** Pure sweep decision (decision logic stays I/O-free — CLAUDE.md). `started`
 *  maps issue identifier → live view for every started-type issue fetched this
 *  pass; an in-flight key ABSENT from it has left the started states entirely.
 *  `pending` is the cross-pass debounce memory — mutated in place. */
export function claimLossSweep(
  inFlight: ReadonlySet<string>,
  started: ReadonlyMap<string, LiveClaimView>,
  pending: Set<string>,
): { abort: string[]; warn: string[] } {
  const abort: string[] = [];
  const warn: string[] = [];
  for (const key of inFlight) {
    const live = started.get(key);
    const lost = live === undefined
      || !live.labels.includes(linear.EXECUTING_LABEL)
      || live.stateType !== "started";
    if (!lost) { pending.delete(key); continue; }
    if (pending.has(key)) { pending.delete(key); abort.push(key); }
    else { pending.add(key); warn.push(key); }
  }
  // An issue that left the in-flight set (run ended) must not haunt the memory.
  for (const key of [...pending]) if (!inFlight.has(key)) pending.delete(key);
  return { abort, warn };
}

const pendingClaimLoss = new Set<string>();

export async function reconcileTick(inFlightKeys: ReadonlySet<string> = new Set()): Promise<void> {
  const startedByKey = new Map<string, LiveClaimView>();
  // (1) In-Review tickets with a merged PR → Done.
  for (const teamKey of config.teamKeys) {
    const inReview = await linear.fetchIssuesByStateType("started", teamKey)
      .catch(() => [] as linear.Issue[]);
    for (const issue of inReview) {
      startedByKey.set(issue.identifier, { labels: issue.labels, stateType: issue.stateType });
      // Only the review lane, not "In Progress". WP3: tag-anchored
      // (`[factory:review]` in the state description) so renaming the column
      // cannot silently break the merge→Done link; falls back to the pre-WP3
      // name regex on an untagged board.
      if (!linear.isReviewLane(issue.stateName, issue.stateDescription)) continue;
      const repo = repoFromTicket(issue.description);
      if (!repo) continue;
      if (!(await prMerged(repo, `factory/${issue.identifier.toLowerCase()}`))) continue;
      if (config.dryRun) { console.log(`[dry-run] [reconcile] ${issue.identifier} PR merged → would close`); continue; }
      const moved = await linear.transition(issue, "done");
      if (moved) console.log(`[reconcile] ${issue.identifier} PR merged → Done`);
    }
  }

  // (2) Stewarded epics whose children are all terminal → Done.
  const planned = await linear.fetchByLabel(linear.PLANNED_LABEL).catch(() => [] as linear.Issue[]);
  for (const epic of planned) {
    if (!epic.labels.includes(linear.STEWARDED_LABEL)) continue;
    // A failed steward stamps STEWARDED_LABEL too (don't-loop) and flags the epic
    // Needs-Human — never auto-close over an explicit human-review escalation.
    if (epic.labels.includes(linear.NEEDS_HUMAN_LABEL)) continue;
    if (epic.stateType === "completed" || epic.stateType === "canceled") continue;
    const detail = await linear.getIssueDetail(epic.identifier);
    // "all terminal" AND none still merely In-Review (a merged-away child is Done;
    // an open-PR child keeps the epic alive so the human sees the remaining work).
    const allClosed = detail.children.length > 0 && detail.children.every((c) =>
      c.stateType === "completed" || c.stateType === "canceled");
    if (allClosed && childrenAllTerminal(detail)) {
      if (config.dryRun) { console.log(`[dry-run] [reconcile] ${epic.identifier} all children closed → would close`); continue; }
      const moved = await linear.transition(epic, "done");
      if (moved) console.log(`[reconcile] ${epic.identifier} all children closed → Done`);
    }
  }

  // (3) Stale approval-inbox rows. A PR can be merged (by the ladder, the
  // steward, or a human on GitHub) or closed (a pivot/cancel) OUTSIDE the
  // approvals inbox, leaving its pending row orphaned in the review queue
  // forever (hit 3× on 2026-08-03 — the operator saw "4 items" that were all
  // already resolved). Retire each pending row whose PR GitHub reports as
  // terminal: merged → approved (the merge already happened), closed-unmerged →
  // stale. An OPEN PR or an unreadable state (prState null) is left untouched —
  // this only ever RESOLVES rows the world already resolved, never merges.
  if (!config.dryRun) {
    for (const item of await listPendingApprovals().catch(() => [])) {
      if (!item.prUrl || !item.repo) continue;
      const state = prState(item.repo, item.prUrl);
      if (state === "open" || state === null) continue;
      const status = state === "merged" ? "approved" as const : "stale" as const;
      const reason = state === "merged"
        ? `PR already merged outside the inbox — retiring orphaned approval (${item.prUrl})`
        : `PR closed without merge outside the inbox — retiring stale approval (${item.prUrl})`;
      await finalizeApproval(item.id, status, reason);
      if (status === "approved") bus.emit({ type: "approval_granted", issueKey: item.issueKey, approvalId: item.id, prUrl: item.prUrl, sha: item.gatedHeadSha ?? "external" });
      else bus.emit({ type: "approval_stale", issueKey: item.issueKey, approvalId: item.id, reason });
      console.log(`[reconcile] ${item.issueKey} approval #${item.id} → ${status} (PR ${state} outside inbox)`);
    }
  }

  // (4) Claim-loss sweep — see claimLossSweep above. Uses the started-type
  // fetch pass (1) already paid for; no additional Linear calls. Dry-run has
  // no live claims and must never abort anything.
  if (!config.dryRun && inFlightKeys.size > 0) {
    const { abort, warn } = claimLossSweep(inFlightKeys, startedByKey, pendingClaimLoss);
    for (const key of warn) {
      console.error(`[reconcile] ${key} looks externally moved (label/state gone) — will abort its stages if still gone next pass`);
    }
    for (const key of abort) {
      const labels = abortIssueStages(key, "issue left In Progress / lost executing label (confirmed across two reconcile passes)");
      if (labels.length > 0) console.error(`[reconcile] ${key} claim lost — aborted in-flight stage(s): ${labels.join(", ")}`);
      else console.error(`[reconcile] ${key} claim lost — no stage in flight to abort (between stages); the next stillOurs check ends the run`);
    }
  }
}
