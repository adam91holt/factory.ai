// Risk-based model routing (issue #6 Part 2). One pure module, three jobs:
//
//   1. RISK CLASS — classify a run (low|medium|high|critical) from EVIDENCE
//      ONLY: the implementer's committed diff shape, guarded paths, and
//      sensitive-path patterns. Ticket text is not an input anywhere in this
//      file — no description, no FactoryMeta, no parse of anything a ticket
//      author controls. That is the same discipline merge-ladder.ts draws for
//      merge evidence: an untrusted ticket must be structurally unable to
//      LOWER its own risk (dodging the strong reviewers) or RAISE a sibling's
//      (burning its budget). tests/risk.test.ts pins the module import-free.
//
//   2. MODEL TIERS — resolve which tier (cheap|standard|strong) serves each
//      risk-routed stage at each risk class (RISK_MODEL_TIERS, an in-code
//      table), and map that tier onto an operator-configured model id. The
//      "standard" tier IS the existing config.models[stage] value, so an
//      operator who declares no *_MODEL_CHEAP/_STRONG env var gets exactly
//      today's model for every stage at every risk class — the additive-only
//      guarantee lives in resolveTierModel's fallback, not in a caller check.
//
//   3. VENDOR DIVERSITY — the policy that code review and security review are
//      judged by different model FAMILIES (the .env comment that nothing used
//      to enforce), expressed as code: for high/critical risk the security
//      reviewer must not share a vendor with BOTH adversarial code-review
//      legs. vendorDiversityViolations detects it; config.ts applies
//      vendorDiversityPolicy at load (throw once the operator has adopted
//      gate-stage tiers; a loud warning for pre-tier configs, which must keep
//      booting unchanged — see that function's comment).
//
// This file imports NOTHING (routing.ts precedent): pure, I/O-free,
// cycle-free, so config.ts can assert on it at load and loop.ts/meta.ts can
// share the tables without an import cycle. NOT a merge input: merge-ladder.ts
// never reads a risk class, and nothing here appears in MergeEvidence —
// risk decides who reviews the work, never whether the work may land.

// ---------------------------------------------------------------------------
// 1. Risk class.
// ---------------------------------------------------------------------------

export const RISK_CLASSES = ["low", "medium", "high", "critical"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

const RISK_RANK: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The more severe of two classes — folds never lower a class. */
export function maxRiskClass(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

/** In-code thresholds (CLAUDE.md: caps/thresholds are constants, never env
 *  knobs). The medium diff bound deliberately matches the merge ladder's
 *  default lowRiskMaxDiff (40): "low risk" here and "low-risk mergeable" there
 *  describe the same size of change. */
export const RISK_THRESHOLDS = Object.freeze({
  mediumDiffLines: 40,
  highDiffLines: 400,
  mediumFiles: 5,
  highFiles: 20,
});

/** Path patterns whose PRESENCE in a diff raises risk to at least "high" —
 *  the "this touches auth / migrations / secrets, use the strong bench"
 *  signal. Matched against repo-relative paths from the diff, never against
 *  prose. Deliberately tight word shapes (auth-not-author, acl-not-oracle) so
 *  an innocent filename doesn't buy a strong-model bill; a miss only means
 *  standard-tier review, and the guarded-path/security gates still stand. */
export const SENSITIVE_PATH_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/auth(?!or)/i, "authentication/authorization surface"],
  [/migrat/i, "database migration"],
  [/secret|credential|token|passw/i, "secret/credential handling"],
  [/crypt/i, "cryptography"],
  [/payment|billing/i, "payment/billing surface"],
  [/permission|rbac|(^|[^a-z])acl([^a-z]|$)/i, "permission/access-control surface"],
  [/(^|\/)\.env/i, "environment/secret file"],
  [/dockerfile|docker-compose/i, "container/deployment definition"],
];

/** Everything deriveRiskClass may see. Every field is produced IN CODE from
 *  the worktree/diff (loop.ts: countDiffLines, diffFilePaths, repos.ts
 *  guardedPathsTouched / testFilesRemoved) — no field is ever parsed out of a
 *  ticket description, and none may be added that is. */
