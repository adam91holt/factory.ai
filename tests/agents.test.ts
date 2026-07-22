import { describe, expect, test } from "bun:test";
import { stageBudgetUsd } from "../src/agents.ts";

// B8: two parallel reviewers (loop.ts) now split budget.remainingUsd instead of
// each getting it in full — but that split only matters if the per-stage floor
// stops re-inflating a small-but-positive remainder back up to $0.50. The old
// `Math.max(0.5, opts.budgetUsd)` did exactly that, letting a near-exhausted
// issue budget be doubled right back by the floor itself.
describe("stageBudgetUsd (B8: floor must not exceed a positive remainder)", () => {
  test("a small positive remainder passes through UNCHANGED — never floored up", () => {
    expect(stageBudgetUsd(0.1)).toBe(0.1);
    expect(stageBudgetUsd(0.01)).toBe(0.01);
    expect(stageBudgetUsd(0.001)).toBe(0.001);
  });

  test("a half-split of a small remaining budget stays half — the exact B8 scenario", () => {
    const remainingUsd = 0.4;
    const perReviewer = remainingUsd / 2;
    expect(stageBudgetUsd(perReviewer)).toBe(0.2);
    // Both parallel legs together must not exceed what was actually left.
    expect(stageBudgetUsd(perReviewer) * 2).toBeLessThanOrEqual(remainingUsd);
  });

  test("a remainder at or above the floor passes through unchanged", () => {
    expect(stageBudgetUsd(0.5)).toBe(0.5);
    expect(stageBudgetUsd(25)).toBe(25);
  });

  test("zero or negative (issue budget already exhausted) falls back to the defensive floor", () => {
    expect(stageBudgetUsd(0)).toBe(0.5);
    expect(stageBudgetUsd(-1)).toBe(0.5);
  });
});
