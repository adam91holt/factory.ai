import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../src/config.ts";
import { bus } from "../src/events.ts";
import { drainInfo, isDraining, resetDrainForTest } from "../src/control.ts";
import { resetSpendCapForTest, rollingSpendUsd, startSpendCap } from "../src/spend-cap.ts";

// Prerequisite-0 rolling spend cap (T5, docs/planning/autonomy.md "Build order"
// item 0). resetSpendCapForTest()/resetDrainForTest() mirror db.ts's
// closeTestDatabase() seam — module-level state must not leak across tests.

const originalBudgetUsdPerDay = config.caps.budgetUsdPerDay;

beforeEach(() => {
  resetDrainForTest();
  resetSpendCapForTest();
});
afterEach(() => {
  config.caps.budgetUsdPerDay = originalBudgetUsdPerDay;
  resetDrainForTest();
  resetSpendCapForTest();
});

function emitStage(costUsd: number, issueKey = "FAC-1"): void {
  bus.emit({ type: "run_stage_finished", issueKey, stage: "implementer", costUsd, turns: 1, wallSeconds: 1, resultText: "" });
}

describe("rollingSpendUsd", () => {
  test("zero with nothing observed", () => {
    expect(rollingSpendUsd()).toBe(0);
  });

  test("sums run_stage_finished costUsd seen while subscribed", () => {
    const unsubscribe = startSpendCap();
    try {
      emitStage(1.5);
      emitStage(2.25);
      expect(rollingSpendUsd()).toBeCloseTo(3.75, 5);
    } finally {
      unsubscribe();
    }
  });

  test("ignores event types other than run_stage_finished", () => {
    const unsubscribe = startSpendCap();
    try {
      bus.emit({ type: "tick_started" });
      bus.emit({ type: "issue_needs_human", issueKey: "FAC-2", reason: "x" });
      expect(rollingSpendUsd()).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  test("entries older than the trailing 24h are pruned out", () => {
    const unsubscribe = startSpendCap();
    try {
      emitStage(5);
      expect(rollingSpendUsd()).toBeCloseTo(5, 5); // still within the window "now"
      const past25h = Date.now() + 25 * 60 * 60 * 1000;
      expect(rollingSpendUsd(past25h)).toBe(0); // pruned once 24h has elapsed
    } finally {
      unsubscribe();
    }
  });
});

describe("startSpendCap — drain mode on MAX_BUDGET_USD_PER_DAY", () => {
  test("under the cap: no drain entered", () => {
    config.caps.budgetUsdPerDay = 10;
    const unsubscribe = startSpendCap();
    try {
      emitStage(4);
      emitStage(4);
      expect(isDraining()).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  test("crossing the cap enters drain with trigger budget_cap", () => {
    config.caps.budgetUsdPerDay = 1;
    const unsubscribe = startSpendCap();
    try {
      emitStage(0.6);
      expect(isDraining()).toBe(false); // 0.60 <= 1.00
      emitStage(0.6);
      expect(isDraining()).toBe(true); // 1.20 > 1.00
      expect(drainInfo().reason).toContain("MAX_BUDGET_USD_PER_DAY");
      expect(drainInfo().reason).toContain("1.00");
    } finally {
      unsubscribe();
    }
  });

  test("exactly at the cap does not trip (strictly greater-than)", () => {
    config.caps.budgetUsdPerDay = 5;
    const unsubscribe = startSpendCap();
    try {
      emitStage(5);
      expect(isDraining()).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  test("unsubscribing stops further spend from being tallied or tripping drain", () => {
    config.caps.budgetUsdPerDay = 1;
    const unsubscribe = startSpendCap();
    unsubscribe();
    emitStage(100); // way over cap, but no subscriber is listening anymore
    expect(isDraining()).toBe(false);
  });
});
