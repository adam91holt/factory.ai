// Structured factory metadata block — the robust replacement for regex-over-
// prose ticket parsing (Linear's API has no custom fields, so we carry typed
// key:values in an HTML-comment block, set ATOMICALLY in the description at
// issueCreate). Invisible in Linear's rendered markdown; parsed as explicit
// key:value pairs. This kills two bug classes: the create-then-label race
// (the block is present the instant the issue exists) and section-header
// parse drift (LLMs format `## Repo (x)` vs `## Repo\nx` inconsistently).

import { config } from "./config.ts";
import { parsePrecondition } from "./precondition.ts";
import { resolveTierModel, type RiskClass, type RiskRoutedStage } from "./risk.ts";

export interface FactoryMeta {
  repo?: string;                       // org/name — machine-exact, no regex
  // routing. epic → planner; task → pipeline; idea → intake authoring (Gap 5);
  // bootstrap → project bootstrap (Gap 5). idea/bootstrap parse ONLY at offset 0
  // like every other key (start-anchor) so injected prose can never reroute a
  // ticket into repo-creation or the intake interview.
  type?: "epic" | "task" | "idea" | "bootstrap";
  // Per-ticket model override. Historically scoped to implementer/fixer only;
  // resolveModel now consults it for every stage EXCEPT the cross-vendor gate
  // stages (reviewerClaude, reviewerCodex, securityReviewer — see GATE_STAGES
  // below), which always run their config.models default regardless of this
  // field, `models`, or the "*" wildcard. A value here still passes isKnownModel
  // at parse time, same as every other model source.
  model?: string;                      // per-ticket model override (implementer/fixer/etc — gate stages excluded)
  // Per-STAGE model overrides (execution-profiles). Keys are stage names
  // (matching config.models's keys — implementer, reviewerClaude, reviewerCodex,
  // fixer, scout, planner, steward, designReviewer, tester, securityReviewer,
  // distiller) plus the wildcard "*" for a blanket override. Parsed from a
  // compact "stage=model stage2=model2" line. Each VALUE is validated against
  // the exact same isKnownModel allowlist as the legacy `model` field below —
  // an unknown/injected model id is dropped and the stage falls back through
  // resolveModel's chain, never forcing an arbitrary model or a specific proxy
  // route. The STAGE NAME is free text at parse time (only capped in count/
  // length): an unrecognized key is simply never read by resolveModel, so it
  // costs nothing and grants nothing — the allowlist protection is entirely on
  // the model VALUE, exactly like `model`. Default undefined so a description
  // with no `models:` line renders a byte-identical block to today. NOTE: even
  // a stage-specific or "*" entry here is ignored by resolveModel for the
  // cross-vendor gate stages (reviewerClaude, reviewerCodex, securityReviewer)
  // — the allowlist confines the VALUE to the roster but places no constraint
  // on vendor, so pinning those stages to config.models is what actually
  // defends the cross-vendor invariant (see GATE_STAGES).
  models?: Record<string, string>;
  // per-ticket merge policy. UNREAD today (auto-merge is gated solely on
  // config.autoMergeRepos). If ever wired in, a description-sourced value may
  // only WITHHOLD auto-merge, never GRANT it — untrusted text must not confer
  // merge authority on a repo the operator did not allowlist.
  merge?: "auto" | "shadow" | "review";
  // Gap-1 DAG scheduling. depends_on carries sibling identifiers (e.g.
  // ["FAC-123","FAC-124"]) that must all reach a completed state before this
  // child is claimed (the topological frontier); touches carries the path globs
  // this child will modify — the file-level mutex key that serializes any two
  // children whose globs overlap. Both are set only by the decomposer (plan.ts)
  // and default to undefined so today's children render a byte-identical block.
  depends_on?: string[];
  touches?: string[];
  // Gap-4 freshness/idempotency preconditions. Each entry is a raw DSL string
  // ("pr-open acme/w#4", "path-missing src/x.ts") re-checked by precondition.ts
  // at stage start; a fully-satisfied premise cancels the ticket, a partially-
  // satisfied or unconfirmable one parks it. COLLECTED (one per `precondition:`
  // meta line, not overwritten) and each validated via parsePrecondition — an
  // injected/malformed line is dropped. Like `merge`, a precondition may only
  // ever STOP work, never grant authority. Default undefined so a child with no
  // preconditions renders a byte-identical block.
  preconditions?: string[];
  // Per-ticket/per-stage reasoning-effort override (execution-profiles). Two
  // forms, mirroring `model`/`models` above but folded into ONE field per the
  // build spec: a bare scalar ("effort: high") sets the default for every
  // non-gate stage; a "stage=level stage2=level2" line (detected by the "="
  // in each token, same tokenizing as `models`) sets specific stages. Each
  // value is independently validated against the fixed EFFORT_VALUES enum —
  // an unknown/injected level (e.g. "effort: max-plus-plus" or a huge string)
  // is dropped, never widening to an unbounded value the SDK is handed
  // verbatim. Like `models`, resolveEffort below never lets this field reach
  // the cross-vendor gate stages (GATE_STAGES) — an untrusted description
  // must not be able to weaken a safety reviewer's reasoning depth (e.g.
  // `effort: securityReviewer=low`) to make a real vulnerability more likely
  // to slip through; that is a strength downgrade with the same abuse shape
  // isKnownModel's vendor-pin already defends against, just via effort
  // instead of model choice. Default undefined so a description with no
  // `effort:` line renders a byte-identical block to today.
  effort?: Record<string, string> | string;
}

