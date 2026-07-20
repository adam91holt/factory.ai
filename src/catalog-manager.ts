import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./agents.ts";
import { invalidateCard } from "./catalog.ts";
import { catalogUsage, type CardUsage } from "./db.ts";
import { validateGroundskeeperContent, type GroundskeeperCard } from "./groundskeepers.ts";

// Catalog manager — the read/write half of the mission-control catalog page
// (roadmap "Queued build: catalog manager UI"). GET /catalog lists every agent
// card, skill pack, and groundskeeper card with its per-card telemetry; POST
// /catalog/save writes ONE file back and commits it. Writes are the ONLY
// mutation the dashboard performs, so validation is strict and layered:
//   name charset-locked → path built ONLY as <fixed-dir>/<name>.md (+ resolve
//   prefix-check) → 64KB cap → frontmatter must parse (GK cards run the full
//   loader validation incl. validateCron) → redactSecrets rejects on any hit so
//   a secret can never land in a tracked file → write → git add + commit (no
//   push; a human pushes — the commit is the audit trail). Everything here runs
//   inside the loopback-only dashboard process (src/server.ts).

const FACTORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENTS_DIR = join(FACTORY_ROOT, "agents");
const SKILLS_DIR = join(FACTORY_ROOT, "skills");
const GROUNDSKEEPERS_DIR = join(FACTORY_ROOT, "groundskeepers");

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_CONTENT_BYTES = 64 * 1024;

export type CatalogKind = "agent" | "skill" | "groundskeeper";

export interface UsageStat { runs: number; costUsd: number; avgTurns: number }

export interface AgentEntry {
  name: string;
  frontmatter: Record<string, string>;
  prompt: string;
  content: string; // full file text — editor source + diff baseline
  usage: UsageStat | null;
}
export interface SkillEntry {
  name: string;
  frontmatter: Record<string, string>;
  body: string; // full SKILL.md text (a skill IS its file) — editor source + diff baseline
  usage: null;
}
export interface GroundskeeperEntry {
  name: string;
  frontmatter: Record<string, string | number | boolean | string[]>;
  charter: string;
  content: string; // full file text — editor source + diff baseline
  usage: UsageStat | null;
  invalid?: string; // set when the on-disk card fails loader validation
}
export interface CatalogPayload {
  agents: AgentEntry[];
  skills: SkillEntry[];
  groundskeepers: GroundskeeperEntry[];
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

/** Flat YAML-frontmatter split — the same grammar catalog.ts's parser accepts
 *  (first-level `key: value` lines only). Returns the parsed header, the body
 *  after it, and whether a `--- ... ---` block was present at all. */
function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string; hasFrontmatter: boolean } {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) return { frontmatter: {}, body: raw.trim(), hasFrontmatter: false };
  const frontmatter: Record<string, string> = {};
  for (const line of (fm[1] ?? "").split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && m[1]) frontmatter[m[1]] = (m[2] ?? "").trim();
  }
  return { frontmatter, body: (fm[2] ?? "").trim(), hasFrontmatter: true };
}

function toUsage(u: CardUsage | undefined): UsageStat | null {
  if (!u || u.runs === 0) return null;
  return { runs: u.runs, costUsd: u.costUsd, avgTurns: u.turns / u.runs };
}

/** Groundskeeper structured fields → an ordered, display-ready header map.
 *  `enabled` stays a boolean so the UI can render it as a prominent badge. */
function groundskeeperFrontmatter(card: GroundskeeperCard): GroundskeeperEntry["frontmatter"] {
  return {
    enabled: card.enabled,
    schedule: card.schedule,
    team: card.team,
    model: card.model,
    repos: card.repos,
    agents: card.agents,
    tools: card.tools,
    budget: `perRun $${card.budget.perRun} · weekly $${card.budget.weekly}`,
    maxTicketsPerRun: card.maxTicketsPerRun,
  };
}

