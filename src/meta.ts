// Structured factory metadata block — the robust replacement for regex-over-
// prose ticket parsing (Linear's API has no custom fields, so we carry typed
// key:values in an HTML-comment block, set ATOMICALLY in the description at
// issueCreate). Invisible in Linear's rendered markdown; parsed as explicit
// key:value pairs. This kills two bug classes: the create-then-label race
// (the block is present the instant the issue exists) and section-header
// parse drift (LLMs format `## Repo (x)` vs `## Repo\nx` inconsistently).

import { config } from "./config.ts";

export interface FactoryMeta {
  repo?: string;                       // org/name — machine-exact, no regex
  type?: "epic" | "task";              // routing: planner vs pipeline
  model?: string;                      // per-ticket implementer/fixer model override
  // per-ticket merge policy. UNREAD today (auto-merge is gated solely on
  // config.autoMergeRepos). If ever wired in, a description-sourced value may
  // only WITHHOLD auto-merge, never GRANT it — untrusted text must not confer
  // merge authority on a repo the operator did not allowlist.
  merge?: "auto" | "shadow" | "review";
}

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
    const kv = line.match(/^\s*([a-z]+)\s*:\s*(.+?)\s*$/i);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.replace(/^["'`]|["'`]$/g, "").trim();
    if (key === "repo" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) meta.repo = value;
    else if (key === "type" && (value === "epic" || value === "task")) meta.type = value;
    else if (key === "model" && value && isKnownModel(value)) meta.model = value;
    else if (key === "merge" && (value === "auto" || value === "shadow" || value === "review")) meta.merge = value;
  }
  return meta;
}

/** Render a metadata block to prepend to a ticket description. Omits empty keys. */
export function renderFactoryMeta(meta: FactoryMeta): string {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  if (lines.length === 0) return "";
  return `<!-- factory\n${lines.join("\n")}\n-->`;
}

/** Prepend/replace the block in a description (idempotent). */
export function withFactoryMeta(description: string, meta: FactoryMeta): string {
  const body = description.replace(BLOCK_STRIP, "").replace(/^\s+/, "");
  const block = renderFactoryMeta(meta);
  return block ? `${block}\n\n${body}` : body;
}
