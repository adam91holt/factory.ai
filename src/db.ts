import { config } from "./config.ts";
import { bus, type FactoryEvent } from "./events.ts";
import { bunStore, pgliteStore, type Store } from "./store.ts";
import { advanceLadder, seedLadderState, ceilingForRepo, isEnrolled, type LadderState, type MergeDecision, type MergeEvidence } from "./merge-ladder.ts";

// Durable event store (owner request 2026-07-20): every FactoryEvent — already
// redacted at emit — lands in POSTGRES so agent activity survives restarts.
//
// Postgres is the ONLY production path (there is no SQLite fallback, and no
// env-switchable second driver). Bring it up with `bun run db:up`; the compose
// file is checked in at the repo root. The unit suite does NOT need it — tests
// run on an in-process PGlite (WASM Postgres) seam via openTestDatabase(), so
// `bun test` stays hermetic and fast. src/store.ts is the ONLY file that
// imports a driver; every SQL string lives here.
//
// SINGLE WRITER, unchanged: this module holds the only Store handle, it is the
// only subscriber that persists bus events, and every other module goes through
// the exported helpers — never raw SQL.
//
// THE SYNC/ASYNC SEAM. bun:sqlite was synchronous; a Postgres client is not.
// Exactly ONE asymmetry resolves that, and it is deliberate:
//
//   • bus.emit stays SYNCHRONOUS (events.ts documents it as sync, never-throws,
//     fire-and-forget, and ~40 call sites rely on that). Its subscriber here
//     therefore stays a sync callback that ENQUEUES into a bounded, strictly
//     ordered write-behind queue and kicks a single-flight drain.
//   • EVERY other export is async, and every read path calls `await
//     flushEvents()` first — so write-behind is invisible to readers and the
//     only residual difference from the old inline INSERT is the crash window.
//
// ONE consumer, FIFO, serial batched INSERTs ⇒ identity ids are assigned in
// EMIT order, which is what lastParkReasonForIssue (ORDER BY id DESC) and
// issueEvents (ORDER BY id ASC) depend on.
//
// TYPE-MAPPING RULE (measured, not assumed — see src/store.ts): Bun returns
// int8/BIGINT/COUNT(*)/SUM() as STRINGS; PGlite returns them as NUMBERS. So
// (a) every numeric SELECT here carries an explicit `::float8` / `::int` cast,
// and (b) every numeric column is funnelled through num(), which now also
// accepts numeric strings. (a) is the fast path; (b) is the safety net that
// makes a missed cast slow-but-correct instead of silently handing a string to
// arithmetic. tests/db-cast-discipline.test.ts machine-enforces (a).

let store: Store | null = null;
let state: "open" | "closed" = "closed";
let opening: Promise<void> | null = null;

