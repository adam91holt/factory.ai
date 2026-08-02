// Value-shape parity between the two Store implementations.
//
// WHY THIS FILE EXISTS. The obvious assumption — "Postgres is Postgres, so the
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
// So this file pins the CAST contract — the behaviour both drivers agree on —
// against the driver the suite actually runs, plus the two raw shapes the
// adapter has to normalise. Do NOT "simplify" the casts away: green tests here
// would not mean a green daemon.
//
// It boots its OWN PGlite engine rather than borrowing db.ts's seam, because it
// asserts on arbitrary SQL and db.ts's store handle is private by design
// (single-writer). One extra WASM boot, paid once for the file.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { pgliteStore, type Store } from "../src/store.ts";

let s: Store;

beforeAll(async () => {
  s = await pgliteStore();
  // Same column types db.ts's real DDL uses, so the shapes asserted below are
  // the shapes the daemon actually reads.
  await s.exec(`CREATE TABLE parity (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at BIGINT NOT NULL,
    flag BOOLEAN NOT NULL DEFAULT FALSE,
    cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0,
    label TEXT NOT NULL DEFAULT '')`);
});

afterAll(async () => { await s.close(); });

async function reset(): Promise<void> {
  await s.exec("TRUNCATE parity RESTART IDENTITY");
}

describe("Store parity — the cast contract db.ts depends on", () => {
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
    // Verbatim structure of computeTelemetry's watermark query, including the
    // GREATEST that replaced SQLite's 2-arg max(a, b).
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
    // Empty table ⇒ 0, not null: the COALESCE legs are what make the cold-start
    // cache key a number rather than NaN.
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

describe("Store parity — the one raw shape the two drivers disagree on", () => {
  // Bun returns [] from a non-RETURNING write, carrying `.count`; PGlite returns
  // { rows, fields, affectedRows }. store.ts normalises both to a plain number,
  // and claimApproval's double-click guard is `changed > 0` — so this number
  // being right is a governance property, not a detail.
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

  test("ON CONFLICT DO NOTHING reports 0 affected — restorePushbackFeedback's contract", async () => {
    // restorePushbackFeedback returns `changed > 0`: a restore must never
    // overwrite a NEWER directive the owner recorded during the run.
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

describe("Store parity — the divergence itself, recorded so nobody 'simplifies' the casts", () => {
  test("UNCAST BIGINT is where the two drivers part company", async () => {
    await reset();
    await s.exec("INSERT INTO parity (at) VALUES ($1)", [1785628979286]);
    const rows = await s.query<{ id: unknown; at: unknown }>("SELECT id, at FROM parity");
    // On PGlite (this engine) an uncast BIGINT is a number; on Bun's client
    // against a real server the SAME query returns "1" / "1785628979286".
    // The assertion below is therefore a RECORD of the measurement, not a
    // guarantee — it is the reason every numeric select in db.ts is cast and
    // every numeric column additionally passes through coerceNumeric().
    expect(typeof rows[0]?.id).toBe("number");
    expect(typeof rows[0]?.at).toBe("number");
  });
});
