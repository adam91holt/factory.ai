import { describe, expect, test } from "bun:test";
import type { GateMeta } from "../ui/src/lib/events.ts";
import {
  approveDisabledReason,
  splitApprovals,
  statusLabel,
  testCountDelta,
  type ApprovalItem,
} from "../ui/src/lib/approvals.ts";

// The review queue's pure logic: the pending/handled split the page renders,
// and — the safety-relevant piece — approveDisabledReason, which decides when
// [Approve & merge] is even offered. TIGHTEN-ONLY: the button must disappear
// for stale/handled items and for anything missing a PR or a gated head SHA
// (nothing to pin --match-head-commit to); the backend re-checks all of this,
// these tests pin the UI's belt to those braces.

function item(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: "FAC-1", issueKey: "FAC-1", title: "t", repo: "acme/x",
    parkedAt: 1000, holdReasons: ["guarded paths touched: src/config.ts"],
    prUrl: "https://github.com/acme/x/pull/1", linearUrl: null,
    costUsd: 1, turns: 10,
    gates: { green: true, strength: "strong", gates: [] },
    securityVerdict: "pass", tasteVerdict: null, browser: "pass",
    findings: null, diffStat: null, gatedHeadSha: "abc123",
    status: "pending", staleReason: null, handledAt: null,
    ...overrides,
  };
}

describe("splitApprovals — the two sections of the review queue", () => {
  test("pending sorts oldest-first (longest wait on top), handled newest-handled-first", () => {
    const items = [
      item({ id: "a", parkedAt: 3000 }),
      item({ id: "b", parkedAt: 1000 }),
      item({ id: "c", status: "approved", handledAt: 500 }),
      item({ id: "d", status: "pushed_back", handledAt: 900 }),
      item({ id: "e", status: "stale", handledAt: null, parkedAt: 700 }),
    ];
    const { pending, handled } = splitApprovals(items);
    expect(pending.map((i) => i.id)).toEqual(["b", "a"]);
    // e has no handledAt — falls back to parkedAt (700) for ordering.
    expect(handled.map((i) => i.id)).toEqual(["d", "e", "c"]);
  });

  test("handled is capped (last 10 by default) so the queue keeps context without clutter", () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      item({ id: `h${i}`, status: "approved", handledAt: i }),
    );
    const { handled } = splitApprovals(items);
    expect(handled.length).toBe(10);
    // the 10 MOST RECENTLY handled survive, newest first
    expect(handled[0]!.id).toBe("h14");
    expect(handled[9]!.id).toBe("h5");
  });

  test("never mutates its input", () => {
    const items = [item({ id: "a", parkedAt: 2 }), item({ id: "b", parkedAt: 1 })];
    splitApprovals(items);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("approveDisabledReason — when [Approve & merge] may not be offered", () => {
  test("a clean pending item is approvable", () => {
    expect(approveDisabledReason(item())).toBeNull();
  });

  test("stale item is disabled with its verbatim stale reason", () => {
    const r = approveDisabledReason(
      item({ status: "stale", staleReason: "branch moved since gating — needs re-gate" }),
    );
    expect(r).toBe("branch moved since gating — needs re-gate");
  });

  test("stale item with no recorded reason still refuses (never silently enables)", () => {
    expect(approveDisabledReason(item({ status: "stale" }))).toContain("stale");
  });

  test("a PENDING item the backend flagged stale between polls loses the button too", () => {
    const r = approveDisabledReason(item({ staleReason: "branch moved since gating — needs re-gate" }));
    expect(r).toBe("branch moved since gating — needs re-gate");
  });

  test("already-handled items can never be re-approved", () => {
    expect(approveDisabledReason(item({ status: "approved" }))).toBe("already approved");
    expect(approveDisabledReason(item({ status: "pushed_back" }))).toBe("already pushed back");
  });

  test("no PR / no gated head SHA → disabled (nothing to merge / nothing to pin to)", () => {
    expect(approveDisabledReason(item({ prUrl: null }))).toContain("no PR");
    expect(approveDisabledReason(item({ gatedHeadSha: null }))).toContain("gated head SHA");
  });
});

describe("testCountDelta — the a→b ratchet evidence on the strip", () => {
  const gate = (over: Partial<GateMeta>): GateMeta => ({
    name: "test", baselinePassed: true, passed: true, outputTail: "", ...over,
  });

  test("first gate with counts wins; decrease flags red", () => {
    const d = testCountDelta([
      gate({ name: "typecheck" }),
      gate({ baselineTestCount: 640, testCount: 631 }),
    ]);
    expect(d).toEqual({ baseline: 640, current: 631, decreased: true });
  });

  test("increase is not a decrease; unknown side is tolerated", () => {
    expect(testCountDelta([gate({ baselineTestCount: 631, testCount: 640 })])!.decreased).toBe(false);
    expect(testCountDelta([gate({ baselineTestCount: null, testCount: 640 })])).toEqual({
      baseline: null, current: 640, decreased: false,
    });
  });

  test("no gate carries counts → null (strip renders nothing)", () => {
    expect(testCountDelta([gate({ name: "typecheck" }), gate({ name: "build" })])).toBeNull();
  });
});

describe("statusLabel", () => {
  test("covers every status", () => {
    expect(statusLabel("pending")).toBe("pending");
    expect(statusLabel("stale")).toBe("stale");
    expect(statusLabel("approved")).toBe("approved");
    expect(statusLabel("pushed_back")).toBe("pushed back");
  });
});
