import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { detectGates, gateSummary, isE2eGate, hasUiSurface, requiresBrowserEvidence, runWithRetryOnError, ensureDeps, type GateResult, type RunResult } from "../src/verify.ts";
import type { Workspace } from "../src/repos.ts";

const gate = (name: string, passed: boolean | null, baselinePassed = passed !== null): GateResult =>
  ({ name, baselinePassed, passed, output: passed === false ? "boom" : "" });

describe("gateSummary", () => {
  test("no gates at all → green with strength none", () => {
    expect(gateSummary([])).toEqual({ green: true, strength: "none", failures: [], hasE2eGate: false });
  });

  test("all gates skipped (failed baseline) → strength none, still green", () => {
    const s = gateSummary([gate("typecheck", null), gate("test", null)]);
    expect(s.green).toBe(true);
    expect(s.strength).toBe("none");
  });

  test("typecheck-only is a weak gate", () => {
    const s = gateSummary([gate("typecheck", true)]);
    expect(s).toEqual({ green: true, strength: "weak", failures: [], hasE2eGate: false });
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

  test("browser/e2e scripts are detected as gates (Gap 2)", () => {
    const ws = withPackageJson({ "test:e2e": "playwright test", e2e: "playwright test", "test:browser": "playwright test", playwright: "playwright test" });
    try {
      const gates = detectGates(ws);
      for (const g of ["test:e2e", "e2e", "test:browser", "playwright"]) expect(gates).toContain(g);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });
});

describe("isE2eGate", () => {
  test("classifies the browser/e2e script names, exactly", () => {
    for (const n of ["e2e", "test:e2e", "test:browser", "playwright"]) expect(isE2eGate(n)).toBe(true);
  });
  test("unit-test and unrelated gates are NOT e2e", () => {
    for (const n of ["test", "test:ci", "test:unit", "typecheck", "build", "lint", "pretest:e2e", "test:e2e-utils"]) expect(isE2eGate(n)).toBe(false);
  });
});

describe("gateSummary strength ladder (Gap 2)", () => {
  test("a unit test gate alone is real, not strong", () => {
    const s = gateSummary([gate("test", true)]);
    expect(s.strength).toBe("real");
    expect(s.hasE2eGate).toBe(false);
  });

  test("unit test + a passing e2e gate is strong", () => {
    const s = gateSummary([gate("test", true), gate("test:e2e", true)]);
    expect(s.strength).toBe("strong");
    expect(s.hasE2eGate).toBe(true);
    expect(s.green).toBe(true);
  });

  test("an e2e gate alone (no unit test) is real — a real test that drove the app", () => {
    // Chosen rule: a passing/usable e2e gate is at least as strong as unit tests,
    // so it lifts strength to "real"; "strong" additionally requires unit tests.
    const s = gateSummary([gate("playwright", true)]);
    expect(s.strength).toBe("real");
    expect(s.hasE2eGate).toBe(true);
  });

  test("a FAILING e2e flips green but strength still reflects capability (strong)", () => {
    const s = gateSummary([gate("test", true), gate("e2e", false)]);
    expect(s.green).toBe(false);
    expect(s.strength).toBe("strong");
    expect(s.failures.map((f) => f.name)).toEqual(["e2e"]);
  });

  test("e2e gate + only weak gates (no unit) stays real, never strong", () => {
    const s = gateSummary([gate("typecheck", true), gate("test:browser", true)]);
    expect(s.strength).toBe("real");
  });
});

const withDir = (build: (dir: string) => void): Workspace => {
  const dir = mkdtempSync(join(tmpdir(), "factory-uisurface-"));
  build(dir);
  return { repo: "acme/x", dir, branch: "factory/x", baseRef: "refs/remotes/origin/main" };
};

describe("hasUiSurface", () => {
  test("index.html → UI surface", () => {
    const ws = withDir((d) => writeFileSync(join(d, "index.html"), "<!doctype html>"));
    try { expect(hasUiSurface(ws)).toBe(true); } finally { rmSync(ws.dir, { recursive: true, force: true }); }
  });

  test("a react dependency → UI surface", () => {
    const ws = withDir((d) => writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { react: "^18" } })));
    try { expect(hasUiSurface(ws)).toBe(true); } finally { rmSync(ws.dir, { recursive: true, force: true }); }
  });

  test("a src/*.tsx file → UI surface", () => {
    const ws = withDir((d) => { mkdirSync(join(d, "src")); writeFileSync(join(d, "src", "App.tsx"), "export const App = () => null;"); });
    try { expect(hasUiSurface(ws)).toBe(true); } finally { rmSync(ws.dir, { recursive: true, force: true }); }
  });

  test("a public/ dir → UI surface", () => {
    const ws = withDir((d) => mkdirSync(join(d, "public")));
    try { expect(hasUiSurface(ws)).toBe(true); } finally { rmSync(ws.dir, { recursive: true, force: true }); }
  });

  test("a pure library package.json (no UI dep, no tsx) → NOT a UI surface", () => {
    const ws = withDir((d) => {
      writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { lodash: "^4" } }));
      mkdirSync(join(d, "src")); writeFileSync(join(d, "src", "index.ts"), "export const x = 1;");
    });
    try { expect(hasUiSurface(ws)).toBe(false); } finally { rmSync(ws.dir, { recursive: true, force: true }); }
  });
});

