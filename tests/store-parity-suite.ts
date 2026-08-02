// The Store parity suite, extracted so it can run against BOTH drivers
// (issue #8 F4). NOT a test file itself (no ".test." in the name — bun test
// never collects it); the two entry points are:
//
//   tests/store-parity.test.ts     — PGlite (WASM), always on: what `bun test`
//                                    runs with no container.
//   tests/store-parity-pg.test.ts  — bunStore against the compose Postgres,
//                                    OPT-IN via FACTORY_PG_INTEGRATION=1. This
//                                    is the ONLY place the production driver's
//                                    exec() affected-rows contract — which
//                                    claimDeploy, claimApproval and
//                                    restorePushbackFeedback's guards depend
//                                    on — is exercised against a real server.
//
// WHY THE SUITE EXISTS. The obvious assumption — "Postgres is Postgres, so the
// WASM test engine and the real server hand back the same JS types" — is FALSE
// for the exact columns this store is built on. Measured, not assumed:
//
//   query("SELECT id, at FROM t")   Bun/real PG → { id: "1", at: "1785628979286" }   (STRINGS)
//                                   PGlite      → { id: 1,   at: 1785628979286  }   (NUMBERS)
//   query("SELECT COUNT(*) ...")    Bun/real PG → "1"          PGlite → 1
//
// With an explicit ::float8 / ::int cast BOTH return numbers. That is why
// src/db.ts casts every numeric select and why tests/db-cast-discipline.test.ts
// machine-enforces it: without the casts the unit suite would happily pass on
// PGlite while production silently handed strings to arithmetic.
//
// So this suite pins the CAST contract — the behaviour both drivers agree on —
// plus the raw exec() shape the adapters normalise. Do NOT "simplify" the casts
// away: green tests here would not mean a green daemon.
//
// It boots its OWN engine rather than borrowing db.ts's seam, because it
// asserts on arbitrary SQL and db.ts's store handle is private by design
// (single-writer).

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { Store } from "../src/store.ts";

/** Register the full parity suite against one driver. `boot` runs in
 *  beforeAll; the tables are (re)created there and dropped in afterAll so the
 *  integration run leaves no residue in the compose database. `extras`
 *  registers driver-SPECIFIC describes inside the same lifecycle (each driver
 *  pins its own raw uncast-BIGINT shape — the one place they disagree). */
