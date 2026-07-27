import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./repos.ts";

// Capability-detecting, BASELINED verify gate. Hardened per code-review verdict
// 2026-07-20: dependencies are installed before any gate runs — install failure
// parks, it is NOT a no-gate (C4); gate-name detection broadened (M7).
//
// #12a (FAC-34/B11): a baseline gate run that ERRORS or TIMES OUT (spawn
// failure, or our own timeout kills it) is a transient infrastructure hiccup —
// distinct from a CLEAN non-zero exit, which means the command ran to
// completion and genuinely failed. FAC-34 parked "gates fail on clean
// baseline / no usable gate" and discarded ~$6/139 turns of implementer work
// because a transient install/timeout on the pristine worktree got
// misclassified as "genuinely red" and the whole repo was written off as
// no-gate. runWithRetryOnError() retries ONLY the errored/timed-out case,
// once, before any baseline/install verdict is recorded — a clean failure is
// never retried, so this can never mask a real red baseline.

export interface GateResult {
  name: string;
  baselinePassed: boolean;
  passed: boolean | null; // null = not run (no-gate)
  output: string;
}

// Gap-2: browser/e2e scripts are gates too — a passing e2e gate is what lifts a
// UI repo's verification from "real" (unit tests exist) to "strong" (the actual
// app was driven). Kept conservative: only these exact script names count as e2e.
const CANDIDATES = ["typecheck", "check", "build", "lint", "test", "test:ci", "test:unit", "test:e2e", "e2e", "test:browser", "playwright"];

/** A gate whose script drives the real app end-to-end (browser/e2e), as opposed
 * to a unit-test gate. START/END-anchored so only the exact script names match —
 * `test:e2e-utils` or `pretest:e2e` are NOT e2e gates. */
export function isE2eGate(name: string): boolean {
  return /^(e2e|test:e2e|test:browser|playwright)$/.test(name);
}

function npmScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

export interface RunResult { ok: boolean; out: string; errored: boolean }

function run(dir: string, cmd: string, args: string[], timeoutMs = 300_000): RunResult {
  const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8", timeout: timeoutMs });
  // errored: the command could not be run to COMPLETION — a spawn error (bad
  // cmd, permissions) or our timeout killed it (a signal, not an exit code).
  // Distinct from a clean non-zero exit (r.status is a number, r.signal null,
  // r.error undefined), which means the command ran and genuinely failed.
  const errored = r.error !== undefined || r.signal !== null;
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).slice(-3000), errored };
}

/** Retry-once-on-error/timeout policy shared by ensureDeps and baseline (#12a).
 * Pure w.r.t. the injected `attempt` so the policy is unit-testable without
 * shelling out or waiting on a real timeout. Never retries a clean non-zero
 * exit — only a run that could not complete gets the second try. */
export function runWithRetryOnError(attempt: () => RunResult): RunResult {
  const first = attempt();
  return first.errored ? attempt() : first;
}

/** Per-repo package manager: respect the TARGET repo's lockfile — the factory
 * itself runs on Bun, but client repos keep whatever they use. */
export function packageManager(dir: string): { name: "bun" | "npm"; install: string[]; runner: string[] } {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) {
    return { name: "bun", install: ["install", "--frozen-lockfile"], runner: ["run"] };
  }
  if (existsSync(join(dir, "package-lock.json"))) {
    return { name: "npm", install: ["ci", "--no-audit", "--no-fund"], runner: ["run", "--silent"] };
  }
  return { name: "npm", install: ["install", "--no-audit", "--no-fund"], runner: ["run", "--silent"] };
}

/** Install dependencies in a fresh worktree. Distinct outcomes: no package.json
 * (fine, no-gate repo) vs install failed (park — verification impossible).
 * #12a: an install that could not complete (network blip, timeout) is retried
 * once before failing (runWithRetryOnError); `transient: true` on a failure
 * that survived the retry tells the caller this is worth a plain requeue
 * rather than a deeper look — FAC-34's "transient install/timeout" case. */
export function ensureDeps(ws: Workspace): { ok: boolean; detail: string; transient?: boolean } {
  if (!existsSync(join(ws.dir, "package.json"))) return { ok: true, detail: "no package.json" };
  const pm = packageManager(ws.dir);
  const r = runWithRetryOnError(() => run(ws.dir, pm.name, [...pm.install], 600_000));
  return r.ok ? { ok: true, detail: `${pm.name} ${pm.install[0]}` } : { ok: false, detail: r.out.slice(-800), transient: r.errored };
}

/** Whether this repo can run Playwright browser checks — a dependency or a
 * config file. The tester stage degrades to "browser verification unavailable"
 * when this is false. */
export function hasPlaywright(ws: Workspace): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(ws.dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps["@playwright/test"] || deps["playwright"]) return true;
  } catch {
    // no/invalid package.json — fall through to config-file probe
  }
  return ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"].some((f) => existsSync(join(ws.dir, f)));
}

