import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { detectGates, gateSummary, type GateResult } from "../src/verify.ts";
import type { Workspace } from "../src/repos.ts";

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

// This is the ticket's actual integration target: `"test": "bun test"` in
// package.json must survive detectGates()'s CANDIDATES filter so gateSummary
// upgrades the factory's own PRs from weak to real. Testing gateSummary alone
// (above) would stay green even if detectGates stopped recognizing "test" —
// these tests pin that specific wiring, in a scratch dir so the repo's own
// package.json is never touched.
const withPackageJson = (scripts: Record<string, string>): Workspace => {
  const dir = mkdtempSync(join(tmpdir(), "factory-detectgates-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
  return { repo: "acme/x", dir, branch: "factory/x", baseRef: "refs/remotes/origin/main" };
};

describe("detectGates", () => {
  test("a `test` script is detected and gateSummary reports the resulting gate as real", () => {
    const ws = withPackageJson({ typecheck: "tsc --noEmit", test: "bun test" });
    try {
      const gates = detectGates(ws);
      expect(gates).toContain("test");
      expect(gates).toContain("typecheck");
      const s = gateSummary(gates.map((name) => gate(name, true)));
      expect(s.strength).toBe("real");
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test("test:ci / test:unit variants are also detected", () => {
    const ws = withPackageJson({ "test:ci": "vitest run" });
    try {
      expect(detectGates(ws)).toContain("test:ci");
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test("a placeholder `npm init` test script is excluded, not counted as a gate", () => {
    const ws = withPackageJson({ test: 'echo "Error: no test specified" && exit 1' });
    try {
      expect(detectGates(ws)).not.toContain("test");
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test("no package.json → no gates detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-detectgates-"));
    try {
      expect(detectGates({ repo: "acme/x", dir, branch: "factory/x", baseRef: "refs/remotes/origin/main" })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
