// Machine-enforced cast discipline over src/db.ts's SQL.
//
// The rule this file exists to keep honest (see tests/store-parity.test.ts for
// the measurement behind it): Bun's Postgres client returns int8/BIGINT and
// COUNT()/MAX()/SUM() as JS **strings**, while PGlite returns them as
// **numbers**. So a numeric column selected WITHOUT an explicit ::float8 /
// ::int cast passes every unit test on the WASM engine and then hands
// "1785628979286" to arithmetic in production. Review cannot be relied on to
// catch that; a lint can.
//
// This is a STATIC test — it reads src/db.ts as text and inspects the select
// list of every SELECT (and every RETURNING clause) it can find. It deliberately
// looks only at the projection, never the whole statement: `ORDER BY id ASC`
// and `WHERE at >= $1` are perfectly fine uncast and are the reason a naive
// grep for "id" is useless here.
//
// The second half pins coerceNumeric(), the runtime safety net that makes a
// cast this lint somehow misses SLOW-but-correct instead of silently wrong.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { coerceNumeric } from "../src/db.ts";

const SOURCE = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");

/** Identifiers that are BIGINT (or otherwise diverge between the drivers) and
 *  are consumed as numbers in JS. Matched whole-word, so `session_id` and
 *  `gated_head_sha` are not mistaken for `id`/`at`. */
const NUMERIC_COLUMNS = ["id", "at", "seq", "created_at", "updated_at", "turns"];
/** Aggregates and window functions — always int8/numeric out of Postgres. */
const AGGREGATES = ["COUNT(", "MAX(", "MIN(", "SUM(", "AVG(", "GREATEST(", "LEAST("];
/** The two select lists db.ts builds from module constants. */
const INTERPOLATED = ["LESSON_COLUMNS", "APPROVAL_COLUMNS", "TEST_TABLES", "PROJECT_COLUMNS", "POLICY_COLUMNS", "PROJECT_AUDIT_COLUMNS"];

/** Strip line and block comments so prose that merely says "SELECT" is ignored.
 *  The `[^:]` guard keeps `https://` style text from being read as a comment. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Value of a `const NAME = "...";` declaration in db.ts. */
function constValue(name: string): string {
  const m = new RegExp(`const ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(SOURCE);
  if (!m) throw new Error(`db.ts no longer declares ${name} as a double-quoted const — update this lint`);
  return m[1] ?? "";
}

/** Every string/template literal in the (comment-free) source. */
function literals(src: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2] ?? "");
  return out;
}

/** Split a select list on TOP-LEVEL commas only (so GREATEST(a, b) is one item). */
function splitTopLevel(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) { items.push(list.slice(start, i)); start = i + 1; }
  }
  items.push(list.slice(start));
  return items.map((s) => s.trim()).filter((s) => s !== "");
}

interface Projection { kind: "SELECT" | "RETURNING"; list: string }

/** Projections of the OUTERMOST statements in one literal.
 *
 *  Nested SELECTs (paren depth > 0) are skipped on purpose: in the telemetry
 *  watermark the inner `MAX(id)` sits inside `GREATEST(...)::float8`, so the
 *  outer cast already governs it — flagging the subquery would be a false
 *  positive that could only be silenced by making the SQL worse. */
function projections(literal: string): Projection[] {
  const out: Projection[] = [];
  for (const kw of ["SELECT", "RETURNING"] as const) {
    const re = new RegExp(`\\b${kw}\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(literal)) !== null) {
      // Paren depth at this keyword — > 0 means it is a subquery.
      let depth = 0;
      for (let i = 0; i < m.index; i++) {
        if (literal[i] === "(") depth += 1;
        else if (literal[i] === ")") depth -= 1;
      }
      if (depth > 0) continue;

      // Walk to the top-level FROM (SELECT) / end of statement, tracking depth.
      const body = literal.slice(m.index + kw.length);
      let d = 0;
      let end = body.length;
      for (let i = 0; i < body.length; i++) {
        const c = body[i] ?? "";
        if (c === "(") d += 1;
        else if (c === ")") d -= 1;
        else if (d === 0 && kw === "SELECT" && /\s/.test(c) && /^FROM\b/i.test(body.slice(i + 1))) { end = i; break; }
      }
      out.push({ kind: kw, list: body.slice(0, end).trim() });
    }
  }
  return out;
}

function needsCast(item: string): boolean {
  if (AGGREGATES.some((a) => item.toUpperCase().includes(a))) return true;
  // Only look at the SOURCE side of `expr AS alias` — an alias named `id` on a
  // cast expression is exactly what correct code looks like.
  const source = item.split(/\s+AS\s+/i)[0] ?? item;
  return NUMERIC_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(source));
}

const hasCast = (item: string): boolean => /::(float8|int|integer|bigint|numeric|double precision)\b/i.test(item);

