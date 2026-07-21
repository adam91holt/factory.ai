import { describe, expect, test } from "bun:test";
import { cronMatches, validateCron } from "../src/groundskeepers.ts";

// All dates are explicit local-time constructions (never argless `new Date()`)
// so the suite is deterministic on any machine at any wall-clock time.
// 2026-02-13 is a Friday (getDay() === 5); 2026-02-15 is a Sunday (0).
const d = (y: number, mo: number, day: number, h = 0, mi = 0): Date => new Date(y, mo - 1, day, h, mi);

describe("cronMatches", () => {
  test("wildcard-everything matches any minute", () => {
    expect(cronMatches("* * * * *", d(2026, 7, 15, 9, 30))).toBe(true);
    expect(cronMatches("* * * * *", d(2026, 1, 1, 0, 0))).toBe(true);
  });

  test("exact minute/hour match", () => {
    expect(cronMatches("30 9 * * *", d(2026, 7, 15, 9, 30))).toBe(true);
    expect(cronMatches("30 9 * * *", d(2026, 7, 15, 9, 31))).toBe(false);
    expect(cronMatches("30 9 * * *", d(2026, 7, 15, 10, 30))).toBe(false);
  });

  test("month field is 1-based (July = 7)", () => {
    expect(cronMatches("0 9 15 7 *", d(2026, 7, 15, 9, 0))).toBe(true);
    expect(cronMatches("0 9 15 6 *", d(2026, 7, 15, 9, 0))).toBe(false);
  });

  test("step values fire from 0", () => {
    expect(cronMatches("*/15 * * * *", d(2026, 7, 15, 9, 0))).toBe(true);
    expect(cronMatches("*/15 * * * *", d(2026, 7, 15, 9, 45))).toBe(true);
    expect(cronMatches("*/15 * * * *", d(2026, 7, 15, 9, 20))).toBe(false);
  });

  test("comma-lists match any element", () => {
    expect(cronMatches("0,30 9,17 * * *", d(2026, 7, 15, 17, 30))).toBe(true);
    expect(cronMatches("0,30 9,17 * * *", d(2026, 7, 15, 12, 30))).toBe(false);
  });

  test("trailing-comma empty element must NOT match (Number('') === 0 trap)", () => {
    // "9,17," at hour 0: a naive Number("") === 0 comparison would silently
    // add a midnight firing. The empty element is skipped instead.
    expect(cronMatches("0 9,17, * * *", d(2026, 7, 15, 0, 0))).toBe(false);
    expect(cronMatches("0 9,17, * * *", d(2026, 7, 15, 9, 0))).toBe(true);
    // A field of just "," matches nothing.
    expect(cronMatches("0 , * * *", d(2026, 7, 15, 0, 0))).toBe(false);
  });

  test("*/0 never matches (no division-by-zero firing)", () => {
    expect(cronMatches("*/0 * * * *", d(2026, 7, 15, 9, 0))).toBe(false);
  });

  test("strict digits: 0x5 / 1e1 / 1.0 do not match via Number() coercion", () => {
    expect(cronMatches("0x5 * * * *", d(2026, 7, 15, 9, 5))).toBe(false);
    expect(cronMatches("1e1 * * * *", d(2026, 7, 15, 9, 10))).toBe(false);
    expect(cronMatches("1.0 * * * *", d(2026, 7, 15, 9, 1))).toBe(false);
  });

  test("dom AND dow: BOTH must match when both are restricted", () => {
    // 2026-02-13 is a Friday: dom 13 AND dow 5 both hold.
    expect(cronMatches("0 9 13 * 5", d(2026, 2, 13, 9, 0))).toBe(true);
    // 2026-03-13 is also a Friday — dom matches, dow matches, different month.
    expect(cronMatches("0 9 13 * 5", d(2026, 3, 13, 9, 0))).toBe(true);
    // 2026-02-15 is a Sunday: dow 0 matches but dom 13 fails → no fire. Under
    // the standard cron OR-when-both-restricted convention this WOULD fire —
    // the AND semantics are the documented deliberate difference.
    expect(cronMatches("0 9 13 * 0", d(2026, 2, 15, 9, 0))).toBe(false);
    // Same Friday, dom mismatch: dow 5 matches but dom 14 ≠ 13 → no fire.
    expect(cronMatches("0 9 14 * 5", d(2026, 2, 13, 9, 0))).toBe(false);
  });

  test("wrong field count never matches", () => {
    expect(cronMatches("* * * *", d(2026, 7, 15, 9, 0))).toBe(false);
    expect(cronMatches("* * * * * *", d(2026, 7, 15, 9, 0))).toBe(false);
    expect(cronMatches("", d(2026, 7, 15, 9, 0))).toBe(false);
  });

  test("ranges are unsupported and never match", () => {
    expect(cronMatches("0 9-17 * * *", d(2026, 7, 15, 12, 0))).toBe(false);
  });
});

describe("validateCron", () => {
  test("accepts the supported grammar", () => {
    expect(validateCron("* * * * *")).toBeNull();
    expect(validateCron("*/15 * * * *")).toBeNull();
    expect(validateCron("0 9 * * 1")).toBeNull();
    expect(validateCron("0,30 9,17 1,15 1,12 0,6")).toBeNull();
    expect(validateCron("  0 9 * * 1  ")).toBeNull(); // tolerant of padding
  });

  test("rejects wrong field counts", () => {
    expect(validateCron("* * * *")).toMatch(/expected 5 fields, got 4/);
    expect(validateCron("* * * * * *")).toMatch(/expected 5 fields, got 6/);
  });

  test("rejects trailing-comma empty list elements", () => {
    expect(validateCron("0 9,17, * * *")).toMatch(/hour: empty list element/);
    expect(validateCron(", * * * *")).toMatch(/minute: empty list element/);
  });

  test("rejects */0", () => {
    expect(validateCron("*/0 * * * *")).toMatch(/minute: \*\/0 is invalid/);
  });

  test("rejects non-strict digits", () => {
    expect(validateCron("0x5 * * * *")).toMatch(/unsupported token "0x5"/);
    expect(validateCron("1e1 * * * *")).toMatch(/unsupported token "1e1"/);
    expect(validateCron("1.0 * * * *")).toMatch(/unsupported token "1\.0"/);
  });

  test("rejects ranges and names", () => {
    expect(validateCron("0 9 * * 1-5")).toMatch(/day-of-week: unsupported token "1-5"/);
    expect(validateCron("0 9 * * MON")).toMatch(/day-of-week: unsupported token "MON"/);
  });

  test("rejects out-of-range values per field", () => {
    expect(validateCron("60 * * * *")).toMatch(/minute: 60 out of range 0-59/);
    expect(validateCron("* 24 * * *")).toMatch(/hour: 24 out of range 0-23/);
    expect(validateCron("* * 0 * *")).toMatch(/day-of-month: 0 out of range 1-31/);
    expect(validateCron("* * 32 * *")).toMatch(/day-of-month: 32 out of range 1-31/);
    expect(validateCron("* * * 0 *")).toMatch(/month: 0 out of range 1-12/);
    expect(validateCron("* * * 13 *")).toMatch(/month: 13 out of range 1-12/);
    expect(validateCron("* * * * 7")).toMatch(/day-of-week: 7 out of range 0-6/);
  });
});