// The SDK's reasoning-effort levels (query() options.effort — see
// @anthropic-ai/claude-agent-sdk's EffortLevel). Fixed enum, never derived
// from ticket text: parseFactoryMeta only ever stores a value that already
// passed isKnownEffort, exactly like isKnownModel confines `model`/`models`.
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORT_VALUES: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
export function isKnownEffort(value: string): value is Effort {
  return EFFORT_VALUES.has(value);
}

// Caps on the array-valued keys so injected junk in an untrusted description
// can't bloat the block or the per-tick dependency query (touches feeds a glob
// comparison, depends_on feeds a Linear number:{in:[…]} filter).
const MAX_ARRAY_ENTRIES = 32;
const MAX_ENTRY_LENGTH = 200;
// A Linear identifier: TEAM-123 (uppercase team key, digits). Anything that
// doesn't match is dropped from depends_on — an injected or malformed id must
// never become a phantom dependency that blocks a child forever.
const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;
// A `models:` stage key: the wildcard "*" or a plain camelCase-ish identifier
// (matches config.models's key shape). Anything else is dropped — the value
// is what actually carries risk (validated against isKnownModel below), but a
// malformed key is still rejected rather than silently stored.
const STAGE_KEY = /^(\*|[A-Za-z][A-Za-z0-9]*)$/;

// Authoritative read is START-ANCHORED: only a factory block at the very start
// of the description is honored. A block buried in prose, a quoted example, or
// pasted/untrusted content must NEVER reroute repo, escalate model, or flip
// type (confused-deputy / injection — the block is invisible in rendered
// markdown). withFactoryMeta always PREPENDS the stamp, so every machine-set
// block sits at offset 0 and parses unchanged; a no-block description still
// returns {} so the ## Repo / label fallbacks are preserved.
const BLOCK = /^\s*<!--\s*factory\b([\s\S]*?)-->/i;
// Strip is global + unanchored so re-stamping removes ANY pre-existing block
// wherever it sits (including one an LLM embedded), leaving no orphan a future
// "read the last block" change could honor.
const BLOCK_STRIP = /<!--\s*factory\b[\s\S]*?-->/gi;

// Per-ticket model overrides are restricted to the models this factory is
// actually configured to run: an unrecognized id (typo or injected) is dropped
// and the stage falls back to config.models.* — never forcing a proxy route,
// pinning an arbitrary model, or guaranteeing a park.
function isKnownModel(value: string): boolean {
  return (Object.values(config.models) as string[]).includes(value);
}

