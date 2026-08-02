import { afterEach, describe, expect, test } from "bun:test";
import { bus } from "../src/events.ts";
import { closeTestDatabase, getTelemetry, openTestDatabase } from "../src/db.ts";

// issue #8 F7 — telemetry single-flight staleness. getTelemetry shares one
// in-flight computeTelemetry() between simultaneous callers (stampede guard),
// but the shared promise used to be adoptable by ANY later caller — including
// one whose own events flushed AFTER the compute began, handing that caller an
// aggregate older than what it just wrote. The fix keys the in-flight promise
// on the flush watermark: adopt only when the compute started at-or-after your
// own flush.
//
// Determinism comes from the db.ts test seam's `holdQueryResult` option: the
// first query matching a substring has its rows fetched from the engine and
// then HELD before being returned, parking one compute mid-flight at a point
// where its data is already frozen. That is exactly the shape of the race —
// no timers, no sleeps.

// The run_finished scan inside computeTelemetry. The watermark query also
// mentions 'run_finished' but has no ORDER BY; the stage scan orders by id but
// matches 'run_stage_finished' — this substring hits exactly one query.
const RUN_SCAN = "type = 'run_finished' ORDER BY";

function emitRun(issueKey: string, outcome: "pr_open" | "merged"): void {
  bus.emit({
    type: "run_finished", issueKey, outcome, prUrl: null, costUsd: 0,
    stages: [], gateStrength: "none", guardedPaths: [], dryRun: false,
  });
}

afterEach(async () => { await closeTestDatabase(); });

describe("getTelemetry — single-flight keyed on the flush watermark (issue #8 F7)", () => {
  test("a caller never receives an aggregate older than its own flushed events", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let onHeld!: () => void;
    const held = new Promise<void>((r) => { onHeld = r; });
    await openTestDatabase({ subscribeBus: true, holdQueryResult: { contains: RUN_SCAN, release: gate, onHeld } });

    emitRun("FAC-A", "pr_open");
    const p1 = getTelemetry();     // flushes A, then its compute parks holding runs=[A]
    await held;                    // the compute HAS read its rows — its result is frozen at 1 run

    emitRun("FAC-B", "merged");
    const p2 = getTelemetry();     // flushes B; the old code would adopt p1's stale compute here

    release();
    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1.totals.runs).toBe(1);          // the parked compute really was stale…
    expect(t2.totals.runs).toBe(2);          // …and the second caller did NOT inherit it
    expect(t2.outcomes.pr_open).toBe(1);
    expect(t2.outcomes.merged).toBe(1);
  });

  test("callers at the SAME flush watermark still share one in-flight compute (stampede guard intact)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let onHeld!: () => void;
    const held = new Promise<void>((r) => { onHeld = r; });
    await openTestDatabase({ subscribeBus: true, holdQueryResult: { contains: RUN_SCAN, release: gate, onHeld } });

    emitRun("FAC-A", "pr_open");
    const p1 = getTelemetry();
    await held;
    const p2 = getTelemetry();     // nothing new flushed — same watermark, must share
    release();
    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t2).toBe(t1);           // literally the same aggregate object: one compute ran
    expect(t1.totals.runs).toBe(1);
  });
});
