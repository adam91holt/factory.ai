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

// "repo:tier,repo2:tier" → { repo: tier } — the per-repo merge-ladder ceiling.
// Only the four known tiers are accepted; an unknown/typo tier is dropped so a
// malformed env var can never widen merge authority.
const LADDER_TIERS = new Set(["human", "shadow", "auto-low-risk", "auto"]);
function parsePairs(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const [repo, tier] = pair.split(":").map((s) => s.trim());
    if (repo && tier && LADDER_TIERS.has(tier)) out[repo] = tier;
  }
  return out;
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

  // Prerequisite-0 alerting (T5, the #1 leverage item — no notification channel
  // existed before this). Optional ntfy/Slack-style webhook URL: alerts.ts POSTs
  // a small redacted JSON payload here on issue_needs_human, run_finished{parked},
  // deploy reverted, tick error, and drain-mode entered. Empty (default) = no-op
  // cleanly, no dependency on any notification provider.
  alertWebhookUrl: (process.env.ALERT_WEBHOOK_URL ?? "").trim(),

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
    // Gap-2 security-review stage — cross-vendor by default (Codex) so a Claude
    // author is not the sole security judge of its own diff.
    securityReviewer: process.env.SECURITY_REVIEWER_MODEL ?? "gpt-5.6-sol",
    // Lesson distiller: one cheap tool-less call per failure (park / needs-human /
    // taste-fail) that turns the event into a one-line reusable lesson (lessons.ts).
    distiller: process.env.DISTILLER_MODEL ?? "haiku",
  },

  workRoot: expandHome(process.env.FACTORY_WORK_ROOT ?? "~/FactoryWork"),

  caps: {
    turnsImplementer: num("MAX_TURNS_IMPLEMENTER", 40),
    turnsReviewer: num("MAX_TURNS_REVIEWER", 8),
    turnsFixer: num("MAX_TURNS_FIXER", 30),
    wallMinutesPerIssue: num("MAX_WALL_MINUTES_PER_ISSUE", 45),
    budgetUsdPerIssue: num("MAX_BUDGET_USD_PER_ISSUE", 25),
    // Prerequisite-0 rolling spend cap (T5, docs/planning/autonomy.md "Build
    // order" item 0): budgetUsdPerIssue above bounds ONE issue; this bounds the
    // whole factory's trailing-24h spend across every issue/stage. spend-cap.ts
    // sums run_stage_finished costUsd off the bus and enters drain mode (no new
    // work claimed; in-flight finishes) once the rolling total exceeds this.
    // Default is 8x the per-issue cap — the WIP_LIMIT=4 default concurrency
    // ceiling with headroom for turnover across a day, not a hard science.
    budgetUsdPerDay: num("MAX_BUDGET_USD_PER_DAY", 200),
    verifierIterations: num("MAX_VERIFIER_ITERATIONS", 3),
    tasteRounds: num("TASTE_MAX_ROUNDS", 2),   // max design-review passes (≥1); fix runs between passes
    wipLimit: num("WIP_LIMIT", 4),
  },

  // Global groundskeeper kill-switch (owner request 2026-07-20): the loop
  // masters are a NEW spend source and ship OFF. Both this AND a card's own
  // `enabled: true` must hold for any groundskeeper to run — default is OFF when
  // the var is unset/empty so a fresh checkout never generates work unattended.
  groundskeepersEnabled: ["1", "true", "yes", "on"].includes((process.env.GROUNDSKEEPERS_ENABLED ?? "").trim().toLowerCase()),

  // Gap-5 post-merge deploy/smoke/revert GLOBAL kill-switch. Deploy is a NEW
  // spend + blast-radius surface (it runs a project's real deploy command and
  // can auto-revert main), so it ships OFF exactly like groundskeepersEnabled:
  // unset/empty/0 = disabled. Both this AND a project card's own
  // `deployEnabled: true` must hold — the groundskeeper double-gate applied to
  // deploys. Leave at 0 unless you intend unattended deploys.
  deployEnabled: ["1", "true", "yes", "on"].includes((process.env.DEPLOY_ENABLED ?? "").trim().toLowerCase()),
  // Default GitHub org/owner for `gh repo create` during project bootstrap
  // (Gap 5). A bootstrap ticket may name org/slug explicitly; this is the
  // fallback owner. Empty means the ticket MUST name a fully-qualified org.
  bootstrapOrg: (process.env.FACTORY_BOOTSTRAP_ORG ?? "").trim(),
  // Optional override for where project registry cards (projects/<name>.md)
  // live — the human-gated routing config that says which repos the factory may
  // build/deploy into. Empty (the default) → registry.ts uses its module-
  // relative projects/ dir, exactly like groundskeepers/. Only set to relocate
  // the cards off the repo tree.
  projectsDir: (process.env.FACTORY_PROJECTS_DIR ?? "").trim() ? expandHome(process.env.FACTORY_PROJECTS_DIR!) : "",

  proxyAll: (process.env.PROXY_ALL ?? "1") !== "0",
  // The factory's OWN repo slug — NEVER auto-merged regardless of enrollment or
  // ceiling (isSelfRepo in merge-ladder.ts also matches any `.../factory`).
  selfRepo: (process.env.FACTORY_SELF_REPO ?? "").trim(),
  // Gap-2 evidence-gated merge ladder. A repo is ENROLLED (here or via the
  // retained MERGE_AUTO_REPOS) but STILL starts at "shadow" and must EARN
  // auto-merge over `promoteAfter` consecutive clean shadow decisions. Ceiling
  // caps how far a repo can climb; MERGE_AUTO_REPOS repos default to ceiling
  // "auto", any other enrolled repo to "auto-low-risk". None of this is derivable
  // from ticket text — the earning is measured from verification evidence only.
  mergeLadder: {
    enrolled: (process.env.MERGE_LADDER_REPOS ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    ceiling: parsePairs(process.env.MERGE_LADDER_CEILING),
    promoteAfter: num("MERGE_LADDER_PROMOTE_AFTER", 10),
    lowRiskMaxDiff: num("MERGE_LADDER_LOW_RISK_MAX_DIFF", 40),
  },
  // Repos where the factory may merge its own green, unguarded PRs. RETAINED but
  // re-interpreted (Gap 2): a repo here is enrolled with ceiling "auto" and STILL
  // starts at shadow — it must earn auto-merge through the ladder, not flip on.
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
