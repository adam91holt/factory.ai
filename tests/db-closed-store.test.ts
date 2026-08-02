// Closed-store contract for EVERY db.ts export.
//
// The daemon runs with the store closed in real configurations (`--once`, a
// Postgres that never came up, a dashboard started before startEventStore
// resolved). Nothing in the pipeline may throw because of that, and — far more
// important — nothing may fail OPEN.
//
// The distinction that makes this file worth its length:
//
//   • Reads return an EMPTY value ([] / 0 / null). For the budget and parks
//     gates that is "nothing spent, ever" — fail-OPEN — which is precisely why
//     groundskeeperTick and captureLesson refuse to run at all unless
//     eventStoreOpen() is true FIRST. That gate is a SYNCHRONOUS boolean read
//     of module state; if a refactor ever made it async, `if (eventStoreOpen())`
//     would start reading a truthy Promise and the governance gate would
//     silently invert. The test below pins the synchronicity, not just the value.
//   • Writes return false/null rather than throwing, so a run never dies over
//     telemetry, and claim/restore guards keep their "did anything change?"
//     semantics.
//
// The Postgres migration rewrote all of these from synchronous bun:sqlite calls
// to awaited Store queries. Every value asserted here is the value the SQLite
// version returned — this file is what makes "closed-store semantics are
// FROZEN" a checkable claim instead of a promise in a commit message.

import { describe, expect, test, beforeEach } from "bun:test";
import { config } from "../src/config.ts";
import { decideMerge, type MergeEvidence } from "../src/merge-ladder.ts";
import {
  closeTestDatabase, eventStoreOpen, flushEvents, pendingEventWrites, storeHealth,
  issueEvents, stageSpendForIssueSince, stageRunCountForIssueSince, parkedRunsSince,
  lastParkReasonForIssue, catalogUsage, getTelemetry,
  insertLessonRow, activeLessonRowsForRepo, allLessonRows, archiveLessonRow, lessonRowCountSince,
  recordStageSession, getStageSession, clearStageSession,
  getLadderState, recordShadowDecision,
  recordDeploy, deployAttempted,
  insertApproval, listPendingApprovals, pendingApprovalCount, pendingApprovalsPage,
  getApproval, claimApproval, finalizeApproval,
  recordPushbackFeedback, restorePushbackFeedback, takePushbackFeedback,
  insertTestEvent, startEventStore,
} from "../src/db.ts";

// Every test in this file runs against a CLOSED store. Other files leave the
// seam open in their own afterEach, so close explicitly rather than assume.
beforeEach(async () => { await closeTestDatabase(); });

describe("closed store — the fail-CLOSED governance gate", () => {
  test("eventStoreOpen() is false, and it is SYNCHRONOUS", () => {
    const open = eventStoreOpen();
    expect(open).toBe(false);
    // Not a Promise. `if (eventStoreOpen())` on a Promise is always truthy,
    // which would turn groundskeepers' budget refusal into a budget bypass.
    // (TypeScript already proves the return type; this is the runtime pin, and
    // the `typeof` form is what survives a signature change to Promise<boolean>
    // — a thenable would report "object" here.)
    expect(typeof open).toBe("boolean");
  });

  test("storeHealth() reports closed with nothing pending", () => {
    expect(storeHealth()).toEqual({ open: false, pending: 0, dropped: 0, lastError: null });
    expect(pendingEventWrites()).toBe(0);
  });

  test("startEventStore() REFUSES a blank FACTORY_DATABASE_URL", async () => {
    // tests/setup.ts blanks FACTORY_DATABASE_URL precisely so no unit test can
    // reach a real Postgres — least of all the owner's live factory store. This
    // pins the guard rather than trusting the env line to stay there.
    expect(config.databaseUrl).toBe("");
    await expect(startEventStore()).rejects.toThrow(/refusing to open a store/);
    expect(eventStoreOpen()).toBe(false);
    // A failed open clears the memo, so the SECOND caller re-runs the guard
    // instead of resolving against a cached in-flight promise.
    await expect(startEventStore()).rejects.toThrow(/refusing to open a store/);
    expect(eventStoreOpen()).toBe(false);
  });

  test("flushEvents() on a closed store resolves instead of spinning", async () => {
    // The drain loop can never make progress without a store; flushEvents must
    // not busy-wait on it (this call would hang the whole suite if it did).
    await flushEvents();
    expect(pendingEventWrites()).toBe(0);
  });
});

describe("closed store — event reads return empty, never throw", () => {
  test("issueEvents → []", async () => {
    expect(await issueEvents("FAC-1")).toEqual([]);
  });

  test("groundskeeper budget/parks reads → 0", async () => {
    // These are the fail-OPEN-shaped values the eventStoreOpen() gate exists
    // to keep unreachable. Frozen deliberately: changing them to a throw would
    // move the failure from a refusal to an exception mid-tick.
    expect(await stageSpendForIssueSince("GK-x", 0)).toBe(0);
    expect(await stageRunCountForIssueSince("GK-x", 0)).toBe(0);
    expect(await parkedRunsSince(0)).toBe(0);
  });

  test("lastParkReasonForIssue → null", async () => {
    expect(await lastParkReasonForIssue("FAC-1")).toBeNull();
  });

  test("catalogUsage → zeroed maps", async () => {
    expect(await catalogUsage()).toEqual({ byStage: {}, byIssueKey: {} });
  });

  test("getTelemetry → the zeroed shape, not a throw", async () => {
    const t = await getTelemetry();
    expect(t.totals.costUsd).toBe(0);
    expect(t.totals.stageRuns).toBe(0);
    expect(t.totals.runs).toBe(0);
    expect(t.perModel).toEqual([]);
    expect(t.perStage).toEqual([]);
    expect(t.costPerIssue).toEqual([]);
    expect(t.parkReasons).toEqual([]);
    expect(t.outcomes).toEqual({ pr_open: 0, merged: 0, planned: 0, parked: 0, needs_human: 0, aborted: 0 });
    // The 7-day window is still zero-filled, so the dashboard renders an empty
    // chart rather than crashing on a missing series.
    expect(t.daily.length).toBe(7);
    expect(typeof t.generatedAt).toBe("number");
  });

  test("insertTestEvent is a no-op (the seam itself is closed too)", async () => {
    await insertTestEvent("run_finished", { issueKey: "FAC-1" });
    expect(await issueEvents("FAC-1")).toEqual([]);
  });
});