// #12a (FAC-34/B11): a baseline gate that ERRORS/TIMES OUT (could not complete)
// must be retried once before its verdict is recorded — a transient install/
// timeout on a pristine worktree previously got misclassified as "genuinely
// red baseline" and the whole repo written off as no-gate, discarding ~$6/139
// turns of implementer work. A CLEAN non-zero exit must never be retried — that
// is a real signal (the gate genuinely failed on baseline).
describe("runWithRetryOnError (#12a: baseline gate that errors/times out is retried once)", () => {
  const errored = (out = ""): RunResult => ({ ok: false, out, errored: true });
  const cleanFail = (out = "boom"): RunResult => ({ ok: false, out, errored: false });
  const pass = (): RunResult => ({ ok: true, out: "", errored: false });

  test("an errored/timed-out first attempt is retried once, and the retry's verdict wins", () => {
    let calls = 0;
    const r = runWithRetryOnError(() => { calls++; return calls === 1 ? errored() : pass(); });
    expect(calls).toBe(2);
    expect(r).toEqual(pass());
  });

  test("a CLEAN non-zero exit (genuinely red baseline) is NOT retried", () => {
    let calls = 0;
    const r = runWithRetryOnError(() => { calls++; return cleanFail(); });
    expect(calls).toBe(1);
    expect(r.ok).toBe(false);
  });

  test("an attempt that keeps erroring/timing out stays failed after the single retry (no infinite retry)", () => {
    let calls = 0;
    const r = runWithRetryOnError(() => { calls++; return errored(); });
    expect(calls).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.errored).toBe(true);
  });

  test("a first-attempt pass is never retried", () => {
    let calls = 0;
    const r = runWithRetryOnError(() => { calls++; return pass(); });
    expect(calls).toBe(1);
    expect(r.ok).toBe(true);
  });
});

describe("ensureDeps (#12a: install is retried once on error/timeout via runWithRetryOnError)", () => {
  test("no package.json → ok, no install attempted (fine, no-gate repo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-ensuredeps-"));
    try {
      const ws: Workspace = { repo: "acme/x", dir, branch: "factory/x", baseRef: "refs/remotes/origin/main" };
      expect(ensureDeps(ws)).toEqual({ ok: true, detail: "no package.json" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("requiresBrowserEvidence = hasUiSurface && hasPlaywright (truth table)", () => {
  const make = (opts: { ui: boolean; playwright: boolean }): Workspace => withDir((d) => {
    const deps: Record<string, string> = {};
    if (opts.ui) deps.react = "^18";
    if (opts.playwright) deps["@playwright/test"] = "^1";
    writeFileSync(join(d, "package.json"), JSON.stringify({ devDependencies: deps }));
  });

  test("UI + Playwright → required", () => {
    const ws = make({ ui: true, playwright: true });
    try { expect(requiresBrowserEvidence(ws)).toBe(true); } finally { rmSync(ws.dir, { recursive: true, force: true }); }
  });
  test("UI, no Playwright → not required", () => {
    const ws = make({ ui: true, playwright: false });
    try { expect(requiresBrowserEvidence(ws)).toBe(false); } finally { rmSync(ws.dir, { recursive: true, force: true }); }
  });
  test("Playwright, no UI → not required", () => {
    const ws = make({ ui: false, playwright: true });
    try { expect(requiresBrowserEvidence(ws)).toBe(false); } finally { rmSync(ws.dir, { recursive: true, force: true }); }
  });
  test("neither → not required", () => {
    const ws = make({ ui: false, playwright: false });
    try { expect(requiresBrowserEvidence(ws)).toBe(false); } finally { rmSync(ws.dir, { recursive: true, force: true }); }
  });
});
