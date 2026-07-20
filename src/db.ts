import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "./config.ts";
import { bus, type FactoryEvent } from "./events.ts";

// Durable event store (owner request 2026-07-20): every FactoryEvent — already
// redacted at emit — lands in SQLite so agent activity survives restarts.
// bun:sqlite is built in; no dependencies.

let db: Database | null = null;

export function startEventStore(): void {
  db = new Database(join(config.workRoot, "factory.db"));
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq INTEGER, at INTEGER, type TEXT, issue_key TEXT, json TEXT)`);
  db.run("CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_key, id)");
  // Telemetry aggregation scans by event type (run_stage_finished / run_finished).
  db.run("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id)");
  const insert = db.prepare("INSERT INTO events (seq, at, type, issue_key, json) VALUES (?, ?, ?, ?, ?)");
  bus.subscribe((e: FactoryEvent) => {
    try {
      const key = (e as { issueKey?: string }).issueKey ?? null;
      insert.run(e.seq, e.at, e.type, key, JSON.stringify(e));
    } catch (error) {
      console.error(`[db] event write failed: ${error instanceof Error ? error.message : error}`);
    }
  });
}

/** Full historical event stream for one issue (all sessions). */
export function issueEvents(issueKey: string, limit = 2000): unknown[] {
  if (!db) return [];
  const rows = db.prepare("SELECT json FROM events WHERE issue_key = ? ORDER BY id ASC LIMIT ?")
    .all(issueKey, limit) as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as unknown);
}

// ---------------------------------------------------------------------------
// Telemetry — aggregate spend/token/outcome stats over the whole durable event
// log for GET /telemetry. All numbers reflect real API spend, so dry-run stage
// costs are included in cost/token aggregates; dry-run *deliveries* (rehearsals)
// are excluded from outcome/leaderboard counts. Every string is already redacted
// at emit time. Queries are indexed by `type` (idx_events_type).
// ---------------------------------------------------------------------------

export interface Telemetry {
  generatedAt: number;
  totals: {
    costUsd: number; turns: number; stageRuns: number; runs: number;
    tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number;
    prOpen: number; parked: number; needsHuman: number; aborted: number; planned: number;
    degradedRuns: number;
  };
  /** per model, sorted by costUsd desc — the star chart ("tokens through which model"). */
  perModel: Array<{ model: string; calls: number; tokensIn: number; tokensOut: number;
    cacheRead: number; cacheWrite: number; costUsd: number }>;
  /** per pipeline stage, sorted by costUsd desc. */
  perStage: Array<{ stage: string; calls: number; turns: number; costUsd: number;
    tokensIn: number; tokensOut: number }>;
  /** last 7 calendar days (local), oldest → newest, zero-filled. */
  daily: Array<{ date: string; costUsd: number; turns: number; tokensIn: number;
    tokensOut: number; cacheRead: number; runs: number }>;
  outcomes: { pr_open: number; planned: number; parked: number; needs_human: number; aborted: number };
  /** top-5 park reasons by frequency. */
  parkReasons: Array<{ reason: string; count: number }>;
  /** top-10 issues by total spend. */
  costPerIssue: Array<{ issueKey: string; costUsd: number; runs: number }>;
}

type ModelUsage = { in: number; out: number; cacheRead: number; cacheWrite: number; costUsd: number };
interface StageFinished { costUsd?: number; turns?: number; stage?: string;
  modelUsage?: Record<string, ModelUsage> }
interface RunFinished { outcome?: string; reason?: string; costUsd?: number; issueKey?: string;
  dryRun?: boolean; stages?: Array<{ degraded?: boolean }> }

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyTelemetry(): Telemetry {
  const now = new Date();
  const daily = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - i));
    return { date: dayKey(d.getTime()), costUsd: 0, turns: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, runs: 0 };
  });
  return {
    generatedAt: Date.now(),
    totals: { costUsd: 0, turns: 0, stageRuns: 0, runs: 0, tokensIn: 0, tokensOut: 0,
      cacheRead: 0, cacheWrite: 0, prOpen: 0, parked: 0, needsHuman: 0, aborted: 0, planned: 0, degradedRuns: 0 },
    perModel: [], perStage: [], daily,
    outcomes: { pr_open: 0, planned: 0, parked: 0, needs_human: 0, aborted: 0 },
    parkReasons: [], costPerIssue: [],
  };
}

/** Aggregate GET /telemetry from the durable event log. Returns a zeroed shape
 *  when the store is not open or holds no events. */
export function getTelemetry(): Telemetry {
  const t = emptyTelemetry();
  if (!db) return t;
  const dailyByDate = new Map(t.daily.map((d) => [d.date, d]));

  const stageRows = db.prepare(
    "SELECT at, json FROM events WHERE type = 'run_stage_finished' ORDER BY id ASC",
  ).all() as Array<{ at: number; json: string }>;
  const perModel = new Map<string, Telemetry["perModel"][number]>();
  const perStage = new Map<string, Telemetry["perStage"][number]>();

  for (const row of stageRows) {
    let e: StageFinished;
    try { e = JSON.parse(row.json) as StageFinished; } catch { continue; }
    const costUsd = typeof e.costUsd === "number" ? e.costUsd : 0;
    const turns = typeof e.turns === "number" ? e.turns : 0;
    t.totals.costUsd += costUsd;
    t.totals.turns += turns;
    t.totals.stageRuns += 1;

    let stageIn = 0, stageOut = 0, stageCacheRead = 0;
    for (const [model, u] of Object.entries(e.modelUsage ?? {})) {
      const pm = perModel.get(model) ?? { model, calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
      pm.calls += 1;
      pm.tokensIn += u.in; pm.tokensOut += u.out;
      pm.cacheRead += u.cacheRead; pm.cacheWrite += u.cacheWrite; pm.costUsd += u.costUsd;
      perModel.set(model, pm);
      stageIn += u.in; stageOut += u.out; stageCacheRead += u.cacheRead;
      t.totals.tokensIn += u.in; t.totals.tokensOut += u.out;
      t.totals.cacheRead += u.cacheRead; t.totals.cacheWrite += u.cacheWrite;
    }

    const stageName = typeof e.stage === "string" ? e.stage : "unknown";
    const ps = perStage.get(stageName) ?? { stage: stageName, calls: 0, turns: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 };
    ps.calls += 1; ps.turns += turns; ps.costUsd += costUsd;
    ps.tokensIn += stageIn; ps.tokensOut += stageOut;
    perStage.set(stageName, ps);

    const bucket = dailyByDate.get(dayKey(row.at));
    if (bucket) {
      bucket.costUsd += costUsd; bucket.turns += turns;
      bucket.tokensIn += stageIn; bucket.tokensOut += stageOut; bucket.cacheRead += stageCacheRead;
    }
  }

  const runRows = db.prepare(
    "SELECT at, json FROM events WHERE type = 'run_finished' ORDER BY id ASC",
  ).all() as Array<{ at: number; json: string }>;
  const parkReasons = new Map<string, number>();
  const costByIssue = new Map<string, { costUsd: number; runs: number }>();

  for (const row of runRows) {
    let e: RunFinished;
    try { e = JSON.parse(row.json) as RunFinished; } catch { continue; }
    if (e.dryRun) continue; // rehearsals don't count as deliveries
    t.totals.runs += 1;
    const outcome = e.outcome;
    if (outcome === "pr_open") { t.outcomes.pr_open += 1; t.totals.prOpen += 1; }
    else if (outcome === "planned") { t.outcomes.planned += 1; t.totals.planned += 1; }
    else if (outcome === "parked") { t.outcomes.parked += 1; t.totals.parked += 1; }
    else if (outcome === "needs_human") { t.outcomes.needs_human += 1; t.totals.needsHuman += 1; }
    else if (outcome === "aborted") { t.outcomes.aborted += 1; t.totals.aborted += 1; }

    if (outcome === "parked" && typeof e.reason === "string" && e.reason.trim()) {
      const key = e.reason.trim().slice(0, 120);
      parkReasons.set(key, (parkReasons.get(key) ?? 0) + 1);
    }
    if ((e.stages ?? []).some((s) => s.degraded)) t.totals.degradedRuns += 1;

    const issueKey = typeof e.issueKey === "string" ? e.issueKey : "?";
    const cbi = costByIssue.get(issueKey) ?? { costUsd: 0, runs: 0 };
    cbi.costUsd += typeof e.costUsd === "number" ? e.costUsd : 0;
    cbi.runs += 1;
    costByIssue.set(issueKey, cbi);

    const bucket = dailyByDate.get(dayKey(row.at));
    if (bucket) bucket.runs += 1;
  }

  t.perModel = [...perModel.values()].sort((a, b) => b.costUsd - a.costUsd);
  t.perStage = [...perStage.values()].sort((a, b) => b.costUsd - a.costUsd);
  t.parkReasons = [...parkReasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  t.costPerIssue = [...costByIssue.entries()]
    .map(([issueKey, v]) => ({ issueKey, costUsd: v.costUsd, runs: v.runs }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10);
  return t;
}
