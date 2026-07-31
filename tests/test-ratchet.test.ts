import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { baseline, isTestGate, parsePassingTestCount, testCountRatchet, verify, type GateResult } from "../src/verify.ts";
import { buildReport } from "../src/report.ts";
import type { Workspace } from "../src/repos.ts";

// Test-count ratchet: "automate the TIGHTENING, gate the LOOSENING". The
// runtime complement to repos.ts isAdditiveTestExtension — the classifier reads
// the DIFF, the ratchet reads the RUNNER OUTPUT, so a suite gutted without
// deleting lines (`.skip`, a broken helper that stops half the file
// registering) still surfaces. Withhold-only: a decrease folds into needsHuman
// (loop.ts), never an auto-fail; UNKNOWN never blocks but is never a pass.

const gate = (name: string, passed: boolean | null, baselineTestCount: number | null = null, testCount: number | null = null): GateResult =>
  ({ name, baselinePassed: passed !== null, passed, output: "", baselineTestCount, testCount });

describe("isTestGate", () => {
  test("unit-test and e2e gate names are test gates", () => {
    for (const n of ["test", "test:ci", "test:unit", "test:e2e", "e2e", "test:browser", "playwright"]) expect(isTestGate(n)).toBe(true);
  });
  test("non-test gates are not", () => {
    for (const n of ["typecheck", "check", "build", "lint"]) expect(isTestGate(n)).toBe(false);
  });
});

describe("parsePassingTestCount — tolerant across runner formats, UNKNOWN (null) when unparseable", () => {
  test("bun test summary", () => {
    const out = "bun test v1.1.0\n\ntests/foo.test.ts:\n✓ a thing works\n\n 631 pass\n 0 fail\n 1310 expect() calls\nRan 631 tests across 33 files. [1.2s]\n";
    expect(parsePassingTestCount(out)).toBe(631);
  });

  test("bun with ANSI color codes (real terminal output)", () => {
    const out = "\x1b[32m 631 pass\x1b[0m\n\x1b[31m 2 fail\x1b[0m\n";
    expect(parsePassingTestCount(out)).toBe(631);
  });

  test("bun zero-test run parses as 0, not UNKNOWN", () => {
    expect(parsePassingTestCount(" 0 pass\n 0 fail\n")).toBe(0);
  });

  test("jest/npm summary — the passed number, not failed/total, and not Test Suites", () => {
    const out = "Test Suites: 1 failed, 32 passed, 33 total\nTests:       1 failed, 629 passed, 631 total\nSnapshots:   0 total\nTime:        4.2 s\n";
    expect(parsePassingTestCount(out)).toBe(629);
  });

  test("vitest summary (no colon, pipe-separated)", () => {
    expect(parsePassingTestCount(" Test Files  12 passed (12)\n      Tests  1 failed | 630 passed (631)\n   Start at  10:00:00\n")).toBe(630);
  });

  test("mocha summary", () => {
    expect(parsePassingTestCount("  631 passing (2s)\n  1 pending\n")).toBe(631);
  });

  test("playwright summary", () => {
    expect(parsePassingTestCount("Running 14 tests using 4 workers\n  14 passed (1.2m)\n")).toBe(14);
  });

  test("node --test / tap summary", () => {
    expect(parsePassingTestCount("# tests 631\n# pass 630\n# fail 1\n")).toBe(630);
  });

  test("multiple summaries (workspace/monorepo script) are SUMMED", () => {
    const out = "Tests: 10 passed, 10 total\n...second package...\nTests: 5 passed, 5 total\n";
    expect(parsePassingTestCount(out)).toBe(15);
  });

  test("missing summary (e.g. runner crashed before printing) → UNKNOWN, never 0", () => {
    expect(parsePassingTestCount("bun test v1.1.0\n\nerror: Cannot find module './x'\n")).toBeNull();
  });

  test("garbage / non-runner output → UNKNOWN", () => {
    expect(parsePassingTestCount("All tests passed with flying colors!\nlorem ipsum\n")).toBeNull();
    expect(parsePassingTestCount("")).toBeNull();
  });

  test("a script's own echoed command line ('$ ...') is not miscounted", () => {
    // bun run prints "$ <script>" before output — must not match the bare-form pattern.
    expect(parsePassingTestCount("$ echo ' 5 pass'\n 5 pass\n")).toBe(5);
  });
});