/** All DDL for the factory store — extracted so both the daemon store and the
 * in-memory test seam create an identical schema. `CREATE ... IF NOT EXISTS`
 * throughout, so calling it on an existing database is a no-op.
 *
 * Deliberate type choices, each of which was a real decision:
 *  - epoch millis stay BIGINT, NOT timestamptz: `FactoryEvent.at` is epoch-ms in
 *    the VERBATIM SHARED BLOCK that ui/src/lib/events.ts duplicates, and
 *    Telemetry.generatedAt / dayKey() / the watermark cache key are all epoch-ms
 *    numbers. timestamptz would come back as a Date and disagree with the `at`
 *    inside the stored JSON body. Nothing does date arithmetic in SQL.
 *  - JSON columns stay TEXT, NOT jsonb: jsonb normalises key order and drops
 *    duplicate keys, so it does not round-trip the exact emitted bytes of a
 *    forensic log; every consumer already JSON.parses in JS; and the two drivers
 *    disagree on jsonb (string vs parsed object) — exactly the divergence this
 *    whole design exists to eliminate.
 *  - cost_usd is DOUBLE PRECISION, not REAL: PG REAL is float4 and loses cents
 *    across summed spend.
 *  - SQLite's INTEGER-as-boolean columns are real BOOLEANs now (verified to come
 *    back as JS booleans on both drivers), so the `!== 0` coercions are gone.
 */
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS stage_sessions (
    issue_key TEXT NOT NULL, stage TEXT NOT NULL, session_id TEXT NOT NULL, at BIGINT NOT NULL,
    PRIMARY KEY (issue_key, stage))`,
  `CREATE TABLE IF NOT EXISTS events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seq BIGINT, at BIGINT, type TEXT, issue_key TEXT, json TEXT)`,
  "CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_key, id)",
  // Telemetry aggregation scans by event type (run_stage_finished / run_finished).
  "CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id)",
  // Durable, repo-scoped lessons distilled from failures (park / needs-human /
  // taste-fail) — the self-improvement flywheel's memory (level-4-roadmap.md,
  // principle 7). All reads/writes go through the row helpers here, and ONLY
  // src/lessons.ts calls those — other modules consume the lessons.ts API,
  // never SQL.
  `CREATE TABLE IF NOT EXISTS lessons (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at BIGINT,
    repo TEXT, stage TEXT, issue_key TEXT,
    lesson TEXT, source_reason TEXT,
    archived BOOLEAN NOT NULL DEFAULT FALSE)`,
  "CREATE INDEX IF NOT EXISTS idx_lessons_repo ON lessons(repo, archived, id)",
  // Gap-2 merge ladder: the per-repo EARNED tier + clean streak, and an append-
  // only audit log of every shadow decision. The earning MATH lives in
  // merge-ladder.ts (pure); these tables only persist its output.
  `CREATE TABLE IF NOT EXISTS merge_ladder (
    repo TEXT PRIMARY KEY, tier TEXT, clean_streak INTEGER, total_shadow INTEGER, updated_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS merge_shadow_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at BIGINT, repo TEXT, issue_key TEXT,
    would_merge BOOLEAN, acted BOOLEAN, tier TEXT, reasons TEXT, evidence_json TEXT)`,
  // Gap-5 post-merge deploy ledger: EXACTLY-ONCE idempotency for deploy/smoke/
  // revert. A (repo, sha) pair is recorded the moment a deploy is attempted so a
  // second tick (or a reconcile racing postMergeTick) never re-deploys the same
  // merge — the deployAttempted() guard. PRIMARY KEY (repo, sha) makes the guard
  // a single indexed lookup.
  `CREATE TABLE IF NOT EXISTS deploys (
    repo TEXT NOT NULL, sha TEXT NOT NULL, outcome TEXT, at BIGINT,
    PRIMARY KEY (repo, sha))`,
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
  `CREATE TABLE IF NOT EXISTS approvals (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    issue_key TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    repo TEXT NOT NULL, pr_url TEXT NOT NULL,
    gated_head_sha TEXT,
    hold_reasons TEXT NOT NULL DEFAULT '',
    gate_summary_json TEXT,
    security_verdict TEXT NOT NULL DEFAULT 'none',
    taste_verdict TEXT NOT NULL DEFAULT 'not-required',
    findings_digest TEXT NOT NULL DEFAULT '',
    diff_stat TEXT NOT NULL DEFAULT '',
    cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
    regate_failed BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'pending',
    resolution TEXT NOT NULL DEFAULT '')`,
  // regate_failed post-dates the table by one commit, so a store an earlier
  // build of this branch created lacks it — and SELECT names every column, so
  // every read would throw. Postgres HAS ADD COLUMN IF NOT EXISTS, so this is
  // idempotent outright rather than idempotent-by-failing like the SQLite era.
  "ALTER TABLE approvals ADD COLUMN IF NOT EXISTS regate_failed BOOLEAN NOT NULL DEFAULT FALSE",
  "CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, id)",
  // Push-back feedback handoff: the owner's directive travels from the
  // pushback endpoint to the NEXT run of the same issue via this one-row-per-
  // issue table. Consumed exactly once (takePushbackFeedback = a single
  // DELETE ... RETURNING) so stale direction can never resurrect on a later
  // unrelated re-run; the durable copy for humans is the Linear comment
  // approvals.ts posts.
  `CREATE TABLE IF NOT EXISTS pushback_feedback (
    issue_key TEXT PRIMARY KEY, feedback TEXT NOT NULL, created_at BIGINT NOT NULL)`,
];

/** Create the full schema on `s`. Idempotent. */
export async function migrate(s: Store): Promise<void> {
  for (const stmt of DDL) await s.exec(stmt);
}

// ---------------------------------------------------------------------------
// Write-behind event queue — the ONE place the sync/async seam is bridged.
// ---------------------------------------------------------------------------

interface PendingEvent { seq: number; at: number; type: string; issueKey: string | null; json: string }

/** Hard cap on queued-but-unwritten events. IN-CODE CONSTANT, not an env knob:
 *  an unbounded queue turns a Postgres outage into an OOM, and a knob that can
 *  be set to infinity is not a cap (CLAUDE.md). Overflow drops loudly. */
const MAX_QUEUED_EVENTS = 10_000;
/** Rows per multi-row INSERT. Bounds the parameter count per statement. */
const EVENT_BATCH = 256;

const queue: PendingEvent[] = [];
let draining: Promise<void> | null = null;
/** Rows spliced out of `queue` and currently being INSERTed. Counted separately
 *  so pendingEventWrites()/storeHealth() mean what they say — "accepted but not
 *  yet written" — instead of silently under-reporting by up to one batch the
 *  moment a drain is in flight. Never part of the overflow check: the cap
 *  guards unbounded growth, and this is bounded by EVENT_BATCH. */
let inFlightEvents = 0;
let droppedEvents = 0;
let lastWriteError: string | null = null;
let subscribed: (() => void) | null = null;

/** Sync, never throws — the bus subscriber's whole body. */
function enqueue(e: FactoryEvent): void {
  if (queue.length >= MAX_QUEUED_EVENTS) {
    droppedEvents += 1;
    if (droppedEvents === 1 || droppedEvents % 1000 === 0) {
      console.error(`[db] event queue full (${MAX_QUEUED_EVENTS}) — dropped ${droppedEvents} event(s)`);
    }
    return;
  }
  queue.push({
    seq: e.seq, at: e.at, type: e.type,
    issueKey: (e as { issueKey?: string }).issueKey ?? null,
    json: JSON.stringify(e),
  });
  void drain();
}

async function writeBatch(batch: PendingEvent[]): Promise<void> {
  const s = store;
  if (!s) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  for (const row of batch) {
    const base = params.length;
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    params.push(row.seq, row.at, row.type, row.issueKey, row.json);
  }
  await s.exec(`INSERT INTO events (seq, at, type, issue_key, json) VALUES ${tuples.join(", ")}`, params);
}

/** Single-flight FIFO drain. Serial batches ⇒ identity ids follow emit order. */
function drain(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    try {
      while (queue.length > 0 && store) {
        const batch = queue.splice(0, EVENT_BATCH);
        inFlightEvents = batch.length;
        try {
          await writeBatch(batch);
        } catch (error) {
          lastWriteError = String(error instanceof Error ? error.message : error);
          // One retry, then drop LOUDLY. The SQLITE_BUSY catch this replaces
          // already established best-effort as the contract here, and under
          // MVCC a write failure is strictly rarer than it was.
          try {
            await writeBatch(batch);
          } catch {
            droppedEvents += batch.length;
            console.error(`[db] event batch dropped (${batch.length} rows): ${lastWriteError}`);
          }
        } finally {
          inFlightEvents = 0;
        }
      }
    } finally {
      draining = null;
      if (queue.length > 0 && store) void drain();
    }
  })();
  return draining;
}

/** Wait until every enqueued event has been written (or dropped). Called as the
 *  first statement of EVERY read path, which is what makes write-behind
 *  strictly equivalent to the old inline INSERT from a reader's point of view. */
export async function flushEvents(): Promise<void> {
  while (queue.length > 0 || draining) {
    const inFlight = draining ?? drain();
    await inFlight;
    if (!store) break; // closed store can never drain — don't spin
  }
}

/** Events accepted but not yet written — queued PLUS the batch currently being
 *  INSERTed. Sync (module state, not a query). */
export function pendingEventWrites(): number {
  return queue.length + inFlightEvents;
}

/** Operability snapshot: how far behind the writer is and what last broke.
 *  Sync (module state, not a query). */
export function storeHealth(): { open: boolean; pending: number; dropped: number; lastError: string | null } {
  return { open: state === "open", pending: pendingEventWrites(), dropped: droppedEvents, lastError: lastWriteError };
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

/** host:port/db of a connection string, with any credentials dropped — safe to
 *  put in a log line. Falls back to a constant rather than echoing a malformed
 *  URL, which could itself be (or contain) the password. */
function safeStoreTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable FACTORY_DATABASE_URL)";
  }
}

/** Open the durable store and start persisting bus events. Idempotent AND
 *  concurrency-safe: main() and startDashboard() both call it, and now that it
 *  is async a `if (store) return` guard would let two callers race two
 *  connections and two bus subscriptions. The in-flight promise is memoised
 *  instead. A failed open clears the memo so a later caller can retry. */
export async function startEventStore(): Promise<void> {
  if (opening) return opening;
  opening = (async () => {
    if (config.databaseUrl === "") {
      // FACTORY_DATABASE_URL explicitly blank = "no database configured".
      // tests/setup.ts sets it, so a unit test that somehow reached this path
      // fails loudly here instead of connecting to the owner's live store.
      throw new Error("FACTORY_DATABASE_URL is set to an empty value — refusing to open a store (see .env.example / docker-compose.yml)");
    }
    const s = await bunStore(config.databaseUrl);
    try {
      await migrate(s);
    } catch (error) {
      // Bun's own connect failure is a bare "Connection closed". Say WHERE we
      // tried and how to fix it — without the password: the URL is a secret,
      // and this string reaches logs.
      await s.close().catch(() => { /* nothing to close */ });
      throw new Error(`cannot reach the factory store at ${safeStoreTarget(config.databaseUrl)} (${error instanceof Error ? error.message : error}) — is it up? \`bun run db:up\``);
    }
    store = s;
    state = "open";
    if (!subscribed) subscribed = bus.subscribe(enqueue);
  })().catch((error) => {
    opening = null;
    throw error;
  });
  return opening;
}

