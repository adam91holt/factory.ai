import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeAgentRegisterSnapshot, registerGeneration } from "./db.ts";
import type { RoutableCard } from "./routing.ts";

// Agent card catalog. Each role's system prompt lives as a Markdown card in
// agents/*.md (YAML frontmatter + prompt body); loop/plan/steward read their
// prompts from here so a prompt is edited in one place and version-controlled
// next to its documentation. The code keeps an inline fallback for every call
// site, so a missing/broken card degrades to the exact previous behaviour
// rather than crashing the daemon — cards are additive, never load-bearing.
//
// Issue #16 WP1 — PG-FIRST loading. The agent REGISTER (db.ts agent_register)
// is consulted before the file: when a name has an ACTIVE register version,
// that version's {frontmatter, prompt} is the card; the file is the fallback
// (and the seed — register-io.ts imports files into the register). An empty
// register / closed store therefore behaves BYTE-IDENTICALLY to the file-only
// catalog (the additive-only pin in tests/register.test.ts).
//
// The register is read through db.ts's synchronous ACTIVE-ROW SNAPSHOT, not a
// query, so every function here stays sync (loop/plan/steward call them
// inline). Freshness comes from the REGISTER GENERATION counter: db.ts bumps
// it on every register write, and the cache below keys each entry on the
// generation it was resolved at — so a register edit takes effect on the next
// getCard() with no polling and no restart. Note the import DIRECTION: this
// file imports db.ts; db.ts never imports catalog.ts (no cycle — db.ts stays
// the persistence leaf).

export interface Card {
  /** Frontmatter as flat string values. `model` and `when` remain
   *  reference-only — runStage still takes the model from config/code, and
   *  meta.ts's resolveModel never reads a card, so no card can name a model
   *  the operator did not configure. THREE keys are load-bearing:
   *   - `effort` (execution-profiles) via cardEffort() below, the fallback
   *     tier in meta.ts's resolveEffort precedence;
   *   - `tools` (agent routing) via cardTools() below — a purely SUBTRACTIVE
   *     selection over routing.ts's code-defined ROLE_CEILINGS, so a card can
   *     narrow a stage's allowlist but can never widen it;
   *   - `role` + `match` (agent routing) via listRoutableCards() below — a
   *     specialist card's repo-fact selector. */
  frontmatter: Record<string, string>;
  /** The prompt body verbatim, with {{placeholder}} tokens for runtime values. */
  prompt: string;
}

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

/** Cache entry, effectively keyed (name, version): `gen` is the register
 *  generation the entry was resolved at, and within one generation a name's
 *  active version cannot change — so gen-equality IS version-equality, plus it
 *  also invalidates on activate/disable/rollback, which a bare version key
 *  would miss. `version` records the register version the card came from
 *  (undefined = file-sourced/absent), for tests and later run-pinning. */
interface CachedCard { gen: number; version: number | undefined; card: Card | null }

const cache = new Map<string, CachedCard>();

/** Parse a raw card file (YAML-ish flat frontmatter + body). Exported for
 *  register-io.ts, whose importer must parse files with EXACTLY this grammar —
 *  a second parser would eventually disagree with this one. */
export function parseCardText(raw: string): Card {
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

/** The file leg, verbatim pre-register behaviour: agents/<name>.md or null. */
function readCardFile(name: string): Card | null {
  const file = join(AGENTS_DIR, `${name}.md`);
  try {
    if (existsSync(file)) return parseCardText(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`[catalog] failed to read card ${name}: ${error instanceof Error ? error.message : error}`);
  }
  return null;
}

/** Load a card by name — the ACTIVE register version first, agents/<name>.md
 *  as fallback. Result cached per register generation; missing → null. */
export function getCard(name: string): Card | null {
  const gen = registerGeneration();
  const hit = cache.get(name);
  if (hit && hit.gen === gen) return hit.card;
  const row = activeAgentRegisterSnapshot().get(name);
  const card: Card | null = row
    ? { frontmatter: { ...row.frontmatter }, prompt: row.prompt }
    : readCardFile(name);
  cache.set(name, { gen, version: row?.version, card });
  return card;
}

/** The register version the card for `name` currently resolves to, or
 *  undefined when it is file-sourced (or absent). This is the value a later WP
 *  pins into run_stage_started (`card: name@version`). */
export function cardVersion(name: string): number | undefined {
  return activeAgentRegisterSnapshot().get(name)?.version;
}

/** The run_stage_started / report pin for a card: "name@version", where
 *  version 0 means file-fallback (or absent card) — unambiguous because the
 *  register mints versions from 1 (issue #16 WP2). */
export function cardPin(name: string): string {
  return `${name}@${cardVersion(name) ?? 0}`;
}

/** Drop one card from the in-process cache so the next getCard re-reads it.
 *  The dashboard and the pipeline share a process (src/index.ts), so the
 *  catalog manager calls this after committing an agent-card FILE edit —
 *  register edits need no call here (the generation bump invalidates), but a
 *  file edit changes no generation, so this stays load-bearing for the
 *  file-fallback path. */
export function invalidateCard(name: string): void {
  cache.delete(name);
}

/** List the card names visible to the catalog: files on disk UNION active
 *  register rows (a register-only card must be routable/introspectable even
 *  before a git export writes its file). Empty register → exactly the disk
 *  listing, as before. */
export function listCards(): string[] {
  const names = new Set<string>();
  try {
    for (const f of readdirSync(AGENTS_DIR)) if (f.endsWith(".md")) names.add(f.slice(0, -3));
  } catch { /* no agents dir — register-only */ }
  for (const name of activeAgentRegisterSnapshot().keys()) names.add(name);
  return [...names].sort();
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

/** A card's own frontmatter `tools:` value, or undefined when the card is
 *  missing or declares none. Handed to routing.ts's resolveTools(), which
 *  treats undefined as "no declaration → the code ceiling verbatim" (the
 *  pre-routing behaviour) and treats the string as a SELECTION over that
 *  ceiling. Deliberately unvalidated here for the same reason cardEffort is:
 *  resolveTools is the single enforcement point, and it cannot return anything
 *  outside the ceiling regardless of what this string says — a PG-sourced
 *  declaration inherits the same subset theorem because it flows through the
 *  identical resolveTools call (tests/routing.test.ts fuzzes both sources). */
export function cardTools(name: string): string | undefined {
  return getCard(name)?.frontmatter.tools;
}

/** Every visible card, reduced to the fields routing.ts consumes. This is the
 *  ONLY disk I/O in the routing path — routeStage/selectCard themselves stay
 *  pure, so every routing decision is testable without a filesystem. Cards
 *  that fail to load are simply absent (a broken card can never become a
 *  specialist), which is the fail-closed direction. */
export function listRoutableCards(): RoutableCard[] {
  const out: RoutableCard[] = [];
  for (const name of listCards()) {
    const card = getCard(name);
    if (!card) continue;
    out.push({
      name,
      role: card.frontmatter.role,
      match: card.frontmatter.match,
      tools: card.frontmatter.tools,
    });
  }
  return out;
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
