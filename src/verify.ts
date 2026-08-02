import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./repos.ts";
import type { RepoFacts } from "./routing.ts";

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
  // Test-count ratchet (withhold-only, see testCountRatchet below): passing-test
  // counts parsed from the runner's own summary output, null = UNKNOWN
  // (unparseable output, non-test gate, or gate skipped). Baseline count comes
  // from the pristine pre-change run, testCount from the post-change run.
  baselineTestCount: number | null;
  testCount: number | null;
}

// Gap-2: browser/e2e scripts are gates too — a passing e2e gate is what lifts a
// UI repo's verification from "real" (unit tests exist) to "strong" (the actual
// app was driven). Kept conservative: only these exact script names count as e2e.
export const CANDIDATES = ["typecheck", "check", "build", "lint", "test", "test:ci", "test:unit", "test:e2e", "e2e", "test:browser", "playwright"];

/** A gate whose script drives the real app end-to-end (browser/e2e), as opposed
 * to a unit-test gate. START/END-anchored so only the exact script names match —
 * `test:e2e-utils` or `pretest:e2e` are NOT e2e gates. */
export function isE2eGate(name: string): boolean {
  return /^(e2e|test:e2e|test:browser|playwright)$/.test(name);
}

/** A gate that runs tests at all (unit OR e2e) — the union gateSummary uses for
 * strength. Only these gates participate in the test-count ratchet; parsing a
 * "pass count" out of typecheck/build/lint output would be noise. */
export function isTestGate(name: string): boolean {
  return name.startsWith("test") || isE2eGate(name);
}

// Test-count ratchet parsing. One pattern per runner family, matched against
// ANSI-stripped output. Tried in order of SPECIFICITY — the explicit labelled
// summary lines first, the bare "N pass" forms last — and only the first
// pattern that matches anywhere is used (a run never mixes runner formats, but
// a bare-form pattern could false-match inside another runner's verbose
// output). All matches of the winning pattern are SUMMED: a monorepo/workspace
// script that runs several suites prints one summary per suite, and both the
// baseline and post-change runs are parsed identically so the comparison stays
// apples-to-apples. Anything unmatched is UNKNOWN (null) — never 0, because
// "we could not read the count" must not masquerade as "no tests passed" (or,
// worse, let a gutted suite look like a no-op against a 0 baseline).
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const PASS_COUNT_PATTERNS: RegExp[] = [
  // jest: "Tests:       1 failed, 629 passed, 631 total"
  // vitest: "  Tests  631 passed (631)" / "Tests  1 failed | 630 passed (631)"
  // ("Test Suites:" does not match — the anchor requires the plural "Tests".)
  /^\s*Tests:?\s.*?(\d+) passed\b/gm,
  // node --test / tap: "# pass 631"
  /^# pass (\d+)\b/gm,
  // bun: " 631 pass" (own line) · mocha: "  631 passing (2s)" ·
  // playwright: "  631 passed (1.2m)"
  /^\s*(\d+) pass(?:ing|ed)?\s*(?:\(|$)/gm,
];

/** Parse the PASSING-test count out of a test runner's output; null = UNKNOWN.
 * Tolerant across runner formats (bun, jest, vitest, mocha, playwright,
 * node --test); an unparseable output is UNKNOWN, never a count — the ratchet
 * treats UNKNOWN as "cannot compare" (logged, non-blocking), never as a pass
 * with an invented number. */
export function parsePassingTestCount(output: string): number | null {
  const clean = output.replace(ANSI_RE, "");
  for (const pattern of PASS_COUNT_PATTERNS) {
    const matches = [...clean.matchAll(pattern)];
    if (matches.length > 0) return matches.reduce((sum, m) => sum + Number(m[1]), 0);
  }
  return null;
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

const execFileP = promisify(execFile);

/** ASYNC on purpose (dashboard-starvation fix, live 2026-08-02): gates run
 * for MINUTES (npm ci, Playwright e2e), and the old spawnSync version blocked
 * the daemon's entire event loop for the duration — the mission-control HTTP
 * server stopped accepting, ticks froze, and async gh children went zombie
 * unreaped. Same RunResult contract: `errored` = could not run to COMPLETION
 * (spawn failure or our timeout's signal), distinct from a clean non-zero
 * exit (ran and genuinely failed).
 * maxBuffer generous (32MB): a huge test log must surface as output (we slice
 * the tail), never as a spurious ENOBUFS "error". */
async function run(dir: string, cmd: string, args: string[], timeoutMs = 300_000): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { cwd: dir, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, out: ((stdout ?? "") + (stderr ?? "")).slice(-3000), errored: false };
  } catch (error) {
    const e = error as { code?: number | string; signal?: string | null; killed?: boolean; stdout?: string; stderr?: string };
    const out = (((e.stdout ?? "") as string) + ((e.stderr ?? "") as string)).slice(-3000);
    // Timeout kills via signal; a spawn failure has a string code (ENOENT…).
    const errored = e.killed === true || (e.signal !== undefined && e.signal !== null) || typeof e.code === "string";
    return { ok: false, out, errored };
  }
}

/** Retry-once-on-error/timeout policy shared by ensureDeps and baseline (#12a).
 * Pure w.r.t. the injected `attempt` so the policy is unit-testable without
 * shelling out or waiting on a real timeout. Never retries a clean non-zero
 * exit — only a run that could not complete gets the second try. */
