import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { repoFromTicket } from "./repos.ts";
import { childrenAllTerminal } from "./steward.ts";
import { redactSecrets } from "./agents.ts";

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

export async function reconcileTick(): Promise<void> {
  // (1) In-Review tickets with a merged PR → Done.
  for (const teamKey of config.teamKeys) {
    const inReview = await linear.fetchIssuesByStateType("started", teamKey)
      .catch(() => [] as linear.Issue[]);
    for (const issue of inReview) {
      if (!/review/i.test(issue.stateName)) continue; // only the review lane, not "In Progress"
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
}
