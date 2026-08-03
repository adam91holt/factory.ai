import { config } from "./config.ts";
import { bus, type FactoryEvent } from "./events.ts";
import { bunStore, pgliteStore, jsonbValue, jsonbObject, type Store } from "./store.ts";
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
 *  - JSON columns are native jsonb (issue #11, owner decision 2026-08-02 —
 *    superseding WP1's TEXT choice): queryable with ->/->>/@> and GIN-indexable.
 *    WP1's two reasons died: key-order fidelity was never load-bearing (every
 *    payload is our own JSON.stringify — no meaningful order, no duplicate
 *    keys), and the driver divergence (Bun: string, PGlite: parsed object) is
 *    now normalised ONCE — every jsonb column is projected `::text` and parsed
 *    through store.ts's jsonbValue/jsonbObject, pinned by the parity suites on
 *    both drivers. Writes bind `::text::jsonb` ONLY (never bare `::jsonb` —
 *    the Bun driver would jsonb-encode the pre-stringified param into a string
 *    scalar; live-found 2026-08-02). Legacy TEXT stores are migrated in place
 *    by the idempotent DO blocks below (unparseable rows quarantined, never a
 *    crashed migrate).
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
    seq BIGINT, at BIGINT, type TEXT, issue_key TEXT, json JSONB)`,
  "CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_key, id)",
  // Telemetry aggregation scans by event type (run_stage_finished / run_finished).
  "CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id)",
  // Issue #11: full-fidelity per-stage transcript — one row per SDK message
  // (assistant text, tool_use with FULL input, tool_result, system/init,
  // reasoning, result), captured at agents.ts's runOneAttempt choke point and
  // redacted at write. COMPLEMENTS the summary `events` stream (which stays
  // forever); these rows are bounded (body cap, per-stage row cap) and swept by
  // sweepStageTranscripts after TRANSCRIPT_RETENTION_DAYS. `body` is native
  // jsonb per the issue's owner mandate (queryable with ->/->>/@>, GIN-indexed)
  // — bound `::text::jsonb` ONLY (see writeTranscriptBatch): a bare `::jsonb`
  // cast makes the real Bun driver jsonb-encode the pre-stringified param into
  // a jsonb STRING SCALAR (live-found 2026-08-02; pinned in
  // tests/store-parity-suite.ts).
  `CREATE TABLE IF NOT EXISTS stage_transcript (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at BIGINT NOT NULL,
    issue_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    session_id TEXT,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    body JSONB NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS idx_stage_transcript_issue ON stage_transcript(issue_key, stage, id)",
  "CREATE INDEX IF NOT EXISTS idx_stage_transcript_body ON stage_transcript USING GIN (body)",
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
    would_merge BOOLEAN, acted BOOLEAN, tier TEXT, reasons TEXT, evidence_json JSONB)`,
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
    gate_summary_json JSONB,
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
  // issue #8 F6: "at most one PENDING item per issue" used to be application
  // discipline (insertApproval's supersede-then-insert is two statements with
  // no transaction around them); the partial unique index makes it STRUCTURAL —
  // a concurrent double-insert now conflicts instead of yielding two pending
  // rows. The UPDATE first resolves any duplicates a pre-index build already
  // let in, exactly the way the supersede leg would have: newest pending row
  // per issue survives, older ones go stale. Idempotent (no dupes → no rows),
  // and it must precede the index or CREATE UNIQUE INDEX would fail on the
  // very duplicates it exists to prevent.
  `UPDATE approvals SET status = 'stale', resolution = 'superseded by a newer run', updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
     WHERE status = 'pending' AND id NOT IN (SELECT MAX(id) FROM approvals WHERE status = 'pending' GROUP BY issue_key)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_one_pending ON approvals(issue_key) WHERE status = 'pending'",
  // Push-back feedback handoff: the owner's directive travels from the
  // pushback endpoint to the NEXT run of the same issue via this one-row-per-
  // issue table. Consumed exactly once (takePushbackFeedback = a single
  // DELETE ... RETURNING) so stale direction can never resurrect on a later
  // unrelated re-run; the durable copy for humans is the Linear comment
  // approvals.ts posts.
  `CREATE TABLE IF NOT EXISTS pushback_feedback (
    issue_key TEXT PRIMARY KEY, feedback TEXT NOT NULL, created_at BIGINT NOT NULL)`,
  // ---------------------------------------------------------------------------
  // Issue #7: Postgres-driven project config. `projects` is the entity that owns
  // everything already keyed by repo. Two-tier writes (see the row helpers):
  // descriptive fields apply immediately with an audit row; AUTHORITY fields
  // (repos/deploy/smoke/deployEnabled/merge) land as PENDING project_policy rows
  // and take force only through the approvals-inbox claim pattern. Value columns
  // are TEXT holding JSON, NOT jsonb — same deliberate driver-parity decision as
  // the events table (see the DDL header note); the issue sketch said JSONB, but
  // the two drivers disagree on jsonb (string vs parsed object), which is
  // exactly the divergence this schema exists to avoid.
  `CREATE TABLE IF NOT EXISTS projects (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    goal TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    team TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL)`,
  // AUTHORITATIVE repo→project membership (PG-driven, no card files): the
  // loop.ts/plan.ts work gate reads this via projectOwningRepo — a repo with no
  // row here is never worked (fail closed). Rows are written only through
  // replaceProjectRepos / the /projects/create route (audited); ticket text has
  // no path to any writer of this table.
  `CREATE TABLE IF NOT EXISTS project_repos (
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    PRIMARY KEY (project_id, repo))`,
  // Per-project per-role model config. Validated against config.models ON READ
  // (project-config.ts validateProjectModels — unknown model dropped with a
  // warning, meta.ts discipline), so a roster change can never resurrect a
  // stale model id into an SDK call.
  `CREATE TABLE IF NOT EXISTS project_models (
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT,
    PRIMARY KEY (project_id, role))`,
  // Per-project groundskeeper wiring — a THIRD gate AND-ed with the two
  // existing ones (global GROUNDSKEEPERS_ENABLED env gate AND the card's own
  // enabled: true). enabled=true here alone arms NOTHING; enabled=false blocks
  // a card that both existing gates would run. Never a bypass.
  `CREATE TABLE IF NOT EXISTS project_groundskeepers (
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    card TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    cadence TEXT,
    PRIMARY KEY (project_id, card))`,
  // Authority-bearing config, versioned: pending → active | superseded |
  // rejected. A proposed change is INSERTed as 'pending' and the config in
  // force is unchanged until a human approves it (atomic claim, mirroring
  // claimApproval).
  `CREATE TABLE IF NOT EXISTS project_policy (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    approved_by TEXT, approved_at BIGINT,
    created_at BIGINT NOT NULL)`,
  // The partial unique index is what makes "exactly one active policy per
  // (project, key)" a DATABASE invariant rather than application discipline —
  // same structural upgrade idx_approvals_one_pending made for approvals.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_policy_one_active ON project_policy(project_id, key) WHERE state = 'active'",
  "CREATE INDEX IF NOT EXISTS idx_project_policy_project ON project_policy(project_id, key, id)",
  // Append-only config audit: every change writes old/new/actor. The trigger
  // below makes append-only STRUCTURAL — an UPDATE or DELETE raises, so the
  // record cannot be rewritten even by a bug in this file.
  `CREATE TABLE IF NOT EXISTS project_config_audit (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id BIGINT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT, new_value TEXT,
    actor TEXT NOT NULL,
    at BIGINT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS idx_project_audit_project ON project_config_audit(project_id, id)",
  `CREATE OR REPLACE FUNCTION project_config_audit_guard() RETURNS trigger AS $guard$
     BEGIN RAISE EXCEPTION 'project_config_audit is append-only (no UPDATE, no DELETE)'; END
   $guard$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE TRIGGER trg_project_config_audit_guard
     BEFORE UPDATE OR DELETE ON project_config_audit
     FOR EACH ROW EXECUTE FUNCTION project_config_audit_guard()`,
  // Model catalog: every model id the proxy currently serves (GET /v1/models),
  // synced at daemon boot. This is the PICK LIST for per-project model config —
  // rosterView and the /projects/model allowlist read it — NOT a routing
  // authority: the env roster (config.models) keeps its role as the default,
  // and ticket text still can't reach any of it (meta.ts isKnownModel is
  // deliberately NOT widened to the catalog). available=false rows are kept
  // for history when a model disappears from the proxy.
  `CREATE TABLE IF NOT EXISTS model_catalog (
    model TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'proxy',
    available BOOLEAN NOT NULL DEFAULT TRUE,
    first_seen BIGINT NOT NULL,
    last_seen BIGINT NOT NULL)`,
  // ---------------------------------------------------------------------------
  // Issue #16 WP1: agent + skill REGISTERS — versioned prompt/skill content in
  // Postgres, consulted PG-first by catalog.ts with the files as seed/fallback.
  // Saves are APPEND-ONLY new versions (never UPDATE a version row) — rollback
  // is "re-enable version N" — and the partial unique index makes "exactly one
  // ACTIVE version per name" a DATABASE invariant, the same structural trick as
  // idx_project_policy_one_active. frontmatter/attach are JSONB per the issue's
  // mandate: unlike the events/policy TEXT columns these hold STRUCTURED config
  // (a flat string map / an attach selector), not forensic logs, so jsonb's
  // key-order normalisation is harmless. The drivers still disagree on how raw
  // jsonb comes back (Bun: string, PGlite: object), so every read here selects
  // it `::text` and JSON.parses in JS — one shape on both drivers, the same
  // normalise-on-read discipline num() applies to numerics.
  `CREATE TABLE IF NOT EXISTS agent_register (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    frontmatter JSONB NOT NULL,
    prompt TEXT NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'operator',
    UNIQUE (name, version))`,
  "CREATE UNIQUE INDEX IF NOT EXISTS agent_register_active ON agent_register(name) WHERE enabled",
  `CREATE TABLE IF NOT EXISTS skill_register (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    attach JSONB NOT NULL DEFAULT '{}'::jsonb,
    content_hash TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'operator',
    UNIQUE (name, version))`,
  "CREATE UNIQUE INDEX IF NOT EXISTS skill_register_active ON skill_register(name) WHERE enabled",
  // One-time data repair (2026-08-02): the Bun driver infers a bound param's
  // type from a bare `::jsonb` cast and jsonb-encodes the pre-stringified
  // JSON, storing a jsonb STRING SCALAR ('"{...}"') instead of an object —
  // which the read path degrades to {} (empty frontmatter/attach). PGlite
  // treats the same bind as text, so tests never saw it. The insert sites now
  // bind `::text::jsonb`; these unwrap any rows written before the fix.
  // Idempotent: the WHERE clause matches only the damaged shape.
  `UPDATE agent_register SET frontmatter = (frontmatter #>> '{}')::jsonb
     WHERE jsonb_typeof(frontmatter) = 'string' AND left(frontmatter #>> '{}', 1) = '{'`,
  `UPDATE skill_register SET attach = (attach #>> '{}')::jsonb
     WHERE jsonb_typeof(attach) = 'string' AND left(attach #>> '{}', 1) = '{'`,
  // ---------------------------------------------------------------------------
  // Issue #11 (jsonb half): migrate the three WP1-era TEXT-holding-JSON columns
  // — events.json, merge_shadow_log.evidence_json, approvals.gate_summary_json
  // — to native jsonb IN PLACE. Idempotent: each DO block fires only while
  // information_schema still reports the column as text, so a migrated (or
  // freshly created) store skips it in one catalog probe. Tolerant: the fast
  // path is a single ALTER; if ANY legacy row fails the jsonb parse the block
  // falls back to a row scan that QUARANTINES each unparseable row (raw text
  // preserved in jsonb_migration_quarantine, source column nulled, WARNING
  // raised) and then re-runs the ALTER — a bad row can never crash migrate()
  // and is never silently destroyed. Pinned on both drivers in
  // tests/store-parity-suite.ts and end-to-end in tests/jsonb-migration.test.ts.
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS jsonb_migration_quarantine (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    src_table TEXT NOT NULL, src_id BIGINT NOT NULL, raw TEXT, at BIGINT NOT NULL)`,
  `DO $mig$
   DECLARE bad RECORD;
   BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'events'
                  AND column_name = 'json' AND data_type = 'text') THEN
       BEGIN
         ALTER TABLE events ALTER COLUMN json TYPE jsonb USING json::jsonb;
       EXCEPTION WHEN OTHERS THEN
         FOR bad IN SELECT id::bigint AS id, json::text AS json FROM events WHERE json IS NOT NULL LOOP
           BEGIN
             PERFORM bad.json::jsonb;
           EXCEPTION WHEN OTHERS THEN
             INSERT INTO jsonb_migration_quarantine (src_table, src_id, raw, at)
             VALUES ('events', bad.id, bad.json, (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT);
             UPDATE events SET json = NULL WHERE id = bad.id;
             RAISE WARNING 'events.json -> jsonb: quarantined unparseable row id=%', bad.id;
           END;
         END LOOP;
         ALTER TABLE events ALTER COLUMN json TYPE jsonb USING json::jsonb;
       END;
     END IF;
   END $mig$`,
  `DO $mig$
   DECLARE bad RECORD;
   BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'merge_shadow_log'
                  AND column_name = 'evidence_json' AND data_type = 'text') THEN
       BEGIN
         ALTER TABLE merge_shadow_log ALTER COLUMN evidence_json TYPE jsonb USING evidence_json::jsonb;
       EXCEPTION WHEN OTHERS THEN
         FOR bad IN SELECT id::bigint AS id, evidence_json::text AS raw FROM merge_shadow_log WHERE evidence_json IS NOT NULL LOOP
           BEGIN
             PERFORM bad.raw::jsonb;
           EXCEPTION WHEN OTHERS THEN
             INSERT INTO jsonb_migration_quarantine (src_table, src_id, raw, at)
             VALUES ('merge_shadow_log', bad.id, bad.raw, (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT);
             UPDATE merge_shadow_log SET evidence_json = NULL WHERE id = bad.id;
             RAISE WARNING 'merge_shadow_log.evidence_json -> jsonb: quarantined unparseable row id=%', bad.id;
           END;
         END LOOP;
         ALTER TABLE merge_shadow_log ALTER COLUMN evidence_json TYPE jsonb USING evidence_json::jsonb;
       END;
     END IF;
   END $mig$`,
  `DO $mig$
   DECLARE bad RECORD;
   BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'approvals'
                  AND column_name = 'gate_summary_json' AND data_type = 'text') THEN
       BEGIN
         ALTER TABLE approvals ALTER COLUMN gate_summary_json TYPE jsonb USING gate_summary_json::jsonb;
       EXCEPTION WHEN OTHERS THEN
         FOR bad IN SELECT id::bigint AS id, gate_summary_json::text AS raw FROM approvals WHERE gate_summary_json IS NOT NULL LOOP
           BEGIN
             PERFORM bad.raw::jsonb;
           EXCEPTION WHEN OTHERS THEN
             INSERT INTO jsonb_migration_quarantine (src_table, src_id, raw, at)
             VALUES ('approvals', bad.id, bad.raw, (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT);
             UPDATE approvals SET gate_summary_json = NULL WHERE id = bad.id;
             RAISE WARNING 'approvals.gate_summary_json -> jsonb: quarantined unparseable row id=%', bad.id;
           END;
         END LOOP;
         ALTER TABLE approvals ALTER COLUMN gate_summary_json TYPE jsonb USING gate_summary_json::jsonb;
       END;
     END IF;
   END $mig$`,
  // GIN on the two QUERY surfaces (issue #11): events.json here,
  // stage_transcript.body above. The small tables don't need one. Must follow
  // the events migration — GIN over TEXT would refuse.
  "CREATE INDEX IF NOT EXISTS idx_events_json ON events USING GIN (json)",
  // Project linkage read surface (issue #11 / #7): issue → repo → project_repos
  // → project, derived — not denormalised onto the hot write path. The repo for
  // an issue is taken from its newest event that carries one (run_started /
  // merge_decision / deploy events); jsonb is what makes that ->>'repo' lookup
  // possible in SQL at all. CREATE OR REPLACE keeps it idempotent, and it must
  // follow both the events jsonb migration and the projects/project_repos DDL.
  `CREATE OR REPLACE VIEW project_activity AS
   SELECT p.id::float8 AS project_id, p.name AS project, ir.repo, e.issue_key,
          e.id::float8 AS event_id, e.at::float8 AS at, e.type
   FROM events e
   JOIN (SELECT DISTINCT ON (issue_key) issue_key, json->>'repo' AS repo
         FROM events
         WHERE issue_key IS NOT NULL AND json->>'repo' IS NOT NULL
         ORDER BY issue_key, id DESC) ir ON ir.issue_key = e.issue_key
   JOIN project_repos pr ON pr.repo = ir.repo
   JOIN projects p ON p.id = pr.project_id
   WHERE e.issue_key IS NOT NULL`,
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
/** Monotone count of event batches DURABLY WRITTEN — the flush watermark.
 *  getTelemetry keys its single-flight sharing on this (issue #8 F7): a caller
 *  may only adopt an in-flight aggregate that started at or after the caller's
 *  own flush, so nobody ever receives numbers older than events they just saw
 *  land. Deliberately NOT bumped on dropped batches: dropped rows never reach
 *  the table, so an aggregate computed without them is not stale — it is
 *  exactly what any fresh computation would also see. */
let flushGeneration = 0;
/** False after a PERSISTENT write failure (a batch was dropped even after its
 *  retry), true again the moment a later batch lands. Feeds eventStoreOpen()
 *  so the governance gates that key on it (groundskeeper budget/parks,
 *  captureLesson) fail CLOSED during a mid-run Postgres outage instead of
 *  consulting a store that is silently dropping the very events they meter
 *  (issue #8 F2 — eventStoreOpen used to be a one-way latch set at startup).
 *  Deliberately NOT flipped by queue-overflow drops: those prove the writer is
 *  behind, not that the store is unreachable — and a real outage flips this
 *  anyway the moment the drain reaches the store. */
let writeHealthy = true;
let subscribed: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Issue #11: stage-transcript write-behind queue. Same single-writer discipline
// as the event queue — the SAME single-flight drain() serves both FIFOs, so
// transcript ids follow append order and `await flushEvents()` makes both
// streams visible to every read path. Deliberately SEPARATE health accounting:
// a transcript batch failure drops loudly but never flips writeHealthy /
// flushGeneration — the governance gates (eventStoreOpen) stay keyed to the
// summary events stream exactly as before this table existed (additive pin).
// ---------------------------------------------------------------------------

interface PendingTranscript {
  at: number; issueKey: string; stage: string; sessionId: string | null;
  seq: number; kind: string; bodyJson: string;
  /** utf8 size of bodyJson, precomputed so the queue's byte budget can be
   *  maintained O(1) on enqueue and on batch splice. */
  bodyBytes: number;
}

/** Per-message body cap. IN-CODE CONSTANT, not an env knob (CLAUDE.md): an
 *  audit row that can grow without bound is its own outage. Oversized bodies
 *  are truncated to a marker object (see boundedTranscriptBody). */
export const TRANSCRIPT_BODY_CAP_BYTES = 64 * 1024;
/** The marker an oversized/capped body carries in its `truncated` field. */
export const TRANSCRIPT_TRUNCATION_MARKER = "[transcript-truncated]";
/** Per-stage-run row cap: rows with seq beyond this are dropped, and the row AT
 *  the cap becomes a `kind: "cap"` marker so the truncation is visible in the
 *  audit trail rather than silent. */
export const TRANSCRIPT_MAX_ROWS_PER_STAGE = 2000;
/** Retention window for transcript rows. The summary `events` stream is kept
 *  forever; only stage_transcript is swept (sweepStageTranscripts). */
export const TRANSCRIPT_RETENTION_DAYS = 30;
/** Hard cap on queued-but-unwritten transcript rows. A row count alone is a
 *  weak OOM guard here (unlike events, each body can be 64KB), so the REAL
 *  bound is MAX_QUEUED_TRANSCRIPT_BYTES below; this stays as a secondary cap
 *  on tiny-row floods. Overflow drops loudly. */
const MAX_QUEUED_TRANSCRIPTS = 10_000;
/** Byte budget across all queued-but-unwritten transcript bodies. 10k rows ×
 *  64KB bodies would be ~640MB of heap during a Postgres outage — an OOM, not
 *  a guard. The stream is best-effort by contract, so past this budget new
 *  rows drop loudly while the daemon degrades gracefully. IN-CODE CONSTANT,
 *  not an env knob (CLAUDE.md). Exported for the bound's regression test. */
export const MAX_QUEUED_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** Rows per multi-row transcript INSERT. Smaller than EVENT_BATCH because each
 *  body may be up to TRANSCRIPT_BODY_CAP_BYTES. */
const TRANSCRIPT_BATCH = 64;

const transcriptQueue: PendingTranscript[] = [];
let queuedTranscriptBytes = 0;
let droppedTranscripts = 0;

// ---------------------------------------------------------------------------
// jsonb write hygiene. Postgres jsonb REJECTS two escapes that TEXT accepted
// without a murmur: \u0000 (NUL) and a lone UTF-16 surrogate — and event
// payloads embed agent/tool text (snippets sliced mid-string, binary tool
// junk), so both genuinely occur. One poisoned event would fail its whole
// batch and flip the governance gate closed. The COMMON path is untouched: a
// cheap regex over the serialized text, and only a hit pays for the deep
// clean. (agents.ts already strips NUL for transcript bodies at capture.)
// ---------------------------------------------------------------------------

/** Matches JSON.stringify output only when it carries an escaped NUL or a lone
 *  surrogate escape (stringify escapes surrogates ONLY when unpaired). */
const JSONB_UNSTORABLE = /\\u0000|\\u[dD][89a-fA-F]/;

const cleanJsonString = (s: string): string =>
  s.replaceAll("\u0000", "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

function deepCleanForJsonb(v: unknown): unknown {
  if (typeof v === "string") return cleanJsonString(v);
  if (Array.isArray(v)) return v.map(deepCleanForJsonb);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[cleanJsonString(k)] = deepCleanForJsonb(val);
    return out;
  }
  return v;
}

/** Serialize `value` to a string Postgres jsonb will accept. The regex can
 *  false-positive on text that merely TALKS about such escapes ("\\u0000" in a
 *  code snippet) — then the deep clean is a no-op and the re-stringify is
 *  semantically identical, so correctness never depends on the detection being
 *  exact, only the fast path does. */
export function jsonbSafeStringify(value: unknown): string {
  const raw = JSON.stringify(value);
  if (!JSONB_UNSTORABLE.test(raw)) return raw;
  return JSON.stringify(deepCleanForJsonb(value));
}

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
    json: jsonbSafeStringify(e),
  });
  void drain();
}

/** Multi-row event INSERT. `json` binds `::text::jsonb` — NEVER a bare
 *  `::jsonb` (the Bun driver would jsonb-encode the pre-stringified param into
 *  a jsonb string scalar; see writeTranscriptBatch and the parity suite). */
async function writeBatch(batch: PendingEvent[]): Promise<void> {
  const s = store;
  if (!s) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  for (const row of batch) {
    const base = params.length;
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::text::jsonb)`);
    params.push(row.seq, row.at, row.type, row.issueKey, row.json);
  }
  await s.exec(`INSERT INTO events (seq, at, type, issue_key, json) VALUES ${tuples.join(", ")}`, params);
}

