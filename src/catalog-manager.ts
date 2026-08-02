import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./agents.ts";
import { invalidateCard } from "./catalog.ts";
import { catalogUsage, type CardUsage } from "./db.ts";
import { validateGroundskeeperContent, type GroundskeeperCard } from "./groundskeepers.ts";
import { ceilingForRole, resolveTools, SPECIALIST_ROLES } from "./routing.ts";

// Catalog manager — the read/write half of the mission-control catalog page
// (roadmap "Queued build: catalog manager UI"). GET /catalog lists every agent
// card, skill pack, and groundskeeper card with its per-card telemetry; POST
// /catalog/save writes ONE file back and commits it. Writes are the ONLY
// mutation the dashboard performs, so validation is strict and layered:
//   name charset-locked → path built ONLY as <fixed-dir>/<name>.md (+ resolve
//   prefix-check) → 64KB cap → frontmatter must parse (GK cards run the full
//   loader validation incl. validateCron) → redactSecrets rejects on any hit so
//   a secret can never land in a tracked file → commit guard (refuse, BEFORE
//   writing, when the factory repo has unrelated staged/modified files — issue
//   #8 F8) → write → git add + commit (no push; a human pushes — the commit is
//   the audit trail). FACTORY_CATALOG_NO_COMMIT=1 (test environments) skips
//   both the guard and the commit: the file is written, nothing touches git.
//   Everything here runs inside the loopback-only dashboard process
//   (src/server.ts).

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
  // Agent routing (routing.ts). `tools:`/`role:`/`match:` used to be inert
  // documentation; they are load-bearing now, so the catalog shows what the
  // card ACTUALLY resolves to rather than what it claims:
  //   role         — the stage slot it serves (its own name for a default card,
  //                  its `role:` frontmatter for a specialist), or null when
  //                  the card is not wired to any stage.
  //   match        — the repo-fact terms that select a specialist ([] for a
  //                  default card).
  //   tools        — the RESOLVED allowlist: the card's selection applied to
  //                  routing.ts's code ceiling. null when the card is not
  //                  wired to a stage (its `tools:` line would be inert).
  //   unknownTools — declared selectors that match nothing in the ceiling.
  //                  They grant nothing; surfacing them is how a typo becomes
  //                  visible instead of silently shrinking a stage.
  routing: {
    role: string | null;
    match: string[];
    tools: string[] | null;
    unknownTools: string[];
    specialist: boolean;
  };
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

/** The stage slot a card serves: a specialist's declared `role:` (only when
 *  that role is actually routable), otherwise the card's own name if that name
 *  is a wired role, otherwise null (an unwired card runs nothing). */
function roleOfCard(name: string, frontmatter: Record<string, string>): string | null {
  const declared = (frontmatter.role ?? "").trim();
  if (declared !== "" && SPECIALIST_ROLES.has(declared) && declared !== name) return declared;
  return ceilingForRole(name) !== null ? name : null;
}

/** Resolve one card's routing frontmatter for the catalog view — what the card
 *  ACTUALLY grants, not what it claims. Pure over the parsed frontmatter. */
function cardRouting(name: string, frontmatter: Record<string, string>): AgentEntry["routing"] {
  const role = roleOfCard(name, frontmatter);
  const ceiling = role === null ? null : ceilingForRole(role);
  const declaredRole = (frontmatter.role ?? "").trim();
  const selection = ceiling === null
    ? { tools: null, unknown: [] as string[] }
    : (() => { const r = resolveTools(ceiling, frontmatter.tools); return { tools: r.tools, unknown: r.unknown }; })();
  const match = (frontmatter.match ?? "").replace(/^\[/, "").replace(/\]$/, "")
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  // A specialist is a card that declares a routable role OTHER than its own
  // name. The catalog view never performs a SELECTION — that happens per run
  // against a real worktree's facts (loop.ts) — it only reports the
  // declaration and the tools it resolves to.
  return { role, match, tools: selection.tools, unknownTools: selection.unknown,
    specialist: declaredRole !== "" && declaredRole !== name };
}

