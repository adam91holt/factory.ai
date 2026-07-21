import { describe, expect, test } from "bun:test";
import { applyEvent } from "../src/server.ts";
import type { FactoryEvent, FactoryEventBody, MissionState } from "../src/events.ts";

// applyEvent is a PURE fold — we drive it with hand-stamped events (explicit
// seq/at, never Date.now()) and assert on the resulting MissionState. The UI
// store mirrors this reducer; these tests pin the daemon side of the contract.

let seq = 0;
const ev = (body: FactoryEventBody, at = 1_000 + seq): FactoryEvent =>
  ({ ...body, seq: ++seq, at }) as FactoryEvent;

const initial = (): MissionState =>
  ({ seq: 0, daemon: null, board: [], boardAt: null, runs: {}, needsHuman: [] });

const fold = (events: FactoryEvent[], from = initial()): MissionState =>
  events.reduce(applyEvent, from);

const started = (issueKey: string): FactoryEvent =>
  ev({ type: "run_started", issueKey, title: `t-${issueKey}`, repo: "acme/x", dryRun: false });

const stageStarted = (issueKey: string, stage: string): FactoryEvent =>
  ev({ type: "run_stage_started", issueKey, stage, model: "sonnet", viaProxy: false });

const stageFinished = (issueKey: string, stage: string, costUsd = 1): FactoryEvent =>
  ev({ type: "run_stage_finished", issueKey, stage, costUsd, turns: 3, wallSeconds: 10, resultText: "done" });

const finished = (issueKey: string, at: number, outcome: "pr_open" | "parked" = "pr_open"): FactoryEvent =>
  ev({ type: "run_finished", issueKey, outcome, prUrl: null, costUsd: 2, stages: [],
    gateStrength: "real", guardedPaths: [], dryRun: false }, at);