/** Multi-row transcript INSERT. `body` binds `::text::jsonb` — NEVER a bare
 *  `::jsonb`: the real Bun driver infers a bare-jsonb param's type and
 *  jsonb-encodes the already-stringified JSON into a jsonb string scalar,
 *  while PGlite parses it as an object — the exact divergence pinned by the
 *  "::text::jsonb" tests in tests/store-parity-suite.ts (live-found 2026-08-02). */
async function writeTranscriptBatch(batch: PendingTranscript[]): Promise<void> {
  const s = store;
  if (!s) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  for (const row of batch) {
    const base = params.length;
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::text::jsonb)`);
    params.push(row.at, row.issueKey, row.stage, row.sessionId, row.seq, row.kind, row.bodyJson);
  }
  await s.exec(`INSERT INTO stage_transcript (at, issue_key, stage, session_id, seq, kind, body) VALUES ${tuples.join(", ")}`, params);
}

/** Single-flight FIFO drain. Serial batches ⇒ identity ids follow emit order. */
function drain(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    try {
      while ((queue.length > 0 || transcriptQueue.length > 0) && store) {
        if (queue.length > 0) {
          const batch = queue.splice(0, EVENT_BATCH);
          inFlightEvents = batch.length;
          try {
            await writeBatch(batch);
            writeHealthy = true;
            flushGeneration += 1;
          } catch (error) {
            lastWriteError = String(error instanceof Error ? error.message : error);
            // One retry, then drop LOUDLY. The SQLITE_BUSY catch this replaces
            // already established best-effort as the contract here, and under
            // MVCC a write failure is strictly rarer than it was.
            try {
              await writeBatch(batch);
              writeHealthy = true;
              flushGeneration += 1;
            } catch {
              droppedEvents += batch.length;
              // Both attempts failed — the store is unreachable RIGHT NOW, and
              // rows were lost. Flip the governance gate closed until a later
              // batch proves recovery (conservative: unhealthy sticks while no
              // writes flow, and the daemon emits events constantly, so a real
              // recovery clears it within one drain).
              writeHealthy = false;
              console.error(`[db] event batch dropped (${batch.length} rows): ${lastWriteError} — eventStoreOpen() now false until a write lands (governance gates fail closed)`);
            }
          } finally {
            inFlightEvents = 0;
          }
          continue; // events first — the governance stream keeps priority
        }
        const tBatch = transcriptQueue.splice(0, TRANSCRIPT_BATCH);
        for (const row of tBatch) queuedTranscriptBytes -= row.bodyBytes;
        try {
          await writeTranscriptBatch(tBatch);
        } catch (error) {
          // Same one-retry contract as events, but WITHOUT touching
          // writeHealthy/flushGeneration/lastWriteError: the audit transcript
          // is best-effort and must never move the governance gate (additive).
          try {
            await writeTranscriptBatch(tBatch);
          } catch {
            // Defense in depth against batch poisoning: a whole-batch failure
            // can be ONE unstorable row (jsonb rejects things TEXT accepted),
            // and dropping 64 innocent neighbors for it would punch holes in
            // the audit trail. Retry per-row so only the genuinely bad row(s)
            // drop. During a real outage this costs at most TRANSCRIPT_BATCH
            // extra failed INSERTs per drain pass — still best-effort, still
            // bounded.
            let rowDrops = 0;
            for (const row of tBatch) {
              try {
                await writeTranscriptBatch([row]);
              } catch {
                rowDrops += 1;
              }
            }
            if (rowDrops > 0) {
              droppedTranscripts += rowDrops;
              console.error(`[db] transcript rows dropped (${rowDrops} of ${tBatch.length} in batch): ${String(error instanceof Error ? error.message : error)}`);
            }
          }
        }
      }
    } finally {
      draining = null;
      if ((queue.length > 0 || transcriptQueue.length > 0) && store) void drain();
    }
  })();
  return draining;
}

/** Wait until every enqueued event has been written (or dropped). Called as the
 *  first statement of EVERY read path, which is what makes write-behind
 *  strictly equivalent to the old inline INSERT from a reader's point of view. */
export async function flushEvents(): Promise<void> {
  while (queue.length > 0 || transcriptQueue.length > 0 || draining) {
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
  return { open: state === "open" && writeHealthy, pending: pendingEventWrites(), dropped: droppedEvents, lastError: lastWriteError };
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
    writeHealthy = true;
    // A daemon restart must pick up the register state the last process wrote —
    // catalog.ts reads the snapshot synchronously, so it is loaded here once and
    // then refreshed by every register write.
    await refreshRegisterSnapshot();
    if (!subscribed) subscribed = bus.subscribe(enqueue);
    // Retention enforcement survives daemon restarts and idle stretches: sweep
    // (watermark-gated) as soon as the store opens; appendStageTranscript
    // re-checks the watermark continuously while stages run.
    void maybeSweepStageTranscripts();
  })().catch((error) => {
    opening = null;
    throw error;
  });
  return opening;
}

/** True when the durable event store is open AND its writes are landing.
 *  Budget/parks governance is only enforceable with a store that is actually
 *  recording spend — callers must fail CLOSED when it isn't. "Open" alone was
 *  a one-way latch set at startup (issue #8 F2): a mid-run Postgres outage
 *  left the gates consulting a store that was silently dropping the events
 *  they meter. Now a persistent write failure (a dropped batch — see drain())
 *  reads as closed until a later write proves recovery.
 *  Deliberately SYNCHRONOUS: it reads module state, never the database, so the
 *  fail-closed gates in groundskeeperTick / captureLesson keep working exactly
 *  as they did (no await, no chance of a rejected promise reading as "open"). */
export function eventStoreOpen(): boolean {
  return state === "open" && writeHealthy;
}

/** Full historical event stream for one issue (all sessions). */
export async function issueEvents(issueKey: string, limit = 2000): Promise<unknown[]> {
  await flushEvents();
  if (!store) return [];
  const rows = await store.query<{ json: unknown }>(
    "SELECT json::text AS json FROM events WHERE issue_key = $1 ORDER BY id ASC LIMIT $2", [issueKey, limit]);
  return rows.map((r) => jsonbValue(r.json));
}

// ---------------------------------------------------------------------------
// Issue #11: stage-transcript row helpers. The append path is SYNC and
// never-throws (same contract as the bus subscriber's enqueue) because it is
// called from agents.ts's hot message loop; bounds are enforced HERE — the raw
// write path — so a cap that could be bypassed by calling one layer lower is
// not a cap (CLAUDE.md, same reasoning as registerWriteViolation).
// ---------------------------------------------------------------------------

/** Shrink an oversized serialized body to a marker object whose OWN serialized
 *  size fits the cap. The head is re-measured after wrapping (JSON escaping
 *  inflates it), shrunk proportionally until it fits; a lone trailing high
 *  surrogate is dropped so the head can never smuggle an unpaired surrogate
 *  into jsonb (Postgres rejects those). Bounded: at most 8 passes, then the
 *  degenerate headless marker. */
function boundedTranscriptBody(bodyJson: string): string {
  const originalBytes = Buffer.byteLength(bodyJson, "utf8");
  if (originalBytes <= TRANSCRIPT_BODY_CAP_BYTES) return bodyJson;
  let keep = TRANSCRIPT_BODY_CAP_BYTES;
  for (let i = 0; i < 8 && keep > 0; i++) {
    let head = bodyJson.slice(0, keep);
    const lastCode = head.charCodeAt(head.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) head = head.slice(0, -1);
    const wrapped = JSON.stringify({ truncated: TRANSCRIPT_TRUNCATION_MARKER, originalBytes, head });
    const wrappedBytes = Buffer.byteLength(wrapped, "utf8");
    if (wrappedBytes <= TRANSCRIPT_BODY_CAP_BYTES) return wrapped;
    keep = Math.floor((keep * (TRANSCRIPT_BODY_CAP_BYTES - 256)) / wrappedBytes);
  }
  return JSON.stringify({ truncated: TRANSCRIPT_TRUNCATION_MARKER, originalBytes });
}

/** Make an already-serialized body storable as Postgres jsonb — the transcript
 *  twin of jsonbSafeStringify (events get that guard in enqueue; the transcript
 *  path takes pre-stringified JSON, so it is re-checked HERE, the raw write
 *  path). agents.ts strips raw NULs at capture, but a LONE UTF-16 surrogate
 *  survives that as a `\udXXX` escape in the serialized text — they arise
 *  organically when a tool result is truncated mid-surrogate-pair (e.g. cut
 *  mid-emoji) — and jsonb rejects the row, which without this guard poisoned
 *  its whole INSERT batch. Cheap regex on the common path; only a hit pays for
 *  parse + deep clean + re-stringify (never larger — cleaning only removes). */
function jsonbSafeBodyJson(bodyJson: string): string {
  if (!JSONB_UNSTORABLE.test(bodyJson)) return bodyJson;
  try {
    return JSON.stringify(deepCleanForJsonb(JSON.parse(bodyJson)));
  } catch {
    // Contract violation (bodyJson was not valid JSON) — store a visible
    // marker instead of letting an unstorable row reach the batch writer.
    return JSON.stringify({ truncated: TRANSCRIPT_TRUNCATION_MARKER, reason: "body was not storable as jsonb" });
  }
}

/** Append one transcript row through the write-behind queue. Sync, never
 *  throws, best-effort — a closed store, a missing key, or a full queue is a
 *  quiet no-op (the pipeline must never fail because auditing did). `bodyJson`
 *  must be a serialized JSON OBJECT already redacted by the caller (agents.ts
 *  redacts at write, the same emit-time discipline as events). Bounds applied
 *  here: body cap (truncate-with-marker), per-stage row cap (the row AT the
 *  cap becomes a kind:"cap" marker; rows beyond it are dropped), jsonb-safety
 *  scrub (lone surrogates / NUL escapes can never poison a batch), and the
 *  queue's row + byte budgets. Also the retention trigger: appends happen
 *  constantly while the daemon works, so the daily sweep watermark is checked
 *  here (and at startEventStore for idle daemons after a restart). */
export function appendStageTranscript(row: {
  issueKey: string; stage: string; sessionId: string | null;
  seq: number; kind: string; bodyJson: string;
}): void {
  if (state !== "open" || !store) return; // no transcripts when the store is closed
  if (row.issueKey.trim() === "" || row.stage.trim() === "") return;
  if (!Number.isInteger(row.seq) || row.seq < 1 || row.seq > TRANSCRIPT_MAX_ROWS_PER_STAGE) return;
  const capped = row.seq === TRANSCRIPT_MAX_ROWS_PER_STAGE;
  const bodyJson = capped
    ? JSON.stringify({ truncated: TRANSCRIPT_TRUNCATION_MARKER, reason: `per-stage row cap (${TRANSCRIPT_MAX_ROWS_PER_STAGE}) reached — later messages not recorded` })
    : boundedTranscriptBody(jsonbSafeBodyJson(row.bodyJson));
  const bodyBytes = Buffer.byteLength(bodyJson, "utf8");
  if (transcriptQueue.length >= MAX_QUEUED_TRANSCRIPTS || queuedTranscriptBytes + bodyBytes > MAX_QUEUED_TRANSCRIPT_BYTES) {
    droppedTranscripts += 1;
    if (droppedTranscripts === 1 || droppedTranscripts % 1000 === 0) {
      console.error(`[db] transcript queue full (${transcriptQueue.length} rows, ${queuedTranscriptBytes} body bytes) — dropped ${droppedTranscripts} row(s)`);
    }
    return;
  }
  queuedTranscriptBytes += bodyBytes;
  transcriptQueue.push({
    at: Date.now(),
    issueKey: row.issueKey, stage: row.stage, sessionId: row.sessionId,
    seq: row.seq,
    kind: capped ? "cap" : row.kind,
    bodyJson, bodyBytes,
  });
  void drain();
  void maybeSweepStageTranscripts();
}

export interface TranscriptRow {
  id: number; at: number; issueKey: string; stage: string;
  sessionId: string | null; seq: number; kind: string;
  /** Parsed body — jsonb read back `::text` and JSON.parsed in JS, one shape on
   *  both drivers (the registers' normalise-on-read discipline). */
  body: Record<string, unknown>;
}

interface RawTranscriptRow { id: unknown; at: unknown; issue_key: string; stage: string;
  session_id: string | null; seq: unknown; kind: string; body: unknown }

const TRANSCRIPT_COLUMNS = "id::float8 AS id, at::float8 AS at, issue_key, stage, session_id, seq::int AS seq, kind, body::text AS body";

function toTranscriptRow(r: RawTranscriptRow): TranscriptRow {
  return {
    id: num(r.id), at: num(r.at), issueKey: r.issue_key, stage: r.stage,
    sessionId: r.session_id, seq: num(r.seq), kind: r.kind, body: jsonbObject(r.body),
  };
}

/** Full transcript for one issue (optionally one stage), ordered by id — the
 *  audit read behind "what exactly did the factory do on FAC-49?". */
export async function issueTranscript(issueKey: string, stage?: string, limit = 5000): Promise<TranscriptRow[]> {
  await flushEvents();
  if (!store) return [];
  const rows = stage === undefined
    ? await store.query<RawTranscriptRow>(
        `SELECT ${TRANSCRIPT_COLUMNS} FROM stage_transcript WHERE issue_key = $1 ORDER BY id ASC LIMIT $2`, [issueKey, limit])
    : await store.query<RawTranscriptRow>(
        `SELECT ${TRANSCRIPT_COLUMNS} FROM stage_transcript WHERE issue_key = $1 AND stage = $2 ORDER BY id ASC LIMIT $3`, [issueKey, stage, limit]);
  return rows.map(toTranscriptRow);
}

/** Rows per transcript page — the GET /issue/:key/transcript response bound.
 *  IN-CODE CONSTANT, not an env knob (CLAUDE.md). */
export const TRANSCRIPT_PAGE_MAX_ROWS = 500;

export interface TranscriptPage {
  rows: TranscriptRow[];
  /** Cursor for the next page (pass as `after`), or null when this was the
   *  last page. Keyset pagination on id — stable under concurrent appends. */
  nextAfter: number | null;
}

/** One bounded page of the transcript for GET /issue/:key/transcript.
 *  Keyset-paginated (`id > afterId`), capped at TRANSCRIPT_PAGE_MAX_ROWS
 *  regardless of what the caller asks for. */
export async function issueTranscriptPage(issueKey: string, opts: { stage?: string; afterId?: number; limit?: number } = {}): Promise<TranscriptPage> {
  await flushEvents();
  if (!store) return { rows: [], nextAfter: null };
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 200)), TRANSCRIPT_PAGE_MAX_ROWS);
  const after = typeof opts.afterId === "number" && Number.isFinite(opts.afterId) && opts.afterId > 0 ? Math.floor(opts.afterId) : 0;
  // limit + 1 probes for a next page without a second COUNT query.
  const raw = opts.stage === undefined
    ? await store.query<RawTranscriptRow>(
        `SELECT ${TRANSCRIPT_COLUMNS} FROM stage_transcript WHERE issue_key = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
        [issueKey, after, limit + 1])
    : await store.query<RawTranscriptRow>(
        `SELECT ${TRANSCRIPT_COLUMNS} FROM stage_transcript WHERE issue_key = $1 AND id > $2 AND stage = $3 ORDER BY id ASC LIMIT $4`,
        [issueKey, after, opts.stage, limit + 1]);
  const rows = raw.slice(0, limit).map(toTranscriptRow);
  const last = rows[rows.length - 1];
  return { rows, nextAfter: raw.length > limit && last ? last.id : null };
}

