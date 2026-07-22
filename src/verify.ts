import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./repos.ts";

// Capability-detecting, BASELINED verify gate. Hardened per code-review verdict
// 2026-07-20: dependencies are installed before any gate runs — install failure
// parks, it is NOT a no-gate (C4); gate-name detection broadened (M7).

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

function run(dir: string, cmd: string, args: string[], timeoutMs = 300_000): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8", timeout: timeoutMs });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).slice(-3000) };
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
 * (fine, no-gate repo) vs install failed (park — verification impossible). */
export function ensureDeps(ws: Workspace): { ok: boolean; detail: string } {
  if (!existsSync(join(ws.dir, "package.json"))) return { ok: true, detail: "no package.json" };
  const pm = packageManager(ws.dir);
  const r = run(ws.dir, pm.name, [...pm.install], 600_000);
  return r.ok ? { ok: true, detail: `${pm.name} ${pm.install[0]}` } : { ok: false, detail: r.out.slice(-800) };
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

/** Run on the pristine worktree BEFORE the implementer touches anything. */
export function baseline(ws: Workspace, gates: string[]): Map<string, boolean> {
  const pm = packageManager(ws.dir);
  const result = new Map<string, boolean>();
  for (const gate of gates) result.set(gate, run(ws.dir, pm.name, [...pm.runner, gate]).ok);
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
