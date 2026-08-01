import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  openTestDatabase, closeTestDatabase, insertApproval, listPendingApprovals,
  pendingApprovalCount, getApproval, claimApproval, finalizeApproval,
  recordPushbackFeedback, takePushbackFeedback,
} from "../src/db.ts";
import {
  approveItem, pushbackItem, fileApproval, shouldFileApproval, normalizeFeedback,
  approvalsView, type ApproveDeps, type PushbackDeps,
} from "../src/approvals.ts";
import { notifyApproval, sanitizeNotificationText, resetNotifyThrottleForTest, approvalsUrl } from "../src/notify.ts";
import type { Issue } from "../src/linear.ts";

// Safety invariants of the approvals inbox (stream inbox-backend), pinned:
//   1. approve NEVER merges when the PR head != the gated SHA (pre-check
//      refuses AND a --match-head-commit refusal maps to stale, never retry);
//   2. approve refuses outright when no gated SHA was recorded;
//   3. pushback never merges anything (its dep type has no merge — asserted
//      by construction here with a deps object that would throw);
//   4. double-click cannot double-merge (atomic pending-row claim);
//   5. a run outside the human lane never files an item (shouldFileApproval)
//      and a non-pending item cannot be flipped by any endpoint;
//   6. self-repo items CAN be approved — the merge still runs through the
//      pinned mergePr path like any other repo.
// decideMerge / merge-ladder.ts are deliberately untouched by this feature —
// approvals.ts never imports them (see its import list).

const GATED = "a".repeat(40);
const MOVED = "b".repeat(40);

const fakeIssue = (identifier: string): Issue => ({
  id: `uuid-${identifier}`, identifier, title: `t-${identifier}`, description: "",
  url: `https://linear.app/x/${identifier}`, teamKey: "FAC", teamId: "team-1",
  stateName: "In Review", stateType: "started", labels: ["Factory-Needs-Human"],
  createdAt: "2026-08-01T00:00:00.000Z",
});

function seedItem(overrides: Partial<Parameters<typeof insertApproval>[0]> = {}): number {
  const id = insertApproval({
    issueKey: "FAC-43", title: "guarded paths + incomplete design review", repo: "acme/widgets",
    prUrl: "https://github.com/acme/widgets/pull/7", gatedHeadSha: GATED,
    holdReasons: "guarded paths touched: .github/workflows/ci.yml",
    gateSummary: { green: true, strength: "real", tests: [{ name: "test", from: 631, to: 640 }] },
    securityVerdict: "pass", tasteVerdict: "not-required",
    findingsDigest: "fixed: 2, rejected: 1", diffStat: "3 files · 42 changed lines",
    costUsd: 1.23, turns: 17,
    ...overrides,
  });
  if (id === null) throw new Error("insertApproval returned null with an open test store");
  return id;
}

interface Calls { merged: string[][]; comments: string[]; transitions: string[]; removedLabels: string[]; postMerge: number }

function approveDeps(opts: { head?: string | null; mergeOk?: boolean; headMoved?: boolean } = {}): { deps: ApproveDeps; calls: Calls } {
  const calls: Calls = { merged: [], comments: [], transitions: [], removedLabels: [], postMerge: 0 };
  const deps: ApproveDeps = {
    getApproval, claimApproval, finalizeApproval,
    prHeadSha: () => (opts.head === undefined ? GATED : opts.head),
    mergePr: (repo, prUrl, sha) => {
      calls.merged.push([repo, prUrl, sha]);
      return { ok: opts.mergeOk ?? true, out: opts.mergeOk === false ? "refused" : "merged", headMoved: opts.headMoved ?? false };
    },
    getIssue: (key) => Promise.resolve(fakeIssue(key)),
    postComment: (_i, body) => { calls.comments.push(body); return Promise.resolve(); },
    transitionAfterMerge: () => { calls.transitions.push("after-merge"); return Promise.resolve(); },
    removeLabel: (_i, name) => { calls.removedLabels.push(name); return Promise.resolve(); },
    postMerge: () => { calls.postMerge += 1; return Promise.resolve(); },
  };
  return { deps, calls };
}