export interface RiskSignals {
  /** Added+removed source lines (loop.ts countDiffLines over the real diff). */
  diffLines: number;
  /** Repo-relative paths the diff touches (diffFilePaths below). */
  paths: readonly string[];
  /** repos.ts guardedPathsTouched(ws), with the DIFF_FAILED sentinel removed
   *  (that condition arrives as diffUnavailable instead). */
  guardedPaths: readonly string[];
  /** git could not produce the diff at all — classify blind, fail CLOSED. */
  diffUnavailable: boolean;
  /** repos.ts testFilesRemoved(ws) found deletions (categorical human review
   *  downstream; categorical top class here). */
  testFilesRemoved: boolean;
}

export interface RiskAssessment {
  class: RiskClass;
  /** Why — one entry per rule that fired, for the log line and telemetry. */
  reasons: string[];
}

/** Classify one run. Pure and total; table-driven (each rule names its class
 *  and the fold is maxRiskClass, so no rule can ever LOWER the class another
 *  rule set — tighten-only composition, pinned by tests/risk.test.ts). */
export function deriveRiskClass(signals: RiskSignals): RiskAssessment {
  let cls: RiskClass = "low";
  const reasons: string[] = [];
  const raise = (to: RiskClass, why: string): void => {
    cls = maxRiskClass(cls, to);
    reasons.push(`${why} → ${to}`);
  };

  if (signals.diffUnavailable) raise("critical", "diff could not be read (classifying blind, fail closed)");
  if (signals.testFilesRemoved) raise("critical", "change deletes test files");
  if (signals.guardedPaths.length > 0) raise("critical", `guarded paths touched (${signals.guardedPaths.slice(0, 3).join(", ")}${signals.guardedPaths.length > 3 ? ", …" : ""})`);

  const sensitive = new Set<string>();
  for (const path of signals.paths) {
    for (const [re, label] of SENSITIVE_PATH_PATTERNS) {
      if (re.test(path)) sensitive.add(label);
    }
  }
  if (sensitive.size > 0) raise("high", `sensitive paths (${[...sensitive].slice(0, 4).join("; ")})`);

  if (signals.diffLines >= RISK_THRESHOLDS.highDiffLines) raise("high", `${signals.diffLines} changed lines ≥ ${RISK_THRESHOLDS.highDiffLines}`);
  else if (signals.diffLines >= RISK_THRESHOLDS.mediumDiffLines) raise("medium", `${signals.diffLines} changed lines ≥ ${RISK_THRESHOLDS.mediumDiffLines}`);
  if (signals.paths.length >= RISK_THRESHOLDS.highFiles) raise("high", `${signals.paths.length} files touched ≥ ${RISK_THRESHOLDS.highFiles}`);
  else if (signals.paths.length >= RISK_THRESHOLDS.mediumFiles) raise("medium", `${signals.paths.length} files touched ≥ ${RISK_THRESHOLDS.mediumFiles}`);

  if (reasons.length === 0) reasons.push("small, unguarded, non-sensitive diff");
  return { class: cls, reasons };
}

/** Repo-relative paths a unified diff touches (the `b/` side of each
 *  `diff --git` header — the post-change name, so renames count under their
 *  new path). Pure string parsing; feeds RiskSignals.paths. */
export function diffFilePaths(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/.* b\/(.+)$/);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Model tiers.
// ---------------------------------------------------------------------------