/** Retention sweep: delete transcript rows older than TRANSCRIPT_RETENTION_DAYS.
 *  Deletes ONLY stage_transcript rows — the summary `events` stream is kept
 *  forever (issue #11: "keeping the summary events stream forever"). Returns
 *  the deleted-row count. Scheduled via maybeSweepStageTranscripts below — an
 *  exported-but-uncalled sweep would leave the retention bound unenforced,
 *  and a cap nothing enforces is not a cap (CLAUDE.md). */
export async function sweepStageTranscripts(): Promise<number> {
  await flushEvents();
  if (!store) return 0;
  const cutoff = Date.now() - TRANSCRIPT_RETENTION_DAYS * 86_400_000;
  return store.exec("DELETE FROM stage_transcript WHERE at < $1", [cutoff]);
}

/** Minimum interval between retention sweeps. IN-CODE CONSTANT (CLAUDE.md). */
const TRANSCRIPT_SWEEP_INTERVAL_MS = 86_400_000; // daily

let lastTranscriptSweepAt = 0;
let transcriptSweepInFlight: Promise<number> | null = null;

/** Run the retention sweep at most once per TRANSCRIPT_SWEEP_INTERVAL_MS.
 *  Called from the two places that guarantee coverage without a dedicated
 *  scheduler: appendStageTranscript (a working daemon appends constantly, so
 *  the watermark is checked continuously) and startEventStore (a restarted or
 *  idle daemon still sweeps on open). Never throws; returns the in-flight
 *  sweep promise when one was started, null when inside the interval. The
 *  watermark advances BEFORE the async work so concurrent callers can never
 *  stack sweeps. */
