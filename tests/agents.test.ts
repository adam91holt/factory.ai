import { describe, expect, test } from "bun:test";
import { stageBudgetUsd, stageCostCapUsd, stageMayResume } from "../src/agents.ts";

// ADVERSARIAL INDEPENDENCE (SDK-leverage item 5). The writer family shares a
// warm session lineage (fixer resumes the implementer so it doesn't re-read the
// files it is fixing). The JUDGES must never inherit the author's conversation —
// a reviewer that shares the author's context inherits the author's
// rationalisations. This is structural, not a convention.
describe("stageMayResume — judges can NEVER resume a session", () => {
  test("every adversarial judge is refused a resume", () => {
    for (const judge of ["reviewer-claude", "reviewer-repo", "reviewer-spec", "reviewer-fallback", "design-reviewer", "security-reviewer", "tester"]) {
      expect(stageMayResume(judge)).toBe(false);
    }
  });
  test("round-suffixed judge labels are covered too (design-reviewer-2, -3, …)", () => {
    expect(stageMayResume("design-reviewer-2")).toBe(false);
    expect(stageMayResume("design-reviewer-3")).toBe(false);
  });
  test("the writer family MAY resume — that is the warm lineage", () => {
    for (const writer of ["implementer", "fixer", "design-fixer", "design-fixer-2", "verify-repair-1"]) {
      expect(stageMayResume(writer)).toBe(true);
    }
  });
});

// Per-stage cost ceilings (in-code caps, telemetry-calibrated 2026-08-03: the
// runaway-implementer tail was 27% of all-time spend because a stage's
// maxBudgetUsd only carried the per-issue remainder).
describe("stageCostCapUsd — in-code per-stage ceilings", () => {
  test("known stages have their calibrated caps", () => {
    expect(stageCostCapUsd("implementer")).toBe(12);
    expect(stageCostCapUsd("fixer")).toBe(6);
    expect(stageCostCapUsd("security-reviewer")).toBe(3);
    expect(stageCostCapUsd("distiller")).toBe(1);
  });
  test("round-suffixed labels normalize to their family cap", () => {
    expect(stageCostCapUsd("design-fixer-2")).toBe(stageCostCapUsd("design-fixer"));
    expect(stageCostCapUsd("design-reviewer-3")).toBe(stageCostCapUsd("design-reviewer"));
    expect(stageCostCapUsd("verify-repair-4")).toBe(stageCostCapUsd("verify-repair"));
  });
  test("unknown labels get the bounded default, never fail open", () => {
    expect(stageCostCapUsd("some-future-stage")).toBe(8);
  });
  test("the ceiling composes with the issue remainder: min() of both", () => {
    // a huge remainder is clamped by the stage cap...
    expect(Math.min(stageBudgetUsd(100), stageCostCapUsd("implementer"))).toBe(12);
    // ...and a small remainder is NOT inflated up to the cap
    expect(Math.min(stageBudgetUsd(0.2), stageCostCapUsd("implementer"))).toBe(0.2);
  });
});

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