export const MODEL_TIERS = ["cheap", "standard", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** The stages risk routing may retarget. Deliberately EXCLUDES the
 *  implementer: risk is derived from the implementer's own diff, which does
 *  not exist when the implementer starts — and the only pre-diff signal that
 *  could stand in for it is ticket text, which this module must never read.
 *  The implementer keeps resolveModel (meta.ts) exactly as today; "spend more
 *  on genuinely hard work" reaches the build side through the escalation
 *  retry below instead. */
export type RiskRoutedStage = "fixer" | "reviewerClaude" | "reviewerCodex" | "securityReviewer" | "designReviewer" | "tester";

/** Operator-declared tier models per stage (config.ts modelTiers, sourced
 *  from `<STAGE>_MODEL_CHEAP` / `<STAGE>_MODEL_STRONG` env vars — operator
 *  config, NEVER ticket text). A missing entry means "that tier is the
 *  standard model" — resolveTierModel falls back, so an empty TierConfig
 *  reproduces today's behavior identically. */
export type TierConfig = Partial<Record<RiskRoutedStage, { cheap?: string; strong?: string }>>;

/** Which tier serves each stage at each risk class. In-code table, not
 *  config: the SHAPE of "how much model does this risk buy" is policy this
 *  repo owns, and an env knob that could dial a critical-risk reviewer down
 *  to cheap isn't a cap. Invariants (pinned by tests/risk.test.ts):
 *    - EVERY stage whose output reaches buildMergeEvidence or a hold reason
 *      (reviewerClaude, reviewerCodex, securityReviewer, designReviewer,
 *      tester — i.e. every gate-verdict producer; only the fixer is exempt,
 *      it produces no verdict) NEVER maps below "standard" — risk routing may
 *      only strengthen a safety gate, never weaken one below the operator's
 *      configured default. This matters most at LOW risk: the low class is
 *      threshold-aligned with the merge ladder's lowRiskMaxDiff, so "low
 *      risk" describes exactly the runs that can auto-merge unattended —
 *      the tester (the only source of the real→strong browser-evidence
 *      upgrade) and the design reviewer (the only source of the taste hold)
 *      must not be the roster's weakest models on precisely those runs;
 *    - every stage at "critical" maps to "strong";
 *    - "medium" is all-standard — the exact pre-feature behavior. */
export const RISK_MODEL_TIERS: Readonly<Record<RiskClass, Readonly<Record<RiskRoutedStage, ModelTier>>>> = Object.freeze({
  low: Object.freeze({ fixer: "cheap", reviewerClaude: "standard", reviewerCodex: "standard", securityReviewer: "standard", designReviewer: "standard", tester: "standard" } as const),
  medium: Object.freeze({ fixer: "standard", reviewerClaude: "standard", reviewerCodex: "standard", securityReviewer: "standard", designReviewer: "standard", tester: "standard" } as const),
  high: Object.freeze({ fixer: "standard", reviewerClaude: "strong", reviewerCodex: "strong", securityReviewer: "strong", designReviewer: "standard", tester: "standard" } as const),
  critical: Object.freeze({ fixer: "strong", reviewerClaude: "strong", reviewerCodex: "strong", securityReviewer: "strong", designReviewer: "strong", tester: "strong" } as const),
});

/** The model that serves `stage` at `risk`: look up the tier in the table,
 *  then the operator's model for that tier — falling back to `baseModel` (the
 *  stage's standard model, i.e. today's resolveModel output) whenever the
 *  tier is "standard" OR the operator declared no model for it. The fallback
 *  is what makes the whole feature additive: no tier vars → every stage, at
 *  every risk class, runs exactly the model it runs today. */
export function resolveTierModel(stage: RiskRoutedStage, risk: RiskClass, tiers: TierConfig, baseModel: string): string {
  const tier = RISK_MODEL_TIERS[risk][stage];
  if (tier === "standard") return baseModel;
  return tiers[stage]?.[tier] ?? baseModel;
}

// ---------------------------------------------------------------------------
// 3. Escalation.
// ---------------------------------------------------------------------------

/** How many tier-escalated retries a run may spend when its gates come up red,
 *  BEFORE the bounded verify-repair rounds. In-code constant, not an env knob
 *  (CLAUDE.md) — an env value of 100 here would be an unbounded spend lever. */
export const MAX_TIER_ESCALATIONS = 1;

/** The model one tier UP from what `stage` is currently running at `risk`, or
 *  null when there is nowhere to go — already at the top tier, or no
 *  higher-tier model configured that actually DIFFERS from the current one
 *  (retrying a failure on the same model is what the repair rounds already
 *  do; an escalation that resolves to the same id is a no-op and returns null
 *  so the caller spends nothing on it). `baseModel` is the stage's standard
 *  model; `currentModel` is what the failing attempt ran on. */
export function escalationModel(stage: RiskRoutedStage, risk: RiskClass, tiers: TierConfig, baseModel: string, currentModel: string): string | null {
  const current = RISK_MODEL_TIERS[risk][stage];
  for (let i = MODEL_TIERS.indexOf(current) + 1; i < MODEL_TIERS.length; i++) {
    const tier = MODEL_TIERS[i]!;
    const candidate = tier === "standard" ? baseModel : tiers[stage]?.[tier];
    if (candidate !== undefined && candidate !== currentModel) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. Vendor diversity.
// ---------------------------------------------------------------------------

/** Model id → vendor (model FAMILY, not serving account: qwen and deepseek
 *  both arrive through the same CLIProxyAPI account but are independent
 *  families, which is the independence the review gates rely on). Substring
 *  table over the operator's roster shapes; an id matching nothing maps to
 *  "unknown:<id>" so two UNRECOGNIZED ids collide only when they are the SAME
 *  id — the main failure being defended against is a future edit pointing
 *  both judges at one model, and identical ids always collide regardless of
 *  recognition. */
export function modelVendor(model: string): string {
  const m = model.trim().toLowerCase();
  const table: ReadonlyArray<readonly [RegExp, string]> = [
    [/claude|opus|sonnet|haiku|fable|anthropic/, "anthropic"],
    [/gpt|codex|openai/, "openai"],
    [/qwen/, "qwen"],
    [/deepseek/, "deepseek"],
    [/glm|zhipu|chatglm/, "zhipu"],
    [/gemini/, "google"],
    [/grok/, "xai"],
    [/mistral|mixtral|devstral|magistral/, "mistral"],
    [/kimi|moonshot/, "moonshot"],
    [/llama/, "meta"],
  ];
  for (const [re, vendor] of table) if (re.test(m)) return vendor;
  return `unknown:${m}`;
}

/** The three gate legs' STANDARD models — config.models's values for them. */
export interface GateLegModels {
  reviewerClaude: string;
  reviewerCodex: string;
  securityReviewer: string;
}

/** Detect vendor collapse between code review and security review at HIGH and
 *  CRITICAL risk (where RISK_MODEL_TIERS resolves all three legs to their
 *  strong tier). A violation is: the security reviewer's vendor equals the
 *  vendor of BOTH adversarial code-review legs — one vendor holding the
 *  entire code-review bench AND the security judgment, i.e. zero cross-vendor
 *  independence left between the two judgments. Deliberately NOT the stricter
 *  "security must differ from the repo-lens leg alone": the shipped defaults
 *  (reviewerCodex and securityReviewer both gpt-5.6-sol, reviewerClaude opus)
 *  have always shared that pair, with the claude leg providing the
 *  independence — a pairwise rule would declare every default config invalid
 *  retroactively. Returns one message per violating risk class; empty = ok. */
export function vendorDiversityViolations(models: GateLegModels, tiers: TierConfig): string[] {
  const out: string[] = [];
  for (const risk of ["high", "critical"] as const) {
    const spec = resolveTierModel("reviewerClaude", risk, tiers, models.reviewerClaude);
    const repo = resolveTierModel("reviewerCodex", risk, tiers, models.reviewerCodex);
    const sec = resolveTierModel("securityReviewer", risk, tiers, models.securityReviewer);
    const secVendor = modelVendor(sec);
    if (modelVendor(spec) === secVendor && modelVendor(repo) === secVendor) {
      out.push(`at ${risk} risk the security reviewer (${sec}) and BOTH code-review legs (${spec}, ${repo}) resolve to one vendor (${secVendor}) — no cross-vendor independence between code review and security review`);
    }
  }
  return out;
}

/** Has the operator declared any tier model for a GATE leg? This is the
 *  "adopted risk-based gate routing" signal vendorDiversityPolicy binds on. */
export function gateTiersDeclared(tiers: TierConfig): boolean {
  return (["reviewerClaude", "reviewerCodex", "securityReviewer"] as const)
    .some((stage) => tiers[stage]?.cheap !== undefined || tiers[stage]?.strong !== undefined);
}

/** How config load reacts to vendor-collapse violations:
 *    - "throw": the operator has declared gate-stage tier models — they are
 *      USING risk-based gate routing, so its vendor-diversity contract binds
 *      in full and a collapsed config must fail LOUDLY at load, before any
 *      ticket is claimed.
 *    - "warn":  violations exist but NO gate-stage tier var is declared — a
 *      config written before this feature. The additive-only rule ("a config
 *      that declares none of the new fields behaves exactly as today") means
 *      it must keep booting; the collapse is still shouted to the console on
 *      every start so the operator sees the gap instead of assuming coverage.
 *    - "ok":    no violations.
 *  Pure so the load-time decision is unit-testable without reloading config. */
export function vendorDiversityPolicy(violations: readonly string[], adopted: boolean): "ok" | "warn" | "throw" {
  if (violations.length === 0) return "ok";
  return adopted ? "throw" : "warn";
}