export function maybeSweepStageTranscripts(now = Date.now()): Promise<number> | null {
  if (state !== "open" || !store) return null;
  if (now - lastTranscriptSweepAt < TRANSCRIPT_SWEEP_INTERVAL_MS) return null;
  lastTranscriptSweepAt = now;
  transcriptSweepInFlight = sweepStageTranscripts()
    .catch((error) => {
      // Best-effort like the rest of the transcript path: a failed sweep must
      // never surface into a stage. Leave the watermark advanced — the next
      // interval retries, and a DB that is down will fail appends loudly
      // elsewhere anyway.
      console.error(`[db] transcript retention sweep failed: ${String(error instanceof Error ? error.message : error)}`);
      return 0;
    })
    .finally(() => { transcriptSweepInFlight = null; });
  return transcriptSweepInFlight;
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
  const rows = await store.query<{ json: unknown }>(
    "SELECT json::text AS json FROM events WHERE type = 'run_stage_finished' AND issue_key = $1 AND at >= $2",
    [issueKey, sinceMs]);
  let total = 0;
  for (const r of rows) total += num(jsonbObject(r.json).costUsd); // bad row ⇒ {} ⇒ +0
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

/** Count of real (non-dry) PIPELINE run_finished events since `sinceMs` —
 *  excludes the groundskeeper's own GK-* runs. The "new task activity" signal a
 *  card can gate on (requiresActivity): a factory groundskeeper that only mines
 *  telemetry has nothing new to say until the factory has actually run work, so
 *  it should sleep rather than re-file the same analysis. */
export async function pipelineRunsSince(sinceMs: number): Promise<number> {
  await flushEvents();
  if (!store) return 0;
  const rows = await store.query<{ issue_key: string | null; json: unknown }>(
    "SELECT issue_key, json::text AS json FROM events WHERE type = 'run_finished' AND at >= $1", [sinceMs]);
  let n = 0;
  for (const r of rows) {
    if ((r.issue_key ?? "").startsWith("GK-")) continue;
    const e = jsonbObject(r.json) as { dryRun?: boolean };
    if (!e.dryRun) n += 1;
  }
  return n;
}

/** Count of real (non-dry) run_finished parked outcomes since `sinceMs` — the
 *  parks-spike signal that flips a groundskeeper into repair-only mode. */
export async function parkedRunsSince(sinceMs: number): Promise<number> {
  await flushEvents();
  if (!store) return 0;
  const rows = await store.query<{ json: unknown }>(
    "SELECT json::text AS json FROM events WHERE type = 'run_finished' AND at >= $1", [sinceMs]);
  let n = 0;
  for (const r of rows) {
    const e = jsonbObject(r.json) as { outcome?: string; dryRun?: boolean }; // bad row ⇒ {} ⇒ not counted
    if (!e.dryRun && e.outcome === "parked") n += 1;
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
  const rows = await store.query<{ type: string; json: unknown }>(
    "SELECT type, json::text AS json FROM events WHERE issue_key = $1 AND type IN ('run_finished', 'issue_needs_human') ORDER BY id DESC LIMIT 50",
    [issueKey]);
  for (const r of rows) {
    const e = jsonbObject(r.json) as { outcome?: string; reason?: unknown }; // bad row ⇒ {} ⇒ skipped
    const reason = typeof e.reason === "string" && e.reason.trim() ? e.reason.trim() : null;
    if (r.type === "issue_needs_human" && reason) return reason;
    if (r.type === "run_finished" && (e.outcome === "parked" || e.outcome === "needs_human") && reason) return reason;
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
  const rows = await store.query<{ json: unknown }>(
    "SELECT json::text AS json FROM events WHERE type = 'run_stage_finished'");
  for (const r of rows) {
    const e = jsonbObject(r.json) as { costUsd?: unknown; turns?: unknown; stage?: unknown; issueKey?: unknown };
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
  /** top-5 NEEDS-HUMAN reasons by frequency — the human-intervention clusters
   *  (guarded-path touches, taste fails, merge conflicts) a mining groundskeeper
   *  targets. Distinct from parks (retryable) — these are where autonomy leaks. */
  needsHumanReasons: Array<{ reason: string; count: number }>;
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
    parkReasons: [], needsHumanReasons: [], costPerIssue: [],
  };
}

// Cache of the last computed aggregate. The result only changes when a new
// stage/run row lands (watermark: newest relevant row id — two index seeks) or
// the local calendar day rolls over (the zero-filled `daily` window moves).
let telemetryCache: { watermark: number; day: string; value: Telemetry } | null = null;
// Single-flight guard. Now that this is async, two simultaneous dashboard polls
// would BOTH miss the watermark and BOTH run the double full scan; sharing one
// in-flight computation removes a stampede the synchronous version could not
// have had. KEYED on the flush watermark (issue #8 F7): an in-flight compute
// that started at generation G may be adopted only by callers whose own flush
// left the generation at ≤ G — a caller whose events landed AFTER the compute
// began would otherwise receive an aggregate older than what it just wrote.
let telemetryInFlight: { gen: number; promise: Promise<Telemetry> } | null = null;

/** Aggregate GET /telemetry from the durable event log. Returns a zeroed shape
 *  when the store is not open or holds no events. Guarantee: the result is
 *  never older than the caller's own flushed events. */
export async function getTelemetry(): Promise<Telemetry> {
  await flushEvents();
  if (!store) return emptyTelemetry();
  const gen = flushGeneration;
  if (telemetryInFlight && telemetryInFlight.gen >= gen) return telemetryInFlight.promise;
  const promise = computeTelemetry().finally(() => {
    // Clear only if a fresher compute has not already replaced this slot.
    if (telemetryInFlight?.promise === promise) telemetryInFlight = null;
  });
  telemetryInFlight = { gen, promise };
  return promise;
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

  const stageRows = await s.query<{ at: unknown; json: unknown }>(
    "SELECT at::float8 AS at, json::text AS json FROM events WHERE type = 'run_stage_finished' ORDER BY id ASC");
  const perModel = new Map<string, Telemetry["perModel"][number]>();
  const perStage = new Map<string, Telemetry["perStage"][number]>();
  const costByIssue = new Map<string, { costUsd: number; runs: number }>();

  for (const row of stageRows) {
    const body = jsonbObject(row.json);
    if (Object.keys(body).length === 0) continue; // quarantined/bad row — skip, exactly as the JSON.parse catch did
    const e = body as StageFinished;
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

  const runRows = await s.query<{ at: unknown; json: unknown }>(
    "SELECT at::float8 AS at, json::text AS json FROM events WHERE type = 'run_finished' ORDER BY id ASC");
  const parkReasons = new Map<string, number>();
  const needsHumanReasons = new Map<string, number>();

  for (const row of runRows) {
    const body = jsonbObject(row.json);
    if (Object.keys(body).length === 0) continue; // quarantined/bad row — skip, exactly as the JSON.parse catch did
    const e = body as RunFinished;
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
    if (outcome === "needs_human" && typeof e.reason === "string" && e.reason.trim()) {
      const key = e.reason.trim().slice(0, 120);
      needsHumanReasons.set(key, (needsHumanReasons.get(key) ?? 0) + 1);
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
  t.needsHumanReasons = [...needsHumanReasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  t.costPerIssue = [...costByIssue.entries()]
    .map(([issueKey, v]) => ({ issueKey, costUsd: v.costUsd, runs: v.runs }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10);
  // Never let a slow, stale compute overwrite a fresher cache entry: with the
  // watermark-keyed single-flight (issue #8 F7) two computes CAN overlap, and
  // the older one may finish last.
  if (!telemetryCache || telemetryCache.day !== today || watermark >= telemetryCache.watermark) {
    telemetryCache = { watermark, day: today, value: t };
  }
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
          // evidence_json is jsonb — bind ::text::jsonb ONLY (see writeBatch).
          "INSERT INTO merge_shadow_log (at, repo, issue_key, would_merge, acted, tier, reasons, evidence_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)",
          [Date.now(), repo, issueKey, decision.wouldMerge, decision.act, decision.tier,
            decision.reasons.join("; ").slice(0, 1000), jsonbSafeStringify(ev)]);
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
  gate_summary_json: unknown; security_verdict: string; taste_verdict: string;
  findings_digest: string; diff_stat: string; cost_usd: unknown; turns: unknown;
  regate_failed: boolean; status: string; resolution: string;
}

const APPROVAL_COLUMNS = "id::float8 AS id, created_at::float8 AS created_at, updated_at::float8 AS updated_at, issue_key, title, repo, pr_url, gated_head_sha, hold_reasons, gate_summary_json::text AS gate_summary_json, security_verdict, taste_verdict, findings_digest, diff_stat, cost_usd::float8 AS cost_usd, turns::float8 AS turns, regate_failed, status, resolution";

function toApprovalItem(r: RawApprovalRow): ApprovalItem {
  // jsonb read through the central normaliser (store.ts) — a NULL column or a
  // quarantined/legacy row degrades to null, exactly as the old catch did.
  const summary = r.gate_summary_json === null ? null : jsonbObject(r.gate_summary_json);
  const gateSummary = summary && Object.keys(summary).length > 0
    ? (summary as unknown as ApprovalItem["gateSummary"]) : null;
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

/** Attempts insertApproval makes when its INSERT keeps losing the one-pending-
 *  row-per-issue index to a concurrent filer. IN-CODE CONSTANT, not an env knob
 *  (CLAUDE.md). Two contenders resolve in at most two rounds; three is margin. */
const MAX_APPROVAL_INSERT_ATTEMPTS = 3;

/** Insert a new approval item, superseding any still-pending item for the same
 *  issue (a re-run's fresh evidence makes the old card unreliable — its gated
 *  SHA no longer matches the branch, so it could only ever refuse). Returns the
 *  new row id, or null when the store is closed. Caller (approvals.ts) has
 *  already redacted/capped every string.
 *
 *  issue #8 F6: supersede-then-insert is two statements, so two concurrent
 *  filers used to be able to interleave into TWO pending rows. The partial
 *  unique index (idx_approvals_one_pending, WHERE status='pending') now makes
 *  that impossible structurally; this function handles the resulting conflict
 *  by superseding again and retrying — the newest evidence wins, exactly the
 *  semantic the two-statement version was reaching for. */
export async function insertApproval(row: {
  issueKey: string; title: string; repo: string; prUrl: string;
  gatedHeadSha: string | null; holdReasons: string;
  gateSummary: ApprovalItem["gateSummary"];
  securityVerdict: string; tasteVerdict: string; findingsDigest: string;
  diffStat: string; costUsd: number; turns: number; regateFailed: boolean;
}): Promise<number | null> {
  if (!store) return null;
  const now = Date.now();
  for (let attempt = 0; attempt < MAX_APPROVAL_INSERT_ATTEMPTS; attempt++) {
    await store.exec(
      "UPDATE approvals SET status = 'stale', resolution = 'superseded by a newer run', updated_at = $1 WHERE issue_key = $2 AND status = 'pending'",
      [now, row.issueKey]);
    // ON CONFLICT is inferred against idx_approvals_one_pending (the partial
    // unique index above). DO NOTHING + RETURNING means a lost race comes back
    // as ZERO rows instead of an exception — loop back to supersede the row
    // that beat us and insert again.
    const rows = await store.query<{ id: unknown }>(
      `INSERT INTO approvals (created_at, updated_at, issue_key, title, repo, pr_url, gated_head_sha, hold_reasons, gate_summary_json, security_verdict, taste_verdict, findings_digest, diff_stat, cost_usd, turns, regate_failed, status, resolution)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10, $11, $12, $13, $14, $15, $16, 'pending', '')
       ON CONFLICT (issue_key) WHERE status = 'pending' DO NOTHING
       RETURNING id::float8 AS id`,
      [now, now, row.issueKey, row.title, row.repo, row.prUrl, row.gatedHeadSha, row.holdReasons,
        row.gateSummary ? jsonbSafeStringify(row.gateSummary) : null,
        row.securityVerdict, row.tasteVerdict, row.findingsDigest, row.diffStat, row.costUsd, row.turns,
        row.regateFailed]);
    const id = num(rows[0]?.id);
    if (id > 0) return id;
  }
  console.error(`[db] insertApproval lost the pending-row race ${MAX_APPROVAL_INSERT_ATTEMPTS} times for ${row.issueKey} — a concurrent filer's item stands`);
  return null;
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
// Project config rows (issue #7) — persistence ONLY, same split as the merge
// ladder and approvals sections above: every DECISION (which fields are
// descriptive vs authority, what a policy value may contain, how an overlay
// applies to a card) lives in project-config.ts / registry.ts; these helpers
// just read/write rows through the daemon's single shared handle.
//
// AUDIT COUPLING IS STRUCTURAL where it matters: every mutation helper here is
// a SINGLE statement whose data-modifying CTEs write the config change AND its
// project_config_audit row together — there is no code path that edits config
// without auditing it, and the append-only trigger stops the audit from ever
// being rewritten. (The one exception is replaceProjectRepos — the daemon's
// own card-projection sync — which is multi-statement but still writes an
// audit row whenever the projection actually changes.)
//
// Closed-store behavior mirrors the rest of this file: reads return empty/
// null, writes return null/false, nothing throws into a request.
// ---------------------------------------------------------------------------

export type ProjectPolicyState = "pending" | "active" | "superseded" | "rejected";

export interface ProjectRow {
  id: number; name: string; goal: string; description: string;
  team: string; status: string; createdAt: number; updatedAt: number;
}
export interface ProjectPolicyRow {
  id: number; projectId: number; key: string;
  /** JSON.parsed stored value; null when the stored text is unparseable. */
  value: unknown;
  state: ProjectPolicyState; approvedBy: string | null; approvedAt: number | null; createdAt: number;
}
export interface ProjectAuditRow {
  id: number; projectId: number; field: string;
  oldValue: string | null; newValue: string | null; actor: string; at: number;
}
export interface ProjectModelRow { role: string; model: string; effort: string | null }
export interface ProjectGroundskeeperRow { card: string; enabled: boolean; cadence: string | null }

const PROJECT_COLUMNS = "id::float8 AS id, name, goal, description, team, status, created_at::float8 AS created_at, updated_at::float8 AS updated_at";
const POLICY_COLUMNS = "id::float8 AS id, project_id::float8 AS project_id, key, value, state, approved_by, approved_at::float8 AS approved_at, created_at::float8 AS created_at";
const PROJECT_AUDIT_COLUMNS = "id::float8 AS id, project_id::float8 AS project_id, field, old_value, new_value, actor, at::float8 AS at";

interface RawProjectRow { id: unknown; name: string; goal: string; description: string; team: string; status: string; created_at: unknown; updated_at: unknown }
interface RawPolicyRow { id: unknown; project_id: unknown; key: string; value: string; state: string; approved_by: string | null; approved_at: unknown; created_at: unknown }
interface RawProjectAuditRow { id: unknown; project_id: unknown; field: string; old_value: string | null; new_value: string | null; actor: string; at: unknown }

function toProjectRow(r: RawProjectRow): ProjectRow {
  return { id: num(r.id), name: r.name, goal: r.goal, description: r.description,
    team: r.team, status: r.status, createdAt: num(r.created_at), updatedAt: num(r.updated_at) };
}

function toPolicyRow(r: RawPolicyRow): ProjectPolicyRow {
  let value: unknown = null;
  try { value = JSON.parse(r.value) as unknown; } catch { /* unparseable stored value degrades to null */ }
  return {
    id: num(r.id), projectId: num(r.project_id), key: r.key, value,
    state: (["pending", "active", "superseded", "rejected"].includes(r.state) ? r.state : "rejected") as ProjectPolicyState,
    approvedBy: r.approved_by, approvedAt: r.approved_at === null ? null : num(r.approved_at), createdAt: num(r.created_at),
  };
}

function toProjectAuditRow(r: RawProjectAuditRow): ProjectAuditRow {
  return { id: num(r.id), projectId: num(r.project_id), field: r.field,
    oldValue: r.old_value, newValue: r.new_value, actor: r.actor, at: num(r.at) };
}

/** Ensure a projects row exists for a registry card (bootstrap/import path —
 *  cards seed PG, PG is then the descriptive source of truth). Creation writes
 *  an audit row; an existing row is left untouched (a human's PG edits to
 *  goal/team/etc. must not be clobbered by every sync). Returns the row id, or
 *  null when the store is closed. */
export async function ensureProjectRow(name: string, team: string, actor: string): Promise<number | null> {
  if (!store) return null;
  const now = Date.now();
  const rows = await store.query<{ id: unknown }>(
    `WITH ins AS (
       INSERT INTO projects (name, goal, description, team, status, created_at, updated_at)
       VALUES ($1, '', '', $2, 'active', $3, $3)
       ON CONFLICT (name) DO NOTHING
       RETURNING id
     )
     INSERT INTO project_config_audit (project_id, field, old_value, new_value, actor, at)
     SELECT i.id::bigint, 'project:created', NULL, to_json($1::text)::text, $4, $3 FROM ins i
     RETURNING project_id::float8 AS id`,
    [name, team, now, actor]);
  const created = num(rows[0]?.id);
  if (created > 0) return created;
  const existing = await store.query<{ id: unknown }>("SELECT id::float8 AS id FROM projects WHERE name = $1", [name]);
  return existing[0] ? num(existing[0].id) : null;
}

export async function getProjectRowByName(name: string): Promise<ProjectRow | null> {
  if (!store) return null;
  const rows = await store.query<RawProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE name = $1`, [name]);
  return rows[0] ? toProjectRow(rows[0]) : null;
}

export async function listProjectRows(): Promise<ProjectRow[]> {
  if (!store) return [];
  const rows = await store.query<RawProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY name`);
  return rows.map(toProjectRow);
}

/** DESCRIPTIVE-tier write: apply immediately + audit row, in ONE statement (the
 *  audit INSERT only lands when the UPDATE actually changed the row, and both
 *  see the same pre-statement snapshot, so old_value is honest). `field` is
 *  validated against an in-code allowlist and routed to a fixed COALESCE slot —
 *  column names are never caller-interpolated into SQL, keeping every literal
 *  static for the cast-discipline lint. Returns true when a row changed. */
const PROJECT_DESCRIPTIVE_FIELDS = ["goal", "description", "status", "team"] as const;
export type ProjectDescriptiveField = (typeof PROJECT_DESCRIPTIVE_FIELDS)[number];

export function isProjectDescriptiveField(field: string): field is ProjectDescriptiveField {
  return (PROJECT_DESCRIPTIVE_FIELDS as readonly string[]).includes(field);
}

export async function updateProjectDescriptive(projectId: number, field: ProjectDescriptiveField, value: string, actor: string): Promise<boolean> {
  if (!store) return false;
  if (!isProjectDescriptiveField(field)) return false; // decision layer already rejects; belt & braces
  const slot = (f: ProjectDescriptiveField): string | null => (f === field ? value : null);
  const now = Date.now();
  const changed = await store.exec(
    `WITH before AS (SELECT id, goal, description, status, team FROM projects WHERE id = $1),
     changed AS (
       UPDATE projects SET goal = COALESCE($2, goal), description = COALESCE($3, description),
                           status = COALESCE($4, status), team = COALESCE($5, team), updated_at = $6
       WHERE id = $1 AND (goal IS DISTINCT FROM COALESCE($2, goal)
                       OR description IS DISTINCT FROM COALESCE($3, description)
                       OR status IS DISTINCT FROM COALESCE($4, status)
                       OR team IS DISTINCT FROM COALESCE($5, team))
       RETURNING id
     )
     INSERT INTO project_config_audit (project_id, field, old_value, new_value, actor, at)
     SELECT c.id::bigint, $7,
            to_json(CASE $7 WHEN 'goal' THEN b.goal WHEN 'description' THEN b.description WHEN 'status' THEN b.status ELSE b.team END)::text,
            to_json(COALESCE($2, $3, $4, $5))::text, $8, $6
     FROM changed c JOIN before b ON b.id = c.id`,
    [projectId, slot("goal"), slot("description"), slot("status"), slot("team"), now, field, actor]);
  return changed > 0;
}

/** Reconcile the ONE-WAY repos projection from a registry card. Overwrites the
 *  DB set with the card's set whenever they differ (so a DB edit can never
 *  widen — the card always wins) and writes an audit row for the change.
 *  Multi-statement, but the daemon is the single writer of this table. */
export async function replaceProjectRepos(projectId: number, repos: string[], actor: string): Promise<boolean> {
  if (!store) return false;
  const current = await listProjectRepos(projectId);
  const next = [...new Set(repos)].sort();
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  await store.exec("DELETE FROM project_repos WHERE project_id = $1", [projectId]);
  for (const repo of next) {
    await store.exec("INSERT INTO project_repos (project_id, repo) VALUES ($1, $2) ON CONFLICT DO NOTHING", [projectId, repo]);
  }
  await store.exec(
    "INSERT INTO project_config_audit (project_id, field, old_value, new_value, actor, at) VALUES ($1, 'repos:projection', $2, $3, $4, $5)",
    [projectId, JSON.stringify(current), JSON.stringify(next), actor, Date.now()]);
  return true;
}

export async function listProjectRepos(projectId: number): Promise<string[]> {
  if (!store) return [];
  const rows = await store.query<{ repo: string }>(
    "SELECT repo FROM project_repos WHERE project_id = $1 ORDER BY repo", [projectId]);
  return rows.map((r) => r.repo);
}

/** Project-registry membership gate reader (loop.ts / plan.ts): which ACTIVE
 *  project owns `repo`? Tri-state on purpose — "unavailable" (store closed or
 *  query failed) must be distinguishable from "unregistered", because the gate
 *  defers on an outage but needs-humans a genuinely unregistered repo; folding
 *  the two together would mislabel every queued ticket during a DB blip. */
export type ProjectOwnership =
  | { status: "registered"; project: string }
  | { status: "unregistered" }
  | { status: "unavailable" };

export async function projectOwningRepo(repo: string): Promise<ProjectOwnership> {
  if (!store) return { status: "unavailable" };
  try {
    const rows = await store.query<{ name: string }>(
      "SELECT p.name FROM project_repos pr JOIN projects p ON p.id = pr.project_id WHERE pr.repo = $1 AND p.status = 'active' ORDER BY p.name LIMIT 1",
      [repo]);
    return rows[0] ? { status: "registered", project: rows[0].name } : { status: "unregistered" };
  } catch (error) {
    console.error(`[db] projectOwningRepo(${repo}) failed — treating registry as unavailable: ${error instanceof Error ? error.message : error}`);
    return { status: "unavailable" };
  }
}

/** Set (or update) one role's model config — descriptive tier: immediate +
 *  audit in one statement. Validation against config.models happens in
 *  project-config.ts BEFORE this is called, and again on read. */
export async function upsertProjectModel(projectId: number, role: string, model: string, effort: string | null, actor: string): Promise<boolean> {
  if (!store) return false;
  const changed = await store.exec(
    `WITH before AS (SELECT model, effort FROM project_models WHERE project_id = $1 AND role = $2),
     up AS (
       INSERT INTO project_models (project_id, role, model, effort) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, role) DO UPDATE SET model = EXCLUDED.model, effort = EXCLUDED.effort
       RETURNING role
     )
     INSERT INTO project_config_audit (project_id, field, old_value, new_value, actor, at)
     SELECT $1, 'model:' || $2, (SELECT to_json(b)::text FROM before b), json_build_object('model', $3::text, 'effort', $4::text)::text, $5, $6 FROM up`,
    [projectId, role, model, effort, actor, Date.now()]);
  return changed > 0;
}

export async function deleteProjectModel(projectId: number, role: string, actor: string): Promise<boolean> {
  if (!store) return false;
  const changed = await store.exec(
    `WITH del AS (DELETE FROM project_models WHERE project_id = $1 AND role = $2 RETURNING model, effort)
     INSERT INTO project_config_audit (project_id, field, old_value, new_value, actor, at)
     SELECT $1, 'model:' || $2, to_json(d)::text, NULL, $3, $4 FROM del d`,
    [projectId, role, actor, Date.now()]);
  return changed > 0;
}

export async function listProjectModels(projectId: number): Promise<ProjectModelRow[]> {
  if (!store) return [];
  const rows = await store.query<{ role: string; model: string; effort: string | null }>(
    "SELECT role, model, effort FROM project_models WHERE project_id = $1 ORDER BY role", [projectId]);
  return rows.map((r) => ({ role: r.role, model: r.model, effort: r.effort }));
}

/** Per-project groundskeeper row (the THIRD gate) — descriptive tier because it
 *  is restrictive-or-neutral by construction: enabled=true alone arms nothing
 *  (both existing gates must still hold), enabled=false only blocks. */
export async function upsertProjectGroundskeeper(projectId: number, card: string, enabled: boolean, cadence: string | null, actor: string): Promise<boolean> {
  if (!store) return false;
  const changed = await store.exec(
    `WITH before AS (SELECT enabled, cadence FROM project_groundskeepers WHERE project_id = $1 AND card = $2),
     up AS (
       INSERT INTO project_groundskeepers (project_id, card, enabled, cadence) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, card) DO UPDATE SET enabled = EXCLUDED.enabled, cadence = EXCLUDED.cadence
       RETURNING card
     )
     INSERT INTO project_config_audit (project_id, field, old_value, new_value, actor, at)
     SELECT $1, 'groundskeeper:' || $2, (SELECT to_json(b)::text FROM before b), json_build_object('enabled', $3::boolean, 'cadence', $4::text)::text, $5, $6 FROM up`,
    [projectId, card, enabled, cadence, actor, Date.now()]);
  return changed > 0;
}

export async function listProjectGroundskeepers(projectId: number): Promise<ProjectGroundskeeperRow[]> {
  if (!store) return [];
  const rows = await store.query<{ card: string; enabled: boolean; cadence: string | null }>(
    "SELECT card, enabled, cadence FROM project_groundskeepers WHERE project_id = $1 ORDER BY card", [projectId]);
  return rows.map((r) => ({ card: r.card, enabled: r.enabled === true, cadence: r.cadence }));
}

/** Every project row governing one groundskeeper card name, across all
 *  projects — the third gate's input (groundskeepers.ts). Empty when the store
 *  is closed, which the gate treats as "no third-gate rows" (today's behavior);
 *  groundskeeperTick already refuses to run at all when eventStoreOpen() is
 *  false, so a closed store cannot fail-open here. */
export async function projectGroundskeeperRowsForCard(card: string): Promise<Array<{ enabled: boolean }>> {
  if (!store) return [];
  const rows = await store.query<{ enabled: boolean }>(
    "SELECT enabled FROM project_groundskeepers WHERE card = $1", [card]);
  return rows.map((r) => ({ enabled: r.enabled === true }));
}

/** AUTHORITY-tier write: land a PENDING policy revision + its audit row in one
 *  statement, SUPERSEDING any earlier still-pending revision for the same
 *  (project, key) in that same statement (the insertApproval supersede-then-
 *  insert pattern). At most ONE pending revision per key can therefore exist —
 *  the newest proposal is always the only approvable one. Load-bearing: the
 *  dashboard renders only the newest pending revision per key, so without the
 *  supersede an older pending row (e.g. a retracted deployEnabled=true) would
 *  be permanently INVISIBLE yet permanently APPROVABLE by id — a stale tab or
 *  a retried POST could activate a revision no human ever saw. The config in
 *  force is unchanged until approveProjectPolicy claims and activates this
 *  row. Returns the new policy id, or null. */
export async function insertPendingPolicy(projectId: number, key: string, valueJson: string, actor: string): Promise<number | null> {
  if (!store) return null;
  const now = Date.now();
  const rows = await store.query<{ id: unknown }>(
    `WITH superseded AS (
       UPDATE project_policy SET state = 'superseded'
       WHERE project_id = $1 AND key = $2 AND state = 'pending'
     ),
     audit AS (
       INSERT INTO project_config_audit (project_id, field, old_value, new_value, actor, at)
       SELECT $1, 'policy:' || $2 || ':proposed',
              (SELECT pol.value FROM project_policy pol WHERE pol.project_id = $1 AND pol.key = $2 AND pol.state = 'active'),
              $3, $4, $5
     )
     INSERT INTO project_policy (project_id, key, value, state, created_at)
     VALUES ($1, $2, $3, 'pending', $5)
     RETURNING id::float8 AS id`,
    [projectId, key, valueJson, actor, now]);
  const id = num(rows[0]?.id);
  return id > 0 ? id : null;
}

export async function getProjectPolicy(id: number): Promise<ProjectPolicyRow | null> {
  if (!store) return null;
  const rows = await store.query<RawPolicyRow>(`SELECT ${POLICY_COLUMNS} FROM project_policy WHERE id = $1`, [id]);
  return rows[0] ? toPolicyRow(rows[0]) : null;
}

export async function listProjectPolicies(projectId: number, limit = 200): Promise<ProjectPolicyRow[]> {
  if (!store) return [];
  const rows = await store.query<RawPolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM project_policy WHERE project_id = $1 ORDER BY id DESC LIMIT $2`, [projectId, limit]);
  return rows.map(toPolicyRow);
}

/** Every ACTIVE policy joined to its project name — the registry overlay's one
 *  read (registry.ts effectiveProjects). Empty when the store is closed, so a
 *  fresh checkout behaves exactly as cards alone. */
export async function activePoliciesByProjectName(): Promise<Array<{ name: string; key: string; value: unknown }>> {
  if (!store) return [];
  const rows = await store.query<{ name: string; key: string; value: string }>(
    "SELECT p.name, pol.key, pol.value FROM project_policy pol JOIN projects p ON p.id = pol.project_id WHERE pol.state = 'active'");
  return rows.map((r) => {
    let value: unknown = null;
    try { value = JSON.parse(r.value) as unknown; } catch { /* degrades to null; overlay ignores it */ }
    return { name: r.name, key: r.key, value };
  });
}

/** Replace the model catalog with what the proxy serves right now: listed
 *  models are upserted available=true, previously-seen models NOT in the list
 *  flip available=false (kept for history, dropped from pick lists). A closed
 *  store or empty list is a no-op — an unreachable proxy at boot must not
 *  blank the catalog the dashboard is using. */
export async function syncModelCatalog(models: string[], source = "proxy"): Promise<void> {
  if (!store || models.length === 0) return;
  const now = Date.now();
  const unique = [...new Set(models.filter((m) => typeof m === "string" && m !== ""))];
  for (const model of unique) {
    await store.exec(
      `INSERT INTO model_catalog (model, source, available, first_seen, last_seen) VALUES ($1, $2, TRUE, $3, $3)
       ON CONFLICT (model) DO UPDATE SET available = TRUE, last_seen = EXCLUDED.last_seen, source = EXCLUDED.source`,
      [model, source, now]);
  }
  await store.exec(
    "UPDATE model_catalog SET available = FALSE WHERE source = $1 AND last_seen < $2",
    [source, now]);
}

/** The currently-available catalog model ids (the dashboard pick list). */
export async function listCatalogModels(): Promise<string[]> {
  if (!store) return [];
  const rows = await store.query<{ model: string }>(
    "SELECT model FROM model_catalog WHERE available ORDER BY model");
  return rows.map((r) => r.model);
}

export interface ModelCatalogRow {
  model: string; source: string; available: boolean; firstSeen: number; lastSeen: number;
}

/** Full catalog rows (including unavailable history) for the /models view. */
export async function listModelCatalogRows(): Promise<ModelCatalogRow[]> {
  if (!store) return [];
  const rows = await store.query<{ model: string; source: string; available: boolean; first_seen: unknown; last_seen: unknown }>(
    "SELECT model, source, available, first_seen, last_seen FROM model_catalog ORDER BY available DESC, model");
  return rows.map((r) => ({ model: r.model, source: r.source, available: r.available === true, firstSeen: num(r.first_seen), lastSeen: num(r.last_seen) }));
}

/** The ACTIVE human-approved merge policy governing `repo` (via its owning
 *  active project), for effectiveMergeTier's policyMerge leg. Absence, a closed
 *  store, a malformed value, or a query failure all degrade to null — which the
 *  tier resolution treats as "no policy", falling back to ladder/default. That
 *  fail-safe direction matters: a missed read can only ever result in LESS
 *  merge authority, never more. */
export async function activeMergePolicyForRepo(repo: string): Promise<"auto" | "shadow" | "review" | null> {
  if (!store) return null;
  try {
    const rows = await store.query<{ value: string }>(
      "SELECT pol.value FROM project_policy pol JOIN projects p ON p.id = pol.project_id JOIN project_repos pr ON pr.project_id = p.id WHERE pr.repo = $1 AND p.status = 'active' AND pol.key = 'merge' AND pol.state = 'active' LIMIT 1",
      [repo]);
    if (!rows[0]) return null;
    let v: unknown = null;
    try { v = JSON.parse(rows[0].value) as unknown; } catch { return null; }
    return v === "auto" || v === "shadow" || v === "review" ? v : null;
  } catch (error) {
    console.error(`[db] activeMergePolicyForRepo(${repo}) failed — treating as no policy: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/** The active human-approved `mergeGuarded` override for `repo` (via its owning
 *  active project) — the per-project switch that lets an operator-granted
 *  auto-merge also cover guarded-path touches (.github/CLAUDE.md/agents/
 *  existing-test edits). Absence / closed store / malformed value all degrade
 *  to FALSE, the fail-safe direction: a missed read can only ever WITHHOLD the
 *  bypass, never grant it. loop.ts additionally requires merge:auto to be in
 *  force before this matters, and it never applies to the self-repo. */
export async function activeGuardedOverrideForRepo(repo: string): Promise<boolean> {
  if (!store) return false;
  try {
    const rows = await store.query<{ value: string }>(
      "SELECT pol.value FROM project_policy pol JOIN projects p ON p.id = pol.project_id JOIN project_repos pr ON pr.project_id = p.id WHERE pr.repo = $1 AND p.status = 'active' AND pol.key = 'mergeGuarded' AND pol.state = 'active' LIMIT 1",
      [repo]);
    if (!rows[0]) return false;
    try { return JSON.parse(rows[0].value) === true; } catch { return false; }
  } catch (error) {
    console.error(`[db] activeGuardedOverrideForRepo(${repo}) failed — treating as no override: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/** Attempts the activate step makes when it keeps losing the one-active-row
 *  index to a concurrent approver. IN-CODE CONSTANT, not an env knob
 *  (CLAUDE.md) — same shape as MAX_APPROVAL_INSERT_ATTEMPTS. */
const MAX_POLICY_ACTIVATE_ATTEMPTS = 3;

/** ATOMIC pending→active transition — the approvals-inbox claim pattern
 *  applied to config authority. Step 1 CLAIMS the row (one conditional UPDATE
 *  on state='pending' AND approved_at IS NULL, with the audit row written in
 *  the same statement), so of two concurrent approvals exactly ONE proceeds —
 *  a double-click cannot double-apply. Step 2 supersedes the currently-active
 *  revision and activates the claimed one; the partial unique index turns any
 *  concurrent-activation race into a loud conflict that is retried, never two
 *  active rows. Returns the activated policy row, or null when the claim was
 *  lost / the row is not pending / the store is closed. */
export async function approveProjectPolicy(id: number, approvedBy: string): Promise<ProjectPolicyRow | null> {
  if (!store) return null;
  const now = Date.now();
  const claimed = await store.query<{ project_id: unknown }>(
    `WITH claimed AS (
       UPDATE project_policy SET approved_by = $2, approved_at = $3
       WHERE id = $1 AND state = 'pending' AND approved_at IS NULL
       RETURNING project_id, key, value
     )
     INSERT INTO project_config_audit (project_id, field, old_value, new_value, actor, at)
     SELECT project_id, 'policy:' || key || ':approved', NULL, value, $2, $3 FROM claimed
     RETURNING project_id::float8 AS project_id`,
    [id, approvedBy, now]);
  if (claimed.length === 0) return null; // lost the claim — someone already decided
  const row = await getProjectPolicy(id);
  if (!row) return null;
  for (let attempt = 0; attempt < MAX_POLICY_ACTIVATE_ATTEMPTS; attempt++) {
    await store.exec(
      "UPDATE project_policy SET state = 'superseded' WHERE project_id = $1 AND key = $2 AND state = 'active' AND id <> $3",
      [row.projectId, row.key, id]);
    try {
      const activated = await store.exec(
        "UPDATE project_policy SET state = 'active' WHERE id = $1 AND state = 'pending'", [id]);
      if (activated > 0) return await getProjectPolicy(id);
      return null; // we own the claim, so 0 here means the row vanished — refuse
    } catch {
      // Unique-index conflict: a concurrent approve activated a different row
      // for the same (project, key) between our supersede and activate. Loop:
      // supersede it and try again — newest approval wins (insertApproval's
      // retry semantic).
    }
  }
  console.error(`[db] approveProjectPolicy lost the one-active race ${MAX_POLICY_ACTIVATE_ATTEMPTS} times for policy ${id} — a concurrent approval stands`);
  return null;
}

/** ATOMIC pending→rejected — one statement, claim + audit together. True when
 *  this call was the one that decided the row. */
export async function rejectProjectPolicy(id: number, actor: string): Promise<boolean> {
  if (!store) return false;
  const now = Date.now();
  const rows = await store.query<{ project_id: unknown }>(
    `WITH claimed AS (
       UPDATE project_policy SET state = 'rejected', approved_by = $2, approved_at = $3
       WHERE id = $1 AND state = 'pending' AND approved_at IS NULL
       RETURNING project_id, key, value
     )
     INSERT INTO project_config_audit (project_id, field, old_value, new_value, actor, at)
     SELECT project_id, 'policy:' || key || ':rejected', value, NULL, $2, $3 FROM claimed
     RETURNING project_id::float8 AS project_id`,
    [id, actor, now]);
  return rows.length > 0;
}

export async function listProjectAudit(projectId: number, limit = 100): Promise<ProjectAuditRow[]> {
  if (!store) return [];
  const rows = await store.query<RawProjectAuditRow>(
    `SELECT ${PROJECT_AUDIT_COLUMNS} FROM project_config_audit WHERE project_id = $1 ORDER BY id DESC LIMIT $2`,
    [projectId, limit]);
  return rows.map(toProjectAuditRow);
}

// ---------------------------------------------------------------------------
// Agent + skill register rows (issue #16 WP1) — persistence ONLY, same split as
// every section above: WHAT gets written (parse, canonical hashing, secret
// scanning, file import/export) lives in register-io.ts, and WHO consumes an
// active row (PG-first card loading) lives in catalog.ts. db.ts owns the SQL,
// the exactly-one-active discipline, and the in-memory ACTIVE-ROW SNAPSHOT +
// GENERATION COUNTER that lets catalog.ts stay synchronous:
//
//   - every successful register write refreshes the snapshot and bumps the
//     generation, so the NEXT getCard() sees the new row with no polling and
//     no restart (the cache key in catalog.ts is the generation);
//   - a closed store has an empty snapshot and a never-bumping generation, so
//     a fresh checkout with no database behaves byte-identically to the
//     file-only catalog (the additive-only pin).
//
// Structural validation (name charset, 64KB cap) is enforced HERE as well as in
// register-io.ts — the helpers are the raw write path, and a cap that can be
// bypassed by calling one layer lower is not a cap. The constants are
// deliberately duplicated from catalog-manager.ts rather than imported:
// catalog-manager imports db.ts, so importing back would be a cycle (the same
// reason routing.ts duplicates KNOWN_GATE_NAMES).
// ---------------------------------------------------------------------------

const REGISTER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_REGISTER_CONTENT_BYTES = 64 * 1024;
/** Attempts a register write makes when it keeps losing the one-active-per-name
 *  index to a concurrent writer. IN-CODE CONSTANT, not an env knob (CLAUDE.md)
 *  — same shape as MAX_APPROVAL_INSERT_ATTEMPTS / MAX_POLICY_ACTIVATE_ATTEMPTS. */
const MAX_REGISTER_WRITE_ATTEMPTS = 3;
const MAX_REGISTER_LIST_ROWS = 500;

export interface AgentRegisterRow {
  id: number; name: string; version: number;
  /** Flat string map, exactly the shape catalog.ts's Card.frontmatter holds.
   *  Non-string JSONB values are dropped on read — the register can never hand
   *  routing/meta a shape the file parser could not have produced. */
  frontmatter: Record<string, string>;
  prompt: string;
  /** Canonical content hash (register-io.ts) — the importer's idempotency key. */
  contentHash: string;
  enabled: boolean; createdAt: number; createdBy: string;
}

export interface SkillRegisterRow {
  id: number; name: string; version: number;
  description: string;
  /** The SKILL.md body, verbatim. */
  content: string;
  /** {roles?, projects?, match?} carry-selector — consumed by a later WP; WP1
   *  only stores and round-trips it. Repo facts only, never ticket text. */
  attach: Record<string, unknown>;
  contentHash: string;
  enabled: boolean; createdAt: number; createdBy: string;
}

const AGENT_REGISTER_COLUMNS = "id::float8 AS id, name, version::int AS version, frontmatter::text AS frontmatter, prompt, content_hash, enabled, created_at::float8 AS created_at, created_by";
const SKILL_REGISTER_COLUMNS = "id::float8 AS id, name, version::int AS version, description, content, attach::text AS attach, content_hash, enabled, created_at::float8 AS created_at, created_by";

interface RawAgentRegisterRow { id: unknown; name: string; version: unknown; frontmatter: unknown;
  prompt: string; content_hash: string; enabled: boolean; created_at: unknown; created_by: string }
interface RawSkillRegisterRow { id: unknown; name: string; version: unknown; description: string;
  content: string; attach: unknown; content_hash: string; enabled: boolean; created_at: unknown; created_by: string }

// jsonb columns are normalised by store.ts's jsonbValue/jsonbObject — the ONE
// central parse-if-string (imported at the top of this file). The bounded
// double-parse in jsonbObject also degrades the damaged double-encoded shape a
// bare `::jsonb` bind under the Bun driver used to write (see the migrate()
// repair) to a usable object.

function toFlatStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(jsonbObject(v))) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function toAgentRegisterRow(r: RawAgentRegisterRow): AgentRegisterRow {
  return { id: num(r.id), name: r.name, version: num(r.version), frontmatter: toFlatStringMap(r.frontmatter),
    prompt: r.prompt, contentHash: r.content_hash, enabled: r.enabled === true,
    createdAt: num(r.created_at), createdBy: r.created_by };
}

function toSkillRegisterRow(r: RawSkillRegisterRow): SkillRegisterRow {
  return { id: num(r.id), name: r.name, version: num(r.version), description: r.description,
    content: r.content, attach: jsonbObject(r.attach), contentHash: r.content_hash,
    enabled: r.enabled === true, createdAt: num(r.created_at), createdBy: r.created_by };
}

// --- The active-row snapshot + generation counter (catalog.ts's sync seam). ---

let registerGen = 0;
let agentRegisterSnapshot = new Map<string, AgentRegisterRow>();
let skillRegisterSnapshot = new Map<string, SkillRegisterRow>();

/** Monotone counter bumped on EVERY register change (write, rollback, store
 *  open/close/truncate). catalog.ts keys its card cache on this, which is what
 *  makes a register edit take effect on the next stage with no polling and no
 *  restart. Synchronous module state, never a query. */
export function registerGeneration(): number {
  return registerGen;
}

/** The active agent register rows, by name — a snapshot refreshed on every
 *  register write. Empty when the store is closed / the register is empty,
 *  which is exactly the file-fallback (pre-register) behaviour. Synchronous so
 *  catalog.ts's getCard stays sync. */
export function activeAgentRegisterSnapshot(): ReadonlyMap<string, AgentRegisterRow> {
  return agentRegisterSnapshot;
}

/** The active skill register rows, by name — same contract as the agent map. */
export function activeSkillRegisterSnapshot(): ReadonlyMap<string, SkillRegisterRow> {
  return skillRegisterSnapshot;
}

/** Reload the snapshot from the store (empty when closed) and bump the
 *  generation. Called by every register write helper, by startEventStore (so a
 *  daemon restart picks up register state), and by the test seam. */
export async function refreshRegisterSnapshot(): Promise<void> {
  if (!store) {
    agentRegisterSnapshot = new Map();
    skillRegisterSnapshot = new Map();
    registerGen += 1;
    return;
  }
  const agents = await listActiveAgentRegisterRows();
  const skills = await listActiveSkillRegisterRows();
  agentRegisterSnapshot = new Map(agents.map((r) => [r.name, r]));
  skillRegisterSnapshot = new Map(skills.map((r) => [r.name, r]));
  registerGen += 1;
}

// --- Reads. ---

/** Every version of one name (or of every name), newest first, bounded. */
export async function listAgentRegisterRows(name?: string): Promise<AgentRegisterRow[]> {
  if (!store) return [];
  const rows = name === undefined
    ? await store.query<RawAgentRegisterRow>(
        `SELECT ${AGENT_REGISTER_COLUMNS} FROM agent_register ORDER BY name, version DESC LIMIT $1`, [MAX_REGISTER_LIST_ROWS])
    : await store.query<RawAgentRegisterRow>(
        `SELECT ${AGENT_REGISTER_COLUMNS} FROM agent_register WHERE name = $1 ORDER BY version DESC LIMIT $2`, [name, MAX_REGISTER_LIST_ROWS]);
  return rows.map(toAgentRegisterRow);
}

export async function listSkillRegisterRows(name?: string): Promise<SkillRegisterRow[]> {
  if (!store) return [];
  const rows = name === undefined
    ? await store.query<RawSkillRegisterRow>(
        `SELECT ${SKILL_REGISTER_COLUMNS} FROM skill_register ORDER BY name, version DESC LIMIT $1`, [MAX_REGISTER_LIST_ROWS])
    : await store.query<RawSkillRegisterRow>(
        `SELECT ${SKILL_REGISTER_COLUMNS} FROM skill_register WHERE name = $1 ORDER BY version DESC LIMIT $2`, [name, MAX_REGISTER_LIST_ROWS]);
  return rows.map(toSkillRegisterRow);
}

/** The ONE active version for a name, or null (none active / store closed). */
export async function getActiveAgentRegisterRow(name: string): Promise<AgentRegisterRow | null> {
  if (!store) return null;
  const rows = await store.query<RawAgentRegisterRow>(
    `SELECT ${AGENT_REGISTER_COLUMNS} FROM agent_register WHERE name = $1 AND enabled`, [name]);
  return rows[0] ? toAgentRegisterRow(rows[0]) : null;
}

export async function getActiveSkillRegisterRow(name: string): Promise<SkillRegisterRow | null> {
  if (!store) return null;
  const rows = await store.query<RawSkillRegisterRow>(
    `SELECT ${SKILL_REGISTER_COLUMNS} FROM skill_register WHERE name = $1 AND enabled`, [name]);
  return rows[0] ? toSkillRegisterRow(rows[0]) : null;
}

export async function listActiveAgentRegisterRows(): Promise<AgentRegisterRow[]> {
  if (!store) return [];
  const rows = await store.query<RawAgentRegisterRow>(
    `SELECT ${AGENT_REGISTER_COLUMNS} FROM agent_register WHERE enabled ORDER BY name LIMIT $1`, [MAX_REGISTER_LIST_ROWS]);
  return rows.map(toAgentRegisterRow);
}

export async function listActiveSkillRegisterRows(): Promise<SkillRegisterRow[]> {
  if (!store) return [];
  const rows = await store.query<RawSkillRegisterRow>(
    `SELECT ${SKILL_REGISTER_COLUMNS} FROM skill_register WHERE enabled ORDER BY name LIMIT $1`, [MAX_REGISTER_LIST_ROWS]);
  return rows.map(toSkillRegisterRow);
}

// --- Writes (append-only versions; exactly-one-active is the DB's invariant). ---

/** Structural validation shared by both insert helpers. Returns an error string
 *  or null. The cap and charset live in code, not env (CLAUDE.md). `texts` are
 *  the values bound to TEXT columns: Postgres rejects a NUL byte in TEXT at the
 *  database, so refusing it here turns a would-be DB error into a clear
 *  refusal before anything is issued. (register-io's contentViolation rejects
 *  the whole control-character class at the user-facing write gate; this is
 *  the structural backstop for direct callers.) */
function registerWriteViolation(name: string, contentBytes: number, texts: string[]): string | null {
  if (!REGISTER_NAME_RE.test(name)) return `register name ${JSON.stringify(name)} fails the charset lock`;
  if (contentBytes > MAX_REGISTER_CONTENT_BYTES) return `register content exceeds the ${MAX_REGISTER_CONTENT_BYTES / 1024}KB cap`;
  if (texts.some((t) => t.includes("\u0000"))) return "register content contains a NUL byte";
  return null;
}

/** True when a DB error is the unique-index conflict a concurrent register
 *  writer causes (SQLSTATE 23505) — the ONLY error class the claim loops
 *  retry. Every other database error (NUL in a jsonb escape, statement
 *  timeout, disk full, …) is reported as what it is and never as "lost a
 *  race". Bun's client exposes `code`; PGlite surfaces only the message. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "23505") return true;
  return typeof e.message === "string" && e.message.includes("duplicate key");
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Append a NEW version of an agent card and make it the active one. The
 *  deactivate + insert run as ONE statement (the data-modifying CTE), so they
 *  are atomic: a failed insert — NUL in a jsonb escape, timeout, disk full,
 *  anything — rolls the deactivate back with it and the current active version
 *  keeps standing. The `WHERE (SELECT COUNT(*) FROM deactivated) >= 0` clause
 *  is always true; its job is to make the INSERT depend on the CTE so Postgres
 *  completes the deactivate before the insert's unique check runs. Only the
 *  unique-index conflict a concurrent writer causes is retried — the partial
 *  index is the invariant, the loop is just how a loser converges. Returns
 *  {id, version}, or null (closed store / validation failure / database error
 *  / lost the race MAX_REGISTER_WRITE_ATTEMPTS times). */
export async function insertAgentRegisterVersion(row: {
  name: string; frontmatter: Record<string, string>; prompt: string;
  contentHash: string; createdBy: string;
}): Promise<{ id: number; version: number } | null> {
  if (!store) return null;
  const fmJson = JSON.stringify(row.frontmatter);
  const violation = registerWriteViolation(
    row.name,
    Buffer.byteLength(row.prompt, "utf8") + Buffer.byteLength(fmJson, "utf8"),
    [row.prompt, row.contentHash, row.createdBy]);
  if (violation) {
    console.error(`[db] agent register write refused: ${violation}`);
    return null;
  }
  const now = Date.now();
  try {
    for (let attempt = 0; attempt < MAX_REGISTER_WRITE_ATTEMPTS; attempt++) {
      try {
        const rows = await store.query<{ id: unknown; version: unknown }>(
          `WITH deactivated AS (
             UPDATE agent_register SET enabled = FALSE WHERE name = $1 AND enabled RETURNING id
           )
           INSERT INTO agent_register (name, version, frontmatter, prompt, content_hash, enabled, created_at, created_by)
           SELECT $1, (COALESCE((SELECT MAX(version) FROM agent_register WHERE name = $1), 0) + 1)::int, $2::text::jsonb, $3, $4, TRUE, $5, $6
           WHERE (SELECT COUNT(*) FROM deactivated) >= 0
           RETURNING id::float8 AS id, version::int AS version`,
          [row.name, fmJson, row.prompt, row.contentHash, now, row.createdBy]);
        const id = num(rows[0]?.id);
        if (id > 0) return { id, version: num(rows[0]?.version) };
        return null; // statement inserted nothing — refuse, do not claim a race
      } catch (error) {
        // The statement is atomic, so a failure changed NOTHING. Retry only
        // the conflict a concurrent writer causes; report anything else as
        // the database error it is.
        if (!isUniqueViolation(error)) {
          console.error(`[db] insertAgentRegisterVersion failed for ${row.name} (database error, nothing written): ${errorText(error)}`);
          return null;
        }
      }
    }
    console.error(`[db] insertAgentRegisterVersion lost the one-active race ${MAX_REGISTER_WRITE_ATTEMPTS} times for ${row.name} — a concurrent write stands`);
    return null;
  } finally {
    // Belt-and-braces: the snapshot must never outlive the rows it mirrors,
    // whatever path the write took out of this function.
    await refreshRegisterSnapshot();
  }
}

/** Append a NEW version of a skill pack and make it the active one. Same
 *  atomic-statement + retry-only-conflicts discipline as
 *  insertAgentRegisterVersion. `attach` must be a plain object
 *  ({roles/projects/match} selector) — it is stored verbatim as jsonb. */
export async function insertSkillRegisterVersion(row: {
  name: string; description: string; content: string; attach: Record<string, unknown>;
  contentHash: string; createdBy: string;
}): Promise<{ id: number; version: number } | null> {
  if (!store) return null;
  const attachJson = JSON.stringify(row.attach);
  const violation = registerWriteViolation(
    row.name,
    Buffer.byteLength(row.content, "utf8") + Buffer.byteLength(attachJson, "utf8"),
    [row.content, row.description, row.contentHash, row.createdBy]);
  if (violation) {
    console.error(`[db] skill register write refused: ${violation}`);
    return null;
  }
  const now = Date.now();
  try {
    for (let attempt = 0; attempt < MAX_REGISTER_WRITE_ATTEMPTS; attempt++) {
      try {
        const rows = await store.query<{ id: unknown; version: unknown }>(
          `WITH deactivated AS (
             UPDATE skill_register SET enabled = FALSE WHERE name = $1 AND enabled RETURNING id
           )
           INSERT INTO skill_register (name, version, description, content, attach, content_hash, enabled, created_at, created_by)
           SELECT $1, (COALESCE((SELECT MAX(version) FROM skill_register WHERE name = $1), 0) + 1)::int, $2, $3, $4::text::jsonb, $5, TRUE, $6, $7
           WHERE (SELECT COUNT(*) FROM deactivated) >= 0
           RETURNING id::float8 AS id, version::int AS version`,
          [row.name, row.description, row.content, attachJson, row.contentHash, now, row.createdBy]);
        const id = num(rows[0]?.id);
        if (id > 0) return { id, version: num(rows[0]?.version) };
        return null; // statement inserted nothing — refuse, do not claim a race
      } catch (error) {
        if (!isUniqueViolation(error)) {
          console.error(`[db] insertSkillRegisterVersion failed for ${row.name} (database error, nothing written): ${errorText(error)}`);
          return null;
        }
      }
    }
    console.error(`[db] insertSkillRegisterVersion lost the one-active race ${MAX_REGISTER_WRITE_ATTEMPTS} times for ${row.name} — a concurrent write stands`);
    return null;
  } finally {
    await refreshRegisterSnapshot();
  }
}

/** Flip one version's enabled flag. enabled=true is ROLLBACK — "make version N
 *  the active one" — under the same deactivate-then-activate claim pattern (the
 *  partial index turns any race into a retried conflict, never two active
 *  rows). enabled=false disables JUST that version; disabling the active one
 *  leaves the name with NO active version, which reads as file-fallback in
 *  catalog.ts (fail towards the git-committed content, never towards a stale
 *  row). Returns true when the named version exists and the state was applied. */
async function setRegisterEnabled(table: "agent_register" | "skill_register", name: string, version: number, enabled: boolean): Promise<boolean> {
  if (!store) return false;
  // Static SQL per table — `table` is a two-value union from OUR callers, never
  // caller-interpolated text, but keeping whole literals static preserves the
  // cast-discipline lint's assumptions.
  const probeSql = table === "agent_register"
    ? "SELECT 1 AS n FROM agent_register WHERE name = $1 AND version = $2"
    : "SELECT 1 AS n FROM skill_register WHERE name = $1 AND version = $2";
  // Demote-others + enable-target as ONE atomic statement. The demote CTE
  // carries its own EXISTS guard on the target version, so even mid-statement
  // the current active version can never be demoted in favour of nothing; the
  // always-true `(SELECT COUNT(*) FROM demoted) >= 0` clause makes the enable
  // depend on the CTE so the demote completes before the unique check runs.
  // A failure anywhere rolls the whole statement back — no half-applied swap.
  const enableSql = table === "agent_register"
    ? `WITH demoted AS (
         UPDATE agent_register SET enabled = FALSE
         WHERE name = $1 AND enabled AND version <> $2
           AND EXISTS (SELECT 1 FROM agent_register WHERE name = $1 AND version = $2)
         RETURNING id
       )
       UPDATE agent_register SET enabled = TRUE
       WHERE name = $1 AND version = $2 AND (SELECT COUNT(*) FROM demoted) >= 0`
    : `WITH demoted AS (
         UPDATE skill_register SET enabled = FALSE
         WHERE name = $1 AND enabled AND version <> $2
           AND EXISTS (SELECT 1 FROM skill_register WHERE name = $1 AND version = $2)
         RETURNING id
       )
       UPDATE skill_register SET enabled = TRUE
       WHERE name = $1 AND version = $2 AND (SELECT COUNT(*) FROM demoted) >= 0`;
  const disableSql = table === "agent_register"
    ? "UPDATE agent_register SET enabled = FALSE WHERE name = $1 AND version = $2"
    : "UPDATE skill_register SET enabled = FALSE WHERE name = $1 AND version = $2";
  // Existence probe FIRST: a rollback to a version that does not exist must be
  // a no-op refusal, never "deactivate the current version and activate nothing".
  const probe = await store.query(probeSql, [name, version]);
  if (probe.length === 0) return false;
  try {
    if (!enabled) {
      try {
        await store.exec(disableSql, [name, version]);
        return true;
      } catch (error) {
        console.error(`[db] setRegisterEnabled failed for ${table}/${name}@${version} (database error, nothing changed): ${errorText(error)}`);
        return false;
      }
    }
    for (let attempt = 0; attempt < MAX_REGISTER_WRITE_ATTEMPTS; attempt++) {
      try {
        const changed = await store.exec(enableSql, [name, version]);
        if (changed > 0) return true;
        return false; // the row vanished between probe and update — refuse (nothing demoted: the CTE guard saw it gone too)
      } catch (error) {
        // Atomic statement: a failure changed nothing. Retry only a concurrent
        // activation's unique-index conflict; report anything else honestly.
        if (!isUniqueViolation(error)) {
          console.error(`[db] setRegisterEnabled failed for ${table}/${name}@${version} (database error, nothing changed): ${errorText(error)}`);
          return false;
        }
      }
    }
    console.error(`[db] setRegisterEnabled lost the one-active race ${MAX_REGISTER_WRITE_ATTEMPTS} times for ${table}/${name}@${version}`);
    return false;
  } finally {
    // The snapshot must never outlive the rows it mirrors — refresh on every
    // exit path once any mutating statement was issued.
    await refreshRegisterSnapshot();
  }
}

export async function setAgentRegisterEnabled(name: string, version: number, enabled: boolean): Promise<boolean> {
  return setRegisterEnabled("agent_register", name, version, enabled);
}

export async function setSkillRegisterEnabled(name: string, version: number, enabled: boolean): Promise<boolean> {
  return setRegisterEnabled("skill_register", name, version, enabled);
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

const TEST_TABLES ="events, stage_transcript, stage_sessions, lessons, merge_ladder, merge_shadow_log, deploys, approvals, pushback_feedback, projects, project_repos, project_models, project_groundskeepers, project_policy, project_config_audit, agent_register, skill_register, jsonb_migration_quarantine, model_catalog";

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
  /** Test-only outage simulation: make the FIRST N event-batch INSERTs reject,
   *  exactly as an unreachable Postgres would. N = 2 exercises the persistent-
   *  failure path (first attempt + its retry both fail → batch dropped →
   *  eventStoreOpen() flips false); N = 1 exercises the transient path (the
   *  retry lands, the gate stays open). Everything else — reads, other writes —
   *  hits the real engine, so only the drain's failure handling is simulated. */
  failEventWrites?: number;
  /** Test-only poisoned-row simulation: any stage_transcript INSERT whose
   *  bound params contain this marker string rejects — exactly like Postgres
   *  rejecting one unstorable body — while every other write succeeds. Lets a
   *  test prove the per-row fallback persists a poisoned row's neighbors. */
  failTranscriptRowContaining?: string;
  /** Test-only interleaving control (issue #8 F7): after the FIRST query whose
   *  SQL contains `contains` has EXECUTED (rows already fetched from the
   *  engine), hold those rows back from the caller until `release` resolves;
   *  `onHeld` fires the moment the hold begins. One-shot — every later query
   *  passes straight through. This is what lets the telemetry staleness test
   *  park one compute mid-flight DETERMINISTICALLY, land newer events, and
   *  prove a second caller does not adopt the stale in-flight aggregate. */
  holdQueryResult?: { contains: string; release: Promise<void>; onHeld?: () => void };
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
  if (opts.failEventWrites && opts.failEventWrites > 0) {
    const inner = testEngine;
    let remaining = opts.failEventWrites;
    store = {
      query: (text, params) => inner.query(text, params),
      exec: (text, params) => {
        if (remaining > 0 && text.startsWith("INSERT INTO events")) {
          remaining -= 1;
          return Promise.reject(new Error("simulated postgres outage (failEventWrites)"));
        }
        return inner.exec(text, params);
      },
      close: () => inner.close(),
    };
  }
  if (opts.failTranscriptRowContaining !== undefined) {
    const inner = store;
    const marker = opts.failTranscriptRowContaining;
    store = {
      query: (text, params) => inner.query(text, params),
      exec: (text, params) => {
        if (text.startsWith("INSERT INTO stage_transcript") && (params ?? []).some((p) => typeof p === "string" && p.includes(marker))) {
          return Promise.reject(new Error("simulated unstorable transcript row (failTranscriptRowContaining)"));
        }
        return inner.exec(text, params);
      },
      close: () => inner.close(),
    };
  }
  if (opts.holdQueryResult) {
    const inner = store;
    const hold = opts.holdQueryResult;
    let armed = true;
    store = {
      query: async <T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> => {
        const rows = await inner.query<T>(text, params);
        if (armed && text.includes(hold.contains)) {
          armed = false;
          hold.onHeld?.();
          await hold.release;
        }
        return rows;
      },
      exec: (text, params) => inner.exec(text, params),
      close: () => inner.close(),
    };
  }
  state = "open";
  writeHealthy = true;
  telemetryCache = null;
  telemetryInFlight = null;
  flushGeneration = 0;
  queue.length = 0;
  transcriptQueue.length = 0;
  queuedTranscriptBytes = 0;
  // Suppress the append-triggered retention sweep across tests: a stale
  // watermark would let test A's fire-and-forget DELETE land after test B's
  // TRUNCATE and eat B's deliberately-old fixture rows. Tests that exercise
  // the sweep move the watermark back explicitly (testSetTranscriptSweepAt).
  lastTranscriptSweepAt = Date.now();
  transcriptSweepInFlight = null;
  draining = null;
  inFlightEvents = 0;
  droppedEvents = 0;
  droppedTranscripts = 0;
  lastWriteError = null;
  // The TRUNCATE above emptied both registers; the snapshot must agree, and the
  // generation must MOVE (never reset — catalog.ts's cache entries from an
  // earlier test would otherwise read as fresh at a re-used generation value).
  agentRegisterSnapshot = new Map();
  skillRegisterSnapshot = new Map();
  registerGen += 1;
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
  transcriptQueue.length = 0;
  store = null;
  const inFlight = draining;
  if (inFlight) await inFlight.catch(() => { /* drain never rejects, but be safe */ });
  // A retention DELETE dispatched before store was nulled must settle too —
  // otherwise it could land after the next test's TRUNCATE and eat that
  // test's deliberately-old fixture rows.
  const sweepInFlight = transcriptSweepInFlight;
  if (sweepInFlight) await sweepInFlight.catch(() => 0);
  state = "closed";
  writeHealthy = true;
  telemetryCache = null;
  telemetryInFlight = null;
  flushGeneration = 0;
  queue.length = 0;
  transcriptQueue.length = 0;
  queuedTranscriptBytes = 0;
  lastTranscriptSweepAt = Date.now();
  transcriptSweepInFlight = null;
  draining = null;
  inFlightEvents = 0;
  droppedEvents = 0;
  droppedTranscripts = 0;
  lastWriteError = null;
  // Closed store = empty register snapshot (file-fallback behaviour), and the
  // generation moves forward so no cached card survives the close.
  agentRegisterSnapshot = new Map();
  skillRegisterSnapshot = new Map();
  registerGen += 1;
}

/** Test-only: insert a raw event row directly into the durable log, bypassing
 *  the bus subscription AND the write queue (openTestDatabase() deliberately
 *  wires up neither — see above). Lets tests exercise the READ paths that scan
 *  the `events` table (getTelemetry, issueEvents, …) without a real store + bus.
 *  No-op when the test store isn't open. */
export async function insertTestEvent(type: string, body: Record<string, unknown>, at = Date.now()): Promise<void> {
  if (!store) return;
  const key = typeof body.issueKey === "string" ? body.issueKey : null;
  await store.exec("INSERT INTO events (seq, at, type, issue_key, json) VALUES ($1, $2, $3, $4, $5::text::jsonb)",
    [0, at, type, key, JSON.stringify({ type, seq: 0, at, ...body })]);
}

/** Test-only: insert a raw transcript row with an explicit `at`, bypassing the
 *  write queue — the retention-sweep tests need rows older than the window and
 *  appendStageTranscript always stamps Date.now(). Same `::text::jsonb` bind
 *  discipline as the production batch writer. */
export async function insertTestTranscriptRow(issueKey: string, stage: string, kind: string, body: Record<string, unknown>, at = Date.now(), seq = 1): Promise<void> {
  if (!store) return;
  await store.exec(
    "INSERT INTO stage_transcript (at, issue_key, stage, session_id, seq, kind, body) VALUES ($1, $2, $3, NULL, $4, $5, $6::text::jsonb)",
    [at, issueKey, stage, seq, kind, JSON.stringify(body)]);
}

/** Test-only: jsonb_typeof of every stored events.json for one issue, in id
 *  order — pins that the write-behind QUEUE stores native jsonb OBJECTS,
 *  never the double-encoded string scalar a bare `::jsonb` bind produces
 *  under the real Bun driver (the read path's parse-if-string would mask it). */
export async function testEventJsonTypes(issueKey: string): Promise<string[]> {
  await flushEvents();
  if (!store) return [];
  const rows = await store.query<{ t: string }>(
    "SELECT jsonb_typeof(json) AS t FROM events WHERE issue_key = $1 ORDER BY id ASC", [issueKey]);
  return rows.map((r) => r.t);
}

/** Test-only: move the retention-sweep watermark. openTestDatabase pins it to
 *  "now" (so a cross-test sweep can never race a TRUNCATE); a sweep test moves
 *  it back past TRANSCRIPT_SWEEP_INTERVAL_MS to arm the trigger. */
export function testSetTranscriptSweepAt(at: number): void {
  lastTranscriptSweepAt = at;
}

/** Test-only: the in-flight retention sweep (resolved 0 when none) — lets a
 *  test await the fire-and-forget DELETE deterministically. */
export function testTranscriptSweepInFlight(): Promise<number> {
  return transcriptSweepInFlight ?? Promise.resolve(0);
}

/** Test-only: transcript queue occupancy and drop counter — pins the byte
 *  budget (rows past it are DROPPED, not queued, so heap stays bounded during
 *  a Postgres outage). */
export function testTranscriptQueueStats(): { rows: number; bytes: number; dropped: number } {
  return { rows: transcriptQueue.length, bytes: queuedTranscriptBytes, dropped: droppedTranscripts };
}

/** Test-only: jsonb_typeof of every stored body for one issue, in id order —
 *  pins that the QUEUE write path stores native jsonb OBJECTS, never the
 *  double-encoded string scalar a bare `::jsonb` bind produces under the real
 *  Bun driver (issueTranscript's defensive double-parse would mask that). */
export async function testTranscriptBodyTypes(issueKey: string): Promise<string[]> {
  await flushEvents();
  if (!store) return [];
  const rows = await store.query<{ t: string }>(
    "SELECT jsonb_typeof(body) AS t FROM stage_transcript WHERE issue_key = $1 ORDER BY id ASC", [issueKey]);
  return rows.map((r) => r.t);
}