export async function runWithRetryOnError(attempt: () => Promise<RunResult> | RunResult): Promise<RunResult> {
  const first = await attempt();
  return first.errored ? await attempt() : first;
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
export async function ensureDeps(ws: Workspace): Promise<{ ok: boolean; detail: string; transient?: boolean }> {
  if (!existsSync(join(ws.dir, "package.json"))) return { ok: true, detail: "no package.json" };
  const pm = packageManager(ws.dir);
  const r = await runWithRetryOnError(() => run(ws.dir, pm.name, [...pm.install], 600_000));
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

/** Baseline verdict per gate, plus the passing-test count parsed from the
 * baseline run's output (test gates only; null = UNKNOWN/not-a-test-gate).
 * The count is only recorded off a PASSING baseline — a red baseline makes the
 * gate no-gate (verify skips it) so its count could never be compared anyway,
 * and recording one would invite comparing against a half-run suite. */
export interface BaselineRun { ok: boolean; testCount: number | null }

/** Run on the pristine worktree BEFORE the implementer touches anything. #12a:
 * a gate run that errored/timed out (not a clean non-zero exit) is retried
 * once via runWithRetryOnError before its baselinePassed verdict is recorded —
 * a transient hiccup here used to be indistinguishable from a genuinely red
 * baseline, classing the gate no-gate (FAC-34/B11). */
export async function baseline(ws: Workspace, gates: string[]): Promise<Map<string, BaselineRun>> {
  const pm = packageManager(ws.dir);
  const result = new Map<string, BaselineRun>();
  for (const gate of gates) {
    const r = await runWithRetryOnError(() => run(ws.dir, pm.name, [...pm.runner, gate]));
    result.set(gate, { ok: r.ok, testCount: r.ok && isTestGate(gate) ? parsePassingTestCount(r.out) : null });
  }
  return result;
}

/** After changes: a gate counts only if its baseline passed. */
export async function verify(ws: Workspace, gates: string[], baselines: Map<string, BaselineRun>): Promise<GateResult[]> {
  const pm = packageManager(ws.dir);
  const out: GateResult[] = [];
  for (const gate of gates) {
    const base = baselines.get(gate);
    const baselinePassed = base?.ok ?? false;
    if (!baselinePassed) { out.push({ name: gate, baselinePassed, passed: null, output: "skipped: fails on clean baseline (no-gate)", baselineTestCount: null, testCount: null }); continue; }
    const r = await run(ws.dir, pm.name, [...pm.runner, gate]);
    out.push({ name: gate, baselinePassed, passed: r.ok, output: r.ok ? "" : r.out,
      baselineTestCount: base?.testCount ?? null,
      testCount: isTestGate(gate) ? parsePassingTestCount(r.out) : null });
  }
  return out;
}

// ---- Test-count ratchet (withhold-only) -----------------------------------
// Complements repos.ts isAdditiveTestExtension: the diff classifier reads the
// CHANGE (were test lines removed?), the ratchet reads the RUNTIME OUTCOME
// (did fewer tests actually pass?). A gutted suite the classifier misses —
// e.g. `.skip` sprinkled on, a helper edited so half the file stops
// registering, a loop-generated table shrunk — still shows up here as a
// falling pass count. Principle: automate the TIGHTENING, gate the LOOSENING —
// an increase flows freely, a decrease requires a human act. So a decrease
// folds into needsHuman (blocks auto-merge, PR still opens for a human) and
// NEVER auto-fails/parks the run: renames and consolidations can legitimately
// lower the count and only a human can tell those apart from gutting.

export interface TestCountRatchet {
  // "decreased" → fold into needsHuman. "unknown" → NEVER blocks (a count was
  // unparseable on either side — log it so it is visible, the diff classifier
  // still guards). "skipped" → no test gate actually ran (strength none, or
  // every test gate was no-gated by a red baseline — existing baseline logic
  // already handled those). "ok" → count held or grew.
  verdict: "ok" | "decreased" | "unknown" | "skipped";
  evidence: string; // "tests: 631 -> 640" style, "" when skipped
}

/** Pure fold over the final GateResults. Only test gates that actually RAN
 * (baseline green → passed !== null) participate. A decrease on ANY such gate
 * wins over unknowns elsewhere — one confirmed drop is enough evidence to
 * route to a human, tighten-only. */
export function testCountRatchet(results: GateResult[]): TestCountRatchet {
  const ran = results.filter((r) => isTestGate(r.name) && r.passed !== null);
  if (ran.length === 0) return { verdict: "skipped", evidence: "" };
  const fmt = (n: number | null) => (n === null ? "?" : String(n));
  const parts = ran.map((r) => `${ran.length > 1 ? `${r.name} ` : ""}${fmt(r.baselineTestCount)} -> ${fmt(r.testCount)}`);
  const evidence = `tests: ${parts.join(", ")}`;
  const decreased = ran.some((r) => r.baselineTestCount !== null && r.testCount !== null && r.testCount < r.baselineTestCount);
  if (decreased) return { verdict: "decreased", evidence };
  const unknown = ran.some((r) => r.baselineTestCount === null || r.testCount === null);
  if (unknown) return { verdict: "unknown", evidence };
  return { verdict: "ok", evidence };
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

/** Agent routing (routing.ts): the repo's own observable facts, and the ONLY
 *  input a specialist card may be selected on. Everything here is read from
 *  the WORKTREE — no ticket text reaches it, which is what makes card
 *  selection immune to a description that asks for a different agent. Reuses
 *  the existing detectors verbatim so a fact can never disagree with the gate
 *  logic that already depends on it. */
export function repoFacts(ws: Workspace, gates?: readonly string[]): RepoFacts {
  return {
    ui: hasUiSurface(ws),
    playwright: hasPlaywright(ws),
    gates: gates ?? detectGates(ws),
  };
}
