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
  // The daemon and a --server-only dashboard may share this file. Without WAL +
  // busy_timeout a long telemetry read holds the lock, the writer's INSERT
  // throws SQLITE_BUSY, and the subscriber catch below silently DROPS the event
  // from the durable log.
  db.run("PRAGMA busy_timeout = 2000");
  try { db.run("PRAGMA journal_mode = WAL"); } catch (error) {
    console.error(`[db] WAL switch failed (keeping default journal): ${error instanceof Error ? error.message : error}`);
  }
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
// Groundskeeper governance reads (owner request 2026-07-20). Read-only queries
// over the same durable log the daemon already writes — the loop masters never
// open their own handle, so a running daemon's factory.db is never touched by a
// second writer. NOTE: a closed store returning 0 here would be fail-OPEN for
// the budget gate ("nothing spent" forever) — that is why groundskeeperTick
// refuses to run at all when eventStoreOpen() is false. Indexed by
// idx_events_issue / idx_events_type.
// ---------------------------------------------------------------------------

/** True when the durable event store is open. Budget/parks governance is only
 *  enforceable with the store open — callers must fail CLOSED when it isn't. */
export function eventStoreOpen(): boolean {
  return db !== null;
}

/** Sum of run_stage_finished costUsd for one issueKey (e.g. "GK-kiwi-quest")
 *  since `sinceMs`. Backs a groundskeeper's weekly budget envelope. */
export function stageSpendForIssueSince(issueKey: string, sinceMs: number): number {
  if (!db) return 0;
  const rows = db.prepare(
    "SELECT json FROM events WHERE type = 'run_stage_finished' AND issue_key = ? AND at >= ?",
  ).all(issueKey, sinceMs) as Array<{ json: string }>;
  let total = 0;
  for (const r of rows) {
    try { total += num((JSON.parse(r.json) as { costUsd?: unknown }).costUsd); } catch { /* skip one bad row */ }
  }
  return total;
}

/** Count of run_stage_finished rows for one issueKey since `sinceMs`. Aborted/
 *  crashed stages record costUsd 0 even though real API spend occurred, so the
 *  weekly envelope is ALSO bounded by runs × perRun — a reliably-crashing card
 *  cannot spend unbounded dollars while telemetry reads $0. */
export function stageRunCountForIssueSince(issueKey: string, sinceMs: number): number {
  if (!db) return 0;
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE type = 'run_stage_finished' AND issue_key = ? AND at >= ?",
  ).get(issueKey, sinceMs) as { n: number };
  return row.n;
}

/** Count of real (non-dry) run_finished parked outcomes since `sinceMs` — the
 *  parks-spike signal that flips a groundskeeper into repair-only mode. */