/** True when the durable event store is open. Budget/parks governance is only
 *  enforceable with the store open — callers must fail CLOSED when it isn't.
 *  Deliberately SYNCHRONOUS: it reads module state, never the database, so the
 *  fail-closed gates in groundskeeperTick / captureLesson keep working exactly
 *  as they did (no await, no chance of a rejected promise reading as "open"). */
export function eventStoreOpen(): boolean {
  return state === "open";
}

/** Full historical event stream for one issue (all sessions). */
export async function issueEvents(issueKey: string, limit = 2000): Promise<unknown[]> {
  await flushEvents();
  if (!store) return [];
  const rows = await store.query<{ json: string }>(
    "SELECT json FROM events WHERE issue_key = $1 ORDER BY id ASC LIMIT $2", [issueKey, limit]);
  return rows.map((r) => JSON.parse(r.json) as unknown);
}

// ---------------------------------------------------------------------------
// Groundskeeper governance reads (owner request 2026-07-20). Read-only queries
// over the same durable log the daemon already writes. NOTE: a closed store
// returning 0 here would be fail-OPEN for the budget gate ("nothing spent"
// forever) — that is why groundskeeperTick refuses to run at all when
// eventStoreOpen() is false. Indexed by idx_events_issue / idx_events_type.
// ---------------------------------------------------------------------------

/** Sum of run_stage_finished costUsd for one issueKey (e.g. "GK-kiwi-quest")
 *  since `sinceMs`. Backs a groundskeeper's weekly budget envelope. */
