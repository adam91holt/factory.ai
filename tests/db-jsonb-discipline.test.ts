// Machine-enforced jsonb read/write discipline over src/db.ts's SQL — the
// sibling of tests/db-cast-discipline.test.ts, for the OTHER measured driver
// divergence: a raw jsonb column comes back as a STRING from Bun's client and
// a parsed OBJECT from PGlite, and a `$n::jsonb` bind makes the Bun driver
// jsonb-encode a pre-stringified param into a jsonb string scalar (live-found
// 2026-08-02, cost a HIGH).
//
// Three rules, all lintable:
//   1. READ: every projection of a jsonb column carries `::text` (then the
//      central store.ts helper parses it), unless the SQL itself consumes the
//      column server-side (`->`/`->>`/`#>>`/`jsonb_typeof(`/`@>`).
//   2. PARSE ONCE, CENTRALLY: no caller anywhere in src/ JSON.parses a row's
//      jsonb field — store.ts's jsonbValue/jsonbObject are the ONE seam.
//   3. WRITE: a bound parameter is never cast `$n::jsonb` directly — always
//      `$n::text::jsonb`.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const DB_SOURCE = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
const STORE_SOURCE = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");

/** The jsonb columns of the store (issue #11): the three migrated ones, the
 *  transcript body, and the two register columns. */
const JSONB_COLUMNS = ["json", "evidence_json", "gate_summary_json", "body", "frontmatter", "attach"];

/** Server-side consumption markers — a projection item carrying one of these
 *  never reaches JS as a raw jsonb value. */
const SERVER_SIDE = ["->>", "->", "#>>", "jsonb_typeof(", "@>"];

// --- the same compact SQL-literal scanner the cast lint uses -----------------

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function constValue(source: string, name: string): string {
  const m = new RegExp(`const ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(source);
  if (!m) throw new Error(`db.ts no longer declares ${name} as a double-quoted const — update this lint`);
  return m[1] ?? "";
}

function literals(src: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2] ?? "");
  return out;
}

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

/** Projections of the OUTERMOST SELECT/RETURNING statements in one literal
 *  (nested subqueries are governed by their outer expression — same policy as
 *  the cast lint). */
function projections(literal: string): string[] {
  const out: string[] = [];
  for (const kw of ["SELECT", "RETURNING"]) {
    const re = new RegExp(`\\b${kw}\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(literal)) !== null) {
      let depth = 0;
      for (let i = 0; i < m.index; i++) {
        if (literal[i] === "(") depth += 1;
        else if (literal[i] === ")") depth -= 1;
      }
      if (depth > 0) continue;
      const body = literal.slice(m.index + kw.length);
      let d = 0;
      let end = body.length;
      for (let i = 0; i < body.length; i++) {
        const c = body[i] ?? "";
        if (c === "(") d += 1;
        else if (c === ")") d -= 1;
        else if (d === 0 && kw === "SELECT" && /\s/.test(c) && /^FROM\b/i.test(body.slice(i + 1))) { end = i; break; }
      }
      out.push(body.slice(0, end).trim());
    }
  }
  return out;
}

/** Offending items: reference a jsonb column, are not consumed server-side,
 *  and lack the `::text` projection. */
function jsonbOffenders(literal: string): string[] {
  const out: string[] = [];
  for (const list of projections(literal)) {
    for (const item of splitTopLevel(list)) {
      const source = item.split(/\s+AS\s+/i)[0] ?? item;
      if (!JSONB_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(source))) continue;
      if (SERVER_SIDE.some((s) => source.includes(s))) continue;
      if (/::text\b/.test(source)) continue;
      out.push(item.replace(/\s+/g, " "));
    }
  }
  return out;
}

const CLEAN = stripComments(DB_SOURCE);
const INTERPOLATED = ["LESSON_COLUMNS", "APPROVAL_COLUMNS", "TEST_TABLES", "PROJECT_COLUMNS", "POLICY_COLUMNS", "PROJECT_AUDIT_COLUMNS", "AGENT_REGISTER_COLUMNS", "SKILL_REGISTER_COLUMNS", "TRANSCRIPT_COLUMNS"];
const SQL_LITERALS = literals(CLEAN)
  .map((l) => {
    let out = l;
    for (const name of INTERPOLATED) out = out.replaceAll("${" + name + "}", constValue(DB_SOURCE, name));
    return out;
  })
  .filter((l) => /\b(SELECT|RETURNING)\b/.test(l));

