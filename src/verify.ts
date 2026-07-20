import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const CANDIDATES = ["typecheck", "check", "build", "lint", "test", "test:ci", "test:unit"];

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

export function gateSummary(results: GateResult[]): { green: boolean; strength: "none" | "weak" | "real"; failures: GateResult[] } {
  const usable = results.filter((r) => r.passed !== null);
  const failures = usable.filter((r) => r.passed === false);
  const strength = usable.length === 0 ? "none" : usable.some((r) => r.name.startsWith("test")) ? "real" : "weak";
  return { green: failures.length === 0, strength, failures };
}
