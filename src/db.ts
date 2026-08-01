import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "./config.ts";
import { bus, type FactoryEvent } from "./events.ts";
import { advanceLadder, seedLadderState, ceilingForRepo, isEnrolled, type LadderState, type MergeDecision, type MergeEvidence } from "./merge-ladder.ts";

// Durable event store (owner request 2026-07-20): every FactoryEvent — already
// redacted at emit — lands in SQLite so agent activity survives restarts.
// bun:sqlite is built in; no dependencies.

let db: Database | null = null;

/** All DDL for factory.db — extracted so both the daemon store and the in-memory
 * test seam create an identical schema. `CREATE ... IF NOT EXISTS` throughout, so
 * calling it on an existing file is a no-op. */
function ensureSchema(d: Database): void {
  d.run(`CREATE TABLE IF NOT EXISTS stage_sessions (
    issue_key TEXT NOT NULL, stage TEXT NOT NULL, session_id TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (issue_key, stage))`);
  d.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq INTEGER, at INTEGER, type TEXT, issue_key TEXT, json TEXT)`);
  d.run("CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_key, id)");
  // Telemetry aggregation scans by event type (run_stage_finished / run_finished).
  d.run("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id)");
  // Durable, repo-scoped lessons distilled from failures (park / needs-human /
  // taste-fail) — the self-improvement flywheel's memory (level-4-roadmap.md,
  // principle 7). Same shared handle as the event log: never a second writer
  // against a running daemon (see governance note below). All reads/writes go
  // through the row helpers here, and ONLY src/lessons.ts calls those — other
  // modules consume the lessons.ts API, never SQL.
  d.run(`CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER,
    repo TEXT, stage TEXT, issue_key TEXT,
    lesson TEXT, source_reason TEXT,
    archived INTEGER DEFAULT 0)`);
  d.run("CREATE INDEX IF NOT EXISTS idx_lessons_repo ON lessons(repo, archived, id)");
  // Gap-2 merge ladder: the per-repo EARNED tier + clean streak, and an append-
  // only audit log of every shadow decision. The earning MATH lives in
  // merge-ladder.ts (pure); these tables only persist its output.
  d.run(`CREATE TABLE IF NOT EXISTS merge_ladder (
    repo TEXT PRIMARY KEY, tier TEXT, clean_streak INTEGER, total_shadow INTEGER, updated_at INTEGER)`);
  d.run(`CREATE TABLE IF NOT EXISTS merge_shadow_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, repo TEXT, issue_key TEXT,
    would_merge INTEGER, acted INTEGER, tier TEXT, reasons TEXT, evidence_json TEXT)`);
  // Gap-5 post-merge deploy ledger: EXACTLY-ONCE idempotency for deploy/smoke/
  // revert. A (repo, sha) pair is recorded the moment a deploy is attempted so a
  // second tick (or a reconcile racing postMergeTick) never re-deploys the same
  // merge — the deployAttempted() guard, the stillOurs()/idempotency pattern
  // extended past merge (Gap-4 interaction). PRIMARY KEY (repo, sha) makes the
  // guard a single indexed lookup.
  d.run(`CREATE TABLE IF NOT EXISTS deploys (
    repo TEXT NOT NULL, sha TEXT NOT NULL, outcome TEXT, at INTEGER,
    PRIMARY KEY (repo, sha))`);
  // Approvals inbox (human review lane): one row per run that ended routed to
  // a human with an OPEN PR — the actionable item behind GET /approvals. The
  // row carries everything a human needs to DECIDE without leaving the app
  // (hold reasons, gate summary, verdicts, findings digest, diff stat, spend)
  // plus gated_head_sha — the exact commit the evidence ran against, which the
  // approve action re-verifies and pins the merge to (--match-head-commit).
  // status transitions: pending → approved | pushed_back | stale; the
  // pending→X step is a single atomic UPDATE ... WHERE status='pending'
  // (claimApproval below) so a double-click can never double-merge. All free
  // text is redacted at write time (approvals.ts) — same emit-time discipline
  // as the events table.
  d.run(`CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    issue_key TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    repo TEXT NOT NULL, pr_url TEXT NOT NULL,
    gated_head_sha TEXT,
    hold_reasons TEXT NOT NULL DEFAULT '',
    gate_summary_json TEXT,
    security_verdict TEXT NOT NULL DEFAULT 'none',
    taste_verdict TEXT NOT NULL DEFAULT 'not-required',
    findings_digest TEXT NOT NULL DEFAULT '',
    diff_stat TEXT NOT NULL DEFAULT '',
    cost_usd REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
    regate_failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    resolution TEXT NOT NULL DEFAULT '')`);
  // regate_failed post-dates the table by one commit, so a store an earlier
  // build of this branch created lacks it — and SELECT names every column, so
  // every read would throw. SQLite has no ADD COLUMN IF NOT EXISTS; the ALTER
  // is idempotent by way of failing (duplicate column) on an up-to-date store.
  try { d.run("ALTER TABLE approvals ADD COLUMN regate_failed INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }
  d.run("CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, id)");
  // Push-back feedback handoff: the owner's directive travels from the
  // pushback endpoint to the NEXT run of the same issue via this one-row-per-
  // issue table. Consumed exactly once (takePushbackFeedback = read+delete) so
  // stale direction can never resurrect on a later unrelated re-run; the
  // durable copy for humans is the Linear comment approvals.ts posts.
  d.run(`CREATE TABLE IF NOT EXISTS pushback_feedback (
    issue_key TEXT PRIMARY KEY, feedback TEXT NOT NULL, created_at INTEGER NOT NULL)`);
}

export function startEventStore(): void {
  if (db) return; // idempotent — main() and startDashboard() may both call this
  db = new Database(join(config.workRoot, "factory.db"));
  // The daemon and a --server-only dashboard may share this file. Without WAL +
  // busy_timeout a long telemetry read holds the lock, the writer's INSERT
  // throws SQLITE_BUSY, and the subscriber catch below silently DROPS the event
  // from the durable log.
  db.run("PRAGMA busy_timeout = 2000");
  try { db.run("PRAGMA journal_mode = WAL"); } catch (error) {
    console.error(`[db] WAL switch failed (keeping default journal): ${error instanceof Error ? error.message : error}`);
  }
  ensureSchema(db);
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

/** Most recent recorded park / needs-human reason for one issue key, or null
 *  when none was ever recorded (legacy rows, closed store). Reads newest-first
 *  over the issue's own rows (idx_events_issue): run_finished rows with a
 *  parked/needs_human outcome and issue_needs_human marks both carry the
 *  reason. Backs the steward's child-status closeout input — a steward must
 *  never see "parked" with the WHY stranded in SQLite (FAC-14 lesson). */
export function lastParkReasonForIssue(issueKey: string): string | null {
  if (!db) return null;
  const rows = db.prepare(
    "SELECT type, json FROM events WHERE issue_key = ? AND type IN ('run_finished', 'issue_needs_human') ORDER BY id DESC LIMIT 50",
  ).all(issueKey) as Array<{ type: string; json: string }>;
  for (const r of rows) {
    try {
      const e = JSON.parse(r.json) as { outcome?: string; reason?: unknown };
      const reason = typeof e.reason === "string" && e.reason.trim() ? e.reason.trim() : null;
      if (r.type === "issue_needs_human" && reason) return reason;
      if (r.type === "run_finished" && (e.outcome === "parked" || e.outcome === "needs_human") && reason) return reason;
    } catch { /* skip one bad row */ }
  }
  return null;
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
    // B16: "merged" is counted separately from "prOpen" — prOpen now means "a
    // human still has to merge it", merged means the ladder closed the loop
    // with zero human intervention. Both are still summed in `runs`.
    prOpen: number; merged: number; parked: number; needsHuman: number; aborted: number; planned: number;
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
  outcomes: { pr_open: number; merged: number; planned: number; parked: number; needs_human: number; aborted: number };
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
      cacheRead: 0, cacheWrite: 0, prOpen: 0, merged: 0, parked: 0, needsHuman: 0, aborted: 0, planned: 0, degradedRuns: 0 },
    perModel: [], perStage: [], daily,
    outcomes: { pr_open: 0, merged: 0, planned: 0, parked: 0, needs_human: 0, aborted: 0 },
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
    else if (outcome === "merged") { t.outcomes.merged += 1; t.totals.merged += 1; }
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

// ---------------------------------------------------------------------------
// Lessons rows — thin shared-handle accessors consumed ONLY by src/lessons.ts
// (which owns validation, redaction, caps, and the distillation step). Keeping
// them here honors the single-writer rule: the daemon's one Database handle is
// the only writer factory.db ever sees. Each returns a safe zero value when the
// store is closed (--once / DASHBOARD_PORT=0) — lessons capture is best-effort
// and must never throw into the pipeline.
// ---------------------------------------------------------------------------

export interface LessonRow {
  id: number;
  createdAt: number;
  repo: string;
  stage: string;
  issueKey: string;
  lesson: string;
  sourceReason: string;
  archived: boolean;
}

interface RawLessonRow { id: number; created_at: number; repo: string; stage: string;
  issue_key: string; lesson: string; source_reason: string; archived: number }

function toLessonRow(r: RawLessonRow): LessonRow {
  return { id: r.id, createdAt: r.created_at, repo: r.repo, stage: r.stage,
    issueKey: r.issue_key, lesson: r.lesson, sourceReason: r.source_reason,
    archived: r.archived !== 0 };
}

/** Insert one lesson row. Returns false (no throw) when the store is closed. */
export function insertLessonRow(row: { createdAt: number; repo: string; stage: string;
  issueKey: string; lesson: string; sourceReason: string }): boolean {
  if (!db) return false;
  db.prepare(
    "INSERT INTO lessons (created_at, repo, stage, issue_key, lesson, source_reason, archived) VALUES (?, ?, ?, ?, ?, ?, 0)",
  ).run(row.createdAt, row.repo, row.stage, row.issueKey, row.lesson, row.sourceReason);
  return true;
}

/** Newest-first active (archived = 0) lessons for one repo, capped by `limit`. */
export function activeLessonRowsForRepo(repo: string, limit: number): LessonRow[] {
  if (!db) return [];
  const rows = db.prepare(
    "SELECT id, created_at, repo, stage, issue_key, lesson, source_reason, archived FROM lessons WHERE repo = ? AND archived = 0 ORDER BY id DESC LIMIT ?",
  ).all(repo, limit) as RawLessonRow[];
  return rows.map(toLessonRow);
}

/** Every lesson row (archived included), newest first, bounded. */
export function allLessonRows(limit: number): LessonRow[] {
  if (!db) return [];
  const rows = db.prepare(
    "SELECT id, created_at, repo, stage, issue_key, lesson, source_reason, archived FROM lessons ORDER BY id DESC LIMIT ?",
  ).all(limit) as RawLessonRow[];
  return rows.map(toLessonRow);
}

/** Human-initiated archive (sets archived = 1 — rows are never deleted).
 *  Returns true when a row actually changed. */
export function archiveLessonRow(id: number): boolean {
  if (!db) return false;
  const res = db.prepare("UPDATE lessons SET archived = 1 WHERE id = ? AND archived = 0").run(id);
  return res.changes > 0;
}

/** Count of lessons written since `sinceMs` — backs the distillation spend
 *  guard (per-day cap on distiller calls). */
export function lessonRowCountSince(sinceMs: number): number {
  if (!db) return 0;
  const row = db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE created_at >= ?").get(sinceMs) as { n: number };
  return row.n;
}


/** Resume support: persist the SDK session_id for an in-flight stage so a
 * cut-off run (process killed mid-stage) can resume its actual conversation
 * on re-claim instead of starting over. Recorded on session init, cleared when
 * the stage returns normally — so a lingering row == the stage was interrupted. */
export function recordStageSession(issueKey: string, stage: string, sessionId: string): void {
  if (!db || !issueKey || !stage || !sessionId) return;
  try { db.prepare("INSERT OR REPLACE INTO stage_sessions (issue_key, stage, session_id, at) VALUES (?, ?, ?, ?)")
    .run(issueKey, stage, sessionId, Date.now()); } catch { /* best-effort */ }
}
export function getStageSession(issueKey: string, stage: string): string | null {
  if (!db) return null;
  try { const r = db.prepare("SELECT session_id FROM stage_sessions WHERE issue_key = ? AND stage = ?").get(issueKey, stage) as { session_id?: string } | null;
    return r?.session_id ?? null; } catch { return null; }
}
export function clearStageSession(issueKey: string, stage: string): void {
  if (!db) return;
  try { db.prepare("DELETE FROM stage_sessions WHERE issue_key = ? AND stage = ?").run(issueKey, stage); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Merge ladder persistence (Gap 2) — persistence ONLY. The earning transition
// (advanceLadder) and every policy decision (decideMerge / effectiveMergeTier)
// live in merge-ladder.ts so the loop and the steward share one source of truth.
// A closed store returns null / a pass-through state, so the pipeline never
// throws and simply records nothing when telemetry is off (--once).
// ---------------------------------------------------------------------------

/** The persisted earned tier + streak for a repo, or null when it has no row. */
export function getLadderState(repo: string): LadderState | null {
  if (!db) return null;
  const r = db.prepare("SELECT repo, tier, clean_streak, total_shadow FROM merge_ladder WHERE repo = ?")
    .get(repo) as { repo: string; tier: string; clean_streak: number; total_shadow: number } | null;
  if (!r) return null;
  return { repo: r.repo, tier: r.tier as LadderState["tier"], cleanStreak: r.clean_streak, totalShadow: r.total_shadow };
}

/** Append a shadow-decision audit row and advance the earned tier. Returns the
 * new LadderState (also when the store is closed — then it is the pure
 * transition, unpersisted). This is the ONE writer of the earning streak, gated
 * by loop.ts behind a stillOurs() re-check so a stale PR never advances it.
 *
 * B9: also gated on isEnrolled(repo) — a repo that has not opted into the
 * ladder must not accrue a clean streak (or even seed a merge_ladder row) at
 * all. Before this gate, effectiveMergeTier hid the earned tier from an
 * un-enrolled repo but recordShadowDecision kept advancing it underneath, so
 * the repo could jump straight past shadow the moment a human DID enroll it —
 * voiding "earn after opt-in". A not-yet-enrolled repo now returns `prev`
 * (unpersisted, unadvanced) instead of writing anything. */
export function recordShadowDecision(repo: string, issueKey: string, decision: MergeDecision, ev: MergeEvidence): LadderState {
  const prev = getLadderState(repo) ?? seedLadderState(repo);
  if (!isEnrolled(repo)) return prev;
  const next = advanceLadder(prev, decision.wouldMerge, {
    promoteAfter: config.mergeLadder.promoteAfter,
    ceiling: ceilingForRepo(repo),
  });
  if (db) {
    try {
      db.prepare("INSERT INTO merge_shadow_log (at, repo, issue_key, would_merge, acted, tier, reasons, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(Date.now(), repo, issueKey, decision.wouldMerge ? 1 : 0, decision.act ? 1 : 0, decision.tier, decision.reasons.join("; ").slice(0, 1000), JSON.stringify(ev));
      db.prepare(`INSERT INTO merge_ladder (repo, tier, clean_streak, total_shadow, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(repo) DO UPDATE SET tier = excluded.tier, clean_streak = excluded.clean_streak, total_shadow = excluded.total_shadow, updated_at = excluded.updated_at`)
        .run(next.repo, next.tier, next.cleanStreak, next.totalShadow, Date.now());
    } catch (error) {
      console.error(`[db] merge-ladder write failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Gap-5 post-merge deploy ledger. recordDeploy marks a (repo, sha) attempt with
// its outcome; deployAttempted is the exactly-once guard postMergeTick consults
// BEFORE deploying so a merge is never deployed twice (a second tick, or a
// reconcile racing the merge→Done transition). Both no-op / return false safely
// when the store is closed (--once) — deploy is gated OFF there anyway, so this
// never silently double-deploys. recordDeploy is INSERT OR REPLACE so a later
// re-attempt (e.g. after a human clears a failed deploy row) overwrites the
// outcome rather than throwing on the primary key.
// ---------------------------------------------------------------------------

/** Record a deploy attempt's outcome for (repo, sha). No-op when store closed. */
export function recordDeploy(repo: string, sha: string, outcome: string): void {
  if (!db || !repo || !sha) return;
  try {
    db.prepare("INSERT OR REPLACE INTO deploys (repo, sha, outcome, at) VALUES (?, ?, ?, ?)")
      .run(repo, sha, outcome, Date.now());
  } catch (error) {
    console.error(`[db] deploy write failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** True iff a deploy was already attempted for (repo, sha) — the exactly-once
 *  guard. Returns false when the store is closed (deploy is OFF there). */
export function deployAttempted(repo: string, sha: string): boolean {
  if (!db || !repo || !sha) return false;
  const row = db.prepare("SELECT 1 AS n FROM deploys WHERE repo = ? AND sha = ?").get(repo, sha) as { n: number } | null;
  return row !== null;
}

// ---------------------------------------------------------------------------
// Approvals inbox rows — persistence ONLY, same split as the merge ladder
// above: every decision about WHEN an item is filed, whether an approve may
// merge, and what a pushback does lives in approvals.ts; these helpers just
// read/write rows through the daemon's single shared handle. Closed-store
// behavior mirrors the rest of this file: reads return empty/null, writes
// return null/false, nothing ever throws into the pipeline or a request.
// ---------------------------------------------------------------------------

export type ApprovalStatus = "pending" | "approved" | "pushed_back" | "stale";

/** Per-gate test-count ratchet slice ("tests 631 → 640") for the approval card. */
export interface ApprovalGateTests { name: string; from: number | null; to: number | null }

export interface ApprovalItem {
  id: number;
  createdAt: number;
  updatedAt: number;
  issueKey: string;
  title: string;
  repo: string;
  prUrl: string;
  /** The head SHA the evidence gates ran against — the ONLY commit approve may
   *  merge (pinned via --match-head-commit). null when the run could not record
   *  one; approve refuses such an item outright. */
  gatedHeadSha: string | null;
  holdReasons: string;
  gateSummary: { green: boolean; strength: string; tests: ApprovalGateTests[] } | null;
  securityVerdict: string;
  tasteVerdict: string;
  findingsDigest: string;
  diffStat: string;
  costUsd: number;
  turns: number;
  /** The recorded gateSummary green is KNOWN NOT to describe this branch merged
   *  with current main: the pre-merge re-gate ran against the combined head and
   *  FAILED (loop.ts preMergeIntegrity). Carried as its own field because the
   *  card's green evidence would otherwise read as the whole story. */
  regateFailed: boolean;
  status: ApprovalStatus;
  resolution: string;
}

interface RawApprovalRow {
  id: number; created_at: number; updated_at: number; issue_key: string; title: string;
  repo: string; pr_url: string; gated_head_sha: string | null; hold_reasons: string;
  gate_summary_json: string | null; security_verdict: string; taste_verdict: string;
  findings_digest: string; diff_stat: string; cost_usd: number; turns: number;
  regate_failed: number; status: string; resolution: string;
}

const APPROVAL_COLUMNS = "id, created_at, updated_at, issue_key, title, repo, pr_url, gated_head_sha, hold_reasons, gate_summary_json, security_verdict, taste_verdict, findings_digest, diff_stat, cost_usd, turns, regate_failed, status, resolution";

function toApprovalItem(r: RawApprovalRow): ApprovalItem {
  let gateSummary: ApprovalItem["gateSummary"] = null;
  if (r.gate_summary_json) {
    try { gateSummary = JSON.parse(r.gate_summary_json) as ApprovalItem["gateSummary"]; } catch { /* legacy/bad row degrades to null */ }
  }
  return {
    id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, issueKey: r.issue_key,
    title: r.title, repo: r.repo, prUrl: r.pr_url, gatedHeadSha: r.gated_head_sha,
    holdReasons: r.hold_reasons, gateSummary, securityVerdict: r.security_verdict,
    tasteVerdict: r.taste_verdict, findingsDigest: r.findings_digest, diffStat: r.diff_stat,
    costUsd: num(r.cost_usd), turns: num(r.turns), regateFailed: r.regate_failed === 1,
    status: (["pending", "approved", "pushed_back", "stale"].includes(r.status) ? r.status : "stale") as ApprovalStatus,
    resolution: r.resolution,
  };
}

/** Insert a new approval item, superseding any still-pending item for the same
 *  issue (a re-run's fresh evidence makes the old card unreliable — its gated
 *  SHA no longer matches the branch, so it could only ever refuse). Returns the
 *  new row id, or null when the store is closed. Caller (approvals.ts) has
 *  already redacted/capped every string. */
export function insertApproval(row: {
  issueKey: string; title: string; repo: string; prUrl: string;
  gatedHeadSha: string | null; holdReasons: string;
  gateSummary: ApprovalItem["gateSummary"];
  securityVerdict: string; tasteVerdict: string; findingsDigest: string;
  diffStat: string; costUsd: number; turns: number; regateFailed: boolean;
}): number | null {
  if (!db) return null;
  const now = Date.now();
  db.prepare("UPDATE approvals SET status = 'stale', resolution = 'superseded by a newer run', updated_at = ? WHERE issue_key = ? AND status = 'pending'")
    .run(now, row.issueKey);
  const res = db.prepare(
    `INSERT INTO approvals (created_at, updated_at, issue_key, title, repo, pr_url, gated_head_sha, hold_reasons, gate_summary_json, security_verdict, taste_verdict, findings_digest, diff_stat, cost_usd, turns, regate_failed, status, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '')`,
  ).run(now, now, row.issueKey, row.title, row.repo, row.prUrl, row.gatedHeadSha, row.holdReasons,
    row.gateSummary ? JSON.stringify(row.gateSummary) : null,
    row.securityVerdict, row.tasteVerdict, row.findingsDigest, row.diffStat, row.costUsd, row.turns,
    row.regateFailed ? 1 : 0);
  return Number(res.lastInsertRowid);
}

/** Pending items, newest first — the GET /approvals payload. */
export function listPendingApprovals(limit = 100): ApprovalItem[] {
  if (!db) return [];
  const rows = db.prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE status = 'pending' ORDER BY id DESC LIMIT ?`)
    .all(limit) as RawApprovalRow[];
  return rows.map(toApprovalItem);
}

/** Count of pending items — the nav badge. */
export function pendingApprovalCount(): number {
  if (!db) return 0;
  const row = db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number };
  return row.n;
}

export function getApproval(id: number): ApprovalItem | null {
  if (!db) return null;
  const row = db.prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`).get(id) as RawApprovalRow | null;
  return row ? toApprovalItem(row) : null;
}

/** ATOMIC pending→`to` transition — the idempotency/double-click guard. A
 *  single conditional UPDATE (WHERE status='pending'), so of two concurrent
 *  approve calls exactly ONE observes changes>0 and proceeds to merge; the
 *  other gets false and returns 409 without acting. Also what makes "no
 *  endpoint can flip a decision for a run that is not in the human lane" hold:
 *  a run outside the lane has no pending row to claim. */
export function claimApproval(id: number, to: Exclude<ApprovalStatus, "pending">): boolean {
  if (!db) return false;
  const res = db.prepare("UPDATE approvals SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(to, Date.now(), id);
  return res.changes > 0;
}

/** Unconditional status/resolution write — used AFTER a successful claim to
 *  record the outcome detail, roll a failed action back to pending (merge
 *  refused for a non-head reason), or mark an item stale. Never a substitute
 *  for claimApproval on the act path. */
export function finalizeApproval(id: number, status: ApprovalStatus, resolution: string): void {
  if (!db) return;
  db.prepare("UPDATE approvals SET status = ?, resolution = ?, updated_at = ? WHERE id = ?")
    .run(status, resolution.slice(0, 1000), Date.now(), id);
}

/** Store the owner's pushback directive for the issue's next run (one row per
 *  issue — a second pushback before the re-run replaces the first, matching
 *  what the owner most recently said). Returns false when the store is closed. */
export function recordPushbackFeedback(issueKey: string, feedback: string): boolean {
  if (!db || !issueKey) return false;
  db.prepare("INSERT OR REPLACE INTO pushback_feedback (issue_key, feedback, created_at) VALUES (?, ?, ?)")
    .run(issueKey, feedback, Date.now());
  return true;
}

/** Put a TAKEN directive back when the run that consumed it never delivered
 *  anything for the owner to review (parked/aborted/threw before a PR existed).
 *  INSERT OR IGNORE, never REPLACE: a directive the owner recorded DURING that
 *  run is newer and must win — a restore may never resurrect superseded
 *  direction over it. loop.ts owns the when (ownerFeedbackHandoff). */
export function restorePushbackFeedback(issueKey: string, feedback: string): boolean {
  if (!db || !issueKey) return false;
  const res = db.prepare("INSERT OR IGNORE INTO pushback_feedback (issue_key, feedback, created_at) VALUES (?, ?, ?)")
    .run(issueKey, feedback, Date.now());
  return res.changes > 0;
}

/** Read-and-delete the pending directive for an issue (exactly-once handoff
 *  into the re-run's prompts). null when none / store closed. */
export function takePushbackFeedback(issueKey: string): string | null {
  if (!db || !issueKey) return null;
  const row = db.prepare("SELECT feedback FROM pushback_feedback WHERE issue_key = ?").get(issueKey) as { feedback: string } | null;
  if (!row) return null;
  db.prepare("DELETE FROM pushback_feedback WHERE issue_key = ?").run(issueKey);
  return row.feedback;
}

// ---------------------------------------------------------------------------
// Test seam — an in-memory database with the full schema, used only by the unit
// suite (no bus subscription, no file). Kept here so the module-level `db` handle
// stays private and the single-writer invariant holds.
// ---------------------------------------------------------------------------

/** Open an :memory: (or given-path) db with the full schema for tests. */
export function openTestDatabase(path = ":memory:"): void {
  db = new Database(path);
  ensureSchema(db);
}

/** Close and clear the test database (resets caches too). */
export function closeTestDatabase(): void {
  try { db?.close(); } catch { /* already closed */ }
  db = null;
  telemetryCache = null;
}

/** Test-only: insert a raw event row directly into the durable log, bypassing
 *  the bus subscription (openTestDatabase() deliberately wires up no bus — see
 *  above). Lets tests exercise the READ paths that scan the `events` table
 *  (getTelemetry, issueEvents, …) without a real file + bus.subscribe. No-op
 *  when the test store isn't open. */
export function insertTestEvent(type: string, body: Record<string, unknown>, at = Date.now()): void {
  if (!db) return;
  const key = typeof body.issueKey === "string" ? body.issueKey : null;
  db.prepare("INSERT INTO events (seq, at, type, issue_key, json) VALUES (?, ?, ?, ?, ?)")
    .run(0, at, type, key, JSON.stringify({ type, seq: 0, at, ...body }));
}
