import { spawnSync } from "node:child_process";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { repoFromTicket } from "./repos.ts";
import { childrenAllTerminal } from "./steward.ts";

// Reconcile tick (owner request 2026-07-21): close the two edges the pipeline
// left open, so the board never drifts regardless of who merges.
//   (1) An In-Review ticket whose PR is merged → Done. The factory transitions
//       to In-Review when it opens a PR and then waits for a human; when the
//       human merges on GitHub, nothing told Linear. This links merge→Done.
//   (2) A Stewarded epic whose children are all terminal → Done. The steward
//       posts its closeout but never closed the parent.
// Read-only against GitHub (gh pr view), idempotent, cheap: only touches
// tickets already in a terminal-ish state.

function prState(repo: string, branch: string): string | null {
  const r = spawnSync("gh", ["pr", "view", branch, "--repo", repo, "--json", "state", "-q", ".state"],
    { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : null; // MERGED | OPEN | CLOSED | null(no PR)
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
      const state = prState(repo, `factory/${issue.identifier.toLowerCase()}`);
      if (state === "MERGED") {
        const moved = await linear.transition(issue, "done");
        if (moved) console.log(`[reconcile] ${issue.identifier} PR merged → Done`);
      }
    }
  }

  // (2) Stewarded epics whose children are all terminal → Done.
  const planned = await linear.fetchByLabel(linear.PLANNED_LABEL).catch(() => [] as linear.Issue[]);
  for (const epic of planned) {
    if (!epic.labels.includes(linear.STEWARDED_LABEL)) continue;
    if (epic.stateType === "completed" || epic.stateType === "canceled") continue;
    const detail = await linear.getIssueDetail(epic.identifier);
    // "all terminal" AND none still merely In-Review (a merged-away child is Done;
    // an open-PR child keeps the epic alive so the human sees the remaining work).
    const allClosed = detail.children.length > 0 && detail.children.every((c) =>
      c.stateType === "completed" || c.stateType === "canceled");
    if (allClosed && childrenAllTerminal(detail)) {
      const moved = await linear.transition(epic, "done");
      if (moved) console.log(`[reconcile] ${epic.identifier} all children closed → Done`);
    }
  }
}