/** Parse the factory metadata block. Tolerant: unknown keys ignored, missing
 * block returns {}. Never throws. */
export function parseFactoryMeta(description: string): FactoryMeta {
  const block = description.match(BLOCK);
  if (!block?.[1]) return {};
  const meta: FactoryMeta = {};
  for (const line of block[1].split("\n")) {
    // [a-z_] (not [a-z]) so snake_case keys like "depends_on" parse — the
    // scalar keys (repo/type/model/merge) are single-word and unaffected.
    const kv = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.replace(/^["'`]|["'`]$/g, "").trim();
    if (key === "repo" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) meta.repo = value;
    else if (key === "type" && (value === "epic" || value === "task" || value === "idea" || value === "bootstrap")) meta.type = value;
    else if (key === "model" && value && isKnownModel(value)) meta.model = value;
    else if (key === "models") {
      // Compact "stage=model stage2=model2" syntax, whitespace-separated.
      // Token-count capped like the other array keys; each token independently
      // validated (malformed shape / unknown stage key / unlisted model id are
      // each dropped with a log line rather than throwing or silently keeping
      // the whole line).
      const map: Record<string, string> = {};
      for (const tok of value.split(/\s+/).filter(Boolean).slice(0, MAX_ARRAY_ENTRIES)) {
        const eq = tok.indexOf("=");
        if (eq <= 0 || eq === tok.length - 1) { console.warn(`[meta] dropping malformed models entry "${tok}" (expected stage=model)`); continue; }
        const stageKey = tok.slice(0, eq);
        const modelVal = tok.slice(eq + 1);
        if (!STAGE_KEY.test(stageKey)) { console.warn(`[meta] dropping models entry with invalid stage key "${stageKey}"`); continue; }
        if (!isKnownModel(modelVal)) { console.warn(`[meta] dropping models entry for "${stageKey}": unknown model "${modelVal}"`); continue; }
        map[stageKey] = modelVal;
      }
      if (Object.keys(map).length > 0) meta.models = map;
    }
    else if (key === "effort") {
      // Same compact tokenizing as `models`, but the scalar form ("effort: high",
      // exactly one token with no "=") is distinguished from the per-stage map
      // form ("effort: stage=level ...", one or more "=" tokens) up front — the
      // two forms are mutually exclusive per line, matching how the DSL reads.
      const tokens = value.split(/\s+/).filter(Boolean);
      if (tokens.length === 1 && !tokens[0]!.includes("=")) {
        if (isKnownEffort(tokens[0]!)) meta.effort = tokens[0];
        else console.warn(`[meta] dropping unknown effort value "${tokens[0]}"`);
      } else {
        const map: Record<string, string> = {};
        for (const tok of tokens.slice(0, MAX_ARRAY_ENTRIES)) {
          const eq = tok.indexOf("=");
          if (eq <= 0 || eq === tok.length - 1) { console.warn(`[meta] dropping malformed effort entry "${tok}" (expected stage=level)`); continue; }
          const stageKey = tok.slice(0, eq);
          const effortVal = tok.slice(eq + 1);
          if (!STAGE_KEY.test(stageKey)) { console.warn(`[meta] dropping effort entry with invalid stage key "${stageKey}"`); continue; }
          if (!isKnownEffort(effortVal)) { console.warn(`[meta] dropping effort entry for "${stageKey}": unknown effort "${effortVal}"`); continue; }
          map[stageKey] = effortVal;
        }
        if (Object.keys(map).length > 0) meta.effort = map;
      }
    }
    else if (key === "merge" && (value === "auto" || value === "shadow" || value === "review")) meta.merge = value;
    else if (key === "depends_on") {
      // Split, trim, drop empties, keep only well-formed identifiers, cap count.
      const ids = value.split(",").map((s) => s.trim()).filter((s) => IDENTIFIER.test(s)).slice(0, MAX_ARRAY_ENTRIES);
      if (ids.length > 0) meta.depends_on = ids;
    } else if (key === "touches") {
      // Split, trim, drop empties, cap count and per-entry length so an injected
      // glob can't bloat the block or the overlap comparison.
      const globs = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= MAX_ENTRY_LENGTH).slice(0, MAX_ARRAY_ENTRIES);
      if (globs.length > 0) meta.touches = globs;
    } else if (key === "precondition") {
      // COLLECT one entry per line (do not overwrite), validating each via the
      // same allowlist parse precondition.ts uses — a malformed/injected DSL
      // line is dropped rather than throwing. Capped like the other arrays.
      const p = parsePrecondition(value);
      if (p) {
        (meta.preconditions ??= []).push(p.raw);
        if (meta.preconditions.length >= MAX_ARRAY_ENTRIES) meta.preconditions = meta.preconditions.slice(0, MAX_ARRAY_ENTRIES);
      }
    }
  }
  return meta;
}

/** B5: which bookend (if any) a ticket routes to — epic → planner, idea →
 *  intake authoring, bootstrap → project bootstrap, or null for an ordinary
 *  ticket. The factory META block is AUTHORITATIVE over labels when it
 *  declares one of these three types: before this fix, index.ts computed
 *  isEpic/isIdea/isBootstrap as independent `label OR meta` checks, so a
 *  ticket whose meta was rewritten to type:epic but whose stale
 *  Factory-Intake label lingered (e.g. intake.ts's removeLabel(INTAKE_LABEL)
 *  failing after the description rewrite, swallowed at intake.ts ~193)
 *  satisfied BOTH isEpic and isIdea — and was excluded from every routing
 *  `find()` (each requires the others false), silently skipped forever. Here,
 *  a meta type of epic/idea/bootstrap always wins outright; only when the
 *  block is absent or names the ordinary "task" type do labels decide (the
 *  unchanged pre-fix behavior for tickets with no meta block at all, e.g. a
 *  human manually applying Factory-Epic). */
export type TicketRoute = "epic" | "idea" | "bootstrap" | null;

export function resolveTicketRoute(
  description: string,
  labels: { epic: boolean; idea: boolean; bootstrap: boolean },
): TicketRoute {
  const metaType = parseFactoryMeta(description).type;
  if (metaType === "epic" || metaType === "idea" || metaType === "bootstrap") return metaType;
  if (labels.epic) return "epic";
  if (labels.idea) return "idea";
  if (labels.bootstrap) return "bootstrap";
  return null;
}

/** Render a metadata block to prepend to a ticket description. Omits empty keys
 * (scalar undefined/"" AND empty arrays) so a child with no DAG data renders a
 * block byte-identical to today's — the backward-compat guarantee. Array values
 * serialize as a comma-space list ("depends_on: FAC-1, FAC-2"). */
export function renderFactoryMeta(meta: FactoryMeta): string {
  // preconditions serialize as ONE `precondition: <dsl>` line PER entry (not a
  // comma-joined list like depends_on/touches), and `models` serializes as a
  // single "stage=model stage2=model2" line (sorted by stage key for a
  // deterministic, diff-stable render) — both handled separately from the
  // generic scalar/array loop below.
  const lines = Object.entries(meta)
    .filter(([k]) => k !== "preconditions" && k !== "models" && k !== "effort")
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== ""))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  if (meta.models && Object.keys(meta.models).length > 0) {
    const pairs = Object.entries(meta.models).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
    lines.push(`models: ${pairs.join(" ")}`);
  }
  if (typeof meta.effort === "string" && meta.effort) {
    lines.push(`effort: ${meta.effort}`);
  } else if (meta.effort && typeof meta.effort === "object" && Object.keys(meta.effort).length > 0) {
    const pairs = Object.entries(meta.effort).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
    lines.push(`effort: ${pairs.join(" ")}`);
  }
  for (const pre of meta.preconditions ?? []) lines.push(`precondition: ${pre}`);
  if (lines.length === 0) return "";
  return `<!-- factory\n${lines.join("\n")}\n-->`;
}

