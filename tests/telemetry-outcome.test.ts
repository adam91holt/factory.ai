import { afterEach, describe, expect, test } from "bun:test";
import { openTestDatabase, closeTestDatabase, insertTestEvent, getTelemetry } from "../src/db.ts";
import { buildReport } from "../src/report.ts";

// B16: auto-merged runs used to be recorded as "pr_open" forever — mergePr's
// success was never persisted anywhere queryable, so the "≤1 human
// intervention" milestone was unmeasurable. These tests pin the fix at both
// ends: the durable telemetry aggregation (db.ts getTelemetry) counts
// "merged" in its own bucket, distinct from "pr_open"; and the ticket-facing
// report (report.ts buildReport) renders a "merged" outcome sensibly.

describe("getTelemetry — B16 'merged' outcome is its own bucket, not folded into pr_open", () => {
  afterEach(() => closeTestDatabase());

  test("a run_finished(outcome: merged) row counts under outcomes.merged / totals.merged, not pr_open", () => {
    openTestDatabase();
    insertTestEvent("run_finished", {
      issueKey: "FAC-1", outcome: "merged", prUrl: "https://github.com/acme/x/pull/1",
      costUsd: 1, stages: [], gateStrength: "strong", guardedPaths: [], dryRun: false,
    });
    const t = getTelemetry();
    expect(t.outcomes.merged).toBe(1);
    expect(t.totals.merged).toBe(1);
    expect(t.outcomes.pr_open).toBe(0);
    expect(t.totals.prOpen).toBe(0);
    expect(t.totals.runs).toBe(1); // still counted as one delivery
  });

  test("merged and pr_open runs are tallied independently in the same aggregate", () => {
    openTestDatabase();
    insertTestEvent("run_finished", { issueKey: "FAC-1", outcome: "merged", prUrl: null, costUsd: 1, stages: [], gateStrength: "strong", guardedPaths: [], dryRun: false });
    insertTestEvent("run_finished", { issueKey: "FAC-2", outcome: "pr_open", prUrl: null, costUsd: 1, stages: [], gateStrength: "strong", guardedPaths: [], dryRun: false });
    insertTestEvent("run_finished", { issueKey: "FAC-3", outcome: "pr_open", prUrl: null, costUsd: 1, stages: [], gateStrength: "strong", guardedPaths: [], dryRun: false });
    const t = getTelemetry();
    expect(t.outcomes.merged).toBe(1);
    expect(t.outcomes.pr_open).toBe(2);
    expect(t.totals.runs).toBe(3);
  });

  test("a dry-run merged event is excluded from delivery counts, like every other outcome", () => {
    openTestDatabase();
    insertTestEvent("run_finished", { issueKey: "FAC-1", outcome: "merged", prUrl: null, costUsd: 1, stages: [], gateStrength: "strong", guardedPaths: [], dryRun: true });
    const t = getTelemetry();
    expect(t.outcomes.merged).toBe(0);
    expect(t.totals.runs).toBe(0);
  });
});

describe("buildReport — B16 'merged' outcome renders distinctly from pr_open", () => {
  test("merged with a prUrl prints a merged line, not the generic Outcome fallback", () => {
    const text = buildReport({
      issueKey: "FAC-1", prUrl: "https://github.com/acme/x/pull/9", outcome: "merged",
      stages: [], gates: [], gateStrength: "strong", guardedPaths: [],
    });
    expect(text).toContain("PR merged: https://github.com/acme/x/pull/9");
    expect(text).not.toContain("PR ready for review");
    expect(text).toContain("outcome: merged");
  });

  test("pr_open (still unmerged) keeps its original text — merged did not steal its branch", () => {
    const text = buildReport({
      issueKey: "FAC-1", prUrl: "https://github.com/acme/x/pull/9", outcome: "pr_open",
      stages: [], gates: [], gateStrength: "strong", guardedPaths: [],
    });
    expect(text).toContain("PR ready for review: https://github.com/acme/x/pull/9");
  });
});

// #12b/#13 (FAC-34): a parked report must (a) tell a human that re-queue is a
// single label removal, and (b) surface the salvage branch URL when park's
// best-effort push landed.
describe("buildReport — parked outcome (#12b push-on-park, #13 requeue-by-label)", () => {
  test("every parked report instructs how to requeue: remove the Factory-Parked label", () => {
    const text = buildReport({
      issueKey: "FAC-1", prUrl: null, outcome: "parked", reason: "gates still failing",
      stages: [], gates: [], gateStrength: "none", guardedPaths: [],
    });
    expect(text).toContain("Remove the `Factory-Parked` label to requeue.");
  });

  test("a parked report with a pushed branch surfaces the salvage URL and records it in the yaml meta", () => {
    const text = buildReport({
      issueKey: "FAC-1", prUrl: null, outcome: "parked", reason: "gates still failing",
      stages: [], gates: [], gateStrength: "none", guardedPaths: [],
      parkedBranchUrl: "https://github.com/acme/widgets/tree/factory/fac-1",
    });
    expect(text).toContain("Work pushed — branch available for salvage:** https://github.com/acme/widgets/tree/factory/fac-1");
    expect(text).toContain('parked_branch: "https://github.com/acme/widgets/tree/factory/fac-1"');
  });

  test("a parked report with no pushed branch (nothing to salvage) omits the salvage line and records null", () => {
    const text = buildReport({
      issueKey: "FAC-1", prUrl: null, outcome: "parked", reason: "workspace setup failed",
      stages: [], gates: [], gateStrength: "none", guardedPaths: [],
    });
    expect(text).not.toContain("available for salvage");
    expect(text).toContain("parked_branch: null");
  });

  test("a non-parked report never carries the requeue-by-label instruction", () => {
    const text = buildReport({
      issueKey: "FAC-1", prUrl: "https://github.com/acme/x/pull/9", outcome: "pr_open",
      stages: [], gates: [], gateStrength: "strong", guardedPaths: [],
    });
    expect(text).not.toContain("Factory-Parked");
  });
});
