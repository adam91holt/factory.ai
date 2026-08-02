// The write-behind event queue — the ONE place db.ts bridges the sync/async seam.
//
// bus.emit is synchronous, never-throws and fire-and-forget (events.ts), and
// ~40 call sites depend on that. A Postgres client is async. db.ts resolves the
// two with a bounded single-flight FIFO queue: the bus subscriber only
// ENQUEUES, a serial drain writes batches, and every read path awaits
// flushEvents() first so write-behind is invisible to readers.
//
// Three properties make that substitution safe, and all three are pinned here:
//   1. ORDER. Identity ids must be assigned in EMIT order — lastParkReasonForIssue
//      reads ORDER BY id DESC and issueEvents ORDER BY id ASC, so if the drain
//      ever went concurrent, "the newest park reason" would become "whichever
//      write won the race". 500 events cross the 256-row batch boundary on
//      purpose.
//   2. DRAIN-BEFORE-READ. A reader called with no explicit flush must still see
//      an event emitted a microsecond earlier, or write-behind would be a
//      behaviour change rather than an implementation detail.
//   3. BOUNDEDNESS. A Postgres outage must not turn the queue into an OOM.
//      MAX_QUEUED_EVENTS is an in-code constant (CLAUDE.md: a cap that can be
//      set to infinity is not a cap) and overflow drops loudly instead of
//      throwing back into emit.
//
// This is the only file that opens the test store with { subscribeBus: true }.
// Every other test file leaves the subscription off — an attached store-backed
// subscriber would make ~35 files pay for durable writes they do not assert on.
// closeTestDatabase() always detaches it and quiesces any in-flight drain.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { bus } from "../src/events.ts";
import {
  openTestDatabase, closeTestDatabase, flushEvents, pendingEventWrites, storeHealth,
  issueEvents, lastParkReasonForIssue, stageRunCountForIssueSince, getTelemetry,
} from "../src/db.ts";

beforeEach(async () => { await openTestDatabase({ subscribeBus: true }); });
afterEach(async () => { await closeTestDatabase(); });

describe("write-behind queue — ordering", () => {
  test("500 synchronous emits land as 500 rows in emit order", async () => {
    const N = 500;   // > EVENT_BATCH (256), so this spans multiple INSERTs
    for (let i = 0; i < N; i++) {
      bus.emit({ type: "issue_needs_human", issueKey: "FAC-ORDER", reason: `r${i}` });
    }
    await flushEvents();

    const rows = await issueEvents("FAC-ORDER") as { seq: number; reason: string }[];
    expect(rows.length).toBe(N);
    // issueEvents is ORDER BY id ASC. If ids did not follow emit order this
    // would come back shuffled.
    expect(rows.map((r) => r.reason)).toEqual(Array.from({ length: N }, (_, i) => `r${i}`));
    // bus seq is monotonic from emit; id order must agree with it.
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i]?.seq ?? 0) > (rows[i - 1]?.seq ?? 0)).toBe(true);
    }
    expect(pendingEventWrites()).toBe(0);
    expect(storeHealth().dropped).toBe(0);
  });

  test("newest-first reads see the LAST emit, not whichever write finished first", async () => {
    for (const reason of ["first park", "second park", "newest park"]) {
      bus.emit({ type: "issue_needs_human", issueKey: "FAC-NEWEST", reason });
    }
    await flushEvents();
    // ORDER BY id DESC LIMIT 50 — the steward's child-status input.
    expect(await lastParkReasonForIssue("FAC-NEWEST")).toBe("newest park");
  });
});

describe("write-behind queue — drain before read", () => {
  test("a read with NO explicit flush still sees an event emitted a moment ago", async () => {
    bus.emit({ type: "issue_needs_human", issueKey: "FAC-DRAIN", reason: "unflushed" });
    // Nothing has been written yet — the emit only enqueued.
    expect(pendingEventWrites()).toBe(1);
    // ...and yet the reader sees it, because every read path awaits flushEvents().
    expect(await lastParkReasonForIssue("FAC-DRAIN")).toBe("unflushed");
    expect(pendingEventWrites()).toBe(0);
  });

  test("the governance counters drain too (they gate real spend)", async () => {
    const at = Date.now();
    for (let i = 0; i < 3; i++) {
      bus.emit({ type: "run_stage_finished", issueKey: "GK-probe", stage: "implementer",
        costUsd: 0.5, turns: 2, wallSeconds: 1, resultText: "" });
    }
    expect(pendingEventWrites()).toBe(3);
    // stageRunCountForIssueSince backs a groundskeeper's weekly run envelope —
    // reading 0 here because writes were still queued would be fail-OPEN.
    expect(await stageRunCountForIssueSince("GK-probe", at - 1000)).toBe(3);
  });

  test("telemetry drains before aggregating", async () => {
    bus.emit({ type: "run_stage_finished", issueKey: "FAC-T", stage: "implementer",
      costUsd: 2.5, turns: 4, wallSeconds: 1, resultText: "" });
    const t = await getTelemetry();
    expect(t.totals.stageRuns).toBe(1);
    expect(t.totals.costUsd).toBeCloseTo(2.5, 10);
    expect(t.totals.turns).toBe(4);
  });
});

describe("write-behind queue — boundedness", () => {
  test("emit never throws and the queue never exceeds MAX_QUEUED_EVENTS", async () => {
    // MAX_QUEUED_EVENTS is 10_000 in db.ts (in-code constant, not an env knob).
    // A tight synchronous loop never yields, so the drain cannot run and the
    // queue fills exactly — which is the shape a Postgres outage produces.
    const CAP = 10_000;
    const OVER = 100;
    expect(() => {
      for (let i = 0; i < CAP + OVER; i++) {
        bus.emit({ type: "issue_needs_human", issueKey: "FAC-FLOOD", reason: `f${i}` });
      }
    }).not.toThrow();

    const health = storeHealth();
    expect(health.open).toBe(true);
    // BOUNDED: never more than the cap plus the one batch already in flight
    // (the very first emit starts a drain synchronously, which splices a batch
    // out of the queue before the loop's second emit is even pushed).
    expect(health.pending).toBeLessThanOrEqual(CAP + 256);
    expect(health.pending).toBeGreaterThanOrEqual(CAP);
    // Overflow is DROPPED (loudly), never buffered without limit and never
    // thrown back into the synchronous emit contract.
    expect(health.dropped).toBeGreaterThan(0);
    // CONSERVED: every emitted event is either still pending or counted as
    // dropped — the queue never loses one silently.
    expect(health.pending + health.dropped).toBe(CAP + OVER);

    // afterEach's closeTestDatabase() empties the queue and waits for the one
    // batch already in flight, so nothing from this flood can land after the
    // next test's TRUNCATE.
  });

  test("closing the store leaves nothing queued or in flight", async () => {
    bus.emit({ type: "issue_needs_human", issueKey: "FAC-CLOSE", reason: "x" });
    expect(pendingEventWrites()).toBe(1);
    await closeTestDatabase();
    expect(pendingEventWrites()).toBe(0);
    expect(storeHealth().open).toBe(false);
    // The subscription is gone with the store, so a later emit cannot enqueue
    // against a closed handle — and still does not throw.
    expect(() => bus.emit({ type: "issue_needs_human", issueKey: "FAC-CLOSE", reason: "y" })).not.toThrow();
    expect(pendingEventWrites()).toBe(0);
    await openTestDatabase({ subscribeBus: true });   // afterEach closes again
  });
});
