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

/** Render a metadata block to prepend to a ticket description. Omits empty keys
 * (scalar undefined/"" AND empty arrays) so a child with no DAG data renders a
 * block byte-identical to today's — the backward-compat guarantee. Array values
 * serialize as a comma-space list ("depends_on: FAC-1, FAC-2"). */
export function renderFactoryMeta(meta: FactoryMeta): string {
  // preconditions serialize as ONE `precondition: <dsl>` line PER entry (not a
  // comma-joined list like depends_on/touches), so handle them separately from
  // the generic scalar/array loop.
  const lines = Object.entries(meta)
    .filter(([k]) => k !== "preconditions")
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== ""))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  for (const pre of meta.preconditions ?? []) lines.push(`precondition: ${pre}`);
  if (lines.length === 0) return "";
  return `<!-- factory\n${lines.join("\n")}\n-->`;
}

/** Prepend/replace the block in a description (idempotent). */
export function withFactoryMeta(description: string, meta: FactoryMeta): string {
  const body = description.replace(BLOCK_STRIP, "").replace(/^\s+/, "");
  const block = renderFactoryMeta(meta);
  return block ? `${block}\n\n${body}` : body;
}
