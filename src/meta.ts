// Structured factory metadata block — the robust replacement for regex-over-
// prose ticket parsing (Linear's API has no custom fields, so we carry typed
// key:values in an HTML-comment block, set ATOMICALLY in the description at
// issueCreate). Invisible in Linear's rendered markdown; parsed as explicit
// key:value pairs. This kills two bug classes: the create-then-label race
// (the block is present the instant the issue exists) and section-header
// parse drift (LLMs format `## Repo (x)` vs `## Repo\nx` inconsistently).

export interface FactoryMeta {
  repo?: string;                       // org/name — machine-exact, no regex
  type?: "epic" | "task";              // routing: planner vs pipeline
  model?: string;                      // per-ticket implementer/fixer model override
  merge?: "auto" | "shadow" | "review"; // per-ticket merge policy (future)
}

const BLOCK = /<!--\s*factory\b([\s\S]*?)-->/i;

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
    else if (key === "model" && value) meta.model = value;
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
  const body = description.replace(BLOCK, "").replace(/^\s+/, "");
  const block = renderFactoryMeta(meta);
  return block ? `${block}\n\n${body}` : body;
}