function listMarkdown(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

export async function readCatalog(): Promise<CatalogPayload> {
  const { byStage, byIssueKey } = await catalogUsage();

  const agents: AgentEntry[] = [];
  for (const file of listMarkdown(AGENTS_DIR)) {
    const name = file.slice(0, -3);
    let content: string;
    try { content = readFileSync(join(AGENTS_DIR, file), "utf8"); } catch { continue; }
    const { frontmatter, body } = splitFrontmatter(content);
    agents.push({ name, frontmatter, prompt: body, content, usage: toUsage(byStage[name]),
      routing: cardRouting(name, frontmatter) });
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

/** Routing ceiling for POST /catalog/save on an AGENT card. Returns an error
 *  string to reject with, or null when the save is allowed. `file` is the
 *  on-disk path so the current (trusted, git-committed) routing declaration
 *  can be compared against the incoming one. A card with no readable file on
 *  disk is treated as declaring nothing — so a NEW card may be created from
 *  the UI, but never one that routes. */
export function validateAgentCardRouting(
  name: string,
  incoming: Record<string, string>,
  file: string,
): string | null {
  let onDisk: Record<string, string> = {};
  try { onDisk = splitFrontmatter(readFileSync(file, "utf8")).frontmatter; } catch { /* new card */ }
  return validateAgentRoutingAgainst(name, incoming, onDisk);
}

/** The pure core of validateAgentCardRouting: compare an incoming frontmatter
 *  against a trusted BASELINE declaration (the on-disk file for /catalog/save;
 *  the active register row for the PG register save route — issue #16 WP3).
 *  Extracted rather than duplicated so the two browser-reachable write paths
 *  cannot drift: whatever routing edit the file route refuses, the register
 *  route refuses identically. */
export function validateAgentRoutingAgainst(
  name: string,
  incoming: Record<string, string>,
  baseline: Record<string, string>,
): string | null {
  const norm = (v: string | undefined): string => (v ?? "").trim().replace(/^\[/, "").replace(/\]$/, "")
    .split(/[,\s]+/).filter(Boolean).join(" ");
  for (const key of ["role", "match"] as const) {
    if (norm(incoming[key]) !== norm(baseline[key])) {
      return `refusing to change an agent card's \`${key}:\` routing declaration from the UI (the trusted baseline has ${JSON.stringify(baseline[key] ?? null)}) — routing decides which agent runs a stage, so it is an on-disk, git-committed edit only. The prompt body is freely editable here.`;
    }
  }
  // Which ceiling this card's tools are measured against: a specialist's
  // declared role, else the card's own name when that is a wired stage.
  const declaredRole = (incoming.role ?? "").trim();
  const role = declaredRole !== "" && SPECIALIST_ROLES.has(declaredRole) && declaredRole !== name
    ? declaredRole
    : (ceilingForRole(name) !== null ? name : null);
  const ceiling = role === null ? null : ceilingForRole(role);
  if (incoming.tools === undefined) return null;
  if (ceiling === null) {
    return `agents/${name}.md is not wired to any stage, so a \`tools:\` line on it grants nothing — remove it (or wire the card on disk first).`;
  }
  const { unknown } = resolveTools(ceiling, incoming.tools);
  if (unknown.length > 0) {
    return `\`tools:\` names ${unknown.length} selector(s) that are not in this stage's ceiling and would grant nothing: ${unknown.join(", ")}. Allowed here: ${ceiling.join(", ") || "(none — this stage is tool-less by design)"}.`;
  }
  return null;
}

/** Which `git status --porcelain` entries block a catalog-save commit (issue
 *  #8 F8). Pure over the porcelain text so the classification is testable
 *  without a git repo. Blocking = any staged or modified TRACKED file that is
 *  not the card file being saved:
 *   - the card file itself is exempt — the commit is pathspec-scoped to exactly
 *    that file, and committing it is precisely the audit trail this route
 *    exists to produce (e.g. re-saving after a FACTORY_CATALOG_NO_COMMIT save);
 *   - untracked files (`??`) never block — a pathspec-scoped commit cannot
 *    sweep them in, and a dev working tree legitimately carries scratch files;
 *   - renames (`R old -> new`) always block, even when they involve the card
 *    file: a rename is never the simple content edit this route performs.
 *  Returns the repo-relative paths of the blockers (empty = safe to commit). */
export function commitBlockers(porcelain: string, relFile: string): string[] {
  const blockers: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") continue;
    const status = line.slice(0, 2);
    const path = line.slice(3);
    if (status === "??") continue;                    // untracked — cannot be swept in
    if (path === relFile && !path.includes(" -> ")) continue; // the card file itself
    blockers.push(path);
  }
  return blockers;
}

/** `git status --porcelain` for the factory repo, or null when git is
 *  unavailable / this is not a repo (the caller then proceeds exactly as the
 *  pre-guard code did: the write happens, `git add` fails, the response carries
 *  a warning instead of a commit hash). */
function readGitPorcelain(): string | null {
  const st = spawnSync("git", ["status", "--porcelain"], { cwd: FACTORY_ROOT, encoding: "utf8" });
  return st.status === 0 ? (st.stdout ?? "") : null;
}

/** Validate an untrusted POST /catalog/save body, then write + commit one file.
 *  `input` is the parsed JSON body; every field is treated as untrusted.
 *  `testSeams.gitStatusPorcelain` substitutes the porcelain text the commit
 *  guard classifies (tests only — the guard's spawn is otherwise unmockable
 *  because FACTORY_ROOT is baked from import.meta.url). */
export function saveCatalogEntry(
  input: unknown,
  testSeams: { gitStatusPorcelain?: string | null } = {},
): SaveResult {
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
    if (kind === "agent") {
      // Privilege-escalation ceiling on the write route. This block used to
      // not exist: agent cards were exempt from any ceiling on the EXPLICIT
      // grounds that their `tools:`/`when:` frontmatter was reference-only.
      // Agent routing deletes that premise — `tools:` now selects a stage's
      // real allowlist and `role:`/`match:` decide which card runs a stage —
      // so the exemption has to go with it.
      //
      // Two rules, mirroring the groundskeeper "arming is an on-disk-only
      // action" ceiling directly above:
      //  (1) ROUTING DECLARATIONS ARE ON-DISK-ONLY. A browser-reachable route
      //      must never mint a new specialist, repoint an existing one at
      //      different repo facts, or promote a card into a stage slot. Those
      //      edits are a human's `git` commit, not a POST. (Prompt BODY edits
      //      stay fully allowed — that is what this page is for.)
      //  (2) A `tools:` line may only name selectors that resolve inside the
      //      card's code-defined ceiling. Runtime already guarantees the
      //      subset property, so an unknown selector cannot widen anything —
      //      but it silently NARROWS the stage, which is exactly the kind of
      //      quiet capability change this route must not make by typo.
      const v = validateAgentCardRouting(name, frontmatter, file);
      if (v) return bad(422, v);
    }
  }

  // A secret must never land in a tracked file. This is a hard reject, not a
  // redact-in-place: the human should remove it, not commit a masked version.
  const scan = redactSecrets(content);
  if (scan.found > 0) return bad(422, `refusing to write: content contains ${scan.found} secret-like string(s)`);

  // Commit guard (issue #8 F8) — BEFORE the write, so a refusal is atomic: no
  // file changed, no commit made. A dirty tree means a human (or another
  // process) is mid-edit in the factory repo; a save that commits from under
  // them turns "commit-as-audit-trail" into "commit-as-side-effect" — exactly
  // how a subagent once minted real commits on main during verification.
  // FACTORY_CATALOG_NO_COMMIT=1 (test environments) skips the guard because it
  // also skips the commit the guard protects — with no commit coming, unrelated
  // dirt is irrelevant and the write is side-effect-free beyond the file.
  const noCommit = process.env.FACTORY_CATALOG_NO_COMMIT === "1";
  if (!noCommit) {
    const porcelain = testSeams.gitStatusPorcelain !== undefined ? testSeams.gitStatusPorcelain : readGitPorcelain();
    if (porcelain !== null) {
      const blockers = commitBlockers(porcelain, relative(FACTORY_ROOT, resolvedFile));
      if (blockers.length > 0) {
        return bad(409, `refusing to save: the factory repo working tree has ${blockers.length} unrelated staged/modified file(s) (e.g. ${blockers.slice(0, 3).join(", ")}) and a catalog save git-commits its file as the audit trail — it must never commit from a tree someone is mid-edit in. Commit or stash those changes and retry; nothing was written.`);
      }
    }
  }

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

  // Test environments: the file is written and the card cache invalidated, but
  // git is never touched — no add, no commit (issue #8 F8). `commit: null`
  // plus the note keeps the response shape a strict superset of the normal one.
  if (noCommit) {
    return { status: 200, json: { ok: true, commit: null, note: "commit skipped (FACTORY_CATALOG_NO_COMMIT=1)" } };
  }

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
