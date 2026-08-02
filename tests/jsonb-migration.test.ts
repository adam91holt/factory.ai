// Issue #11 (jsonb half, w2): the three WP1-era TEXT columns — events.json,
// merge_shadow_log.evidence_json, approvals.gate_summary_json — become native
// jsonb, migrated IN PLACE by db.ts's DDL.
//
// What is pinned here, and why each pin is load-bearing:
//   1. REAL MIGRATION over a REAL legacy schema. A store created with WP1's
//      TEXT DDL (reproduced verbatim below) and seeded with legacy rows goes
//      through the actual exported migrate() — not a replica of it — and comes
//      out with jsonb columns, queryable with ->> and GIN-indexed.
//   2. QUARANTINE, NEVER CRASH. An unparseable legacy row is moved aside
//      (raw text preserved in jsonb_migration_quarantine, source nulled with a
//      warning) and migrate() still succeeds. Running migrate() again is a
//      no-op — idempotency is a catalog probe, not luck.
//   3. QUEUE WRITE PATH stores native jsonb OBJECTS (jsonb_typeof pin — the
//      read path's parse-if-string would mask a string-scalar regression; the
//      real-driver leg of the same shape lives in tests/store-parity-suite.ts).
//   4. READS COME BACK PARSED on both drivers — no caller JSON.parses a row
//      field (the grep lint in tests/db-jsonb-discipline.test.ts enforces the
//      source side; this file pins the runtime side).
//   5. jsonb WRITE HYGIENE: an event carrying \u0000 or a lone surrogate —
//      legal in TEXT, rejected by jsonb — is cleaned at enqueue instead of
//      failing its whole batch and flipping the governance gate.
//   6. project_activity view: issue → repo (from the issue's newest
//      repo-carrying event) → project_repos → project, the linkage the issue
//      promised once #7's projects entity landed.
//   7. GET /issue/:key/transcript pagination read: bounded, keyset-cursored,
//      capped by an in-code constant; safe (empty) on a closed store.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { pgliteStore, jsonbValue, jsonbObject, type Store } from "../src/store.ts";
import { bus } from "../src/events.ts";
import {
  migrate, openTestDatabase, closeTestDatabase, flushEvents,
  issueEvents, insertTestEvent, testEventJsonTypes, jsonbSafeStringify,
  insertApproval, getApproval, storeHealth,
  insertTestTranscriptRow, issueTranscriptPage, TRANSCRIPT_PAGE_MAX_ROWS,
} from "../src/db.ts";

// ---------------------------------------------------------------------------
// Legacy-schema end-to-end: WP1's TEXT DDL, seeded, then the REAL migrate().
// Boots its own engine (not the shared test seam) because the whole point is
// to start from a schema migrate() did NOT create.
// ---------------------------------------------------------------------------