function listMarkdown(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

export function readCatalog(): CatalogPayload {
  const { byStage, byIssueKey } = catalogUsage();

  const agents: AgentEntry[] = [];
  for (const file of listMarkdown(AGENTS_DIR)) {
    const name = file.slice(0, -3);
    let content: string;
    try { content = readFileSync(join(AGENTS_DIR, file), "utf8"); } catch { continue; }
    const { frontmatter, body } = splitFrontmatter(content);
    agents.push({ name, frontmatter, prompt: body, content, usage: toUsage(byStage[name]) });
  }

  // Skills live one directory deep: skills/<name>/SKILL.md.
  const skills: SkillEntry[] = [];
  let skillDirs: string[] = [];
  try {
    skillDirs = readdirSync(SKILLS_DIR).filter((d) => {
      try { return statSync(join(SKILLS_DIR, d)).isDirectory(); } catch { return false; }
    }).sort();
  } catch { /* no skills dir yet */ }
  for (const name of skillDirs) {
    const file = join(SKILLS_DIR, name, "SKILL.md");
    let body: string;
    try { body = readFileSync(file, "utf8"); } catch { continue; } // dir without a SKILL.md — skip
    const { frontmatter } = splitFrontmatter(body);
    skills.push({ name, frontmatter, body, usage: null });
  }

  const groundskeepers: GroundskeeperEntry[] = [];
  for (const file of listMarkdown(GROUNDSKEEPERS_DIR)) {
    const name = file.slice(0, -3);
    let content: string;
    try { content = readFileSync(join(GROUNDSKEEPERS_DIR, file), "utf8"); } catch { continue; }
    const usage = toUsage(byIssueKey[`GK-${name}`]);
    const validation = validateGroundskeeperContent(content, name);
    if (validation.ok) {
      groundskeepers.push({
        name,
        frontmatter: groundskeeperFrontmatter(validation.card),
        charter: validation.card.charter,
        content,
        usage,
      });
    } else {
      // Still surface an invalid card so it can be fixed in the UI.
      const flat = splitFrontmatter(content);
      groundskeepers.push({ name, frontmatter: flat.frontmatter, charter: flat.body, content, usage, invalid: validation.error });
    }
  }

  return { agents, skills, groundskeepers };
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

export interface SaveResult { status: number; json: unknown }

const bad = (status: number, error: string): SaveResult => ({ status, json: { error } });

/** Validate an untrusted POST /catalog/save body, then write + commit one file.
 *  `input` is the parsed JSON body; every field is treated as untrusted. */
export function saveCatalogEntry(input: unknown): SaveResult {
  if (typeof input !== "object" || input === null) return bad(400, "body must be a JSON object");
  const { kind, name, content } = input as Record<string, unknown>;

  if (kind !== "agent" && kind !== "skill" && kind !== "groundskeeper") {
    return bad(400, `kind must be one of agent|skill|groundskeeper (got ${JSON.stringify(kind)})`);
  }
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return bad(400, `name must match ${NAME_RE} (got ${JSON.stringify(name)})`);
  }
  if (typeof content !== "string") return bad(400, "content must be a string");
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return bad(413, `content exceeds the ${MAX_CONTENT_BYTES / 1024}KB cap`);
  }

  // Path built ONLY from a fixed base dir + the charset-locked name — no segment
  // from the request reaches the path except `name`. The resolve + prefix check
  // is belt-and-suspenders (the charset already forbids "/" and ".").
  const baseDir = kind === "skill" ? SKILLS_DIR : kind === "agent" ? AGENTS_DIR : GROUNDSKEEPERS_DIR;
  const file = kind === "skill" ? join(SKILLS_DIR, name, "SKILL.md") : join(baseDir, `${name}.md`);
  const resolvedFile = resolve(file);
  const resolvedBase = resolve(baseDir);
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(resolvedBase + sep)) {
    return bad(400, "resolved path escapes its catalog directory");
  }

  // Frontmatter must parse. GK cards run the FULL loader validation (name match,
  // team, cron) so an unschedulable card is rejected here, not silently skipped
  // at next daemon load.
  if (kind === "groundskeeper") {
    const v = validateGroundskeeperContent(content, name);
    if (!v.ok) return bad(422, `groundskeeper card invalid: ${v.error}`);
    // Privilege-escalation ceiling on the write route. A groundskeeper's
    // `enabled`/`model`/`budget`/`schedule` are load-bearing at run time (unlike
    // agent cards, whose model/tools are reference-only). ARMING is therefore an
    // on-disk-only action: this browser-reachable route must never flip a card
    // live ("self-arming groundskeeper via the owner's browser") nor repoint an
    // already-armed card at a new (e.g. costlier) model. It MAY edit disabled
    // cards freely and MAY disarm an armed one. A disabled card never runs, so
    // its model/budget stay inert until a human arms it on disk.
    if (v.card.enabled) {
      let current: GroundskeeperCard | null = null;
      try {
        const cur = validateGroundskeeperContent(readFileSync(file, "utf8"), name);
        if (cur.ok) current = cur.card;
      } catch { /* no readable on-disk card → treated as not-armed below */ }
      if (!current || !current.enabled) {
        return bad(422, "refusing to arm a groundskeeper from the UI — set `enabled: true` by editing the card on disk. The UI may edit disabled cards and disarm armed ones, but never flip one live.");
      }
      if (v.card.model !== current.model) {
        return bad(422, `refusing to change an armed groundskeeper's model via the UI (on disk it is ${JSON.stringify(current.model)}) — disarm it, change the model on disk, then re-arm on disk.`);
      }
    }
  } else {
    const { frontmatter, hasFrontmatter } = splitFrontmatter(content);
    if (!hasFrontmatter) return bad(422, "content must open with a YAML frontmatter block (--- ... ---)");
    if (!frontmatter.name) return bad(422, "frontmatter is missing a name field");
    if (frontmatter.name !== name) return bad(422, `frontmatter name ${JSON.stringify(frontmatter.name)} must equal the save name ${JSON.stringify(name)}`);
    if (kind === "skill" && !frontmatter.description) return bad(422, "skill frontmatter is missing a description field");
  }

  // A secret must never land in a tracked file. This is a hard reject, not a
  // redact-in-place: the human should remove it, not commit a masked version.
  const scan = redactSecrets(content);
  if (scan.found > 0) return bad(422, `refusing to write: content contains ${scan.found} secret-like string(s)`);

  const toWrite = content.endsWith("\n") ? content : `${content}\n`;
  try {
    if (kind === "skill") mkdirSync(dirname(file), { recursive: true });
    // Atomic write (tmp + rename, same dir/filesystem) — mirrors writeState in
    // groundskeepers.ts. loadGroundskeepers/getCard read these files on a live
    // tick; a plain writeFileSync could hand a concurrent reader a torn card
    // (parse failure → skipped schedule window, or a poisoned prompt cache).
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, toWrite);
    renameSync(tmp, file);
  } catch (error) {
    return bad(500, `write failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The dashboard and the pipeline share a process, and getCard memoises agent
  // prompts for the process lifetime. Drop the just-written card so the next
  // stage renders the new prompt instead of the stale cached one (otherwise a
  // committed edit is a silent no-op until restart). GK cards re-read disk each
  // tick and skills are not cached, so only agent cards need this.
  if (kind === "agent") invalidateCard(name);

  // git add + commit (NO push). spawnSync with array args — never a shell — so
  // `name`/`kind` (already charset-locked) cannot inject. Commit scoped to this
  // one pathspec so unrelated working-tree changes are never swept in.
  const commitMsg = `catalog: update ${kind}/${name} via mission control`;
  const add = spawnSync("git", ["add", "--", file], { cwd: FACTORY_ROOT, encoding: "utf8" });
  if (add.status !== 0) {
    // File is written; the commit just didn't happen (e.g. no git). Report ok so
    // the UI reflects the saved file, but flag the missing audit trail.
    return { status: 200, json: { ok: true, commit: null, warning: `git add failed: ${(add.stderr || add.error?.message || "unknown").toString().trim().slice(0, 200)}` } };
  }
  const commit = spawnSync("git", ["commit", "-m", commitMsg, "--", file], { cwd: FACTORY_ROOT, encoding: "utf8" });
  if (commit.status !== 0) {
    const out = `${commit.stdout ?? ""}${commit.stderr ?? ""}`;
    if (/nothing to commit|no changes added/i.test(out)) {
      return bad(409, "no changes to commit — the file already matches the committed version");
    }
    return { status: 200, json: { ok: true, commit: null, warning: `git commit failed: ${out.trim().slice(0, 200)}` } };
  }
  const rev = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: FACTORY_ROOT, encoding: "utf8" });
  const hash = rev.status === 0 ? (rev.stdout ?? "").trim() : null;
  return { status: 200, json: { ok: true, commit: hash } };
}
