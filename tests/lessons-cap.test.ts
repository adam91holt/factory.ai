// The distiller daily-cap check-then-act race (issue #8 F3).
//
// captureLesson's cap check awaits a DB round-trip (lessonRowCountSince)
// between reading today's count and bumping the in-memory counter. A park
// storm makes captures CONCURRENT — several failures land in the same tick —
// and every concurrent caller could pass the `< MAX` check before any of them
// incremented, overshooting the cap. Same shape as the merge-ladder lost
// update fixed in db.ts (ladderLocks); same fix: a promise-chain mutex held
// across exactly the check + increment. reserveDistillerCall() is that
// critical section, exported so this file can hammer it directly.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { openTestDatabase, closeTestDatabase, insertLessonRow } from "../src/db.ts";
import { reserveDistillerCall, resetDistillerBudgetForTests, MAX_DISTILLER_CALLS_PER_DAY } from "../src/lessons.ts";

beforeEach(async () => {
  await openTestDatabase();
  resetDistillerBudgetForTests();
});
afterEach(async () => {
  resetDistillerBudgetForTests(); // never leak a spent budget into another file
  await closeTestDatabase();
});

describe("distiller daily cap — atomic reservation", () => {
  test(`CONCURRENT reservations can never exceed the cap (${MAX_DISTILLER_CALLS_PER_DAY}/day)`, async () => {
    // Fire well past the cap SIMULTANEOUSLY — the park-storm shape. Without
    // the mutex every one of these awaits the same DB count (0), passes the
    // check, and increments afterwards: all N would be granted.
    const N = MAX_DISTILLER_CALLS_PER_DAY + 7;
    const granted = await Promise.all(Array.from({ length: N }, () => reserveDistillerCall()));
    expect(granted.filter(Boolean).length).toBe(MAX_DISTILLER_CALLS_PER_DAY);
    // The budget is spent: later (sequential) callers are refused too.
    expect(await reserveDistillerCall()).toBe(false);
  });

  test("sequential reservations grant exactly up to the cap, then refuse", async () => {
    for (let i = 0; i < MAX_DISTILLER_CALLS_PER_DAY; i++) {
      expect(await reserveDistillerCall()).toBe(true);
    }
    expect(await reserveDistillerCall()).toBe(false);
    expect(await reserveDistillerCall()).toBe(false); // stays closed, no wobble
  });

  test("persisted rows floor the counter across a 'restart' (in-memory state wiped)", async () => {
    // Today's budget was already spent as WRITTEN rows; the process restarts
    // (in-memory counter gone). The DB floor must keep the gate closed rather
    // than re-earning a fresh MAX_DISTILLER_CALLS_PER_DAY.
    const now = Date.now();
    for (let i = 0; i < MAX_DISTILLER_CALLS_PER_DAY; i++) {
      expect(await insertLessonRow({
        createdAt: now, repo: "acme/x", stage: "implementer", issueKey: `FAC-${i}`,
        lesson: `when X${i}, do Y`, sourceReason: "parked",
      })).toBe(true);
    }
    resetDistillerBudgetForTests(); // the "restart"
    expect(await reserveDistillerCall()).toBe(false);
  });

  test("a failed store read inside one reservation does not wedge the gate for the next", async () => {
    // The mutex must release on the rejection path too (the previous-holder
    // await is .catch()-wrapped). Close the store mid-chain: reserve still
    // resolves (closed store reads 0 → grant) rather than deadlocking.
    await closeTestDatabase();
    resetDistillerBudgetForTests();
    const first = await reserveDistillerCall();
    const second = await reserveDistillerCall();
    // Values are secondary (closed-store lesson reads return 0 by the frozen
    // db-closed-store contract); the property under test is that both calls
    // RETURN — the chain never jams.
    expect(typeof first).toBe("boolean");
    expect(typeof second).toBe("boolean");
    await openTestDatabase();
  });
});