export async function stageSpendForIssueSince(issueKey: string, sinceMs: number): Promise<number> {
  await flushEvents();
  if (!store) return 0;
  const rows = await store.query<{ json: string }>(
    "SELECT json FROM events WHERE type = 'run_stage_finished' AND issue_key = $1 AND at >= $2",
    [issueKey, sinceMs]);
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
export async function stageRunCountForIssueSince(issueKey: string, sinceMs: number): Promise<number> {
  await flushEvents();
  if (!store) return 0;
  const rows = await store.query<{ n: unknown }>(
    "SELECT COUNT(*)::int AS n FROM events WHERE type = 'run_stage_finished' AND issue_key = $1 AND at >= $2",
    [issueKey, sinceMs]);
  return num(rows[0]?.n);
}

/** Count of real (non-dry) run_finished parked outcomes since `sinceMs` — the
 *  parks-spike signal that flips a groundskeeper into repair-only mode. */
export async function parkedRunsSince(sinceMs: number): Promise<number> {
  await flushEvents();
  if (!store) return 0;
  const rows = await store.query<{ json: string }>(
    "SELECT json FROM events WHERE type = 'run_finished' AND at >= $1", [sinceMs]);
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
 *  never see "parked" with the WHY stranded in the store (FAC-14 lesson).
 *  ORDER BY id DESC is newest-first only because the write queue assigns ids in
 *  emit order — see the header note. */
export async function lastParkReasonForIssue(issueKey: string): Promise<string | null> {
  await flushEvents();
  if (!store) return null;
  const rows = await store.query<{ type: string; json: string }>(
    "SELECT type, json FROM events WHERE issue_key = $1 AND type IN ('run_finished', 'issue_needs_human') ORDER BY id DESC LIMIT 50",
    [issueKey]);
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
// leaderboard) so every card gets its own honest numbers, and cheap: one scan
// over the indexed run_stage_finished rows. Returns zeroed maps when the store
// is closed. `turns` is total across runs; the UI divides for an average.
// ---------------------------------------------------------------------------

export interface CardUsage { runs: number; costUsd: number; turns: number }

export async function catalogUsage(): Promise<{ byStage: Record<string, CardUsage>; byIssueKey: Record<string, CardUsage> }> {
  const byStage: Record<string, CardUsage> = {};
  const byIssueKey: Record<string, CardUsage> = {};
  await flushEvents();
  if (!store) return { byStage, byIssueKey };
  const rows = await store.query<{ json: string }>(
    "SELECT json FROM events WHERE type = 'run_stage_finished'");
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

/** Coerce a stored/queried field to a finite number.
 *
 *  WIDENED for Postgres and it is load-bearing, not cosmetic: Bun's client
 *  returns int8/BIGINT/COUNT(*) as STRINGS while PGlite returns NUMBERS (see
 *  src/store.ts). Every numeric SELECT here casts explicitly so both drivers
 *  hand back a number — this string leg is the SAFETY NET that makes a missed
 *  cast slow-but-correct rather than silently placing "1785628979286" where a
 *  timestamp was expected. It is also still the same guard agents.ts's writer
 *  uses for JSON-blob fields, which is why non-finite input yields 0. */
const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : 0;
  }
  return 0;
};

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
// Single-flight guard. Now that this is async, two simultaneous dashboard polls
// would BOTH miss the watermark and BOTH run the double full scan; sharing one
// in-flight computation removes a stampede the synchronous version could not
// have had.
let telemetryInFlight: Promise<Telemetry> | null = null;

/** Aggregate GET /telemetry from the durable event log. Returns a zeroed shape
 *  when the store is not open or holds no events. */
export async function getTelemetry(): Promise<Telemetry> {
  await flushEvents();
  if (!store) return emptyTelemetry();
  if (telemetryInFlight) return telemetryInFlight;
  telemetryInFlight = computeTelemetry().finally(() => { telemetryInFlight = null; });
  return telemetryInFlight;
}

async function computeTelemetry(): Promise<Telemetry> {
  const s = store;
  if (!s) return emptyTelemetry();

  // GREATEST is Postgres's 2-arg max (SQLite spelled it `max(a, b)`).
  const wmRows = await s.query<{ m: unknown }>(
    `SELECT GREATEST(
       COALESCE((SELECT MAX(id) FROM events WHERE type = 'run_stage_finished'), 0),
       COALESCE((SELECT MAX(id) FROM events WHERE type = 'run_finished'), 0)
     )::float8 AS m`);
  const watermark = num(wmRows[0]?.m);
  const today = dayKey(Date.now());
  if (telemetryCache && telemetryCache.watermark === watermark && telemetryCache.day === today) {
    return { ...telemetryCache.value, generatedAt: Date.now() };
  }

  const t = emptyTelemetry();
  const dailyByDate = new Map(t.daily.map((d) => [d.date, d]));

  const stageRows = await s.query<{ at: unknown; json: string }>(
    "SELECT at::float8 AS at, json FROM events WHERE type = 'run_stage_finished' ORDER BY id ASC");
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

    const bucket = dailyByDate.get(dayKey(num(row.at)));
    if (bucket) {
      bucket.costUsd += costUsd; bucket.turns += turns;
      bucket.tokensIn += stageIn; bucket.tokensOut += stageOut; bucket.cacheRead += stageCacheRead;
    }
  }

  const runRows = await s.query<{ at: unknown; json: string }>(
    "SELECT at::float8 AS at, json FROM events WHERE type = 'run_finished' ORDER BY id ASC");
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
    if (Array.isArray(e.stages) && e.stages.some((s2) => s2?.degraded === true)) t.totals.degradedRuns += 1;

    // Spend comes from stage rows above; run_finished only contributes the
    // delivery count. Rows without a string issueKey are skipped, never "?".
    if (typeof e.issueKey === "string" && e.issueKey.trim() !== "") {
      const cbi = costByIssue.get(e.issueKey) ?? { costUsd: 0, runs: 0 };
      cbi.runs += 1;
      costByIssue.set(e.issueKey, cbi);
    }

    const bucket = dailyByDate.get(dayKey(num(row.at)));
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
  telemetryCache = { watermark, day: today, value: t };
  return t;
}

// ---------------------------------------------------------------------------
// Lessons rows — thin shared-handle accessors consumed ONLY by src/lessons.ts
// (which owns validation, redaction, caps, and the distillation step). Keeping
// them here honors the single-writer rule. Each returns a safe zero value when
// the store is closed (--once / DASHBOARD_PORT=0) — lessons capture is
// best-effort and must never throw into the pipeline.
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

interface RawLessonRow { id: unknown; created_at: unknown; repo: string; stage: string;
  issue_key: string; lesson: string; source_reason: string; archived: boolean }

function toLessonRow(r: RawLessonRow): LessonRow {
  return { id: num(r.id), createdAt: num(r.created_at), repo: r.repo, stage: r.stage,
    issueKey: r.issue_key, lesson: r.lesson, sourceReason: r.source_reason,
    archived: r.archived === true };
}

const LESSON_COLUMNS = "id::float8 AS id, created_at::float8 AS created_at, repo, stage, issue_key, lesson, source_reason, archived";

/** Insert one lesson row. Returns false (no throw) when the store is closed. */
export async function insertLessonRow(row: { createdAt: number; repo: string; stage: string;
  issueKey: string; lesson: string; sourceReason: string }): Promise<boolean> {
  if (!store) return false;
  await store.exec(
    "INSERT INTO lessons (created_at, repo, stage, issue_key, lesson, source_reason, archived) VALUES ($1, $2, $3, $4, $5, $6, FALSE)",
    [row.createdAt, row.repo, row.stage, row.issueKey, row.lesson, row.sourceReason]);
  return true;
}

/** Newest-first active (archived = false) lessons for one repo, capped by `limit`. */
export async function activeLessonRowsForRepo(repo: string, limit: number): Promise<LessonRow[]> {
  if (!store) return [];
  const rows = await store.query<RawLessonRow>(
    `SELECT ${LESSON_COLUMNS} FROM lessons WHERE repo = $1 AND archived = FALSE ORDER BY id DESC LIMIT $2`,
    [repo, limit]);
  return rows.map(toLessonRow);
}

/** Every lesson row (archived included), newest first, bounded. */
export async function allLessonRows(limit: number): Promise<LessonRow[]> {
  if (!store) return [];
  const rows = await store.query<RawLessonRow>(
    `SELECT ${LESSON_COLUMNS} FROM lessons ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.map(toLessonRow);
}

/** Human-initiated archive (sets archived = TRUE — rows are never deleted).
 *  Returns true when a row actually changed. */
export async function archiveLessonRow(id: number): Promise<boolean> {
  if (!store) return false;
  const changed = await store.exec("UPDATE lessons SET archived = TRUE WHERE id = $1 AND archived = FALSE", [id]);
  return changed > 0;
}

/** Count of lessons written since `sinceMs` — backs the distillation spend
 *  guard (per-day cap on distiller calls). */
export async function lessonRowCountSince(sinceMs: number): Promise<number> {
  if (!store) return 0;
  const rows = await store.query<{ n: unknown }>(
    "SELECT COUNT(*)::int AS n FROM lessons WHERE created_at >= $1", [sinceMs]);
  return num(rows[0]?.n);
}

/** Resume support: persist the SDK session_id for an in-flight stage so a
 * cut-off run (process killed mid-stage) can resume its actual conversation
 * on re-claim instead of starting over. Recorded on session init, cleared when
 * the stage returns normally — so a lingering row == the stage was interrupted. */
export async function recordStageSession(issueKey: string, stage: string, sessionId: string): Promise<void> {
  if (!store || !issueKey || !stage || !sessionId) return;
  try {
    await store.exec(
      `INSERT INTO stage_sessions (issue_key, stage, session_id, at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (issue_key, stage) DO UPDATE SET session_id = EXCLUDED.session_id, at = EXCLUDED.at`,
      [issueKey, stage, sessionId, Date.now()]);
  } catch { /* best-effort */ }
}
export async function getStageSession(issueKey: string, stage: string): Promise<string | null> {
  if (!store) return null;
  try {
    const rows = await store.query<{ session_id?: string }>(
      "SELECT session_id FROM stage_sessions WHERE issue_key = $1 AND stage = $2", [issueKey, stage]);
    return rows[0]?.session_id ?? null;
  } catch { return null; }
}
export async function clearStageSession(issueKey: string, stage: string): Promise<void> {
  if (!store) return;
  try { await store.exec("DELETE FROM stage_sessions WHERE issue_key = $1 AND stage = $2", [issueKey, stage]); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Merge ladder persistence (Gap 2) — persistence ONLY. The earning transition
// (advanceLadder) and every policy decision (decideMerge / effectiveMergeTier)
// live in merge-ladder.ts so the loop and the steward share one source of truth.
// A closed store returns null / a pass-through state, so the pipeline never
// throws and simply records nothing when telemetry is off (--once).
// ---------------------------------------------------------------------------

/** The persisted earned tier + streak for a repo, or null when it has no row. */
export async function getLadderState(repo: string): Promise<LadderState | null> {
  if (!store) return null;
  const rows = await store.query<{ repo: string; tier: string; clean_streak: unknown; total_shadow: unknown }>(
    "SELECT repo, tier, clean_streak::int AS clean_streak, total_shadow::int AS total_shadow FROM merge_ladder WHERE repo = $1",
    [repo]);
  const r = rows[0];
  if (!r) return null;
  return { repo: r.repo, tier: r.tier as LadderState["tier"], cleanStreak: num(r.clean_streak), totalShadow: num(r.total_shadow) };
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
// Per-repo write mutex for the ladder's read-modify-write. Under bun:sqlite
// the whole function was synchronous, so two same-repo calls could never
// interleave; the async store introduced await points between the read and the
// write, and WIP_LIMIT > 1 means two issues on the SAME repo can finish
// near-simultaneously (adversarial review 2026-08-02, HIGH: a lost update here
// can grant auto-merge authority on a streak that contained a failed run).
// Same in-process keyed-mutex pattern as repos.ts's repoLocks (C15) — the
// daemon is the single writer (see governance note above), so an in-process
// lock IS a global lock for this table.
const ladderLocks = new Map<string, Promise<unknown>>();

export async function recordShadowDecision(repo: string, issueKey: string, decision: MergeDecision, ev: MergeEvidence): Promise<LadderState> {
  const previous = ladderLocks.get(repo) ?? Promise.resolve();
  let release!: () => void;
  ladderLocks.set(repo, new Promise<void>((resolve) => { release = resolve; }));
  try {
    await previous.catch(() => {});
    const prev = (await getLadderState(repo)) ?? seedLadderState(repo);
    if (!isEnrolled(repo)) return prev;
    const next = advanceLadder(prev, decision.wouldMerge, {
      promoteAfter: config.mergeLadder.promoteAfter,
      ceiling: ceilingForRepo(repo),
    });
    if (store) {
      try {
        await store.exec(
          "INSERT INTO merge_shadow_log (at, repo, issue_key, would_merge, acted, tier, reasons, evidence_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [Date.now(), repo, issueKey, decision.wouldMerge, decision.act, decision.tier,
            decision.reasons.join("; ").slice(0, 1000), JSON.stringify(ev)]);
        await store.exec(
          `INSERT INTO merge_ladder (repo, tier, clean_streak, total_shadow, updated_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (repo) DO UPDATE SET tier = EXCLUDED.tier, clean_streak = EXCLUDED.clean_streak, total_shadow = EXCLUDED.total_shadow, updated_at = EXCLUDED.updated_at`,
          [next.repo, next.tier, next.cleanStreak, next.totalShadow, Date.now()]);
      } catch (error) {
        console.error(`[db] merge-ladder write failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    return next;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Gap-5 post-merge deploy ledger. recordDeploy marks a (repo, sha) attempt with
// its outcome; deployAttempted is the exactly-once guard postMergeTick consults
// BEFORE deploying so a merge is never deployed twice (a second tick, or a
// reconcile racing the merge→Done transition). Both no-op / return false safely
// when the store is closed (--once) — deploy is gated OFF there anyway, so this
// never silently double-deploys. recordDeploy upserts so a later re-attempt
// (e.g. after a human clears a failed deploy row) overwrites the outcome rather
// than throwing on the primary key.
// ---------------------------------------------------------------------------

/** Atomically claim (repo, sha) for deployment. Returns true exactly once —
 * the INSERT either lands (claimed, outcome 'started') or hits the primary key
 * and affects 0 rows (someone already claimed it). This replaces the
 * deployAttempted()-then-recordDeploy() check-then-act in postMergeTick: ticks
 * are serial today so the old window needed a concurrent caller that does not
 * exist, but the claim shape makes exactly-once hold BY CONSTRUCTION (same
 * pattern as claimApproval's UPDATE...WHERE status='pending') rather than by
 * the accident of serial scheduling. False when the store is closed — deploy
 * is gated OFF there, and fail-closed means never claiming. */
export async function claimDeploy(repo: string, sha: string): Promise<boolean> {
  if (!store || !repo || !sha) return false;
  try {
    const affected = await store.exec(
      "INSERT INTO deploys (repo, sha, outcome, at) VALUES ($1, $2, 'started', $3) ON CONFLICT (repo, sha) DO NOTHING",
      [repo, sha, Date.now()]);
    return affected > 0;
  } catch (error) {
    console.error(`[db] deploy claim failed: ${error instanceof Error ? error.message : error}`);
    return false; // fail closed — an unclaimable SHA is never deployed
  }
}

/** Record a deploy attempt's outcome for (repo, sha). No-op when store closed. */
export async function recordDeploy(repo: string, sha: string, outcome: string): Promise<void> {
  if (!store || !repo || !sha) return;
  try {
    await store.exec(
      `INSERT INTO deploys (repo, sha, outcome, at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo, sha) DO UPDATE SET outcome = EXCLUDED.outcome, at = EXCLUDED.at`,
      [repo, sha, outcome, Date.now()]);
  } catch (error) {
    console.error(`[db] deploy write failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** True iff a deploy was already attempted for (repo, sha) — the exactly-once
 *  guard. Returns false when the store is closed (deploy is OFF there). */
export async function deployAttempted(repo: string, sha: string): Promise<boolean> {
  if (!store || !repo || !sha) return false;
  const rows = await store.query("SELECT 1 AS n FROM deploys WHERE repo = $1 AND sha = $2", [repo, sha]);
  return rows.length > 0;
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
  id: unknown; created_at: unknown; updated_at: unknown; issue_key: string; title: string;
  repo: string; pr_url: string; gated_head_sha: string | null; hold_reasons: string;
  gate_summary_json: string | null; security_verdict: string; taste_verdict: string;
  findings_digest: string; diff_stat: string; cost_usd: unknown; turns: unknown;
  regate_failed: boolean; status: string; resolution: string;
}

const APPROVAL_COLUMNS = "id::float8 AS id, created_at::float8 AS created_at, updated_at::float8 AS updated_at, issue_key, title, repo, pr_url, gated_head_sha, hold_reasons, gate_summary_json, security_verdict, taste_verdict, findings_digest, diff_stat, cost_usd::float8 AS cost_usd, turns::float8 AS turns, regate_failed, status, resolution";

function toApprovalItem(r: RawApprovalRow): ApprovalItem {
  let gateSummary: ApprovalItem["gateSummary"] = null;
  if (r.gate_summary_json) {
    try { gateSummary = JSON.parse(r.gate_summary_json) as ApprovalItem["gateSummary"]; } catch { /* legacy/bad row degrades to null */ }
  }
  return {
    id: num(r.id), createdAt: num(r.created_at), updatedAt: num(r.updated_at), issueKey: r.issue_key,
    title: r.title, repo: r.repo, prUrl: r.pr_url, gatedHeadSha: r.gated_head_sha,
    holdReasons: r.hold_reasons, gateSummary, securityVerdict: r.security_verdict,
    tasteVerdict: r.taste_verdict, findingsDigest: r.findings_digest, diffStat: r.diff_stat,
    costUsd: num(r.cost_usd), turns: num(r.turns), regateFailed: r.regate_failed === true,
    status: (["pending", "approved", "pushed_back", "stale"].includes(r.status) ? r.status : "stale") as ApprovalStatus,
    resolution: r.resolution,
  };
}

/** Insert a new approval item, superseding any still-pending item for the same
 *  issue (a re-run's fresh evidence makes the old card unreliable — its gated
 *  SHA no longer matches the branch, so it could only ever refuse). Returns the
 *  new row id, or null when the store is closed. Caller (approvals.ts) has
 *  already redacted/capped every string. */
export async function insertApproval(row: {
  issueKey: string; title: string; repo: string; prUrl: string;
  gatedHeadSha: string | null; holdReasons: string;
  gateSummary: ApprovalItem["gateSummary"];
  securityVerdict: string; tasteVerdict: string; findingsDigest: string;
  diffStat: string; costUsd: number; turns: number; regateFailed: boolean;
}): Promise<number | null> {
  if (!store) return null;
  const now = Date.now();
  await store.exec(
    "UPDATE approvals SET status = 'stale', resolution = 'superseded by a newer run', updated_at = $1 WHERE issue_key = $2 AND status = 'pending'",
    [now, row.issueKey]);
  const rows = await store.query<{ id: unknown }>(
    `INSERT INTO approvals (created_at, updated_at, issue_key, title, repo, pr_url, gated_head_sha, hold_reasons, gate_summary_json, security_verdict, taste_verdict, findings_digest, diff_stat, cost_usd, turns, regate_failed, status, resolution)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending', '')
     RETURNING id::float8 AS id`,
    [now, now, row.issueKey, row.title, row.repo, row.prUrl, row.gatedHeadSha, row.holdReasons,
      row.gateSummary ? JSON.stringify(row.gateSummary) : null,
      row.securityVerdict, row.tasteVerdict, row.findingsDigest, row.diffStat, row.costUsd, row.turns,
      row.regateFailed]);
  const id = num(rows[0]?.id);
  return id > 0 ? id : null;
}

/** Pending items, newest first — the GET /approvals payload. */
export async function listPendingApprovals(limit = 100): Promise<ApprovalItem[]> {
  if (!store) return [];
  const rows = await store.query<RawApprovalRow>(
    `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE status = 'pending' ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.map(toApprovalItem);
}

/** Count of pending items — the nav badge. */
export async function pendingApprovalCount(): Promise<number> {
  if (!store) return 0;
  const rows = await store.query<{ n: unknown }>("SELECT COUNT(*)::int AS n FROM approvals WHERE status = 'pending'");
  return num(rows[0]?.n);
}

/** The whole GET /approvals payload in ONE query. The list and the badge used
 *  to be two separate reads, so a decision landing between them could render a
 *  badge that disagreed with the list; going async widened that window. A
 *  `COUNT(*) OVER ()` window function is evaluated BEFORE LIMIT, so `total` is
 *  the true pending count while the rows are still the capped page — one
 *  snapshot, strictly better than what it replaces. */
export async function pendingApprovalsPage(limit = 100): Promise<{ pending: ApprovalItem[]; count: number }> {
  if (!store) return { pending: [], count: 0 };
  const rows = await store.query<RawApprovalRow & { total: unknown }>(
    `SELECT ${APPROVAL_COLUMNS}, COUNT(*) OVER ()::int AS total FROM approvals WHERE status = 'pending' ORDER BY id DESC LIMIT $1`,
    [limit]);
  return { pending: rows.map(toApprovalItem), count: num(rows[0]?.total) };
}

export async function getApproval(id: number): Promise<ApprovalItem | null> {
  if (!store) return null;
  const rows = await store.query<RawApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? toApprovalItem(row) : null;
}

/** ATOMIC pending→`to` transition — the idempotency/double-click guard. A
 *  single conditional UPDATE (WHERE status='pending'), so of two concurrent
 *  approve calls exactly ONE observes an affected row and proceeds to merge;
 *  the other gets false and returns 409 without acting. Also what makes "no
 *  endpoint can flip a decision for a run that is not in the human lane" hold:
 *  a run outside the lane has no pending row to claim. */
export async function claimApproval(id: number, to: Exclude<ApprovalStatus, "pending">): Promise<boolean> {
  if (!store) return false;
  const changed = await store.exec(
    "UPDATE approvals SET status = $1, updated_at = $2 WHERE id = $3 AND status = 'pending'",
    [to, Date.now(), id]);
  return changed > 0;
}

/** Unconditional status/resolution write — used AFTER a successful claim to
 *  record the outcome detail, roll a failed action back to pending (merge
 *  refused for a non-head reason), or mark an item stale. Never a substitute
 *  for claimApproval on the act path. */
export async function finalizeApproval(id: number, status: ApprovalStatus, resolution: string): Promise<void> {
  if (!store) return;
  await store.exec("UPDATE approvals SET status = $1, resolution = $2, updated_at = $3 WHERE id = $4",
    [status, resolution.slice(0, 1000), Date.now(), id]);
}

/** Store the owner's pushback directive for the issue's next run (one row per
 *  issue — a second pushback before the re-run replaces the first, matching
 *  what the owner most recently said). Returns false when the store is closed. */
export async function recordPushbackFeedback(issueKey: string, feedback: string): Promise<boolean> {
  if (!store || !issueKey) return false;
  await store.exec(
    `INSERT INTO pushback_feedback (issue_key, feedback, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (issue_key) DO UPDATE SET feedback = EXCLUDED.feedback, created_at = EXCLUDED.created_at`,
    [issueKey, feedback, Date.now()]);
  return true;
}

/** Put a TAKEN directive back when the run that consumed it never delivered
 *  anything for the owner to review (parked/aborted/threw before a PR existed).
 *  DO NOTHING, never a replace: a directive the owner recorded DURING that run
 *  is newer and must win — a restore may never resurrect superseded direction
 *  over it. loop.ts owns the when (ownerFeedbackHandoff). */
export async function restorePushbackFeedback(issueKey: string, feedback: string): Promise<boolean> {
  if (!store || !issueKey) return false;
  const changed = await store.exec(
    "INSERT INTO pushback_feedback (issue_key, feedback, created_at) VALUES ($1, $2, $3) ON CONFLICT (issue_key) DO NOTHING",
    [issueKey, feedback, Date.now()]);
  return changed > 0;
}

/** Read-and-delete the pending directive for an issue (exactly-once handoff
 *  into the re-run's prompts). null when none / store closed.
 *
 *  Now genuinely ATOMIC: one `DELETE ... RETURNING` instead of the old
 *  SELECT-then-DELETE pair, which had no transaction around it — the daemon and
 *  the dashboard could both observe and consume the same directive. */
export async function takePushbackFeedback(issueKey: string): Promise<string | null> {
  if (!store || !issueKey) return null;
  const rows = await store.query<{ feedback: string }>(
    "DELETE FROM pushback_feedback WHERE issue_key = $1 RETURNING feedback", [issueKey]);
  return rows[0]?.feedback ?? null;
}

// ---------------------------------------------------------------------------
// Test seam — an in-process PGlite (WASM Postgres) database with the full
// schema, used only by the unit suite (no bus subscription, no write queue, no
// file, no server, no port). Kept here so the module-level `store` handle stays
// private and the single-writer invariant holds.
//
// PGlite is REAL Postgres, so the SQL strings above run BYTE-IDENTICALLY in
// tests and production — that is the whole point of the seam. Booting the WASM
// engine costs ~1.4s, so the engine is a module-level singleton created once
// and RESET (TRUNCATE ... RESTART IDENTITY, ~2ms) on every openTestDatabase().
// RESTART IDENTITY is load-bearing: several tests assert on returned row ids.
//
// The engine is deliberately NOT closed by closeTestDatabase() — re-booting it
// per test would cost ~1.4s each time. Closing detaches the handle only.
// ---------------------------------------------------------------------------

/** The numeric-coercion safety net (see num() above), surfaced under a
 *  non-generic name so tests/db-cast-discipline.test.ts can pin the string leg
 *  directly. Pure; exported for tests only — production code inside this module
 *  keeps calling the local `num`. */
export { num as coerceNumeric };

let testEngine: Store | null = null;

const TEST_TABLES ="events, stage_sessions, lessons, merge_ladder, merge_shadow_log, deploys, approvals, pushback_feedback";

export interface TestStoreOptions {
  /** Also wire the write-behind queue to the event bus, exactly as
   *  startEventStore() does in production.
   *
   *  OFF by default and that default is load-bearing: the ~35 test files that
   *  emit bus events must not pay for a durable write, and a store-backed
   *  subscriber left attached across files would keep enqueueing after the
   *  store closed. Only tests/event-queue.test.ts — which exists to pin the
   *  enqueue → drain → flushEvents contract itself — turns it on, and
   *  closeTestDatabase() always detaches it again. */
  subscribeBus?: boolean;
}

/** Test seam. First call boots the WASM engine + schema; every later call is
 *  one TRUNCATE. Never touches a real Postgres. */
export async function openTestDatabase(opts: TestStoreOptions = {}): Promise<void> {
  if (!testEngine) {
    testEngine = await pgliteStore();
    await migrate(testEngine);
  }
  await testEngine.exec(`TRUNCATE ${TEST_TABLES} RESTART IDENTITY`);
  store = testEngine;
  state = "open";
  telemetryCache = null;
  telemetryInFlight = null;
  queue.length = 0;
  draining = null;
  inFlightEvents = 0;
  droppedEvents = 0;
  lastWriteError = null;
  if (opts.subscribeBus && !subscribed) subscribed = bus.subscribe(enqueue);
}

/** Test seam. Detaches the store; the engine stays warm for the next test (re-
 *  booting it per test would cost ~1.4s each time). Always drops the bus
 *  subscription, so an opt-in from one test can never leak into the next file. */
export async function closeTestDatabase(): Promise<void> {
  if (subscribed) { subscribed(); subscribed = null; }
  // QUIESCE, don't just abandon. A drain kicked by an earlier emit may be
  // mid-writeBatch right now; dropping the handle without waiting would let
  // that INSERT land AFTER the next test's TRUNCATE and pollute it. Emptying
  // the queue first stops the loop from taking another batch, nulling `store`
  // makes any batch that has not started a no-op, and awaiting the in-flight
  // promise guarantees no write is outstanding when this resolves.
  queue.length = 0;
  store = null;
  const inFlight = draining;
  if (inFlight) await inFlight.catch(() => { /* drain never rejects, but be safe */ });
  state = "closed";
  telemetryCache = null;
  telemetryInFlight = null;
  queue.length = 0;
  draining = null;
  inFlightEvents = 0;
  droppedEvents = 0;
  lastWriteError = null;
}

/** Test-only: insert a raw event row directly into the durable log, bypassing
 *  the bus subscription AND the write queue (openTestDatabase() deliberately
 *  wires up neither — see above). Lets tests exercise the READ paths that scan
 *  the `events` table (getTelemetry, issueEvents, …) without a real store + bus.
 *  No-op when the test store isn't open. */
export async function insertTestEvent(type: string, body: Record<string, unknown>, at = Date.now()): Promise<void> {
  if (!store) return;
  const key = typeof body.issueKey === "string" ? body.issueKey : null;
  await store.exec("INSERT INTO events (seq, at, type, issue_key, json) VALUES ($1, $2, $3, $4, $5)",
    [0, at, type, key, JSON.stringify({ type, seq: 0, at, ...body })]);
}