// Cross-vendor safety-gate stages: reviewerClaude + reviewerCodex form the
// deliberate two-vendor adversarial review pair, and securityReviewer is
// cross-vendor by design (config.ts: "so a Claude author is not the sole
// security judge of its own diff"). isKnownModel confines a description-
// sourced override to the operator's roster but places NO constraint on
// VENDOR — an untrusted ticket with `models: securityReviewer=opus` (or the
// blanket `models: *=sonnet`, or even the legacy `model: opus`) would
// otherwise pass the allowlist and silently collapse the gate onto the same
// vendor as the implementer. These three stages are therefore pinned to
// config.models — resolveModel below never consults meta for them, so no
// description-sourced field (stage-specific, "*", or legacy `model`) can
// reach them. This is an intentional, absolute exclusion, not a preference:
// an operator who wants to change a gate stage's model does so via
// config.models / the stage's env var, never via ticket text.
const GATE_STAGES: ReadonlySet<keyof typeof config.models> = new Set([
  "reviewerClaude", "reviewerCodex", "securityReviewer",
]);

/** Per-stage model resolution (execution-profiles): for every stage EXCEPT
 * the cross-vendor gate stages (GATE_STAGES above, always pinned to
 * config.models[stage]) — stage-specific meta override > wildcard "*" meta
 * override > the legacy scalar `model` field (equivalent to models["*"],
 * kept working for back-compat, now reaching every non-gate stage rather
 * than just implementer/fixer) > the operator's config.models default for
 * that stage. Pure — no I/O — so every non-gate stage call site gets a
 * one-line lookup instead of the old ad-hoc `ovr || config.models.x` that
 * only implementer/fixer ever had; every other non-gate stage (scout,
 * planner, steward, tester, designReviewer) always ran the global config
 * default, so one provider's 429 could take the whole roster down.
 * `stage` is constrained to config.models's own keys, so the fallback branch
 * is always a real, operator-configured model id — this function performs NO
 * validation itself; every value it can possibly return already passed
 * isKnownModel at parse time (meta.models / meta.model) or was set directly
 * by the operator (config.models). An unrecognized key in meta.models (one
 * that doesn't match any `stage` ever passed here) is simply never read. */