export function detectGates(ws: Workspace): string[] {
  const scripts = npmScripts(ws.dir);
  return CANDIDATES.filter((c) => scripts[c] && !/exit 1|no test specified/.test(scripts[c] ?? ""));
}

/** Run on the pristine worktree BEFORE the implementer touches anything. #12a:
 * a gate run that errored/timed out (not a clean non-zero exit) is retried
 * once via runWithRetryOnError before its baselinePassed verdict is recorded —
 * a transient hiccup here used to be indistinguishable from a genuinely red
 * baseline, classing the gate no-gate (FAC-34/B11). */
export function baseline(ws: Workspace, gates: string[]): Map<string, boolean> {
  const pm = packageManager(ws.dir);
  const result = new Map<string, boolean>();
  for (const gate of gates) result.set(gate, runWithRetryOnError(() => run(ws.dir, pm.name, [...pm.runner, gate])).ok);
  return result;
}

/** After changes: a gate counts only if its baseline passed. */
export function verify(ws: Workspace, gates: string[], baselines: Map<string, boolean>): GateResult[] {
  const pm = packageManager(ws.dir);
  return gates.map((gate) => {
    const baselinePassed = baselines.get(gate) ?? false;
    if (!baselinePassed) return { name: gate, baselinePassed, passed: null, output: "skipped: fails on clean baseline (no-gate)" };
    const r = run(ws.dir, pm.name, [...pm.runner, gate]);
    return { name: gate, baselinePassed, passed: r.ok, output: r.ok ? "" : r.out };
  });
}

export function gateSummary(results: GateResult[]): { green: boolean; strength: "none" | "weak" | "real" | "strong"; failures: GateResult[]; hasE2eGate: boolean } {
  const usable = results.filter((r) => r.passed !== null);
  const failures = usable.filter((r) => r.passed === false);
  // Strength reflects CAPABILITY, not outcome (a test gate that ran but failed
  // still proves the repo can test — `green` carries the pass/fail signal). A
  // unit-test gate is a `test*` script that is NOT an e2e gate; an e2e gate is
  // one isE2eGate recognizes. A passing e2e gate can also lift a repo to strong
  // via external browser evidence in buildMergeEvidence (merge-ladder.ts).
  const hasUnitTest = usable.some((r) => r.name.startsWith("test") && !isE2eGate(r.name));
  const hasE2eGate = usable.some((r) => isE2eGate(r.name));
  const strength = usable.length === 0 ? "none"
    : hasUnitTest && hasE2eGate ? "strong"
    : hasUnitTest || hasE2eGate ? "real"
    : "weak";
  return { green: failures.length === 0, strength, failures, hasE2eGate };
}

// UI-source extensions used to detect a repo-level UI surface (distinct from the
// per-diff uiFilesTouched heuristic in repos.ts — that asks "did THIS change
// touch UI", this asks "is this repo a UI project at all").
const UI_SOURCE_RE = /\.(tsx|jsx)$/;
const UI_DEPS = ["react", "react-dom", "vue", "svelte", "solid-js", "next", "nuxt", "@sveltejs/kit", "@angular/core"];

/** Bounded recursive probe for a file matching `re`, skipping node_modules and
 * hidden dirs. Depth-capped so a deep monorepo never turns detection into a walk. */
function hasFileMatching(dir: string, re: RegExp, maxDepth: number): boolean {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && re.test(e.name)) return true;
    if (e.isDirectory() && maxDepth > 0 && e.name !== "node_modules" && !e.name.startsWith(".")) {
      if (hasFileMatching(join(dir, e.name), re, maxDepth - 1)) return true;
    }
  }
  return false;
}

/** Repo-level UI surface: an index.html, a public/ dir, a front-end framework
 * dependency, or a *.tsx/*.jsx file under src/. Conservative on purpose — a
 * false positive would demand browser evidence from a repo that has no screen. */
export function hasUiSurface(ws: Workspace): boolean {
  if (existsSync(join(ws.dir, "index.html"))) return true;
  if (existsSync(join(ws.dir, "public"))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(ws.dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (UI_DEPS.some((d) => deps[d])) return true;
  } catch {
    // no/invalid package.json — fall through to the source-file probe
  }
  return existsSync(join(ws.dir, "src")) && hasFileMatching(join(ws.dir, "src"), UI_SOURCE_RE, 4);
}

/** Enforcement predicate (Gap 2): a repo that HAS a UI surface AND CAN run
 * Playwright MUST produce browser evidence — browser verification stops being a
 * ticket opt-in and becomes required wherever it is actually runnable. When this
 * is true and no browser evidence is produced, the merge ladder sees "missing"
 * and auto-merge is blocked (a PR still opens for a human — it degrades, never
 * parks). */
export function requiresBrowserEvidence(ws: Workspace): boolean {
  return hasUiSurface(ws) && hasPlaywright(ws);
}
