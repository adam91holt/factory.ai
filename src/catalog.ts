import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Agent card catalog. Each role's system prompt lives as a Markdown card in
// agents/*.md (YAML frontmatter + prompt body); loop/plan/steward read their
// prompts from here so a prompt is edited in one place and version-controlled
// next to its documentation. The code keeps an inline fallback for every call
// site, so a missing/broken card degrades to the exact previous behaviour
// rather than crashing the daemon — cards are additive, never load-bearing.

export interface Card {
  /** Frontmatter as flat string values. tools/model/when remain reference-only
   *  (runStage still takes model/allowedTools from config/code — model
   *  resolution never reads the card). `effort` is the one exception
   *  (execution-profiles): cardEffort() below reads it as the fallback tier in
   *  meta.ts's resolveEffort precedence, so a card's `effort:` frontmatter is
   *  now load-bearing, not just documentation. */
  frontmatter: Record<string, string>;
  /** The prompt body verbatim, with {{placeholder}} tokens for runtime values. */
  prompt: string;
}

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

const cache = new Map<string, Card | null>();

function parseCard(raw: string): Card {
  const frontmatter: Record<string, string> = {};
  let body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2] ?? "";
    for (const line of (fm[1] ?? "").split("\n")) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m && m[1]) frontmatter[m[1]] = (m[2] ?? "").trim();
    }
  }
  return { frontmatter, prompt: body.trim() };
}

/** Load a card by name (agents/<name>.md). Result cached; missing → null. */
export function getCard(name: string): Card | null {
  if (cache.has(name)) return cache.get(name) ?? null;
  const file = join(AGENTS_DIR, `${name}.md`);
  let card: Card | null = null;
  try {
    if (existsSync(file)) card = parseCard(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`[catalog] failed to read card ${name}: ${error instanceof Error ? error.message : error}`);
  }
  cache.set(name, card);
  return card;
}

/** Drop one card from the in-process cache so the next getCard re-reads it from
 *  disk. The dashboard and the pipeline share a process (src/index.ts), so the
 *  catalog manager calls this after committing an agent-card edit — otherwise
 *  the memoised prompt would keep rendering until the daemon restarts (a saved,
 *  committed edit that the live system silently ignores). */
export function invalidateCard(name: string): void {
  cache.delete(name);
}

/** List the card names present on disk (for tooling/introspection). */
export function listCards(): string[] {
  try {
    return readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

/** A card's own frontmatter `effort:` value (agents/<name>.md), or undefined
 *  when the card is missing or declares none. This is the "card" leg of
 *  meta.ts's resolveEffort precedence chain — execution-profiles makes the
 *  frontmatter `effort:` LOAD-BEARING (previously catalog.ts's own doc
 *  comment called tools/model/effort "reference, not execution"). The raw
 *  string is NOT validated here — resolveEffort's isKnownEffort check is the
 *  single enforcement point, exactly like every other effort/model source in
 *  this file funnels through one allowlist rather than each call site
 *  re-implementing it. */
export function cardEffort(name: string): string | undefined {
  return getCard(name)?.frontmatter.effort;
}

/**
 * Render a role's prompt from its card, substituting {{token}} placeholders
 * with `vars`. If the card is absent the `fallback` (the call site's inline
 * string, already interpolated) is returned unchanged — identical behaviour to
 * before the catalog existed.
 */
export function renderPrompt(name: string, vars: Record<string, string>, fallback: string): string {
  const card = getCard(name);
  if (!card) return fallback;
  return card.prompt.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] ?? "" : whole);
}
