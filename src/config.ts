import { homedir } from "node:os";
import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required (see .env.example)`);
  return value.trim();
}

function num(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

// Dashboard-only mode: serve the mission-control UI, never poll Linear.
// LINEAR_API_KEY is not required here because linear.ts is never exercised.
const serverOnly = process.argv.includes("--server-only");

export const config = {
  // Daemon-only secret — never passed into any worker env (ADR-0003 in plan §6.1).
  linearApiKey: serverOnly ? (process.env.LINEAR_API_KEY ?? "").trim() : required("LINEAR_API_KEY"),
  teamKeys: (process.env.FACTORY_TEAM_KEYS ?? "FAC").split(",").map((k) => k.trim()).filter(Boolean),

  proxyBaseUrl: (process.env.PROXY_BASE_URL ?? "http://127.0.0.1:8317").replace(/\/+$/, ""),
  proxyAuthToken: process.env.PROXY_AUTH_TOKEN ?? "",

  models: {
    implementer: process.env.IMPLEMENTER_MODEL ?? "sonnet",
    reviewerClaude: process.env.REVIEWER_CLAUDE_MODEL ?? "opus",
    reviewerCodex: process.env.REVIEWER_CODEX_MODEL ?? "gpt-5.6-sol",
    fixer: process.env.FIXER_MODEL ?? "sonnet",
    scout: process.env.SCOUT_MODEL ?? "sonnet",
    planner: process.env.PLANNER_MODEL ?? "opus",
    steward: process.env.STEWARD_MODEL ?? "claude-fable-5",
    designReviewer: process.env.DESIGN_REVIEWER_MODEL ?? "opus",
    tester: process.env.TESTER_MODEL ?? "sonnet",
  },

  workRoot: expandHome(process.env.FACTORY_WORK_ROOT ?? "~/FactoryWork"),

  caps: {
    turnsImplementer: num("MAX_TURNS_IMPLEMENTER", 40),
    turnsReviewer: num("MAX_TURNS_REVIEWER", 8),
    turnsFixer: num("MAX_TURNS_FIXER", 30),
    wallMinutesPerIssue: num("MAX_WALL_MINUTES_PER_ISSUE", 45),
    budgetUsdPerIssue: num("MAX_BUDGET_USD_PER_ISSUE", 25),
    verifierIterations: num("MAX_VERIFIER_ITERATIONS", 3),
    tasteRounds: num("TASTE_MAX_ROUNDS", 2),   // max design-review passes (≥1); fix runs between passes
    wipLimit: num("WIP_LIMIT", 4),
  },

  proxyAll: (process.env.PROXY_ALL ?? "1") !== "0",
  // Repos where the factory may merge its own green, unguarded PRs (greenfield/
  // fun). DEFAULT for every other repo: human merges — the review gate stands.
  autoMergeRepos: (process.env.MERGE_AUTO_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean), // route ALL stages via CLIProxyAPI (multi-account pooling)
  watchIntervalSeconds: Math.max(30, num("WATCH_INTERVAL_SECONDS", 60)),
  idleIntervalSeconds: Math.max(10, num("WATCH_INTERVAL_IDLE_SECONDS", 15)), // fast poll when nothing is in flight
  oneShot: process.argv.includes("--once"),
  dryRun: process.argv.includes("--dry-run"),
  serverOnly,
};

if (config.proxyBaseUrl && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(config.proxyBaseUrl)) {
  throw new Error("PROXY_BASE_URL must be loopback (see codexProxyTest security notes)");
}
