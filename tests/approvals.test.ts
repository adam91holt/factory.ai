import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  openTestDatabase, closeTestDatabase, insertApproval, listPendingApprovals,
  pendingApprovalCount, getApproval, claimApproval, finalizeApproval,
  recordPushbackFeedback, restorePushbackFeedback, takePushbackFeedback,
} from "../src/db.ts";
import {
  approveItem, pushbackItem, fileApproval, shouldFileApproval, normalizeFeedback,
  approvalsView, approvalEvidenceMatches, regateFailedAgainstMain,
  type ApproveDeps, type PushbackDeps,
} from "../src/approvals.ts";
import { ownerFeedbackHandoff, preMergeIntegrity } from "../src/loop.ts";
import { notifyApproval, sanitizeNotificationText, resetNotifyThrottleForTest, approvalsUrl, type ApprovalNotice } from "../src/notify.ts";
import type { Issue } from "../src/linear.ts";
import type { Workspace } from "../src/repos.ts";

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
  stateName: "In Review", stateType: "started", stateDescription: "[factory:review]",
  labels: ["Factory-Needs-Human"],
  createdAt: "2026-08-01T00:00:00.000Z",
});

async function seedItem(overrides: Partial<Parameters<typeof insertApproval>[0]> = {}): Promise<number> {
  const id = await insertApproval({
    issueKey: "FAC-43", title: "guarded paths + incomplete design review", repo: "acme/widgets",
    prUrl: "https://github.com/acme/widgets/pull/7", gatedHeadSha: GATED,
    holdReasons: "guarded paths touched: .github/workflows/ci.yml",
    gateSummary: { green: true, strength: "real", tests: [{ name: "test", from: 631, to: 640 }] },
    securityVerdict: "pass", tasteVerdict: "not-required",
    findingsDigest: "fixed: 2, rejected: 1", diffStat: "3 files · 42 changed lines",
    costUsd: 1.23, turns: 17, regateFailed: false,
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
    recordFeedback: async (issueKey, feedback) => { calls.feedback.push(`${issueKey}: ${feedback}`); return await recordPushbackFeedback(issueKey, feedback); },
    getIssue: (key) => Promise.resolve(fakeIssue(key)),
    postComment: (_i, body) => { calls.comments.push(body); return Promise.resolve(); },
    transition: (_i, kind) => { calls.transitions.push(kind); return Promise.resolve(opts.transitionOk ?? true); },
    removeLabel: (_i, name) => { calls.removedLabels.push(name); return Promise.resolve(); },
  };
  return { deps, calls };
}

beforeEach(async () => { await openTestDatabase(); });
afterEach(async () => { await closeTestDatabase(); });

describe("human lane rule (shouldFileApproval)", () => {
  test("files only when a PR is open and no auto-merge closed it", () => {
    expect(shouldFileApproval("https://github.com/a/b/pull/1", false)).toBe(true);
    expect(shouldFileApproval("https://github.com/a/b/pull/1", true)).toBe(false); // merged run — not human lane
    expect(shouldFileApproval(null, false)).toBe(false);                            // park/abort/stale — no PR
    expect(shouldFileApproval("", false)).toBe(false);
  });
});

describe("approval rows (db)", () => {
  test("filing supersedes a prior pending item for the same issue", async () => {
    const first = await seedItem();
    const second = await seedItem();
    expect((await getApproval(first))?.status).toBe("stale");
    expect((await getApproval(first))?.resolution).toContain("superseded");
    expect((await getApproval(second))?.status).toBe("pending");
    expect(await pendingApprovalCount()).toBe(1);
    expect((await listPendingApprovals()).map((i) => i.id)).toEqual([second]);
  });

  test("claimApproval is atomic: exactly one of two claims wins", async () => {
    const id = await seedItem();
    expect(await claimApproval(id, "approved")).toBe(true);
    expect(await claimApproval(id, "pushed_back")).toBe(false); // already decided
    expect((await getApproval(id))?.status).toBe("approved");
  });

  test("pushback feedback is a take-once handoff", async () => {
    await recordPushbackFeedback("FAC-43", "tighten the null handling");
    expect(await takePushbackFeedback("FAC-43")).toBe("tighten the null handling");
    expect(await takePushbackFeedback("FAC-43")).toBeNull(); // consumed
  });

  test("a CONCURRENT double-insert cannot yield two pending rows (issue #8 F6)", async () => {
    // Two filers race the supersede-then-insert pair. Before the partial
    // unique index (idx_approvals_one_pending, WHERE status='pending') their
    // statements could interleave into TWO pending rows; now the second INSERT
    // conflicts and insertApproval retries the supersede — whatever the
    // interleaving, exactly one pending row survives and it is the newest.
    const [a, b] = await Promise.all([
      seedItem({ title: "first filer" }),
      seedItem({ title: "second filer" }),
    ]);
    expect(a).not.toBe(b);
    expect(await pendingApprovalCount()).toBe(1);
    const pending = await listPendingApprovals();
    expect(pending.length).toBe(1);
    expect(pending[0]?.id).toBe(Math.max(a, b));
    // The loser was resolved the supersede way, never deleted: audit trail intact.
    expect((await getApproval(Math.min(a, b)))?.status).toBe("stale");
    expect((await getApproval(Math.min(a, b)))?.resolution).toContain("superseded");
  });

  test("the one-pending-per-issue constraint is STRUCTURAL, not application discipline", async () => {
    // Different issues coexist; the same issue cannot hold two pendings even
    // across many sequential filings.
    const other = await seedItem({ issueKey: "FAC-99" });
    for (let i = 0; i < 3; i++) await seedItem();
    expect((await getApproval(other))?.status).toBe("pending"); // untouched — constraint is per-issue
    expect(await pendingApprovalCount()).toBe(2);               // FAC-43 + FAC-99, one each
  });
});

describe("approve — the human merge authority", () => {
  test("merges through the pinned mergePr path when head == gated SHA, then closes out Linear", async () => {
    const id = await seedItem();
    const { deps, calls } = approveDeps();
    const r = await approveItem(id, GATED, deps);
    expect(r.status).toBe(200);
    expect(calls.merged).toEqual([["acme/widgets", "https://github.com/acme/widgets/pull/7", GATED]]);
    expect((await getApproval(id))?.status).toBe("approved");
    expect(calls.transitions).toEqual(["after-merge"]); // the SHARED linear.transitionAfterMerge closeout
    expect(calls.removedLabels).toContain("Factory-Needs-Human");
    expect(calls.postMerge).toBe(1);
    expect(calls.comments.join("\n")).toContain("Merged via approvals inbox");
  });

  test("NEVER merges when the PR head moved since gating — item goes stale", async () => {
    const id = await seedItem();
    const { deps, calls } = approveDeps({ head: MOVED });
    const r = await approveItem(id, GATED, deps);
    expect(r.status).toBe(409);
    expect(calls.merged).toHaveLength(0); // the invariant: no merge call at all
    const item = await getApproval(id);
    expect(item?.status).toBe("stale");
    expect(item?.resolution).toBe("branch moved since gating — needs re-gate");
  });

  test("NEVER merges when no gated SHA was recorded", async () => {
    const id = await seedItem({ gatedHeadSha: null });
    const { deps, calls } = approveDeps();
    // The card rendered no SHA either, so the evidence binding matches and the
    // refusal comes from the rule that matters here: nothing to pin to.
    const r = await approveItem(id, null, deps);
    expect(r.status).toBe(409);
    expect(calls.merged).toHaveLength(0);
    expect((await getApproval(id))?.status).toBe("stale");
  });

  test("an unreadable PR head refuses the merge but stays retryable (pending)", async () => {
    const id = await seedItem();
    const { deps, calls } = approveDeps({ head: null });
    const r = await approveItem(id, GATED, deps);
    expect(r.status).toBe(502);
    expect(calls.merged).toHaveLength(0);
    expect((await getApproval(id))?.status).toBe("pending");
  });

  test("a --match-head-commit refusal (headMoved backstop) marks stale, never retries the new head", async () => {
    const id = await seedItem();
    const { deps, calls } = approveDeps({ mergeOk: false, headMoved: true });
    const r = await approveItem(id, GATED, deps);
    expect(r.status).toBe(409);
    expect(calls.merged).toHaveLength(1); // one pinned attempt, refused by GitHub
    expect((await getApproval(id))?.status).toBe("stale");
  });

  test("a non-head merge failure rolls back to pending (retryable), no Linear transition", async () => {
    const id = await seedItem();
    const { deps, calls } = approveDeps({ mergeOk: false });
    const r = await approveItem(id, GATED, deps);
    expect(r.status).toBe(502);
    expect((await getApproval(id))?.status).toBe("pending");
    expect(calls.transitions).toHaveLength(0);
  });

  test("double-click cannot double-merge: second call is a 409 and merge ran once", async () => {
    const id = await seedItem();
    const { deps, calls } = approveDeps();
    const first = await approveItem(id, GATED, deps);
    const second = await approveItem(id, GATED, deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(calls.merged).toHaveLength(1);
  });

  test("no endpoint can flip a decided item (pushback after approve refused)", async () => {
    const id = await seedItem();
    const { deps } = approveDeps();
    await approveItem(id, GATED, deps);
    const pb = pushbackDeps();
    const r = await pushbackItem(id, "do it differently", pb.deps);
    expect(r.status).toBe(409);
    expect((await getApproval(id))?.status).toBe("approved"); // decision stands
  });

  test("a missing item is a 404, never an action", async () => {
    const { deps, calls } = approveDeps();
    expect((await approveItem(999, GATED, deps)).status).toBe(404);
    expect(calls.merged).toHaveLength(0);
  });

  test("self-repo items CAN be approved — the human IS the merge authority, still pinned", async () => {
    const id = await seedItem({ repo: "adam91holt/factory.ai", prUrl: "https://github.com/adam91holt/factory.ai/pull/5" });
    const { deps, calls } = approveDeps();
    const r = await approveItem(id, GATED, deps);
    expect(r.status).toBe(200);
    expect(calls.merged).toEqual([["adam91holt/factory.ai", "https://github.com/adam91holt/factory.ai/pull/5", GATED]]);
  });
});

describe("approve is bound to the evidence the human SAW", () => {
  test("a card rendered against a different gated SHA is refused — no claim, no merge, still approvable", async () => {
    const id = await seedItem();
    const { deps, calls } = approveDeps();
    const r = await approveItem(id, MOVED, deps);
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toContain("card is out of date");
    expect(calls.merged).toHaveLength(0);
    // The row is untouched: a stale tab costs a refresh, never the item.
    expect((await getApproval(id))?.status).toBe("pending");
    expect((await approveItem(id, GATED, deps)).status).toBe(200);
  });

  test("an approve with no gatedHeadSha at all cannot merge an item that has one", async () => {
    const id = await seedItem();
    const { deps, calls } = approveDeps();
    expect((await approveItem(id, undefined, deps)).status).toBe(409);
    expect((await approveItem(id, "", deps)).status).toBe(409);
    expect(calls.merged).toHaveLength(0);
    expect((await getApproval(id))?.status).toBe("pending");
  });

  test("approvalEvidenceMatches: case/whitespace-insensitive, both-absent matches, one-sided never does", () => {
    expect(approvalEvidenceMatches(GATED.toUpperCase(), GATED)).toBe(true);
    expect(approvalEvidenceMatches(` ${GATED} `, GATED)).toBe(true);
    expect(approvalEvidenceMatches(null, null)).toBe(true);
    expect(approvalEvidenceMatches(GATED, null)).toBe(false);
    expect(approvalEvidenceMatches(null, GATED)).toBe(false);
    expect(approvalEvidenceMatches(42, GATED)).toBe(false);
  });

  test("a superseded card cannot merge the run that replaced it", async () => {
    await seedItem();                                      // the card the human is looking at
    const fresh = await seedItem({ gatedHeadSha: MOVED }); // a re-run supersedes it
    const { deps, calls } = approveDeps({ head: MOVED });
    // The human clicks approve on the OLD card; its id is stale, but even the
    // NEW row refuses the old card's SHA.
    expect((await approveItem(fresh, GATED, deps)).status).toBe(409);
    expect(calls.merged).toHaveLength(0);
  });
});

describe("integrity-hold prominence (regateFailed)", () => {
  const ws = { dir: "/tmp/x", branch: "factory/FAC-1", baseRef: "origin/main" } as Workspace;

  test("the flag is set by the LIVE preMergeIntegrity red-re-gate hold (marker coupling)", async () => {
    const result = await preMergeIntegrity(ws, GATED, {
      fetchBase: () => ({ ok: true, out: "" }),
      commitsBehindBase: () => 3,
      mergeBaseIntoBranch: () => ({ ok: true, out: "" }),
      regate: () => ({ green: false, failures: [{ name: "test" }] }),
      push: () => {},
      headSha: () => MOVED,
    });
    expect(result.ok).toBe(false);
    // The producer's phrasing, straight into the consumer's predicate: if
    // loop.ts rewords the hold, this fails instead of silently dropping the
    // banner from the card.
    expect(regateFailedAgainstMain(`merge-integrity: ${(result as { hold: string }).hold}`)).toBe(true);
  });

  test("ordinary holds do not raise it", () => {
    expect(regateFailedAgainstMain("guarded paths touched: src/config.ts")).toBe(false);
    expect(regateFailedAgainstMain("security review returned a FAIL verdict")).toBe(false);
    // A branch that moved is a different failure — approve's freshness check
    // catches that one; this flag is about a green that describes an old main.
    expect(regateFailedAgainstMain("merge-integrity: branch moved since gates passed (--match-head-commit refused the merge) — the new head was never gated; human must re-review")).toBe(false);
  });

  test("fileApproval persists the flag so the card can shout, and approve is still allowed", async () => {
    const id = await fileApproval({
      issueKey: "FAC-60", title: "t", repo: "acme/widgets", prUrl: "https://github.com/acme/widgets/pull/60",
      gatedHeadSha: GATED,
      holdReasons: "merge-integrity: branch was 3 commit(s) behind origin/main; after updating, gates FAILED against the combined head (test)",
      gateSummary: { green: true, strength: "strong", tests: [] }, securityVerdict: "pass",
      tasteVerdict: "not-required", findingsDigest: "", diffStat: "", costUsd: 1, turns: 5,
    }, () => {});
    expect(id).not.toBeNull();
    expect((await getApproval(id!))?.regateFailed).toBe(true);
    // Presentation + flag, NOT a new block: informed human authority stands.
    const { deps, calls } = approveDeps();
    expect((await approveItem(id!, GATED, deps)).status).toBe(200);
    expect(calls.merged).toHaveLength(1);
  });
});

describe("owner pushback directive survives a run that never delivered", () => {
  const handoffDeps = () => {
    const restored: string[] = [];
    return {
      restored,
      deps: {
        take: takePushbackFeedback,
        restore: async (key: string, fb: string) => { restored.push(`${key}: ${fb}`); return restorePushbackFeedback(key, fb); },
      },
    };
  };

  test("an EARLY park never consumes it — the next run still gets the directive", async () => {
    await recordPushbackFeedback("FAC-70", "use the existing helper");
    const { deps, restored } = handoffDeps();
    // Workspace error / deps failure / freshness park / budget expiry: the run
    // ends before the implementer prompt is built, so take() was never called.
    await ownerFeedbackHandoff("FAC-70", deps).settle(false);
    expect(restored).toEqual([]);              // nothing to put back — nothing was taken
    expect(await takePushbackFeedback("FAC-70")).toBe("use the existing helper");
  });

  test("a park AFTER the implementer read it puts it back for the next attempt", async () => {
    await recordPushbackFeedback("FAC-71", "use the existing helper");
    const { deps } = handoffDeps();
    const h = ownerFeedbackHandoff("FAC-71", deps);
    expect(await h.take()).toBe("use the existing helper");
    expect(await takePushbackFeedback("FAC-71")).toBeNull(); // genuinely consumed mid-run
    await h.settle(false);                                   // run parked before any PR
    expect(await takePushbackFeedback("FAC-71")).toBe("use the existing helper");
  });

  test("a delivering run consumes it exactly once — settle twice cannot resurrect it", async () => {
    await recordPushbackFeedback("FAC-72", "split the endpoint");
    const { deps, restored } = handoffDeps();
    const h = ownerFeedbackHandoff("FAC-72", deps);
    expect(await h.take()).toBe("split the endpoint");
    await h.settle(true);
    await h.settle(false); // a stray second settle must not restore a spent directive
    expect(restored).toEqual([]);
    expect(await takePushbackFeedback("FAC-72")).toBeNull();
  });

  test("take is memoized: two reads in one run hit the store once", async () => {
    await recordPushbackFeedback("FAC-73", "one directive");
    const { deps } = handoffDeps();
    const h = ownerFeedbackHandoff("FAC-73", deps);
    expect(await h.take()).toBe("one directive");
    expect(await h.take()).toBe("one directive"); // not null — the take-once already happened
  });

  test("restoring never clobbers a directive the owner recorded DURING the run", async () => {
    await recordPushbackFeedback("FAC-74", "old direction");
    const { deps } = handoffDeps();
    const h = ownerFeedbackHandoff("FAC-74", deps);
    await h.take();
    await recordPushbackFeedback("FAC-74", "actually, do this instead"); // owner pushes back again
    await h.settle(false);
    expect(await takePushbackFeedback("FAC-74")).toBe("actually, do this instead");
  });
});

describe("pushback — the feedback loop", () => {
  test("posts OWNER FEEDBACK, stores the directive, requeues via the existing mechanism — and cannot merge", async () => {
    const id = await seedItem();
    const { deps, calls } = pushbackDeps();
    const r = await pushbackItem(id, "split the endpoint and add a test for the 409 path", deps);
    expect(r.status).toBe(200);
    expect((await getApproval(id))?.status).toBe("pushed_back");
    expect(calls.comments.join("\n")).toContain("OWNER FEEDBACK");
    expect(calls.removedLabels).toEqual(["Factory-Needs-Human", "Factory-Parked"]);
    expect(calls.transitions).toEqual(["queue"]);
    // The directive reaches the next run through the take-once handoff.
    expect(await takePushbackFeedback("FAC-43")).toBe("split the endpoint and add a test for the 409 path");
    // Structural: PushbackDeps has no merge member at all.
    expect("mergePr" in deps).toBe(false);
  });

  test("rejects an empty / non-string feedback body without claiming the item", async () => {
    const id = await seedItem();
    const { deps } = pushbackDeps();
    expect((await pushbackItem(id, "", deps)).status).toBe(400);
    expect((await pushbackItem(id, 42, deps)).status).toBe(400);
    expect((await getApproval(id))?.status).toBe("pending");
  });

  test("a failed requeue rolls the item back to pending (retryable)", async () => {
    const id = await seedItem();
    const { deps } = pushbackDeps({ transitionOk: false });
    const r = await pushbackItem(id, "please fix", deps);
    expect(r.status).toBe(502);
    expect((await getApproval(id))?.status).toBe("pending");
  });

  test("feedback is redact-scanned and length-capped", async () => {
    expect(normalizeFeedback(`use env var lin_api_${"a".repeat(24)} here`)).toContain("[REDACTED-SECRET]");
    expect(normalizeFeedback("x".repeat(9000))?.length).toBe(4000);
    expect(normalizeFeedback("   ")).toBeNull();
  });
});

describe("filing + view", () => {
  test("the owner notification gets the REDACTED, clamped title — not the raw ticket text", async () => {
    const notices: ApprovalNotice[] = [];
    const leak = `deploy with lin_api_${"c".repeat(24)} ${"x".repeat(400)}`;
    await fileApproval({
      issueKey: "FAC-52", title: leak, repo: "acme/widgets", prUrl: "https://github.com/acme/widgets/pull/12",
      gatedHeadSha: GATED, holdReasons: "guarded paths touched: src/config.ts",
      gateSummary: null, securityVerdict: "pass", tasteVerdict: "not-required",
      findingsDigest: "", diffStat: "", costUsd: 0, turns: 0,
    }, (n) => { notices.push(n); });
    const notice = notices[0]!;
    expect(notice.title).toContain("[REDACTED-SECRET]");
    expect(notice.title).not.toContain("lin_api_");
    expect(notice.title.length).toBe(300); // clamped like the stored row
  });

  test("fileApproval persists a redacted card and approvalsView serves it with a count", async () => {
    const id = await fileApproval({
      issueKey: "FAC-50", title: "add auth", repo: "acme/widgets", prUrl: "https://github.com/acme/widgets/pull/9",
      gatedHeadSha: GATED, holdReasons: `security review FAIL — token lin_api_${"b".repeat(24)} leaked`,
      gateSummary: { green: true, strength: "strong", tests: [{ name: "test", from: 10, to: 12 }] },
      securityVerdict: "fail", tasteVerdict: "pass", findingsDigest: "one real finding fixed",
      diffStat: "2 files · 30 changed lines", costUsd: 2.5, turns: 30,
    }, () => {});
    expect(id).not.toBeNull();
    const view = await approvalsView();
    expect(view.count).toBe(1);
    const item = view.pending[0]!;
    expect(item.issueKey).toBe("FAC-50");
    expect(item.holdReasons).toContain("[REDACTED-SECRET]");
    expect(item.gatedHeadSha).toBe(GATED);
    expect(item.gateSummary?.tests).toEqual([{ name: "test", from: 10, to: 12 }]);
  });

  test("fileApproval returns null (and files nothing durable) when the store is closed", async () => {
    await closeTestDatabase();
    const id = await fileApproval({
      issueKey: "FAC-51", title: "x", repo: "a/b", prUrl: "https://github.com/a/b/pull/1",
      gatedHeadSha: GATED, holdReasons: "r", gateSummary: null, securityVerdict: "none",
      tasteVerdict: "not-required", findingsDigest: "", diffStat: "", costUsd: 0, turns: 0,
    }, () => {});
    expect(id).toBeNull();
    await openTestDatabase(); // afterEach closes again
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