describe("applyEvent", () => {
  test("never mutates the input state", () => {
    const before = initial();
    const frozen = JSON.stringify(before);
    applyEvent(before, started("FAC-1"));
    expect(JSON.stringify(before)).toBe(frozen);
  });

  test("stamps seq from every event, even unknown-ish ones", () => {
    const m = fold([ev({ type: "tick_started" })]);
    expect(m.seq).toBe(seq);
  });

  test("daemon_started populates daemon; tick_finished records lastTick and clears backoff", () => {
    const m = fold([
      ev({ type: "daemon_started", mode: "watch", teamKeys: ["FAC"], workRoot: "/w", wipLimit: 4, watchIntervalSeconds: 60, budgetUsdPerIssue: 25 }),
      ev({ type: "linear_backoff", seconds: 300 }),
      ev({ type: "tick_finished", queued: 3, eligible: 2, markedNeedsHuman: 0, processed: 1 }),
    ]);
    expect(m.daemon?.mode).toBe("watch");
    expect(m.daemon?.lastTick?.queued).toBe(3);
    expect(m.daemon?.backoffSeconds).toBe(0); // error-free tick resets backoff
  });

  test("tick_finished with an error preserves the backoff", () => {
    const m = fold([
      ev({ type: "daemon_started", mode: "watch", teamKeys: ["FAC"], workRoot: "/w", wipLimit: 4, watchIntervalSeconds: 60, budgetUsdPerIssue: 25 }),
      ev({ type: "linear_backoff", seconds: 300 }),
      ev({ type: "tick_finished", queued: 0, eligible: 0, markedNeedsHuman: 0, processed: 0, error: "HTTP 429" }),
    ]);
    expect(m.daemon?.backoffSeconds).toBe(300);
  });

  test("issue_needs_human dedupes by issueKey, keeping the latest reason", () => {
    const m = fold([
      ev({ type: "issue_needs_human", issueKey: "FAC-9", reason: "old" }),
      ev({ type: "issue_needs_human", issueKey: "FAC-9", reason: "new" }),
    ]);
    expect(m.needsHuman).toHaveLength(1);
    expect(m.needsHuman[0]?.reason).toBe("new");
  });

  test("full run lifecycle: start → stage → tool_use → finish accumulates correctly", () => {
    const m = fold([
      started("FAC-2"),
      stageStarted("FAC-2", "implementer"),
      ev({ type: "run_tool_use", issueKey: "FAC-2", stage: "implementer", tool: "Edit", detail: "src/x.ts" }),
      ev({ type: "run_assistant_text", issueKey: "FAC-2", stage: "implementer", text: "working…" }),
      stageFinished("FAC-2", "implementer", 1.5),
      finished("FAC-2", 9_999),
    ]);
    const run = m.runs["FAC-2"];
    expect(run?.status).toBe("pr_open");
    expect(run?.finishedAt).toBe(9_999);
    expect(run?.stages).toHaveLength(1);
    expect(run?.stages[0]?.toolCalls).toBe(1);
    expect(run?.stages[0]?.lastActivity).toBe("working…");
    expect(run?.stages[0]?.costUsd).toBe(1.5);
    expect(run?.costUsd).toBe(2); // run_finished's total wins
  });

  test("parallel same-label stages: events attach to the LAST unfinished instance", () => {
    const m = fold([
      started("FAC-3"),
      stageStarted("FAC-3", "reviewer"),
      stageStarted("FAC-3", "reviewer"),
      stageFinished("FAC-3", "reviewer", 1), // closes the second (latest open)
      stageFinished("FAC-3", "reviewer", 2), // then the remaining open one
    ]);
    const stages = m.runs["FAC-3"]?.stages ?? [];
    expect(stages).toHaveLength(2);
    expect(stages.every((s) => s.finishedAt !== null)).toBe(true);
  });

  test("stage_finished for an unknown stage still accrues run cost (tolerance rule)", () => {
    const m = fold([started("FAC-4"), stageFinished("FAC-4", "ghost-stage", 3)]);
    expect(m.runs["FAC-4"]?.costUsd).toBe(3);
    expect(m.runs["FAC-4"]?.stages).toHaveLength(0);
  });

  test("events for an unseen issueKey create a placeholder run (never crash)", () => {
    const m = fold([stageStarted("FAC-5", "implementer")]);
    expect(m.runs["FAC-5"]?.stages).toHaveLength(1);
    expect(m.runs["FAC-5"]?.status).toBe("active");
  });

  test("run_finished marks degraded stages by label", () => {
    const m = fold([
      started("FAC-6"),
      stageStarted("FAC-6", "reviewer-fallback"),
      stageFinished("FAC-6", "reviewer-fallback"),
      ev({ type: "run_finished", issueKey: "FAC-6", outcome: "pr_open", prUrl: null, costUsd: 1,
        stages: [{ label: "reviewer-fallback", costUsd: 1, turns: 1, wallSeconds: 5, degraded: true }],
        gateStrength: "weak", guardedPaths: [], dryRun: false }),
    ]);
    expect(m.runs["FAC-6"]?.stages[0]?.degraded).toBe(true);
  });

  test("run_gates stores the latest gate snapshot", () => {
    const m = fold([
      started("FAC-7"),
      ev({ type: "run_gates", issueKey: "FAC-7", round: 0, green: false, strength: "real",
        gates: [{ name: "test", baselinePassed: true, passed: false, outputTail: "1 fail" }] }),
      ev({ type: "run_gates", issueKey: "FAC-7", round: 1, green: true, strength: "real", gates: [] }),
    ]);
    expect(m.runs["FAC-7"]?.gates).toEqual({ round: 1, green: true, strength: "real", gates: [] });
  });
});

describe("pruneFinishedRuns (via the run_finished fold)", () => {
  test("keeps the newest 50 finished runs and every active run", () => {
    let m = initial();
    // 60 finished runs with strictly increasing finishedAt.
    for (let i = 1; i <= 60; i++) {
      const key = `FAC-${100 + i}`;
      m = fold([started(key), finished(key, 10_000 + i)], m);
    }
    // Plus one active run started BEFORE all of them.
    m = fold([stageStarted("FAC-ACTIVE", "implementer")], m);
    const runs = Object.values(m.runs);
    const finishedRuns = runs.filter((r) => r.status !== "active");
    expect(finishedRuns).toHaveLength(50);
    // The 10 OLDEST finished runs were dropped.
    expect(m.runs["FAC-101"]).toBeUndefined();
    expect(m.runs["FAC-110"]).toBeUndefined();
    expect(m.runs["FAC-111"]).toBeDefined();
    expect(m.runs["FAC-160"]).toBeDefined();
    expect(m.runs["FAC-ACTIVE"]?.status).toBe("active");
  });

  test("at or under the cap nothing is pruned", () => {
    let m = initial();
    for (let i = 1; i <= 50; i++) {
      const key = `FAC-${200 + i}`;
      m = fold([started(key), finished(key, 20_000 + i)], m);
    }
    expect(Object.keys(m.runs)).toHaveLength(50);
  });
});