export function resolveModel(stage: keyof typeof config.models, meta: FactoryMeta): string {
  if (GATE_STAGES.has(stage)) return config.models[stage];
  return meta.models?.[stage] ?? meta.models?.["*"] ?? meta.model ?? config.models[stage];
}

/** Did the TICKET explicitly request a model for this stage (models: entry,
 *  the "*" wildcard, or the legacy scalar `model:`)? Always false for the
 *  cross-vendor gate stages — meta is never consulted for them (GATE_STAGES
 *  above), so nothing a description says can count as a pin there. Used by
 *  resolveModelForRisk: an explicit, isKnownModel-validated ticket request is
 *  a legitimate NARROWING (the ticket may request within the operator's
 *  roster — docs/ticket-contract.md) and outranks the risk-tier adjustment. */
export function metaPinsModel(stage: keyof typeof config.models, meta: FactoryMeta): boolean {
  if (GATE_STAGES.has(stage)) return false;
  return (meta.models?.[stage] ?? meta.models?.["*"] ?? meta.model) !== undefined;
}

/** Risk-aware model resolution (issue #6 Part 2) for the risk-routed stages —
 *  resolveModel's precedence chain with ONE extra, evidence-driven layer at
 *  the bottom:
 *
 *    ticket meta pin (non-gate stages only, isKnownModel-validated)
 *      > risk-tier model (risk.ts RISK_MODEL_TIERS × config.modelTiers —
 *        BOTH inputs operator/code-owned: the table is in-code and the tier
 *        models come from env vars, so no description-sourced value exists
 *        anywhere in this leg; `risk` itself is derived by deriveRiskClass
 *        from diff/worktree evidence, never ticket text)
 *      > config.models[stage] (today's default).
 *
 *  The GATE_STAGES pin is inherited intact from resolveModel: for
 *  reviewerClaude/reviewerCodex/securityReviewer the base is always
 *  config.models[stage] and meta can never pin, so the ONLY thing risk can do
 *  to a safety gate is swap in another operator-declared model — and
 *  RISK_MODEL_TIERS never maps a gate stage below "standard", so it can only
 *  ever be a STRONGER one. `risk === undefined` (caller has no evidence yet)
 *  returns resolveModel verbatim — the additive path. */