function pushbackDeps(opts: { transitionOk?: boolean } = {}): { deps: PushbackDeps; calls: Calls & { feedback: string[] } } {
  const calls = { merged: [] as string[][], comments: [] as string[], transitions: [] as string[], removedLabels: [] as string[], postMerge: 0, feedback: [] as string[] };
  const deps: PushbackDeps = {
    getApproval, claimApproval, finalizeApproval,
    recordFeedback: (issueKey, feedback) => { calls.feedback.push(`${issueKey}: ${feedback}`); return recordPushbackFeedback(issueKey, feedback); },
    getIssue: (key) => Promise.resolve(fakeIssue(key)),
    postComment: (_i, body) => { calls.comments.push(body); return Promise.resolve(); },
    transition: (_i, kind) => { calls.transitions.push(kind); return Promise.resolve(opts.transitionOk ?? true); },
    removeLabel: (_i, name) => { calls.removedLabels.push(name); return Promise.resolve(); },
  };
  return { deps, calls };
}

beforeEach(() => openTestDatabase());
afterEach(() => closeTestDatabase());

describe("human lane rule (shouldFileApproval)", () => {
  test("files only when a PR is open and no auto-merge closed it", () => {
    expect(shouldFileApproval("https://github.com/a/b/pull/1", false)).toBe(true);
    expect(shouldFileApproval("https://github.com/a/b/pull/1", true)).toBe(false); // merged run — not human lane
    expect(shouldFileApproval(null, false)).toBe(false);                            // park/abort/stale — no PR
    expect(shouldFileApproval("", false)).toBe(false);
  });
});

describe("approval rows (db)", () => {
  test("filing supersedes a prior pending item for the same issue", () => {
    const first = seedItem();
    const second = seedItem();
    expect(getApproval(first)?.status).toBe("stale");
    expect(getApproval(first)?.resolution).toContain("superseded");
    expect(getApproval(second)?.status).toBe("pending");
    expect(pendingApprovalCount()).toBe(1);
    expect(listPendingApprovals().map((i) => i.id)).toEqual([second]);
  });

  test("claimApproval is atomic: exactly one of two claims wins", () => {
    const id = seedItem();
    expect(claimApproval(id, "approved")).toBe(true);
    expect(claimApproval(id, "pushed_back")).toBe(false); // already decided
    expect(getApproval(id)?.status).toBe("approved");
  });

  test("pushback feedback is a take-once handoff", () => {
    recordPushbackFeedback("FAC-43", "tighten the null handling");
    expect(takePushbackFeedback("FAC-43")).toBe("tighten the null handling");
    expect(takePushbackFeedback("FAC-43")).toBeNull(); // consumed
  });
});

