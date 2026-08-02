// eventStoreOpen() during a mid-run Postgres outage (issue #8 F2).
//
// Before this fix the flag was a ONE-WAY latch: set "open" at startup, never
// cleared when Postgres later became unreachable. The governance gates that
// key on it — groundskeeperTick's budget/parks refusal, captureLesson's skip —
// treat "open" as "reachable", so a mid-run outage left them consulting a
// store that was silently DROPPING the very events they meter: spend reads
// would return stale/partial sums forever, which is fail-OPEN for a budget
// gate. Now a persistent write failure (a batch dropped even after its retry)
// flips eventStoreOpen() to false until a later write proves recovery.
//
// The outage is simulated through the test seam's failEventWrites option: the
// first N event-batch INSERTs reject exactly as an unreachable server would,
// everything else hits the real engine — so the code under test is the real
// drain, not a mock of it.

import { describe, expect, test, afterEach } from "bun:test";
import { bus } from "../src/events.ts";
import {
  openTestDatabase, closeTestDatabase, eventStoreOpen, flushEvents, storeHealth,
} from "../src/db.ts";

afterEach(async () => { await closeTestDatabase(); });

describe("event store outage — the governance gate fails CLOSED", () => {
  test("a PERSISTENT write failure (write + retry both fail) flips eventStoreOpen() false", async () => {
    // failEventWrites: 2 — the batch's first INSERT and its one retry both
    // reject, so the batch is dropped: the exact shape of a real outage.
    await openTestDatabase({ subscribeBus: true, failEventWrites: 2 });
    expect(eventStoreOpen()).toBe(true);

    bus.emit({ type: "issue_needs_human", issueKey: "FAC-OUTAGE", reason: "boom" });
    await flushEvents();

    // The gate is CLOSED: groundskeeperTick refuses to run, captureLesson
    // skips — no governance read consults a store that is dropping events.
    expect(eventStoreOpen()).toBe(false);
    const health = storeHealth();
    expect(health.open).toBe(false);
    expect(health.dropped).toBe(1);
    expect(health.lastError).toContain("simulated postgres outage");
    // ...and it stays a SYNCHRONOUS boolean (the db-closed-store pin, upheld
    // on this path too — a Promise here would read truthy and invert the gate).
    expect(typeof eventStoreOpen()).toBe("boolean");
  });

  test("recovery: the next batch that LANDS reopens the gate", async () => {
    await openTestDatabase({ subscribeBus: true, failEventWrites: 2 });
    bus.emit({ type: "issue_needs_human", issueKey: "FAC-OUTAGE", reason: "boom" });
    await flushEvents();
    expect(eventStoreOpen()).toBe(false);

    // Postgres is "back" (the simulated failures are spent): the next event
    // drains successfully and the gate reopens — no restart required.
    bus.emit({ type: "issue_needs_human", issueKey: "FAC-OUTAGE", reason: "recovered" });
    await flushEvents();
    expect(eventStoreOpen()).toBe(true);
    expect(storeHealth().open).toBe(true);
    // The drop stays on the books (forensics), recovery does not launder it.
    expect(storeHealth().dropped).toBe(1);
  });

  test("a TRANSIENT failure (the retry lands) does NOT flip the gate — semantics stay conservative", async () => {
    await openTestDatabase({ subscribeBus: true, failEventWrites: 1 });
    bus.emit({ type: "issue_needs_human", issueKey: "FAC-BLIP", reason: "blip" });
    await flushEvents();

    // One failed attempt whose retry succeeded is a blip, not an outage:
    // nothing was dropped, so the gates keep running.
    expect(eventStoreOpen()).toBe(true);
    expect(storeHealth().open).toBe(true);
    expect(storeHealth().dropped).toBe(0);
    // The blip is still visible to operators.
    expect(storeHealth().lastError).toContain("simulated postgres outage");
  });

  test("a closed store still reads closed regardless of write health (existing contract untouched)", async () => {
    await closeTestDatabase();
    expect(eventStoreOpen()).toBe(false);
    expect(storeHealth().open).toBe(false);
  });
});
