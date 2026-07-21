import { describe, expect, test } from "bun:test";
import { gateSummary, type GateResult } from "../src/verify.ts";

const gate = (name: string, passed: boolean | null, baselinePassed = passed !== null): GateResult =>
  ({ name, baselinePassed, passed, output: passed === false ? "boom" : "" });

describe("gateSummary", () => {
  test("no gates at all → green with strength none", () => {
    expect(gateSummary([])).toEqual({ green: true, strength: "none", failures: [] });
  });

  test("all gates skipped (failed baseline) → strength none, still green", () => {
    const s = gateSummary([gate("typecheck", null), gate("test", null)]);
    expect(s.green).toBe(true);
    expect(s.strength).toBe("none");
  });

  test("typecheck-only is a weak gate", () => {
    const s = gateSummary([gate("typecheck", true)]);
    expect(s).toEqual({ green: true, strength: "weak", failures: [] });
  });

  test("a usable test gate upgrades strength to real", () => {
    const s = gateSummary([gate("typecheck", true), gate("test", true)]);
    expect(s.green).toBe(true);
    expect(s.strength).toBe("real");
  });

  test("test:ci / test:unit also count as real (name startsWith test)", () => {
    expect(gateSummary([gate("test:ci", true)]).strength).toBe("real");
    expect(gateSummary([gate("test:unit", true)]).strength).toBe("real");
  });

  test("a SKIPPED test gate does not count toward strength", () => {
    // baseline failed → passed null → not usable; only typecheck remains.
    const s = gateSummary([gate("typecheck", true), gate("test", null)]);
    expect(s.strength).toBe("weak");
  });

  test("failures are collected and green flips", () => {
    const failing = gate("test", false);
    const s = gateSummary([gate("typecheck", true), failing]);
    expect(s.green).toBe(false);
    expect(s.strength).toBe("real"); // strength reflects capability, not outcome
    expect(s.failures).toEqual([failing]);
  });

  test("build/lint gates are weak, never real", () => {
    expect(gateSummary([gate("build", true), gate("lint", true)]).strength).toBe("weak");
  });
});
