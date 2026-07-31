import { describe, expect, test } from "bun:test";
import type { FactoryEvent } from "../ui/src/lib/events.ts";
import { summarizeRuns, distinctRepos } from "../ui/src/lib/history.ts";
import { reconstructRun } from "../ui/src/lib/reconstruct.ts";
import { mockRunEvents, mockRunRecords } from "../ui/src/lib/fixtures.ts";

// The history list's summary math and the run-detail reconstruction are the two
// pieces of non-trivial pure logic added for the "full history" view. Both are
// unit-tested here so a regression fails loudly instead of silently rendering
// wrong totals or dropping merge/deploy events on the drill-down.

describe("summarizeRuns — the history summary strip", () => {
  const runs = mockRunRecords();

  test("total + spend + spend/run are consistent", () => {
    const s = summarizeRuns(runs);
    expect(s.total).toBe(runs.length);
    const expectedCost = runs.reduce((a, r) => a + r.costUsd, 0);
    expect(s.totalCost).toBeCloseTo(expectedCost, 6);
    expect(s.costPerRun).toBeCloseTo(expectedCost / runs.length, 6);
  });

  test("outcome tally sums back to the total", () => {
    const s = summarizeRuns(runs);
    const summed = Object.values(s.byOutcome).reduce((a, n) => a + n, 0);
    expect(summed).toBe(runs.length);
    // fixtures carry two pr_open runs (FAC-17, FAC-16, FAC-13) — assert the bucket exists
    expect(s.byOutcome.pr_open).toBeGreaterThan(0);
  });

  test("empty input is safe (no divide-by-zero)", () => {
    const s = summarizeRuns([]);
    expect(s.total).toBe(0);
    expect(s.costPerRun).toBe(0);
  });
});

describe("distinctRepos", () => {
  test("returns the sorted distinct repos present on the records", () => {
    const repos = distinctRepos(mockRunRecords());
    expect(repos).toContain("rapido/api");
    expect(repos).toContain("rapido/portal");
    expect([...repos]).toEqual([...repos].sort());
  });
});

describe("reconstructRun — folding a run's event stream for the drill-down", () => {
  test("rebuilds the RunView (stages, cost, outcome) from events", () => {
    const events = mockRunEvents("FAC-16");
    expect(events.length).toBeGreaterThan(0);
    const rec = reconstructRun(events);
    const rows = mockRunRecords();
    const source = rows.find((r) => r.issueKey === "FAC-16")!;

    expect(rec.run).not.toBeNull();
    expect(rec.run!.issueKey).toBe("FAC-16");
    expect(rec.run!.status).toBe(source.outcome);
    expect(rec.run!.stages.length).toBe(source.stages.length);
    expect(rec.run!.costUsd).toBeCloseTo(source.costUsd, 4);
  });

  test("surfaces per-stage token usage the live MissionState drops", () => {
    const rec = reconstructRun(mockRunEvents("FAC-16"));
    const impl = rec.usageByStage["implementer"];
    expect(impl).toBeDefined();
    expect(impl!.tokensIn).toBeGreaterThan(0);
    expect(impl!.models.length).toBeGreaterThan(0);
  });

  test("surfaces the write-only merge_decision for a delivered run", () => {
    const rec = reconstructRun(mockRunEvents("FAC-16"));
    expect(rec.mergeDecisions.length).toBe(1);
    expect(rec.mergeDecisions[0]!.tier).toBeTruthy();
  });

  test("keeps EVERY gate round, not just the latest", () => {
    // Two rounds: round 0 red, round 1 green — the reducer keeps only the last,
    // the reconstruction keeps both.
    const events: FactoryEvent[] = [
      { type: "run_started", issueKey: "FAC-X", title: "t", repo: "r/x", dryRun: false, seq: 1, at: 1000 },
      { type: "run_stage_started", issueKey: "FAC-X", stage: "implementer", model: "sonnet", viaProxy: false, seq: 2, at: 1100 },
      { type: "run_stage_finished", issueKey: "FAC-X", stage: "implementer", costUsd: 1, turns: 5, wallSeconds: 10, resultText: "", seq: 3, at: 2000 },
      { type: "run_gates", issueKey: "FAC-X", round: 0, green: false, strength: "real", gates: [{ name: "test", baselinePassed: true, passed: false, outputTail: "fail" }], seq: 4, at: 2100 },
      { type: "run_gates", issueKey: "FAC-X", round: 1, green: true, strength: "real", gates: [{ name: "test", baselinePassed: true, passed: true, outputTail: "" }], seq: 5, at: 2200 },
      { type: "run_finished", issueKey: "FAC-X", outcome: "pr_open", prUrl: null, costUsd: 1, stages: [{ label: "implementer", costUsd: 1, turns: 5, wallSeconds: 10 }], gateStrength: "real", guardedPaths: [], dryRun: false, seq: 6, at: 2300 },
    ];
    const rec = reconstructRun(events);
    expect(rec.gateRounds.map((g) => g.round)).toEqual([0, 1]);
    expect(rec.gateRounds[0]!.green).toBe(false);
    expect(rec.gateRounds[1]!.green).toBe(true);
    expect(rec.feed.length).toBe(0); // no tool_use/assistant_text in this stream
  });
});