const CLEAN = stripComments(SOURCE);
const SQL_LITERALS = literals(CLEAN)
  .map((l) => {
    let out = l;
    for (const name of INTERPOLATED) out = out.replaceAll("${" + name + "}", constValue(name));
    return out;
  })
  .filter((l) => /\b(SELECT|RETURNING)\b/.test(l));

describe("db.ts cast discipline (static lint over the SQL)", () => {
  test("the extractor still finds db.ts's SQL at all (guards against a vacuous pass)", () => {
    // If a refactor moves the SQL somewhere this parser cannot see, every
    // assertion below would trivially pass over an empty list. Fail instead.
    expect(SQL_LITERALS.length).toBeGreaterThanOrEqual(12);
    const all = SQL_LITERALS.flatMap(projections);
    expect(all.length).toBeGreaterThanOrEqual(15);
    // And the two interpolated column lists really were resolved.
    expect(SQL_LITERALS.some((l) => l.includes("cost_usd::float8"))).toBe(true);
    expect(SQL_LITERALS.some((l) => l.includes("source_reason"))).toBe(true);
    expect(SQL_LITERALS.every((l) => !l.includes("${"))).toBe(true);
  });

  test("every numeric projection carries an explicit ::float8 / ::int cast", () => {
    const offenders: string[] = [];
    for (const literal of SQL_LITERALS) {
      for (const p of projections(literal)) {
        for (const item of splitTopLevel(p.list)) {
          if (needsCast(item) && !hasCast(item)) {
            offenders.push(`${p.kind} item \`${item.replace(/\s+/g, " ")}\` in: ${literal.replace(/\s+/g, " ").slice(0, 120)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the lint actually fires on an uncast numeric projection", () => {
    // Proof the rule is not vacuous — the exact regression it exists to catch.
    const bad = "SELECT id, at, json FROM events WHERE issue_key = $1 ORDER BY id ASC LIMIT $2";
    const flagged = projections(bad)
      .flatMap((p) => splitTopLevel(p.list))
      .filter((i) => needsCast(i) && !hasCast(i));
    expect(flagged).toEqual(["id", "at"]);

    const good = "SELECT id::float8 AS id, at::float8 AS at, json FROM events ORDER BY id ASC";
    expect(projections(good).flatMap((p) => splitTopLevel(p.list)).filter((i) => needsCast(i) && !hasCast(i))).toEqual([]);
  });

  test("known-good shapes are NOT false-positived", () => {
    const ok = [
      // ORDER BY / WHERE mention id and at — after FROM, so out of scope.
      "SELECT json FROM events WHERE issue_key = $1 ORDER BY id ASC LIMIT $2",
      "SELECT json FROM events WHERE type = 'run_finished' AND at >= $1",
      // A literal 1 probe consumed via rows.length, never as a number.
      "SELECT 1 AS n FROM deploys WHERE repo = $1 AND sha = $2",
      // session_id must not read as `id`.
      "SELECT session_id FROM stage_sessions WHERE issue_key = $1 AND stage = $2",
      // The watermark: the inner MAX(id) is governed by the outer cast.
      `SELECT GREATEST(
         COALESCE((SELECT MAX(id) FROM events WHERE type = 'run_stage_finished'), 0),
         COALESCE((SELECT MAX(id) FROM events WHERE type = 'run_finished'), 0)
       )::float8 AS m`,
      "DELETE FROM pushback_feedback WHERE issue_key = $1 RETURNING feedback",
    ];
    for (const stmt of ok) {
      const flagged = projections(stmt).flatMap((p) => splitTopLevel(p.list)).filter((i) => needsCast(i) && !hasCast(i));
      expect(flagged).toEqual([]);
    }
  });
});

describe("coerceNumeric — the runtime safety net under the casts", () => {
  test("accepts the numeric STRINGS Bun's client returns for uncast int8", () => {
    expect(coerceNumeric("1785628979286")).toBe(1785628979286);
    expect(coerceNumeric("1")).toBe(1);
    expect(coerceNumeric("0")).toBe(0);
    expect(coerceNumeric("1.25")).toBe(1.25);
    expect(coerceNumeric("-3")).toBe(-3);
  });

  test("passes finite numbers through unchanged", () => {
    expect(coerceNumeric(42)).toBe(42);
    expect(coerceNumeric(0.5)).toBe(0.5);
    expect(coerceNumeric(0)).toBe(0);
  });

  test("everything non-numeric folds to 0 — never NaN into an aggregate", () => {
    expect(coerceNumeric("nope")).toBe(0);
    expect(coerceNumeric("")).toBe(0);
    expect(coerceNumeric("   ")).toBe(0);
    expect(coerceNumeric(undefined)).toBe(0);
    expect(coerceNumeric(null)).toBe(0);
    expect(coerceNumeric(NaN)).toBe(0);
    expect(coerceNumeric(Infinity)).toBe(0);
    expect(coerceNumeric({})).toBe(0);
    expect(coerceNumeric(true)).toBe(0);
  });
});