describe("approve — the human merge authority", () => {
  test("merges through the pinned mergePr path when head == gated SHA, then closes out Linear", async () => {
    const id = seedItem();
    const { deps, calls } = approveDeps();
    const r = await approveItem(id, deps);
    expect(r.status).toBe(200);
    expect(calls.merged).toEqual([["acme/widgets", "https://github.com/acme/widgets/pull/7", GATED]]);
    expect(getApproval(id)?.status).toBe("approved");
    expect(calls.transitions).toEqual(["after-merge"]); // the SHARED linear.transitionAfterMerge closeout
    expect(calls.removedLabels).toContain("Factory-Needs-Human");
    expect(calls.postMerge).toBe(1);
    expect(calls.comments.join("\n")).toContain("Merged via approvals inbox");
  });

  test("NEVER merges when the PR head moved since gating — item goes stale", async () => {
    const id = seedItem();
    const { deps, calls } = approveDeps({ head: MOVED });
    const r = await approveItem(id, deps);
    expect(r.status).toBe(409);
    expect(calls.merged).toHaveLength(0); // the invariant: no merge call at all
    const item = getApproval(id);
    expect(item?.status).toBe("stale");
    expect(item?.resolution).toBe("branch moved since gating — needs re-gate");
  });

  test("NEVER merges when no gated SHA was recorded", async () => {
    const id = seedItem({ gatedHeadSha: null });
    const { deps, calls } = approveDeps();
    const r = await approveItem(id, deps);
    expect(r.status).toBe(409);
    expect(calls.merged).toHaveLength(0);
    expect(getApproval(id)?.status).toBe("stale");
  });

  test("an unreadable PR head refuses the merge but stays retryable (pending)", async () => {
    const id = seedItem();
    const { deps, calls } = approveDeps({ head: null });
    const r = await approveItem(id, deps);
    expect(r.status).toBe(502);
    expect(calls.merged).toHaveLength(0);
    expect(getApproval(id)?.status).toBe("pending");
  });

  test("a --match-head-commit refusal (headMoved backstop) marks stale, never retries the new head", async () => {
    const id = seedItem();
    const { deps, calls } = approveDeps({ mergeOk: false, headMoved: true });
    const r = await approveItem(id, deps);
    expect(r.status).toBe(409);
    expect(calls.merged).toHaveLength(1); // one pinned attempt, refused by GitHub
    expect(getApproval(id)?.status).toBe("stale");
  });

  test("a non-head merge failure rolls back to pending (retryable), no Linear transition", async () => {
    const id = seedItem();
    const { deps, calls } = approveDeps({ mergeOk: false });
    const r = await approveItem(id, deps);
    expect(r.status).toBe(502);
    expect(getApproval(id)?.status).toBe("pending");
    expect(calls.transitions).toHaveLength(0);
  });

  test("double-click cannot double-merge: second call is a 409 and merge ran once", async () => {
    const id = seedItem();
    const { deps, calls } = approveDeps();
    const first = await approveItem(id, deps);
    const second = await approveItem(id, deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(calls.merged).toHaveLength(1);
  });

  test("no endpoint can flip a decided item (pushback after approve refused)", async () => {
    const id = seedItem();
    const { deps } = approveDeps();
    await approveItem(id, deps);
    const pb = pushbackDeps();
    const r = await pushbackItem(id, "do it differently", pb.deps);
    expect(r.status).toBe(409);
    expect(getApproval(id)?.status).toBe("approved"); // decision stands
  });

  test("a missing item is a 404, never an action", async () => {
    const { deps, calls } = approveDeps();
    expect((await approveItem(999, deps)).status).toBe(404);
    expect(calls.merged).toHaveLength(0);
  });

  test("self-repo items CAN be approved — the human IS the merge authority, still pinned", async () => {
    const id = seedItem({ repo: "adam91holt/factory.ai", prUrl: "https://github.com/adam91holt/factory.ai/pull/5" });
    const { deps, calls } = approveDeps();
    const r = await approveItem(id, deps);
    expect(r.status).toBe(200);
    expect(calls.merged).toEqual([["adam91holt/factory.ai", "https://github.com/adam91holt/factory.ai/pull/5", GATED]]);
  });
});

describe("pushback — the feedback loop", () => {
  test("posts OWNER FEEDBACK, stores the directive, requeues via the existing mechanism — and cannot merge", async () => {
    const id = seedItem();
    const { deps, calls } = pushbackDeps();
    const r = await pushbackItem(id, "split the endpoint and add a test for the 409 path", deps);
    expect(r.status).toBe(200);
    expect(getApproval(id)?.status).toBe("pushed_back");
    expect(calls.comments.join("\n")).toContain("OWNER FEEDBACK");
    expect(calls.removedLabels).toEqual(["Factory-Needs-Human", "Factory-Parked"]);
    expect(calls.transitions).toEqual(["queue"]);
    // The directive reaches the next run through the take-once handoff.
    expect(takePushbackFeedback("FAC-43")).toBe("split the endpoint and add a test for the 409 path");
    // Structural: PushbackDeps has no merge member at all.
    expect("mergePr" in deps).toBe(false);
  });

  test("rejects an empty / non-string feedback body without claiming the item", async () => {
    const id = seedItem();
    const { deps } = pushbackDeps();
    expect((await pushbackItem(id, "", deps)).status).toBe(400);
    expect((await pushbackItem(id, 42, deps)).status).toBe(400);
    expect(getApproval(id)?.status).toBe("pending");
  });

  test("a failed requeue rolls the item back to pending (retryable)", async () => {
    const id = seedItem();
    const { deps } = pushbackDeps({ transitionOk: false });
    const r = await pushbackItem(id, "please fix", deps);
    expect(r.status).toBe(502);
    expect(getApproval(id)?.status).toBe("pending");
  });

  test("feedback is redact-scanned and length-capped", () => {
    expect(normalizeFeedback(`use env var lin_api_${"a".repeat(24)} here`)).toContain("[REDACTED-SECRET]");
    expect(normalizeFeedback("x".repeat(9000))?.length).toBe(4000);
    expect(normalizeFeedback("   ")).toBeNull();
  });
});

describe("filing + view", () => {
  test("fileApproval persists a redacted card and approvalsView serves it with a count", () => {
    const id = fileApproval({
      issueKey: "FAC-50", title: "add auth", repo: "acme/widgets", prUrl: "https://github.com/acme/widgets/pull/9",
      gatedHeadSha: GATED, holdReasons: `security review FAIL — token lin_api_${"b".repeat(24)} leaked`,
      gateSummary: { green: true, strength: "strong", tests: [{ name: "test", from: 10, to: 12 }] },
      securityVerdict: "fail", tasteVerdict: "pass", findingsDigest: "one real finding fixed",
      diffStat: "2 files · 30 changed lines", costUsd: 2.5, turns: 30,
    });
    expect(id).not.toBeNull();
    const view = approvalsView();
    expect(view.count).toBe(1);
    const item = view.pending[0]!;
    expect(item.issueKey).toBe("FAC-50");
    expect(item.holdReasons).toContain("[REDACTED-SECRET]");
    expect(item.gatedHeadSha).toBe(GATED);
    expect(item.gateSummary?.tests).toEqual([{ name: "test", from: 10, to: 12 }]);
  });

  test("fileApproval returns null (and files nothing durable) when the store is closed", () => {
    closeTestDatabase();
    const id = fileApproval({
      issueKey: "FAC-51", title: "x", repo: "a/b", prUrl: "https://github.com/a/b/pull/1",
      gatedHeadSha: GATED, holdReasons: "r", gateSummary: null, securityVerdict: "none",
      tasteVerdict: "not-required", findingsDigest: "", diffStat: "", costUsd: 0, turns: 0,
    });
    expect(id).toBeNull();
    openTestDatabase(); // afterEach closes again
  });
});

describe("notify (macOS notification)", () => {
  beforeEach(() => resetNotifyThrottleForTest());

  const notice = { id: 1, issueKey: "FAC-43", title: "guarded paths", holdReasons: "guarded paths touched" };

  test("throttled: at most one notification per item id", () => {
    const scripts: string[] = [];
    const deps = { platform: "darwin", enabled: true, run: (s: string) => { scripts.push(s); } };
    expect(notifyApproval(notice, deps)).toBe(true);
    expect(notifyApproval(notice, deps)).toBe(false);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("Factory needs you: FAC-43");
    expect(scripts[0]).toContain(approvalsUrl());
  });

  test("no-op when disabled (APPROVALS_NOTIFY=0) or off macOS", () => {
    const scripts: string[] = [];
    const run = (s: string) => { scripts.push(s); };
    expect(notifyApproval(notice, { platform: "darwin", enabled: false, run })).toBe(false);
    expect(notifyApproval(notice, { platform: "linux", enabled: true, run })).toBe(false);
    expect(scripts).toHaveLength(0);
  });

  test("untrusted title text cannot escape the AppleScript string literal", () => {
    const cleaned = sanitizeNotificationText('evil" with title "pwned\\\nx');
    expect(cleaned).not.toContain('"');
    expect(cleaned).not.toContain("\\");
    expect(cleaned).not.toContain("\n");
    expect(sanitizeNotificationText("x".repeat(500)).length).toBe(160);
  });
});