describe("db.ts jsonb READ discipline (rule 1: project ::text or consume server-side)", () => {
  test("the extractor still sees the jsonb reads at all (guards against a vacuous pass)", () => {
    expect(SQL_LITERALS.some((l) => l.includes("json::text AS json"))).toBe(true);
    expect(SQL_LITERALS.some((l) => l.includes("body::text AS body"))).toBe(true);
    expect(SQL_LITERALS.some((l) => l.includes("gate_summary_json::text AS gate_summary_json"))).toBe(true);
    expect(SQL_LITERALS.some((l) => l.includes("frontmatter::text AS frontmatter"))).toBe(true);
  });

  test("no projection hands a raw jsonb column to JS", () => {
    const offenders = SQL_LITERALS.flatMap((l) =>
      jsonbOffenders(l).map((item) => `\`${item}\` in: ${l.replace(/\s+/g, " ").slice(0, 120)}`));
    expect(offenders).toEqual([]);
  });

  test("the lint actually fires on a raw jsonb projection, and not on the sanctioned shapes", () => {
    expect(jsonbOffenders("SELECT json FROM events WHERE issue_key = $1")).toEqual(["json"]);
    expect(jsonbOffenders("SELECT type, json FROM events")).toEqual(["json"]);
    expect(jsonbOffenders("SELECT json::text AS json FROM events")).toEqual([]);
    expect(jsonbOffenders("SELECT jsonb_typeof(json) AS t FROM events")).toEqual([]);
    expect(jsonbOffenders("SELECT json->>'repo' AS repo FROM events")).toEqual([]);
    // WHERE/ORDER BY mentions are out of scope, exactly like the cast lint.
    expect(jsonbOffenders("SELECT id::float8 AS id FROM events WHERE json IS NOT NULL ORDER BY id")).toEqual([]);
  });
});

describe("src/ jsonb PARSE discipline (rule 2: only store.ts parses a jsonb field)", () => {
  test("no JSON.parse of a row's jsonb column property anywhere in src/", () => {
    const offending: string[] = [];
    const columnAlt = JSONB_COLUMNS.join("|");
    // `JSON.parse(<expr>.json)` / `.body` / ... — property access is what makes
    // it a ROW FIELD; bare identifiers (request bodies, file lines) stay legal.
    const re = new RegExp(`JSON\\.parse\\(\\s*[A-Za-z_$][\\w$.]*\\.(?:${columnAlt})\\b`, "g");
    for (const file of readdirSync(new URL("../src", import.meta.url))) {
      if (!file.endsWith(".ts")) continue;
      const src = stripComments(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
      if (re.test(src)) offending.push(file);
      re.lastIndex = 0;
    }
    expect(offending).toEqual([]);
  });

  test("the central helpers live in store.ts and db.ts imports them (never a local reimplementation)", () => {
    expect(STORE_SOURCE).toContain("export function jsonbValue");
    expect(STORE_SOURCE).toContain("export function jsonbObject");
    expect(/import\s*\{[^}]*jsonbValue[^}]*\}\s*from\s*"\.\/store\.ts"/.test(DB_SOURCE.replace(/\n/g, " "))).toBe(true);
    expect(/import\s*\{[^}]*jsonbObject[^}]*\}\s*from\s*"\.\/store\.ts"/.test(DB_SOURCE.replace(/\n/g, " "))).toBe(true);
    expect(DB_SOURCE).not.toContain("function jsonbObject"); // no shadowing local copy
  });

  test("the parse-of-row-field detector actually fires", () => {
    const bad = 'const e = JSON.parse(r.json) as StageFinished;';
    expect(new RegExp(`JSON\\.parse\\(\\s*[A-Za-z_$][\\w$.]*\\.(?:${JSONB_COLUMNS.join("|")})\\b`).test(bad)).toBe(true);
    const fine = 'const b = JSON.parse(body) as unknown;';
    expect(new RegExp(`JSON\\.parse\\(\\s*[A-Za-z_$][\\w$.]*\\.(?:${JSONB_COLUMNS.join("|")})\\b`).test(fine)).toBe(false);
  });
});

describe("db.ts jsonb WRITE discipline (rule 3: params bind ::text::jsonb, never bare ::jsonb)", () => {
  test("no `$n::jsonb` bind anywhere in db.ts — the exact shape that stored string scalars on the real driver", () => {
    const bare = CLEAN.match(/\$\d+::jsonb\b/g) ?? [];
    expect(bare).toEqual([]);
  });

  test("the sanctioned write shape is present (guards against a vacuous pass)", () => {
    expect(CLEAN.includes("::text::jsonb")).toBe(true);
  });
});