describe("testCountRatchet — decrease withholds, increase flows, UNKNOWN never blocks", () => {
  test("count grew (tests added) → ok, evidence in 'tests: a -> b' form", () => {
    expect(testCountRatchet([gate("test", true, 631, 640)])).toEqual({ verdict: "ok", evidence: "tests: 631 -> 640" });
  });

  test("count held → ok", () => {
    expect(testCountRatchet([gate("test", true, 631, 631)]).verdict).toBe("ok");
  });

  test("count DECREASED → decreased (folds into needsHuman, never auto-fail)", () => {
    const r = testCountRatchet([gate("test", true, 631, 625)]);
    expect(r.verdict).toBe("decreased");
    expect(r.evidence).toBe("tests: 631 -> 625");
  });

  test("a decrease of one is enough — no tolerance", () => {
    expect(testCountRatchet([gate("test", true, 631, 630)]).verdict).toBe("decreased");
  });

  test("UNKNOWN baseline count → unknown (visible, not blocking)", () => {
    const r = testCountRatchet([gate("test", true, null, 640)]);
    expect(r.verdict).toBe("unknown");
    expect(r.evidence).toBe("tests: ? -> 640");
  });

  test("UNKNOWN post-change count → unknown, even when baseline was known", () => {
    // A post-change run whose summary vanished must NOT count as a pass.
    expect(testCountRatchet([gate("test", true, 631, null)]).verdict).toBe("unknown");
  });

  test("a confirmed decrease on one gate WINS over unknown on another (tighten-only)", () => {
    const r = testCountRatchet([gate("test", true, 631, 625), gate("test:e2e", true, null, null)]);
    expect(r.verdict).toBe("decreased");
    expect(r.evidence).toBe("tests: test 631 -> 625, test:e2e ? -> ?");
  });

  test("no test gates at all (strength none / weak-only repo) → skipped", () => {
    expect(testCountRatchet([])).toEqual({ verdict: "skipped", evidence: "" });
    expect(testCountRatchet([gate("typecheck", true, null, null), gate("build", true)])).toEqual({ verdict: "skipped", evidence: "" });
  });

  test("a test gate no-gated by a red baseline (passed null) does not participate", () => {
    // Existing baseline-park logic owns this case; the ratchet must not resurrect it.
    expect(testCountRatchet([gate("test", null, null, null)]).verdict).toBe("skipped");
  });

  test("non-test gates never contribute counts even if somehow populated", () => {
    expect(testCountRatchet([gate("typecheck", true, 9, 1)]).verdict).toBe("skipped");
  });

  test("multi-gate evidence names each gate", () => {
    const r = testCountRatchet([gate("test", true, 10, 12), gate("test:e2e", true, 3, 3)]);
    expect(r).toEqual({ verdict: "ok", evidence: "tests: test 10 -> 12, test:e2e 3 -> 3" });
  });
});

describe("report surfaces the ratchet evidence (queryable 'tests: a -> b')", () => {
  const base = { issueKey: "FAC-1", prUrl: null, outcome: "needs_human" as const, stages: [], gates: [gate("test", true, 631, 625)], gateStrength: "real" as const, guardedPaths: [] };

  test("a DECREASED verdict renders the counts, the withhold note, and YAML meta", () => {
    const r = buildReport({ ...base, reason: "passing test count DECREASED", testRatchet: { verdict: "decreased", evidence: "tests: 631 -> 625" } });
    expect(r).toContain("**Test count:** tests: 631 -> 625");
    expect(r).toContain("DECREASED vs baseline");
    expect(r).toContain("test_ratchet: decreased");
    expect(r).toContain('test_counts: "tests: 631 -> 625"');
  });

  test("an unknown verdict is visible but explicitly non-blocking", () => {
    const r = buildReport({ ...base, outcome: "pr_open", testRatchet: { verdict: "unknown", evidence: "tests: 631 -> ?" } });
    expect(r).toContain("tests: 631 -> ?");
    expect(r).toContain("not blocking");
  });

  test("no testRatchet input (skipped) → no test-count lines at all", () => {
    const r = buildReport({ ...base, outcome: "pr_open" });
    expect(r).not.toContain("Test count");
    expect(r).not.toContain("test_ratchet");
  });
});

// End-to-end through the real baseline() → verify() path: a scratch repo whose
// `test` script echoes a bun-style summary. bun.lock forces packageManager to
// bun (installed everywhere the factory runs) so the test never depends on npm.
describe("baseline/verify carry test counts end-to-end", () => {
  const scratch = (testScript: string): Workspace => {
    const dir = mkdtempSync(join(tmpdir(), "factory-ratchet-"));
    writeFileSync(join(dir, "bun.lock"), "");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: testScript } }));
    return { repo: "acme/x", dir, branch: "factory/x", baseRef: "refs/remotes/origin/main" };
  };

  test("baseline records the count; verify compares it against the post-change run", () => {
    const ws = scratch("echo ' 5 pass' && echo ' 0 fail'");
    try {
      const baselines = baseline(ws, ["test"]);
      expect(baselines.get("test")).toEqual({ ok: true, testCount: 5 });
      // Simulate the implementer gutting the suite: fewer tests pass post-change.
      writeFileSync(join(ws.dir, "package.json"), JSON.stringify({ scripts: { test: "echo ' 3 pass' && echo ' 0 fail'" } }));
      const results = verify(ws, ["test"], baselines);
      expect(results[0]).toMatchObject({ name: "test", passed: true, baselineTestCount: 5, testCount: 3 });
      expect(testCountRatchet(results)).toEqual({ verdict: "decreased", evidence: "tests: 5 -> 3" });
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a red baseline records no count and verify no-gates it (existing park logic owns it)", () => {
    const ws = scratch("echo ' 2 pass' && exit 1");
    try {
      const baselines = baseline(ws, ["test"]);
      expect(baselines.get("test")).toEqual({ ok: false, testCount: null });
      const results = verify(ws, ["test"], baselines);
      expect(results[0]?.passed).toBeNull();
      expect(testCountRatchet(results).verdict).toBe("skipped");
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 30_000);
});