describe("closed store — lessons", () => {
  test("insertLessonRow → false (the write did not happen, and says so)", async () => {
    expect(await insertLessonRow({ createdAt: Date.now(), repo: "acme/x", stage: "implementer",
      issueKey: "FAC-1", lesson: "when X, do Y", sourceReason: "parked" })).toBe(false);
  });

  test("lesson reads → [] / 0", async () => {
    expect(await activeLessonRowsForRepo("acme/x", 10)).toEqual([]);
    expect(await allLessonRows(10)).toEqual([]);
    expect(await lessonRowCountSince(0)).toBe(0);
  });

  test("archiveLessonRow → false (nothing changed)", async () => {
    expect(await archiveLessonRow(1)).toBe(false);
  });
});

describe("closed store — stage sessions (resume support)", () => {
  test("record is a no-op, get → null, clear does not throw", async () => {
    await recordStageSession("FAC-1", "implementer", "sess-1");
    expect(await getStageSession("FAC-1", "implementer")).toBeNull();
    await clearStageSession("FAC-1", "implementer");
  });
});

describe("closed store — merge ladder", () => {
  const CLEAN: MergeEvidence = { green: true, strength: "strong", guarded: false,
    needsHuman: false, security: "pass", browser: "pass", diffLines: 5 };

  test("getLadderState → null", async () => {
    expect(await getLadderState("acme/x")).toBeNull();
  });

  test("recordShadowDecision returns the PURE transition, unpersisted", async () => {
    // ADR-0001 / decision logic stays pure and I/O-free: the ladder math must
    // produce the same answer whether or not a database happens to be up.
    const repo = "acme/closed-store-probe";
    const decision = decideMerge("shadow", CLEAN, { lowRiskMaxDiff: config.mergeLadder.lowRiskMaxDiff });

    // Un-enrolled: the B9 gate returns the seed state untouched.
    const unenrolled = await recordShadowDecision(repo, "FAC-1", decision, CLEAN);
    expect(unenrolled.repo).toBe(repo);
    expect(unenrolled.tier).toBe("shadow");
    expect(unenrolled.cleanStreak).toBe(0);

    // Enrolled: the transition still advances in memory, and still persists
    // nothing (there is nowhere to persist it to).
    config.mergeLadder.enrolled.push(repo);
    try {
      const advanced = await recordShadowDecision(repo, "FAC-2", decision, CLEAN);
      expect(advanced.cleanStreak).toBe(1);
      expect(await getLadderState(repo)).toBeNull();
    } finally {
      config.mergeLadder.enrolled = config.mergeLadder.enrolled.filter((r) => r !== repo);
    }
  });
});

describe("closed store — deploy ledger (exactly-once guard)", () => {
  test("recordDeploy is a no-op and deployAttempted → false", async () => {
    // False here is safe rather than fail-open: post-merge deploy is itself
    // double-gated OFF, so nothing reaches this guard with the store closed.
    await recordDeploy("acme/x", "abc123", "ok");
    expect(await deployAttempted("acme/x", "abc123")).toBe(false);
  });
});

describe("closed store — approvals inbox", () => {
  test("insertApproval → null (no row id was minted)", async () => {
    expect(await insertApproval({
      issueKey: "FAC-1", title: "t", repo: "acme/x", prUrl: "https://example.invalid/pr/1",
      gatedHeadSha: "abc", holdReasons: "guarded paths", gateSummary: null,
      securityVerdict: "pass", tasteVerdict: "not-required", findingsDigest: "",
      diffStat: "+1 -0", costUsd: 1.25, turns: 7, regateFailed: false,
    })).toBeNull();
  });

  test("reads → empty page, zero badge, null item", async () => {
    expect(await listPendingApprovals()).toEqual([]);
    expect(await pendingApprovalCount()).toBe(0);
    expect(await pendingApprovalsPage()).toEqual({ pending: [], count: 0 });
    expect(await getApproval(1)).toBeNull();
  });

  test("claimApproval → false — the double-click guard stays CLOSED", async () => {
    // claimApproval is the atomic pending→X transition; returning false means
    // "you did not win the claim", so a closed store can never authorise a merge.
    expect(await claimApproval(1, "approved")).toBe(false);
  });

  test("finalizeApproval does not throw", async () => {
    await finalizeApproval(1, "approved", "merged");
  });
});

describe("closed store — pushback feedback handoff", () => {
  test("record → false, restore → false, take → null", async () => {
    expect(await recordPushbackFeedback("FAC-1", "do it differently")).toBe(false);
    expect(await restorePushbackFeedback("FAC-1", "do it differently")).toBe(false);
    expect(await takePushbackFeedback("FAC-1")).toBeNull();
  });
});