export function resolveModelForRisk(stage: RiskRoutedStage, meta: FactoryMeta, risk: RiskClass | undefined): string {
  const base = resolveModel(stage, meta);
  if (risk === undefined || metaPinsModel(stage, meta)) return base;
  return resolveTierModel(stage, risk, config.modelTiers, base);
}

/** Per-stage reasoning-effort resolution (execution-profiles), the effort
 * counterpart to resolveModel above. Precedence: meta per-stage entry > meta
 * single-default (the scalar `effort:` form) > the card's own frontmatter
 * `effort:` (agents/<stage>.md — operator-authored, git-committed, NOT
 * ticket-sourced) > config.defaultEffort. `cardEffort` is passed in by the
 * caller (already read via catalog getCard) rather than looked up here, so
 * this function stays pure/I/O-free like resolveModel.
 *
 * Effort is strictly OPT-IN: when none of those sources specifies a value,
 * this returns `undefined` rather than manufacturing one. agents.ts already
 * omits the SDK call's `effort` key when it receives `undefined` (see its
 * `...(opts.effort ? { effort: opts.effort } : {})` spread), so an
 * unconfigured stage falls through to the SDK's own documented default
 * ("high") verbatim — identical to how every stage behaved before this
 * feature existed. This is deliberate: a formerly-decorative card value or a
 * newly-added feature must never manufacture a silent reasoning-depth
 * reduction that no ticket or operator asked for.
 *
 * The three cross-vendor GATE_STAGES (reviewerClaude, reviewerCodex,
 * securityReviewer) are pinned exactly like resolveModel pins their model: an
 * untrusted description must never be able to dial a safety reviewer's
 * reasoning effort down to make it more likely to wave through a real
 * problem. Meta is never consulted for these three; only the trusted card
 * default (if any) and config.defaultEffort apply — the same "operator-
 * authored sources only" boundary resolveModel draws for the model itself.
 * (Their cards are pinned at `effort: high` — see agents/reviewer-spec.md,
 * agents/reviewer-repo.md, agents/security-reviewer.md — so this pinning
 * path itself no longer downgrades the gate; it only stops a ticket from
 * reaching it.) */
export function resolveEffort(stage: keyof typeof config.models, meta: FactoryMeta, cardEffort?: string): Effort | undefined {
  const trustedCardEffort = cardEffort && isKnownEffort(cardEffort) ? cardEffort : undefined;
  if (GATE_STAGES.has(stage)) return trustedCardEffort ?? config.defaultEffort;
  const metaMap = typeof meta.effort === "object" ? meta.effort : undefined;
  const metaScalar = typeof meta.effort === "string" ? meta.effort : undefined;
  const metaStageValue = metaMap?.[stage];
  return (metaStageValue && isKnownEffort(metaStageValue) ? metaStageValue : undefined)
    ?? (metaScalar && isKnownEffort(metaScalar) ? metaScalar : undefined)
    ?? trustedCardEffort
    ?? config.defaultEffort;
}

/** Prepend/replace the block in a description (idempotent). */
export function withFactoryMeta(description: string, meta: FactoryMeta): string {
  const body = description.replace(BLOCK_STRIP, "").replace(/^\s+/, "");
  const block = renderFactoryMeta(meta);
  return block ? `${block}\n\n${body}` : body;
}
