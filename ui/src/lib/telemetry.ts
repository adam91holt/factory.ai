// Shape of GET /telemetry — mirrors `Telemetry` in src/db.ts (the JSON is the
// contract; the two are duplicated by design, like the events shared block).

export interface Telemetry {
  generatedAt: number;
  totals: {
    costUsd: number;
    turns: number;
    stageRuns: number;
    runs: number;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    prOpen: number;
    parked: number;
    needsHuman: number;
    aborted: number;
    planned: number;
    degradedRuns: number;
  };
  perModel: Array<{
    model: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
  }>;
  perStage: Array<{
    stage: string;
    calls: number;
    turns: number;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
  }>;
  daily: Array<{
    date: string;
    costUsd: number;
    turns: number;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    runs: number;
  }>;
  outcomes: { pr_open: number; planned: number; parked: number; needs_human: number; aborted: number };
  parkReasons: Array<{ reason: string; count: number }>;
  costPerIssue: Array<{ issueKey: string; costUsd: number; runs: number }>;
}
