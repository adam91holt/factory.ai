import { homedir } from "node:os";
import { resolve } from "node:path";
// risk.ts is pure and import-free (routing.ts precedent), so this creates no
// cycle even though meta.ts value-imports config from this module.
import { gateTiersDeclared, vendorDiversityPolicy, vendorDiversityViolations, type TierConfig } from "./risk.ts";

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
// The SDK's reasoning-effort levels (query() options.effort). Duplicated here
// rather than imported from meta.ts's identical EFFORT_VALUES — meta.ts
// already value-imports `config` from this module, so importing back would
// create a circular value dependency; a five-string literal set is cheap
// enough to keep independently, matching how LADDER_TIERS above is its own
// local list rather than sourced from merge-ladder.ts.
const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);
type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
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

// A tier model env value: same plain-identifier shape every model id in this
// file has (see fallbackModel below). Malformed/empty → undefined, i.e. "that
// tier is not configured" — never a garbage id handed to the SDK.
function tierModel(name: string): string | undefined {
  const value = (process.env[name] ?? "").trim();
  return /^[A-Za-z0-9._-]{1,80}$/.test(value) ? value : undefined;
}
// Both tier slots for one stage, from `<PREFIX>_CHEAP` / `<PREFIX>_STRONG`
// (e.g. FIXER_MODEL_CHEAP). Unset slots are omitted so an empty declaration
// object means exactly "standard model at every tier" (risk.ts resolveTierModel
// falls back), keeping pre-tier configs byte-identical in behavior.
function tierPair(prefix: string): { cheap?: string; strong?: string } {
  const cheap = tierModel(`${prefix}_CHEAP`);
  const strong = tierModel(`${prefix}_STRONG`);
  return { ...(cheap !== undefined ? { cheap } : {}), ...(strong !== undefined ? { strong } : {}) };
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

  // Risk-based model tiers (issue #6 Part 2, src/risk.ts). OPTIONAL per-stage
  // cheap/strong models layered over config.models above: the existing
  // per-stage env var IS the "standard" tier, and any tier left undeclared
  // resolves to it — so a config that sets none of these behaves EXACTLY as
  // today at every risk class (additive-only). Operator-set only, via env
  // vars, like every model in this file: ticket text cannot reach these (the
  // meta.ts isKnownModel allowlist is deliberately NOT widened to include
  // tier models — a ticket may request only roster models, and risk class
  // itself is evidence-derived in code, never parsed from a description).
  // WHICH tier serves a stage at a given risk class is the in-code
  // RISK_MODEL_TIERS table in risk.ts, not a knob. The implementer has no
  // tier pair on purpose: risk is derived from its own diff, which does not
  // exist yet when it starts (see risk.ts RiskRoutedStage).
  modelTiers: {
    fixer: tierPair("FIXER_MODEL"),
    reviewerClaude: tierPair("REVIEWER_CLAUDE_MODEL"),
    reviewerCodex: tierPair("REVIEWER_CODEX_MODEL"),
    securityReviewer: tierPair("SECURITY_REVIEWER_MODEL"),
    designReviewer: tierPair("DESIGN_REVIEWER_MODEL"),
    tester: tierPair("TESTER_MODEL"),
  } satisfies TierConfig as TierConfig,

  // #14/#11 resilience: optional GLOBAL fallback model agents.ts's runStage
  // fails a stage over to once its primary model exhausts bounded retries on a
  // TRANSIENT error (429 / "cooling down" / network drop — see agents.ts
  // isTransientStageError). This is the direct fix for the outage where one
  // rate-limited provider — with the whole roster on a single model — took the
  // entire factory down (reviews aborted, tasks parked, steward failed).
  // Operator-set only, via env var: NEVER sourced from ticket text. meta.ts's
  // per-ticket `model:` override is untouched by this addition and keeps
  // validating against Object.values(config.models) exactly as before, so a
  // ticket can never smuggle an unvetted model in through this door either —
  // this is a pure resilience knob, not a new authority surface. Validated
  // against the same plain-identifier shape every model id in this file has
  // (short alias like "opus"/"fable" or a vendor id like "gpt-5.6-sol"); a
  // malformed value (empty, whitespace, control characters) is dropped rather
  // than handed to the SDK. Empty (default, unset) = no fallback configured —
  // a stage that exhausts retries on a genuine 429 still fails exactly as it
  // did before this fix; agents.ts logs loudly that a fallback would have
  // helped, so an operator can see the gap instead of just seeing "parked".
  fallbackModel: /^[A-Za-z0-9._-]{1,80}$/.test((process.env.FALLBACK_MODEL ?? "").trim())
    ? (process.env.FALLBACK_MODEL ?? "").trim()
    : "",

  // Global default reasoning-effort (execution-profiles): the fallback every
  // stage's resolveEffort (meta.ts) lands on when neither the ticket meta nor
  // the stage's agent card declares one. Operator-set only, via env var, exactly
  // like fallbackModel above — enum-validated so a malformed/typo'd env value
  // can never reach the SDK's query() options.effort verbatim. Deliberately
  // undefined (not "medium") when DEFAULT_EFFORT is unset: effort is
  // strictly opt-in end-to-end (see resolveEffort in meta.ts), so a ticket
  // and operator setup that specify no effort at all fall all the way
  // through to `undefined`, agents.ts omits the `effort` key from the SDK
  // call, and the SDK's own documented default ("high") stands — exactly
  // the behavior every stage had before this feature existed. An operator
  // who wants a different global floor sets DEFAULT_EFFORT explicitly.
  defaultEffort: (EFFORT_VALUES.has((process.env.DEFAULT_EFFORT ?? "").trim())
    ? (process.env.DEFAULT_EFFORT ?? "").trim()
    : undefined) as EffortLevel | undefined,

  workRoot: expandHome(process.env.FACTORY_WORK_ROOT ?? "~/FactoryWork"),

  // Durable store connection string (src/db.ts → src/store.ts). Postgres is the
  // ONLY production path; the checked-in docker-compose.yml brings up the
  // matching loopback instance on 127.0.0.1:5460 (`bun run db:up`).
  //
  // This is an env var and NOT an in-code constant on purpose, and it does not
  // contradict "safety caps are in-code constants": a connection string is
  // deployment topology, not a cap — there is no value of it that widens the
  // factory's authority or removes a bound. It is also a SECRET (it carries the
  // password), so it is scrubbed out of every worker env in agents.ts and is
  // never emitted. Tests set it to "" (tests/setup.ts) and run on the in-process
  // PGlite seam instead, so no test can ever reach a real database.
  // UNSET falls back to the compose default. Explicitly EMPTY means "no
  // database configured" and startEventStore() refuses to open one — that is
  // what tests/setup.ts sets, so no unit test can ever reach a real Postgres.
  databaseUrl: process.env.FACTORY_DATABASE_URL === undefined
    ? "postgres://factory:factory-local-dev@127.0.0.1:5460/factory"
    : process.env.FACTORY_DATABASE_URL.trim(),

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

  // Approvals inbox macOS notification (notify.ts): when a run files an
  // approval item, ping the owner via osascript so held work is noticed in
  // minutes, not at the next dashboard glance. ON by default because it is
  // pure local UX (no spend, no remote call, throttled to one per item);
  // APPROVALS_NOTIFY=0 disables. No-op off macOS regardless.
  approvalsNotify: (process.env.APPROVALS_NOTIFY ?? "1").trim() !== "0",

  // Extra origins the dashboard's write-route guard (server.ts
  // guardedJsonBody) accepts IN ADDITION to loopback — exact full-origin
  // matches only (scheme+host+port). Purpose: the owner serving mission
  // control over `tailscale serve`, where the browser's Origin/Host are the
  // ts.net name, not 127.0.0.1. Operator-set env, never ticket-derived, and
  // an empty default keeps the guard byte-identical to its loopback-only
  // behavior. DNS-rebinding stays dead: a rebound attacker page carries the
  // ATTACKER'S domain in Origin/Host, which exact-matches nothing here.
  trustedOrigins: (process.env.FACTORY_TRUSTED_ORIGINS ?? "").split(",")
    .map((o) => o.trim().replace(/\/+$/, "").toLowerCase()).filter((o) => /^https?:\/\//.test(o)),

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
  // Auto-merge-by-default (operator opt-in via AUTO_MERGE_DEFAULT=1; default OFF so
  // the capability ships dormant). When ON, a non-self repo defaults to the "auto"
  // tier instead of "human" — so a CLEAN task (decideMerge.wouldMerge: green+strong,
  // unguarded, no needs-human fold, security not-fail, browser ok) merges with no
  // human. This changes ONLY the default tier; every SAFETY condition still routes
  // to needs_human via decideMerge/the holdReasons folds. Never derived from ticket
  // text (untrusted description can only WITHHOLD via merge:review, never grant).
  autoMergeDefault: (process.env.AUTO_MERGE_DEFAULT ?? "0") === "1",
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

// Vendor-diversity assertion (issue #6 Part 2): for high/critical risk, the
// security reviewer must not resolve to the same vendor as BOTH adversarial
// code-review legs — one vendor holding every judgment is the silent collapse
// the .env comments used to be the only defense against. Enforced HERE, at
// config load, so a collapsed config fails before any ticket is claimed —
// but only ONCE the operator has declared gate-stage tier models (adopted the
// feature); a pre-tier config that declares none of the new vars must keep
// booting exactly as today (additive-only), so it gets a loud per-start
// warning instead of a crash. The decision itself is pure and pinned by
// tests/risk.test.ts (vendorDiversityPolicy).
{
  const violations = vendorDiversityViolations(
    { reviewerClaude: config.models.reviewerClaude, reviewerCodex: config.models.reviewerCodex, securityReviewer: config.models.securityReviewer },
    config.modelTiers,
  );
  const policy = vendorDiversityPolicy(violations, gateTiersDeclared(config.modelTiers));
  if (policy === "throw") {
    throw new Error(`vendor-diversity: ${violations.join("; ")} — point REVIEWER_CLAUDE_MODEL(_STRONG), REVIEWER_CODEX_MODEL(_STRONG) or SECURITY_REVIEWER_MODEL(_STRONG) at a different model family`);
  }
  if (policy === "warn") {
    console.error(`[config] vendor-diversity WARNING (not fatal — no gate-stage tier vars declared): ${violations.join("; ")}`);
  }
}