export function registerStoreParitySuite(
  label: string,
  boot: () => Promise<Store>,
  extras?: (getStore: () => Store) => void,
): void {
  let s: Store;
  const getStore = (): Store => s;

  const reset = async (): Promise<void> => {
    await s.exec("TRUNCATE parity RESTART IDENTITY");
  };

  describe(`Store parity [${label}]`, () => {
    beforeAll(async () => {
      s = await boot();
      // Idempotent against an earlier aborted run (matters on the real server,
      // where the database outlives the process).
      await s.exec("DROP TABLE IF EXISTS parity");
      await s.exec("DROP TABLE IF EXISTS parity_pk");
      await s.exec("DROP TABLE IF EXISTS parity_reg");
      await s.exec("DROP TABLE IF EXISTS parity_transcript");
      await s.exec("DROP TABLE IF EXISTS parity_mig");
      await s.exec("DROP TABLE IF EXISTS parity_mig_quarantine");
      // Same column types db.ts's real DDL uses, so the shapes asserted below
      // are the shapes the daemon actually reads.
      await s.exec(`CREATE TABLE parity (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        at BIGINT NOT NULL,
        flag BOOLEAN NOT NULL DEFAULT FALSE,
        cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        label TEXT NOT NULL DEFAULT '')`);
    });

    afterAll(async () => {
      if (!s) return; // boot failed — nothing to clean up or close
      await s.exec("DROP TABLE IF EXISTS parity").catch(() => {});
      await s.exec("DROP TABLE IF EXISTS parity_pk").catch(() => {});
      await s.exec("DROP TABLE IF EXISTS parity_reg").catch(() => {});
      await s.exec("DROP TABLE IF EXISTS parity_transcript").catch(() => {});
      await s.exec("DROP TABLE IF EXISTS parity_mig").catch(() => {});
      await s.exec("DROP TABLE IF EXISTS parity_mig_quarantine").catch(() => {});
      await s.close();
    });

    describe("the cast contract db.ts depends on", () => {
      test("BIGINT id/at come back as JS numbers when cast (::float8)", async () => {
        await reset();
        await s.exec("INSERT INTO parity (at, label) VALUES ($1, $2)", [1785628979286, "a"]);
        const rows = await s.query<{ id: unknown; at: unknown }>(
          "SELECT id::float8 AS id, at::float8 AS at FROM parity");
        expect(typeof rows[0]?.id).toBe("number");
        expect(typeof rows[0]?.at).toBe("number");
        expect(rows[0]?.id).toBe(1);
        // Epoch-ms must survive float8 exactly — it is far below 2^53.
        expect(rows[0]?.at).toBe(1785628979286);
      });

      test("COUNT(*)::int is a number", async () => {
        await reset();
        for (const l of ["a", "b", "c"]) await s.exec("INSERT INTO parity (at, label) VALUES ($1, $2)", [1, l]);
        const rows = await s.query<{ n: unknown }>("SELECT COUNT(*)::int AS n FROM parity");
        expect(rows[0]?.n).toBe(3);
        expect(typeof rows[0]?.n).toBe("number");
      });

      test("GREATEST(COALESCE(MAX(id)))::float8 — the telemetry watermark shape", async () => {
        // Verbatim structure of computeTelemetry's watermark query, including
        // the GREATEST that replaced SQLite's 2-arg max(a, b).
        await reset();
        await s.exec("INSERT INTO parity (at, label) VALUES ($1, $2)", [1, "x"]);
        await s.exec("INSERT INTO parity (at, label) VALUES ($1, $2)", [2, "y"]);
        const rows = await s.query<{ m: unknown }>(
          `SELECT GREATEST(
             COALESCE((SELECT MAX(id) FROM parity WHERE label = 'x'), 0),
             COALESCE((SELECT MAX(id) FROM parity WHERE label = 'y'), 0)
           )::float8 AS m`);
        expect(rows[0]?.m).toBe(2);
        expect(typeof rows[0]?.m).toBe("number");
        // Empty table ⇒ 0, not null: the COALESCE legs are what make the
        // cold-start cache key a number rather than NaN.
        await reset();
        const empty = await s.query<{ m: unknown }>(
          `SELECT GREATEST(
             COALESCE((SELECT MAX(id) FROM parity WHERE label = 'x'), 0),
             COALESCE((SELECT MAX(id) FROM parity WHERE label = 'y'), 0)
           )::float8 AS m`);
        expect(empty[0]?.m).toBe(0);
      });

      test("BOOLEAN columns come back as real JS booleans (no 0/1 coercion left)", async () => {
        await reset();
        await s.exec("INSERT INTO parity (at, flag) VALUES ($1, $2)", [1, true]);
        await s.exec("INSERT INTO parity (at, flag) VALUES ($1, $2)", [2, false]);
        const rows = await s.query<{ flag: unknown }>("SELECT flag FROM parity ORDER BY id ASC");
        expect(rows[0]?.flag).toBe(true);
        expect(rows[1]?.flag).toBe(false);
      });

      test("jsonb bound via ::text::jsonb round-trips as an OBJECT (register frontmatter/attach, 2026-08-02)", async () => {
        // Live-found on the real driver: a bare `$n::jsonb` cast makes Bun.sql
        // infer the param as jsonb and JSON-encode the ALREADY-stringified
        // payload — storing a jsonb string scalar ('"{...}"') that the read
        // path degrades to {}. PGlite binds the same param as text, so only
        // the real-PG leg of this suite could ever catch it. `::text::jsonb`
        // pins the param to text on both drivers; this is the write shape the
        // register insert sites use.
        await s.exec("CREATE TABLE IF NOT EXISTS parity_jsonb (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, doc JSONB NOT NULL)");
        await s.exec("DELETE FROM parity_jsonb");
        await s.exec("INSERT INTO parity_jsonb (doc) VALUES ($1::text::jsonb)",
          [JSON.stringify({ roles: ["implementer"], projects: [] })]);
        const rows = await s.query<{ t: unknown; roles: unknown }>(
          "SELECT jsonb_typeof(doc) AS t, doc->'roles'->>0 AS roles FROM parity_jsonb");
        expect(rows[0]?.t).toBe("object");
        expect(rows[0]?.roles).toBe("implementer");
      });

      test("stage_transcript batch shape: multi-row VALUES with body ::text::jsonb round-trips jsonb_typeof='object' + GIN containment (issue #11)", async () => {
        // The EXACT write shape db.ts's writeTranscriptBatch uses: a multi-row
        // INSERT where every body param binds `::text::jsonb`. Under the real
        // Bun driver a bare `::jsonb` bind would jsonb-encode the
        // pre-stringified string into a jsonb STRING SCALAR (live-found
        // 2026-08-02, cost a HIGH) — jsonb_typeof pins the object shape on
        // BOTH drivers, and the @> containment probe proves the GIN-indexable
        // query surface actually works against what was stored.
        await s.exec(`CREATE TABLE IF NOT EXISTS parity_transcript (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          body JSONB NOT NULL)`);
        await s.exec("CREATE INDEX IF NOT EXISTS parity_transcript_body ON parity_transcript USING GIN (body)");
        await s.exec("DELETE FROM parity_transcript");
        await s.exec(
          "INSERT INTO parity_transcript (seq, kind, body) VALUES ($1, $2, $3::text::jsonb), ($4, $5, $6::text::jsonb)",
          [1, "tool_use", JSON.stringify({ tool: "Bash", input: { command: "bun test" } }),
           2, "result", JSON.stringify({ subtype: "success", ok: true })]);
        const rows = await s.query<{ t: unknown; cmd: unknown }>(
          "SELECT jsonb_typeof(body) AS t, body->'input'->>'command' AS cmd FROM parity_transcript ORDER BY id ASC");
        expect(rows.map((r) => r.t)).toEqual(["object", "object"]);
        expect(rows[0]?.cmd).toBe("bun test");
        // The query surface the GIN index exists for — containment on the object.
        const contained = await s.query<{ n: unknown }>(
          "SELECT COUNT(*)::int AS n FROM parity_transcript WHERE body @> $1::text::jsonb",
          [JSON.stringify({ subtype: "success" })]);
        expect(contained[0]?.n).toBe(1);
      });

      test("the migrate() repair unwraps a double-encoded jsonb string scalar", async () => {
        // The damaged shape rows written before the fix hold, then the exact
        // repair expression migrate() ships: (col #>> '{}')::jsonb guarded by
        // jsonb_typeof = 'string'. Idempotent — a second pass matches nothing.
        await s.exec("CREATE TABLE IF NOT EXISTS parity_jsonb (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, doc JSONB NOT NULL)");
        await s.exec("DELETE FROM parity_jsonb");
        await s.exec("INSERT INTO parity_jsonb (doc) VALUES (to_jsonb($1::text))",
          [JSON.stringify({ roles: ["fixer"] })]);
        const before = await s.query<{ t: unknown }>("SELECT jsonb_typeof(doc) AS t FROM parity_jsonb");
        expect(before[0]?.t).toBe("string"); // the damaged shape, reproduced deliberately
        for (let i = 0; i < 2; i++) { // twice: the repair must be idempotent
          await s.exec(`UPDATE parity_jsonb SET doc = (doc #>> '{}')::jsonb
            WHERE jsonb_typeof(doc) = 'string' AND left(doc #>> '{}', 1) = '{'`);
        }
        const after = await s.query<{ t: unknown; roles: unknown }>(
          "SELECT jsonb_typeof(doc) AS t, doc->'roles'->>0 AS roles FROM parity_jsonb");
        expect(after[0]?.t).toBe("object");
        expect(after[0]?.roles).toBe("fixer");
      });

      test("issue #11 w2: the three migrated columns' WRITE SHAPES round-trip jsonb_typeof='object' via ::text::jsonb", async () => {
        // The exact bind shapes db.ts now uses for events.json (multi-row
        // batch — writeBatch), merge_shadow_log.evidence_json and
        // approvals.gate_summary_json (single-row inserts). A bare `::jsonb`
        // bind under the real Bun driver would store a jsonb STRING SCALAR
        // (live-found 2026-08-02); jsonb_typeof pins the object shape on BOTH
        // drivers, and ->> proves the query surface works against what landed.
        await s.exec("DROP TABLE IF EXISTS parity_mig");
        await s.exec(`CREATE TABLE parity_mig (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          kind TEXT NOT NULL, doc JSONB)`);
        // events batch shape: multi-row VALUES, every json param ::text::jsonb.
        await s.exec(
          "INSERT INTO parity_mig (kind, doc) VALUES ($1, $2::text::jsonb), ($3, $4::text::jsonb)",
          ["events", JSON.stringify({ type: "run_finished", outcome: "pr_open", costUsd: 1.25 }),
           "events", JSON.stringify({ type: "run_stage_finished", stage: "implementer" })]);
        // evidence/gate-summary shape: single row, nullable column, same bind.
        await s.exec("INSERT INTO parity_mig (kind, doc) VALUES ($1, $2::text::jsonb)",
          ["evidence", JSON.stringify({ gatesGreen: true, strength: "real" })]);
        await s.exec("INSERT INTO parity_mig (kind, doc) VALUES ($1, $2::text::jsonb)",
          ["gate_summary", JSON.stringify({ green: true, strength: "strong", tests: [{ name: "bun test", from: 631, to: 640 }] })]);
        // NULL through the same cast (insertApproval binds null when no summary).
        await s.exec("INSERT INTO parity_mig (kind, doc) VALUES ($1, $2::text::jsonb)", ["gate_summary", null]);

        const rows = await s.query<{ kind: string; t: unknown }>(
          "SELECT kind, jsonb_typeof(doc) AS t FROM parity_mig WHERE doc IS NOT NULL ORDER BY id ASC");
        expect(rows.map((r) => r.t)).toEqual(["object", "object", "object", "object"]);
        const probe = await s.query<{ outcome: unknown; n: unknown }>(
          "SELECT doc->>'outcome' AS outcome, (doc->>'costUsd')::float8 AS n FROM parity_mig WHERE kind = 'events' AND doc->>'type' = 'run_finished'");
        expect(probe[0]?.outcome).toBe("pr_open");
        expect(probe[0]?.n).toBe(1.25);
        const nested = await s.query<{ v: unknown }>(
          "SELECT doc->'tests'->0->>'name' AS v FROM parity_mig WHERE kind = 'gate_summary' AND doc IS NOT NULL");
        expect(nested[0]?.v).toBe("bun test");
        const nulls = await s.query<{ n: unknown }>(
          "SELECT COUNT(*)::int AS n FROM parity_mig WHERE kind = 'gate_summary' AND doc IS NULL");
        expect(nulls[0]?.n).toBe(1);
      });

      test("issue #11 w2: TEXT→jsonb migration statement shape — ALTER ... USING, quarantine fallback, idempotent", async () => {
        // The exact migration pattern db.ts's DO blocks run for events.json /
        // evidence_json / gate_summary_json, replayed on a scratch table with
        // a deliberately unparseable legacy row: the ALTER fails, the row scan
        // quarantines the bad row (raw preserved, source nulled), the retried
        // ALTER succeeds, and a second pass is a no-op (data_type probe).
        await s.exec("DROP TABLE IF EXISTS parity_mig");
        await s.exec("DROP TABLE IF EXISTS parity_mig_quarantine");
        await s.exec(`CREATE TABLE parity_mig (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, doc TEXT)`);
        await s.exec(`CREATE TABLE parity_mig_quarantine (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          src_table TEXT NOT NULL, src_id BIGINT NOT NULL, raw TEXT, at BIGINT NOT NULL)`);
        await s.exec("INSERT INTO parity_mig (doc) VALUES ($1)", [JSON.stringify({ ok: 1 })]);
        await s.exec("INSERT INTO parity_mig (doc) VALUES ($1)", ["not json {{{"]);
        await s.exec("INSERT INTO parity_mig (doc) VALUES ($1)", [null]);

        const MIGRATE = `DO $mig$
          DECLARE bad RECORD;
          BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = current_schema() AND table_name = 'parity_mig'
                         AND column_name = 'doc' AND data_type = 'text') THEN
              BEGIN
                ALTER TABLE parity_mig ALTER COLUMN doc TYPE jsonb USING doc::jsonb;
              EXCEPTION WHEN OTHERS THEN
                FOR bad IN SELECT id::bigint AS id, doc::text AS raw FROM parity_mig WHERE doc IS NOT NULL LOOP
                  BEGIN
                    PERFORM bad.raw::jsonb;
                  EXCEPTION WHEN OTHERS THEN
                    INSERT INTO parity_mig_quarantine (src_table, src_id, raw, at)
                    VALUES ('parity_mig', bad.id, bad.raw, (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT);
                    UPDATE parity_mig SET doc = NULL WHERE id = bad.id;
                  END;
                END LOOP;
                ALTER TABLE parity_mig ALTER COLUMN doc TYPE jsonb USING doc::jsonb;
              END;
            END IF;
          END $mig$`;
        for (let pass = 0; pass < 2; pass++) await s.exec(MIGRATE); // twice: idempotent

        const type = await s.query<{ t: unknown }>(
          "SELECT data_type AS t FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'parity_mig' AND column_name = 'doc'");
        expect(type[0]?.t).toBe("jsonb");
        const good = await s.query<{ t: unknown; ok: unknown }>(
          "SELECT jsonb_typeof(doc) AS t, (doc->>'ok')::int AS ok FROM parity_mig WHERE id = 1");
        expect(good[0]?.t).toBe("object");
        expect(good[0]?.ok).toBe(1);
        // The bad row: moved aside (raw preserved), source nulled — never crashed.
        const quarantined = await s.query<{ src_id: unknown; raw: unknown }>(
          "SELECT src_id::float8 AS src_id, raw FROM parity_mig_quarantine ORDER BY id ASC");
        expect(quarantined.length).toBe(1); // idempotent: the second pass added nothing
        expect(quarantined[0]?.src_id).toBe(2);
        expect(quarantined[0]?.raw).toBe("not json {{{");
        const nulled = await s.query<{ doc: unknown }>("SELECT doc::text AS doc FROM parity_mig WHERE id = 2");
        expect(nulled[0]?.doc).toBeNull();
      });

      test("DOUBLE PRECISION keeps cents across a sum (why cost_usd is not REAL)", async () => {
        await reset();
        for (let i = 0; i < 3; i++) await s.exec("INSERT INTO parity (at, cost) VALUES ($1, $2)", [i, 0.01]);
        const rows = await s.query<{ total: unknown }>("SELECT SUM(cost)::float8 AS total FROM parity");
        expect(typeof rows[0]?.total).toBe("number");
        expect(rows[0]?.total as number).toBeCloseTo(0.03, 10);
      });

      test("INSERT ... RETURNING id::float8 yields the new id as a number", async () => {
        // This is exactly how insertApproval replaced SQLite's lastInsertRowid.
        await reset();
        const rows = await s.query<{ id: unknown }>(
          "INSERT INTO parity (at, label) VALUES ($1, $2) RETURNING id::float8 AS id", [1, "z"]);
        expect(rows[0]?.id).toBe(1);
        const second = await s.query<{ id: unknown }>(
          "INSERT INTO parity (at, label) VALUES ($1, $2) RETURNING id::float8 AS id", [2, "z2"]);
        expect(second[0]?.id).toBe(2);
      });

      test("DELETE ... RETURNING hands back the deleted row (atomic take)", async () => {
        // takePushbackFeedback's exactly-once handoff is this one statement.
        await reset();
        await s.exec("INSERT INTO parity (at, label) VALUES ($1, $2)", [1, "directive"]);
        const first = await s.query<{ label: string }>(
          "DELETE FROM parity WHERE at = $1 RETURNING label", [1]);
        expect(first[0]?.label).toBe("directive");
        const second = await s.query<{ label: string }>(
          "DELETE FROM parity WHERE at = $1 RETURNING label", [1]);
        expect(second.length).toBe(0);   // consumed exactly once
      });

      test("COUNT(*) OVER ()::int is the pre-LIMIT total (approvals badge/list snapshot)", async () => {
        await reset();
        for (let i = 0; i < 5; i++) await s.exec("INSERT INTO parity (at, label) VALUES ($1, $2)", [i, `l${i}`]);
        const rows = await s.query<{ total: unknown }>(
          "SELECT label, COUNT(*) OVER ()::int AS total FROM parity ORDER BY id DESC LIMIT $1", [2]);
        expect(rows.length).toBe(2);        // the capped page
        expect(rows[0]?.total).toBe(5);     // the TRUE pending count
      });

      test("RESTART IDENTITY really restarts the sequence (tests assert on ids)", async () => {
        await reset();
        const a = await s.query<{ id: unknown }>(
          "INSERT INTO parity (at) VALUES ($1) RETURNING id::float8 AS id", [1]);
        expect(a[0]?.id).toBe(1);
        await s.exec("TRUNCATE parity RESTART IDENTITY");
        const b = await s.query<{ id: unknown }>(
          "INSERT INTO parity (at) VALUES ($1) RETURNING id::float8 AS id", [1]);
        expect(b[0]?.id).toBe(1);
      });
    });

    describe("the raw exec() shape both adapters must normalise", () => {
      // Bun returns [] from a non-RETURNING write, carrying `.count`; PGlite
      // returns { rows, fields, affectedRows }. store.ts normalises both to a
      // plain number, and claimApproval's double-click guard is `changed > 0` —
      // so this number being right is a governance property, not a detail.
      test("exec() returns the affected-row count for UPDATE", async () => {
        await reset();
        for (let i = 0; i < 3; i++) await s.exec("INSERT INTO parity (at, label) VALUES ($1, $2)", [i, "pending"]);
        const changed = await s.exec("UPDATE parity SET label = $1 WHERE label = $2", ["done", "pending"]);
        expect(changed).toBe(3);
        const again = await s.exec("UPDATE parity SET label = $1 WHERE label = $2", ["done", "pending"]);
        expect(again).toBe(0);   // the losing side of a concurrent claim
      });

      test("exec() returns the affected-row count for DELETE and INSERT", async () => {
        await reset();
        const inserted = await s.exec("INSERT INTO parity (at, label) VALUES ($1, $2)", [1, "a"]);
        expect(inserted).toBe(1);
        const deleted = await s.exec("DELETE FROM parity WHERE label = $1", ["a"]);
        expect(deleted).toBe(1);
        const noop = await s.exec("DELETE FROM parity WHERE label = $1", ["a"]);
        expect(noop).toBe(0);
      });

      test("partial unique index — the registers' exactly-one-active invariant (issue #16)", async () => {
        // agent_register/skill_register enforce "exactly one ACTIVE version per
        // name" with `CREATE UNIQUE INDEX ... (name) WHERE enabled` plus
        // UNIQUE(name, version). Both drivers must (a) REJECT a second active
        // row, (b) accept any number of disabled versions, and (c) let the
        // deactivate-then-activate claim pattern converge — the discipline
        // insertAgentRegisterVersion / setRegisterEnabled are built on.
        await s.exec(`CREATE TABLE IF NOT EXISTS parity_reg (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          name TEXT NOT NULL,
          version INTEGER NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          UNIQUE (name, version))`);
        await s.exec("CREATE UNIQUE INDEX IF NOT EXISTS parity_reg_active ON parity_reg(name) WHERE enabled");
        await s.exec("DELETE FROM parity_reg");

        await s.exec("INSERT INTO parity_reg (name, version, enabled) VALUES ($1, $2, TRUE)", ["card", 1]);
        // (a) a second ACTIVE version is a loud conflict, not a second row.
        await expect(
          s.exec("INSERT INTO parity_reg (name, version, enabled) VALUES ($1, $2, TRUE)", ["card", 2]),
        ).rejects.toThrow();
        // (a') flipping a disabled row active while another is active — same.
        await s.exec("INSERT INTO parity_reg (name, version, enabled) VALUES ($1, $2, FALSE)", ["card", 2]);
        await expect(
          s.exec("UPDATE parity_reg SET enabled = TRUE WHERE name = $1 AND version = $2", ["card", 2]),
        ).rejects.toThrow();
        // (b) UNIQUE(name, version) — append-only versions can never collide.
        await expect(
          s.exec("INSERT INTO parity_reg (name, version, enabled) VALUES ($1, $2, FALSE)", ["card", 2]),
        ).rejects.toThrow();
        // (c) the claim pattern: deactivate the rest, then activate the target.
        const off = await s.exec("UPDATE parity_reg SET enabled = FALSE WHERE name = $1 AND enabled AND version <> $2", ["card", 2]);
        expect(off).toBe(1);
        const on = await s.exec("UPDATE parity_reg SET enabled = TRUE WHERE name = $1 AND version = $2", ["card", 2]);
        expect(on).toBe(1);
        const active = await s.query<{ version: unknown }>(
          "SELECT version::int AS version FROM parity_reg WHERE name = $1 AND enabled", ["card"]);
        expect(active.length).toBe(1);
        expect(active[0]?.version).toBe(2);
        // A different NAME is untouched by the index.
        await s.exec("INSERT INTO parity_reg (name, version, enabled) VALUES ($1, $2, TRUE)", ["other", 1]);
      });

      test("atomic register swap — a data-modifying CTE is one statement on both drivers", async () => {
        // insertAgentRegisterVersion / setRegisterEnabled run deactivate +
        // insert (or demote + activate) as ONE statement via a data-modifying
        // CTE, so a failure anywhere leaves the register's active row standing.
        // Both drivers must (a) execute the CTE before the main statement,
        // (b) report the MAIN statement's affected count from exec(), and
        // (c) roll the CTE's update back when the main statement fails.
        await s.exec("DELETE FROM parity_reg");
        await s.exec("INSERT INTO parity_reg (name, version, enabled) VALUES ($1, $2, TRUE)", ["card", 1]);
        await s.exec("INSERT INTO parity_reg (name, version, enabled) VALUES ($1, $2, FALSE)", ["card", 2]);

        // (a)+(b): demote-then-activate in one statement; exec() must report
        // the OUTER update's count — setRegisterEnabled returns `changed > 0`.
        const swapped = await s.exec(
          `WITH demoted AS (
             UPDATE parity_reg SET enabled = FALSE WHERE name = $1 AND enabled AND version <> $2 RETURNING id
           )
           UPDATE parity_reg SET enabled = TRUE WHERE name = $1 AND version = $2 AND (SELECT COUNT(*) FROM demoted) >= 0`,
          ["card", 2]);
        expect(swapped).toBe(1);
        const active = await s.query<{ version: unknown }>(
          "SELECT version::int AS version FROM parity_reg WHERE name = $1 AND enabled", ["card"]);
        expect(active.map((r) => r.version)).toEqual([2]);

        // (c): a failing INSERT (NUL byte in TEXT — a genuine server-side
        // error) must roll back the CTE's deactivate with it.
        await expect(s.query(
          `WITH deactivated AS (
             UPDATE parity_reg SET enabled = FALSE WHERE name = $1 AND enabled RETURNING id
           )
           INSERT INTO parity_reg (name, version, enabled)
           SELECT $2, 1, TRUE WHERE (SELECT COUNT(*) FROM deactivated) >= 0
           RETURNING id::float8 AS id`,
          ["card", `bad${String.fromCharCode(0)}name`]),
        ).rejects.toThrow();
        const survivor = await s.query<{ version: unknown }>(
          "SELECT version::int AS version FROM parity_reg WHERE name = $1 AND enabled", ["card"]);
        expect(survivor.map((r) => r.version)).toEqual([2]); // still active — nothing half-applied
      });

      test("ON CONFLICT DO NOTHING reports 0 affected — restorePushbackFeedback's contract", async () => {
        // restorePushbackFeedback returns `changed > 0`: a restore must never
        // overwrite a NEWER directive the owner recorded during the run. The
        // same shape is claimDeploy's exactly-once INSERT ... DO NOTHING guard.
        await reset();
        await s.exec("CREATE TABLE IF NOT EXISTS parity_pk (k TEXT PRIMARY KEY, v TEXT)");
        await s.exec("DELETE FROM parity_pk");
        const first = await s.exec("INSERT INTO parity_pk (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING", ["FAC-1", "new"]);
        expect(first).toBe(1);
        const second = await s.exec("INSERT INTO parity_pk (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING", ["FAC-1", "stale"]);
        expect(second).toBe(0);
        const rows = await s.query<{ v: string }>("SELECT v FROM parity_pk WHERE k = $1", ["FAC-1"]);
        expect(rows[0]?.v).toBe("new");   // the newer directive won
      });
    });

    extras?.(getStore);
  });
}