export function parkedRunsSince(sinceMs: number): number {
  if (!db) return 0;
  const rows = db.prepare(
    "SELECT json FROM events WHERE type = 'run_finished' AND at >= ?",
  ).all(sinceMs) as Array<{ json: string }>;
  let n = 0;
  for (const r of rows) {
    try {
      const e = JSON.parse(r.json) as { outcome?: string; dryRun?: boolean };
      if (!e.dryRun && e.outcome === "parked") n += 1;
    } catch { /* skip one bad row */ }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Catalog usage (catalog-manager GET /catalog). Per-card spend/run stats folded
// from the same run_stage_finished rows telemetry reads — agent cards key by
// STAGE name (a card named "implementer" ⇒ stage "implementer"), groundskeeper
// cards key by ISSUE key ("GK-<name>"). Uncapped (unlike getTelemetry's top-10
// leaderboard) so every card gets its own honest numbers, and cheap: two grouped
// scans over the indexed run_stage_finished rows. Returns zeroed maps when the
// store is closed. `turns` is total across runs; the UI divides for an average.
// ---------------------------------------------------------------------------

export interface CardUsage { runs: number; costUsd: number; turns: number }

export function catalogUsage(): { byStage: Record<string, CardUsage>; byIssueKey: Record<string, CardUsage> } {
  const byStage: Record<string, CardUsage> = {};
  const byIssueKey: Record<string, CardUsage> = {};
  if (!db) return { byStage, byIssueKey };
  const rows = db.prepare(
    "SELECT json FROM events WHERE type = 'run_stage_finished'",
  ).all() as Array<{ json: string }>;
  for (const r of rows) {
    let e: { costUsd?: unknown; turns?: unknown; stage?: unknown; issueKey?: unknown };
    try { e = JSON.parse(r.json) as typeof e; } catch { continue; }
    const cost = num(e.costUsd);
    const turns = num(e.turns);
    if (typeof e.stage === "string" && e.stage.trim() !== "") {
      const s = byStage[e.stage] ?? { runs: 0, costUsd: 0, turns: 0 };
      s.runs += 1; s.costUsd += cost; s.turns += turns;
      byStage[e.stage] = s;
    }
    if (typeof e.issueKey === "string" && e.issueKey.trim() !== "") {
      const k = byIssueKey[e.issueKey] ?? { runs: 0, costUsd: 0, turns: 0 };
      k.runs += 1; k.costUsd += cost; k.turns += turns;
      byIssueKey[e.issueKey] = k;
    }
  }
  return { byStage, byIssueKey };
}

// ---------------------------------------------------------------------------
// Telemetry — aggregate spend/token/outcome stats over the whole durable event
// log for GET /telemetry. All numbers reflect real API spend, so dry-run stage
// costs are included in cost/token aggregates AND in per-issue leaderboard
// spend (folded from stage rows so it always reconciles with the spend totals,
// including runs that never emitted run_finished); dry-run *deliveries*
// (rehearsals) are excluded from run/outcome counts. Every string is already
// redacted at emit time. Queries are indexed by `type` (idx_events_type), and
// the computed aggregate is cached on a stage/run-row watermark so idle
// dashboard polls don't re-scan the log.
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
  /** top-10 issues by total spend (stage-row spend; runs = non-dry deliveries). */
  costPerIssue: Array<{ issueKey: string; costUsd: number; runs: number }>;
}

// Rows come back from a durable log that outlives any single daemon version —
// field SHAPES are as untrusted as field presence. Never assume numbers.
interface StageFinished { costUsd?: number; turns?: number; stage?: string; issueKey?: string;
  modelUsage?: Record<string, unknown> }
interface RunFinished { outcome?: string; reason?: string; issueKey?: string;
  dryRun?: boolean; stages?: Array<{ degraded?: boolean }> }

/** Coerce a stored field to a finite number (same guard as agents.ts's writer). */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

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

// Cache of the last computed aggregate. The result only changes when a new
// stage/run row lands (watermark: newest relevant row id — two index seeks) or
// the local calendar day rolls over (the zero-filled `daily` window moves).
let telemetryCache: { watermark: number; day: string; value: Telemetry } | null = null;

/** Aggregate GET /telemetry from the durable event log. Returns a zeroed shape
 *  when the store is not open or holds no events. */
export function getTelemetry(): Telemetry {
  if (!db) return emptyTelemetry();

  const wm = db.prepare(
    `SELECT max(
       COALESCE((SELECT MAX(id) FROM events WHERE type = 'run_stage_finished'), 0),
       COALESCE((SELECT MAX(id) FROM events WHERE type = 'run_finished'), 0)
     ) AS m`,
  ).get() as { m: number };
  const today = dayKey(Date.now());
  if (telemetryCache && telemetryCache.watermark === wm.m && telemetryCache.day === today) {
    return { ...telemetryCache.value, generatedAt: Date.now() };
  }

  const t = emptyTelemetry();
  const dailyByDate = new Map(t.daily.map((d) => [d.date, d]));

  const stageRows = db.prepare(
    "SELECT at, json FROM events WHERE type = 'run_stage_finished' ORDER BY id ASC",
  ).all() as Array<{ at: number; json: string }>;
  const perModel = new Map<string, Telemetry["perModel"][number]>();
  const perStage = new Map<string, Telemetry["perStage"][number]>();
  const costByIssue = new Map<string, { costUsd: number; runs: number }>();

  for (const row of stageRows) {
    let e: StageFinished;
    try { e = JSON.parse(row.json) as StageFinished; } catch { continue; }
    const costUsd = num(e.costUsd);
    const turns = num(e.turns);
    t.totals.costUsd += costUsd;
    t.totals.turns += turns;
    t.totals.stageRuns += 1;

    let stageIn = 0, stageOut = 0, stageCacheRead = 0;
    for (const [model, uRaw] of Object.entries(e.modelUsage ?? {})) {
      if (typeof uRaw !== "object" || uRaw === null) continue; // one bad row must not kill /telemetry
      const u = uRaw as Record<string, unknown>;
      const uIn = num(u.in), uOut = num(u.out);
      const uCacheRead = num(u.cacheRead), uCacheWrite = num(u.cacheWrite), uCost = num(u.costUsd);
      const pm = perModel.get(model) ?? { model, calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
      pm.calls += 1;
      pm.tokensIn += uIn; pm.tokensOut += uOut;
      pm.cacheRead += uCacheRead; pm.cacheWrite += uCacheWrite; pm.costUsd += uCost;
      perModel.set(model, pm);
      stageIn += uIn; stageOut += uOut; stageCacheRead += uCacheRead;
      t.totals.tokensIn += uIn; t.totals.tokensOut += uOut;
      t.totals.cacheRead += uCacheRead; t.totals.cacheWrite += uCacheWrite;
    }

    // Leaderboard SPEND folds from stage rows so it reconciles with the spend
    // totals above — dry-run and crashed runs included, no "?" bucket.
    if (typeof e.issueKey === "string" && e.issueKey.trim() !== "") {
      const cbi = costByIssue.get(e.issueKey) ?? { costUsd: 0, runs: 0 };
      cbi.costUsd += costUsd;
      costByIssue.set(e.issueKey, cbi);
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
    if (Array.isArray(e.stages) && e.stages.some((s) => s?.degraded === true)) t.totals.degradedRuns += 1;

    // Spend comes from stage rows above; run_finished only contributes the
    // delivery count. Rows without a string issueKey are skipped, never "?".
    if (typeof e.issueKey === "string" && e.issueKey.trim() !== "") {
      const cbi = costByIssue.get(e.issueKey) ?? { costUsd: 0, runs: 0 };
      cbi.runs += 1;
      costByIssue.set(e.issueKey, cbi);
    }

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
  telemetryCache = { watermark: wm.m, day: today, value: t };
  return t;
}