/** The pre-#11 shapes of the three tables, verbatim from WP1's db.ts. */
const LEGACY_DDL = [
  `CREATE TABLE events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seq BIGINT, at BIGINT, type TEXT, issue_key TEXT, json TEXT)`,
  `CREATE TABLE merge_shadow_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at BIGINT, repo TEXT, issue_key TEXT,
    would_merge BOOLEAN, acted BOOLEAN, tier TEXT, reasons TEXT, evidence_json TEXT)`,
  `CREATE TABLE approvals (
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
];

async function columnType(s: Store, table: string, column: string): Promise<string> {
  const rows = await s.query<{ t: string }>(
    "SELECT data_type AS t FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
    [table, column]);
  return rows[0]?.t ?? "(missing)";
}

describe("legacy TEXT store through the real migrate()", () => {
  test("all three columns become jsonb; good rows survive queryable; bad rows quarantine; second migrate is a no-op", async () => {
    const s = await pgliteStore();
    try {
      for (const stmt of LEGACY_DDL) await s.exec(stmt);
      // Legacy rows written the WP1 way: plain TEXT binds.
      await s.exec("INSERT INTO events (seq, at, type, issue_key, json) VALUES ($1, $2, $3, $4, $5)",
        [1, 1000, "run_started", "FAC-1", JSON.stringify({ type: "run_started", issueKey: "FAC-1", repo: "owner/app", title: "t", dryRun: false })]);
      await s.exec("INSERT INTO events (seq, at, type, issue_key, json) VALUES ($1, $2, $3, $4, $5)",
        [2, 2000, "run_finished", "FAC-1", JSON.stringify({ type: "run_finished", issueKey: "FAC-1", outcome: "pr_open" })]);
      await s.exec("INSERT INTO events (seq, at, type, issue_key, json) VALUES ($1, $2, $3, $4, $5)",
        [3, 3000, "corrupt", "FAC-1", "definitely {not json"]);
      await s.exec(
        "INSERT INTO merge_shadow_log (at, repo, issue_key, would_merge, acted, tier, reasons, evidence_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [1000, "owner/app", "FAC-1", true, false, "shadow", "", JSON.stringify({ gatesGreen: true })]);
      await s.exec(
        "INSERT INTO merge_shadow_log (at, repo, issue_key, would_merge, acted, tier, reasons, evidence_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [2000, "owner/app", "FAC-2", false, false, "shadow", "", "<broken>"]);
      await s.exec(
        `INSERT INTO approvals (created_at, updated_at, issue_key, title, repo, pr_url, gate_summary_json)
         VALUES ($1, $1, $2, $3, $4, $5, $6)`,
        [1000, "FAC-1", "t", "owner/app", "https://example/pr/1", JSON.stringify({ green: true, strength: "real", tests: [] })]);

      await migrate(s); // the REAL DDL, including the DO-block migrations

      expect(await columnType(s, "events", "json")).toBe("jsonb");
      expect(await columnType(s, "merge_shadow_log", "evidence_json")).toBe("jsonb");
      expect(await columnType(s, "approvals", "gate_summary_json")).toBe("jsonb");

      // Good rows: native objects, queryable with the jsonb operators.
      const ev = await s.query<{ t: unknown; repo: unknown }>(
        "SELECT jsonb_typeof(json) AS t, json->>'repo' AS repo FROM events WHERE type = 'run_started'");
      expect(ev[0]?.t).toBe("object");
      expect(ev[0]?.repo).toBe("owner/app");
      const evd = await s.query<{ t: unknown }>(
        "SELECT jsonb_typeof(evidence_json) AS t FROM merge_shadow_log WHERE issue_key = 'FAC-1'");
      expect(evd[0]?.t).toBe("object");
      const gs = await s.query<{ green: unknown }>(
        "SELECT (gate_summary_json->>'green')::boolean AS green FROM approvals WHERE issue_key = 'FAC-1'");
      expect(gs[0]?.green).toBe(true);

      // Bad rows: quarantined with the raw text preserved, source nulled.
      const q = await s.query<{ src_table: string; raw: string | null }>(
        "SELECT src_table, raw FROM jsonb_migration_quarantine ORDER BY id ASC");
      expect(q.map((r) => r.src_table).sort()).toEqual(["events", "merge_shadow_log"]);
      expect(q.map((r) => r.raw).sort()).toEqual(["<broken>", "definitely {not json"]);
      const nulled = await s.query<{ json: unknown }>("SELECT json::text AS json FROM events WHERE type = 'corrupt'");
      expect(nulled[0]?.json).toBeNull();

      // GIN index on events.json exists (the query surface the issue mandates).
      const idx = await s.query<{ n: unknown }>(
        "SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_events_json'");
      expect(idx[0]?.n).toBe(1);

      // Idempotent: a second migrate() adds nothing to quarantine, changes no types.
      await migrate(s);
      const q2 = await s.query<{ n: unknown }>("SELECT COUNT(*)::int AS n FROM jsonb_migration_quarantine");
      expect(q2[0]?.n).toBe(2);
      expect(await columnType(s, "events", "json")).toBe("jsonb");
    } finally {
      await s.close();
    }
  });

  test("project_activity view joins issue → repo → project_repos → project", async () => {
    const s = await pgliteStore();
    try {
      await migrate(s);
      const now = Date.now();
      await s.exec("INSERT INTO projects (name, team, created_at, updated_at) VALUES ($1, $2, $3, $3)", ["fleet", "OPS", now]);
      await s.exec("INSERT INTO project_repos (project_id, repo) SELECT id, $1 FROM projects WHERE name = 'fleet'", ["owner/app"]);
      // The issue's repo comes from its newest repo-carrying event.
      await s.exec("INSERT INTO events (seq, at, type, issue_key, json) VALUES ($1, $2, $3, $4, $5::text::jsonb)",
        [1, 1000, "run_started", "FAC-7", JSON.stringify({ type: "run_started", issueKey: "FAC-7", repo: "owner/app" })]);
      await s.exec("INSERT INTO events (seq, at, type, issue_key, json) VALUES ($1, $2, $3, $4, $5::text::jsonb)",
        [2, 2000, "run_finished", "FAC-7", JSON.stringify({ type: "run_finished", issueKey: "FAC-7", outcome: "pr_open" })]);
      // An issue on an unmapped repo joins to nothing (no phantom project).
      await s.exec("INSERT INTO events (seq, at, type, issue_key, json) VALUES ($1, $2, $3, $4, $5::text::jsonb)",
        [3, 3000, "run_started", "FAC-8", JSON.stringify({ type: "run_started", issueKey: "FAC-8", repo: "owner/other" })]);

      const rows = await s.query<{ project: string; repo: string; issue_key: string; type: string }>(
        "SELECT project, repo, issue_key, type FROM project_activity ORDER BY event_id ASC");
      expect(rows.length).toBe(2); // BOTH FAC-7 events (even the repo-less one), zero FAC-8 rows
      expect(rows.every((r) => r.project === "fleet" && r.repo === "owner/app" && r.issue_key === "FAC-7")).toBe(true);
      expect(rows.map((r) => r.type)).toEqual(["run_started", "run_finished"]);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime behavior on the shared test seam (fresh jsonb schema).
// ---------------------------------------------------------------------------

describe("reads come back parsed; the queue stores objects", () => {
  beforeEach(async () => { await openTestDatabase({ subscribeBus: true }); });
  afterEach(async () => { await closeTestDatabase(); });

  test("events land as native jsonb OBJECTS through the write-behind queue", async () => {
    bus.emit({ type: "issue_needs_human", issueKey: "FAC-JB", reason: "why" });
    await flushEvents();
    expect(await testEventJsonTypes("FAC-JB")).toEqual(["object"]);
    const events = await issueEvents("FAC-JB") as Array<{ reason?: string }>;
    expect(events[0]?.reason).toBe("why"); // parsed object, no caller-side JSON.parse
    expect(storeHealth().dropped).toBe(0);
  });

  test("an event carrying \\u0000 and a lone surrogate still lands (cleaned), never dropping its batch", async () => {
    bus.emit({ type: "issue_needs_human", issueKey: "FAC-NUL",
      reason: `binary\u0000junk then a sliced pair: ${"😀".slice(0, 1)} end` });
    await flushEvents();
    expect(storeHealth().dropped).toBe(0); // the poisoned event did NOT kill the batch / flip the gate
    expect(await testEventJsonTypes("FAC-NUL")).toEqual(["object"]);
    const events = await issueEvents("FAC-NUL") as Array<{ reason?: string }>;
    expect(events[0]?.reason).toBe("binaryjunk then a sliced pair:  end");
  });

  test("gateSummary round-trips insertApproval → getApproval as a parsed object", async () => {
    const gateSummary = { green: true, strength: "real", tests: [{ name: "bun test", from: 631, to: 640 }] };
    const id = await insertApproval({
      issueKey: "FAC-GS", title: "t", repo: "owner/app", prUrl: "https://example/pr/9",
      gatedHeadSha: "abc123", holdReasons: "", gateSummary,
      securityVerdict: "none", tasteVerdict: "not-required", findingsDigest: "", diffStat: "",
      costUsd: 0.5, turns: 3, regateFailed: false,
    });
    expect(id).not.toBeNull();
    const item = await getApproval(id as number);
    expect(item?.gateSummary).toEqual(gateSummary);
    // And a null summary stays null (the nullable jsonb leg).
    const id2 = await insertApproval({
      issueKey: "FAC-GS2", title: "t", repo: "owner/app", prUrl: "https://example/pr/10",
      gatedHeadSha: "def456", holdReasons: "", gateSummary: null,
      securityVerdict: "none", tasteVerdict: "not-required", findingsDigest: "", diffStat: "",
      costUsd: 0, turns: 0, regateFailed: false,
    });
    expect((await getApproval(id2 as number))?.gateSummary).toBeNull();
  });

  test("insertTestEvent + issueEvents round-trip (the ::text::jsonb test seam)", async () => {
    await insertTestEvent("run_finished", { issueKey: "FAC-RT", outcome: "parked", reason: "cap" });
    const events = await issueEvents("FAC-RT") as Array<Record<string, unknown>>;
    expect(events.length).toBe(1);
    expect(events[0]?.outcome).toBe("parked");
    expect(typeof events[0]).toBe("object");
  });
});

describe("GET /issue/:key/transcript read — bounded keyset pagination", () => {
  beforeEach(async () => { await openTestDatabase(); });
  afterEach(async () => { await closeTestDatabase(); });

  test("pages walk the whole transcript in order via nextAfter; stage filter narrows", async () => {
    for (let i = 1; i <= 5; i++) {
      await insertTestTranscriptRow("FAC-PG", "implementer", "assistant_text", { n: i }, 1000 + i, i);
    }
    await insertTestTranscriptRow("FAC-PG", "fixer", "result", { ok: true }, 2000, 1);

    const p1 = await issueTranscriptPage("FAC-PG", { limit: 2 });
    expect(p1.rows.map((r) => r.body.n)).toEqual([1, 2]);
    expect(p1.nextAfter).toBe(p1.rows[1]!.id);
    const p2 = await issueTranscriptPage("FAC-PG", { afterId: p1.nextAfter!, limit: 2 });
    expect(p2.rows.map((r) => r.body.n)).toEqual([3, 4]);
    const p3 = await issueTranscriptPage("FAC-PG", { afterId: p2.nextAfter!, limit: 2 });
    expect(p3.rows.length).toBe(2); // n:5 + the fixer row
    expect(p3.nextAfter).toBeNull(); // exact boundary: no phantom next page
    const fixerOnly = await issueTranscriptPage("FAC-PG", { stage: "fixer" });
    expect(fixerOnly.rows.length).toBe(1);
    expect(fixerOnly.rows[0]!.body.ok).toBe(true);
  });

  test("the page size is capped by the in-code constant, whatever the caller asks", async () => {
    for (let i = 1; i <= TRANSCRIPT_PAGE_MAX_ROWS + 5; i++) {
      await insertTestTranscriptRow("FAC-CAPPED", "implementer", "assistant_text", { n: i }, 1000 + i, Math.min(i, 2000));
    }
    const page = await issueTranscriptPage("FAC-CAPPED", { limit: 1_000_000 });
    expect(page.rows.length).toBe(TRANSCRIPT_PAGE_MAX_ROWS);
    expect(page.nextAfter).not.toBeNull();
  });

  test("closed store: empty page, no throw", async () => {
    await closeTestDatabase();
    expect(await issueTranscriptPage("FAC-X")).toEqual({ rows: [], nextAfter: null });
    await openTestDatabase();
  });
});

describe("jsonbSafeStringify / central parse helpers", () => {
  test("clean payloads pass through byte-identically (fast path)", () => {
    const v = { a: 1, s: "plain ascii and 日本語 and 😀 pairs" };
    expect(jsonbSafeStringify(v)).toBe(JSON.stringify(v));
  });

  test("NUL and lone surrogates are stripped; paired surrogates survive", () => {
    const cleaned = JSON.parse(jsonbSafeStringify({
      s: `a\u0000b`, lone: "x" + "😀".slice(0, 1) + "y", pair: "😀",
      ["k\u0000ey"]: ["v\u0000", 1],
    })) as Record<string, unknown>;
    expect(cleaned.s).toBe("ab");
    expect(cleaned.lone).toBe("xy");
    expect(cleaned.pair).toBe("😀");
    expect(cleaned.key).toEqual(["v", 1]);
  });

  test("text that merely TALKS about the escapes is untouched semantically", () => {
    const v = { doc: "bind \\u0000 as ::text::jsonb" }; // literal backslash-u — a false-positive for the detector
    expect(JSON.parse(jsonbSafeStringify(v))).toEqual(v);
  });

  test("jsonbValue: parse-if-string once; jsonbObject: bounded double-parse to object", () => {
    expect(jsonbValue('{"a":1}')).toEqual({ a: 1 });
    expect(jsonbValue({ a: 1 })).toEqual({ a: 1 }); // PGlite's raw-jsonb shape passes through
    expect(jsonbValue("not json")).toBeNull();
    expect(jsonbObject('{"a":1}')).toEqual({ a: 1 });
    expect(jsonbObject('"{\\"a\\":1}"')).toEqual({ a: 1 }); // the damaged double-encoded scalar
    expect(jsonbObject("[1]")).toEqual({});
    expect(jsonbObject(null)).toEqual({});
  });
});
