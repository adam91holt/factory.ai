// Structured factory metadata block — the robust replacement for regex-over-
// prose ticket parsing (Linear's API has no custom fields, so we carry typed
// key:values in an HTML-comment block, set ATOMICALLY in the description at
// issueCreate). Invisible in Linear's rendered markdown; parsed as explicit
// key:value pairs. This kills two bug classes: the create-then-label race
// (the block is present the instant the issue exists) and section-header
// parse drift (LLMs format `## Repo (x)` vs `## Repo\nx` inconsistently).

import { config } from "./config.ts";
import { parsePrecondition } from "./precondition.ts";

export interface FactoryMeta {
  repo?: string;                       // org/name — machine-exact, no regex
  // routing. epic → planner; task → pipeline; idea → intake authoring (Gap 5);
  // bootstrap → project bootstrap (Gap 5). idea/bootstrap parse ONLY at offset 0
  // like every other key (start-anchor) so injected prose can never reroute a
  // ticket into repo-creation or the intake interview.
  type?: "epic" | "task" | "idea" | "bootstrap";
  model?: string;                      // per-ticket implementer/fixer model override
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
  // with no `models:` line renders a byte-identical block to today.
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
    .filter(([k]) => k !== "preconditions" && k !== "models")
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== ""))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  if (meta.models && Object.keys(meta.models).length > 0) {
    const pairs = Object.entries(meta.models).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
    lines.push(`models: ${pairs.join(" ")}`);
  }
  for (const pre of meta.preconditions ?? []) lines.push(`precondition: ${pre}`);
  if (lines.length === 0) return "";
  return `<!-- factory\n${lines.join("\n")}\n-->`;
}

/** Per-stage model resolution (execution-profiles): stage-specific meta
 * override > wildcard "*" meta override > the legacy scalar `model` field
 * (equivalent to models["*"], kept working for back-compat) > the operator's
 * config.models default for that stage. Pure — no I/O — so every stage call
 * site gets a one-line lookup instead of the old ad-hoc `ovr || config.models.x`
 * that only implementer/fixer ever had; every other stage (reviewers, scout,
 * planner, steward, tester, security/design reviewers) always ran the global
 * config default, so one provider's 429 could take the whole roster down.
 * `stage` is constrained to config.models's own keys, so the fallback branch
 * is always a real, operator-configured model id — this function performs NO
 * validation itself; every value it can possibly return already passed
 * isKnownModel at parse time (meta.models / meta.model) or was set directly
 * by the operator (config.models). An unrecognized key in meta.models (one
 * that doesn't match any `stage` ever passed here) is simply never read. */
export function resolveModel(stage: keyof typeof config.models, meta: FactoryMeta): string {
  return meta.models?.[stage] ?? meta.models?.["*"] ?? meta.model ?? config.models[stage];
}

/** Prepend/replace the block in a description (idempotent). */
export function withFactoryMeta(description: string, meta: FactoryMeta): string {
  const body = description.replace(BLOCK_STRIP, "").replace(/^\s+/, "");
  const block = renderFactoryMeta(meta);
  return block ? `${block}\n\n${body}` : body;
}
