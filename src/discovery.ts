// Register discovery + on-demand skill retrieval (issue #17 part 1).
//
// Two seams, one trust posture:
//
//   1. INDEX — buildRegisterIndex() renders the registers' ENABLED entries as a
//      compact, operator-authored catalog block (name@version + one line each)
//      that loop.ts injects into ORCHESTRATING stages' prompts only (the roles
//      whose resolved allowlist grants Task/Agent — the same derivation
//      agents.ts uses for the worker subagent). The index is assembled from
//      REGISTER ROWS ONLY: ticket text is not an input anywhere in this module,
//      and every row field that reaches the block is newline-stripped and
//      capped, so no content can fabricate an extra index line or a fake
//      delimiter (tests/discovery.test.ts pins the delimiting).
//
//   2. MATERIALIZATION — materializeSkills() writes every enabled register
//      skill to <worktree>/.factory/skills/<name>.md at workspace setup.
//      Workers already hold Read, so retrieval needs no new tool, no endpoint,
//      no network — and a Read of that path surfaces in the tool_use event
//      stream for free, which is what makes skill USAGE (not just attachment)
//      attributable per run (#11). Content is redaction re-scanned at write
//      (register writes already scan — this is defense in depth), and
//      `.factory/` is factory-owned scratch: repos.ts excludes it from
//      commitAll and from guarded-path classification, so a materialized skill
//      can never leak into a diff or a PR.
//
// The index-building half is PURE (CLAUDE.md: decision logic stays pure);
// materializeSkills is the only I/O and is a plain function the DAEMON calls —
// the model never opts skills in or out of the worktree.
//
// Additive-only: an empty register yields an empty index ("" — prompts
// byte-identical to post-#16) and materializes nothing (no .factory/ dir at
// all; a stale one from a prior run is cleaned up).

import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { SUBAGENT_DISALLOWED_TOOLS, SUBAGENT_MAX_TURNS, redactSecrets, type DelegateAgentDef, type DelegateRoster } from "./agents.ts";
import { ceilingForRole, resolveTools } from "./routing.ts";

// ---------------------------------------------------------------------------
// In-code caps (CLAUDE.md: caps are constants, never env knobs).
// ---------------------------------------------------------------------------

/** Most entries one index SECTION may list. The issue's own design note says
 *  the prompt-block index is the right v1 up to ~50 entries — this cap IS that
 *  boundary, so outgrowing it is visible (entries drop) rather than silent
 *  prompt bloat. */
export const MAX_INDEX_ENTRIES_PER_SECTION = 50;
/** One-line cap per index entry (name@version + the when/description line). */
const MAX_INDEX_LINE_CHARS = 160;
/** Most skills materialized into one worktree. */
export const MAX_MATERIALIZED_SKILLS = 64;
/** Per-skill materialized size cap — mirrors the register write cap
 *  (register-io.ts MAX_CONTENT_BYTES), re-checked here as defense in depth. */
const MAX_MATERIALIZED_BYTES = 64 * 1024;

// Same name charset lock as db.ts REGISTER_NAME_RE / register-io.ts NAME_RE
// (kept local like register-io does — two constants beat a cross-module import
// for the dashboard's git machinery). The lock is what makes building a file
// path from a register name safe: no dots, no separators, no traversal.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// ---------------------------------------------------------------------------
// Judges are never delegable (issue #17 safety invariant, pinned by test): an
// author stage must not be able to spawn its own judge and launder a verdict —
// gate outcomes only count when the DAEMON ran the stage. In-code constant,
// exactly per the issue: security-reviewer, design-reviewer, reviewer-*.
// ---------------------------------------------------------------------------

export const NEVER_DELEGABLE_NAMES: ReadonlySet<string> = new Set(["security-reviewer", "design-reviewer"]);
export const NEVER_DELEGABLE_PREFIX = "reviewer-";

/** True when `name` is a judge that may NEVER appear in the delegable set —
 *  matched on the entry's own name AND (belt-and-braces) on its declared
 *  `role:`, so renaming a judge card cannot smuggle it past the constant. */
export function isJudgeName(name: string): boolean {
  // Case-folded: the register write path lower-cases names via its charset
  // lock, but frontmatter `role:` is free text — "Security-Reviewer" must be
  // exactly as never-delegable as "security-reviewer" (review finding).
  const n = name.toLowerCase();
  return NEVER_DELEGABLE_NAMES.has(n) || n.startsWith(NEVER_DELEGABLE_PREFIX);
}

// ---------------------------------------------------------------------------
// Index building (pure).
// ---------------------------------------------------------------------------

export interface SkillIndexEntry {
  name: string;
  version: number;
  /** One-line description from the skill's frontmatter (register `description`
   *  column). Sanitized at render — see oneLine(). */
  description: string;
  /** Optional: an explicit false EXCLUDES the entry. Callers normally pass
   *  already-filtered (materialized) skills; this is the fail-closed re-check
   *  so a disabled row can never render even if a future caller passes raw
   *  table rows (same posture as skills.ts CarriableSkill.enabled). */
  enabled?: boolean;
}

export interface SpecialistIndexEntry {
  name: string;
  version: number;
  /** The one-line "when to delegate" text (frontmatter `when:`, falling back
   *  to `description:`). */
  when: string;
}

/** Structural subset of db.ts AgentRegisterRow — this module imports no db.ts
 *  (stays leaf-testable, same rationale as skills.ts CarriableSkill). */
export interface DelegableCandidate {
  name: string;
  version: number;
  enabled: boolean;
  frontmatter: Record<string, string>;
  /** The card body. When present-and-blank the entry is skipped from the
   *  INDEX too — the index must never advertise a specialist the roster
   *  refuses to spawn (review finding: index/roster single-source). Optional
   *  so index-only callers without card bodies keep their entries. */
  prompt?: string;
}

export const INDEX_BLOCK_HEADER = "=== FACTORY REGISTER INDEX — TRUSTED operator-registered catalog (versioned; NOT ticket text) ===";
export const INDEX_BLOCK_FOOTER = "=== END FACTORY REGISTER INDEX ===";

/** Collapse a row field to ONE bounded line. Newlines can never survive (an
 *  embedded "\n- evil@9 — …" stays inline inside the legit entry's line, so it
 *  cannot read as an index entry), and delimiter-lookalike runs of `=` are
 *  stripped so no field can fabricate the block header/footer. */
function oneLine(raw: string): string {
  return raw.replace(/={3,}/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_INDEX_LINE_CHARS);
}

/** Non-negative integer version for display; anything else renders as 0
 *  (the same "0 = not a real register version" convention as cardPin). */
function displayVersion(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

/** The delegable-specialist subset of the agent register: ENABLED rows that
 *  declare `delegable: true` in frontmatter, minus the judges (in-code
 *  constant above — checked against both the entry name and its `role:`).
 *  A name failing the charset lock is dropped (unknown/malformed → absent,
 *  fail-closed). Deterministic name order, capped. */
export function delegableSpecialists(rows: readonly DelegableCandidate[]): SpecialistIndexEntry[] {
  const out: SpecialistIndexEntry[] = [];
  for (const r of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
    if (r.enabled !== true) continue;
    if (!NAME_RE.test(r.name)) continue;
    // "worker" is the built-in fan-out subagent (agents.ts WORKER_AGENT): a
    // register row must never advertise or shadow it (part 2 keeps the roster
    // aligned with this same reservation).
    if (r.name === "worker") continue;
    if ((r.frontmatter.delegable ?? "").trim() !== "true") continue;
    if (isJudgeName(r.name) || isJudgeName((r.frontmatter.role ?? "").trim())) continue;
    // An empty card body can never spawn (buildDelegateRoster refuses it), so
    // it must not be advertised either — same filter, single source of truth.
    if (r.prompt !== undefined && r.prompt.trim() === "") continue;
    out.push({
      name: r.name,
      version: displayVersion(r.version),
      when: r.frontmatter.when ?? r.frontmatter.description ?? "",
    });
    if (out.length >= MAX_INDEX_ENTRIES_PER_SECTION) break;
  }
  return out;
}

/**
 * Render the register index as one clearly-delimited TRUSTED block, or ""
 * when there is nothing to advertise (no skills AND no specialists) — so an
 * empty register leaves every prompt byte-identical to post-#16 (the
 * additive guarantee).
 *
 * Sections render only when non-empty. Entries are one line each:
 *   - <name>@<version> — <one-line description/when>
 * assembled from OPERATOR-AUTHORED register rows only — the ticket is not an
 * input, and oneLine() above means no row field can fabricate an entry line
 * or a delimiter. Trust posture matches skills.ts buildSkillBlock: the block
 * sits BELOW the card prompt and ABOVE the untrusted spec, ending in a blank
 * line so the boundary stays crisp.
 */
export function buildRegisterIndex(skills: readonly SkillIndexEntry[], specialists: readonly SpecialistIndexEntry[]): string {
  const skillLines: string[] = [];
  for (const s of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    if (s.enabled === false) continue;
    if (!NAME_RE.test(s.name)) continue;
    if (skillLines.length >= MAX_INDEX_ENTRIES_PER_SECTION) break;
    const desc = oneLine(s.description);
    skillLines.push(`- ${s.name}@${displayVersion(s.version)}${desc !== "" ? ` — ${desc}` : ""}`);
  }
  const specialistLines: string[] = [];
  for (const a of specialists) {
    if (!NAME_RE.test(a.name)) continue;
    if (specialistLines.length >= MAX_INDEX_ENTRIES_PER_SECTION) break;
    const when = oneLine(a.when);
    specialistLines.push(`- ${a.name}@${displayVersion(a.version)}${when !== "" ? ` — ${when}` : ""}`);
  }
  if (skillLines.length === 0 && specialistLines.length === 0) return "";

  const parts: string[] = [INDEX_BLOCK_HEADER];
  if (skillLines.length > 0) {
    parts.push(`AVAILABLE SKILLS (on-demand: Read ${MATERIALIZED_SKILLS_SUBDIR}/<name>.md to load one):`);
    parts.push(...skillLines);
  }
  if (specialistLines.length > 0) {
    parts.push("AVAILABLE SPECIALISTS (delegate a sub-problem via the Task tool, subagent_type=<name>):");
    parts.push(...specialistLines);
  }
  parts.push(INDEX_BLOCK_FOOTER);
  return `${parts.join("\n")}\n\n`;
}

// ---------------------------------------------------------------------------
// Orchestrating-stage predicate — the SAME derivation agents.ts uses for the
// worker subagent: a stage orchestrates iff its RESOLVED allowlist grants a
// subagent tool. Because that allowlist is resolveTools ⊆ ROLE_CEILINGS, the
// role ceiling AND the card both had to say yes; a card dropping Task/Agent
// also drops the index for that role with no code change.
// ---------------------------------------------------------------------------

const SUBAGENT_TOOL_BASES: ReadonlySet<string> = new Set(["Task", "Agent"]);

/** True when a resolved tool allowlist grants a subagent tool. */
export function orchestratesTools(tools: readonly string[]): boolean {
  return tools.some((t) => SUBAGENT_TOOL_BASES.has(t.replace(/\(.*$/, "")));
}

/** The index block a stage with `tools` should carry: the block for
 *  orchestrating stages, "" for everyone else (reviewers/judges/planners see
 *  no index — their prompts stay byte-identical). */
export function indexBlockForStage(tools: readonly string[], indexBlock: string): string {
  return orchestratesTools(tools) ? indexBlock : "";
}

// ---------------------------------------------------------------------------
// Delegation (issue #17 part 2, pure): register agents with `delegable: true`
// become extra SDK subagent types for ORCHESTRATING stages. Everything here is
// decision logic (CLAUDE.md: pure, I/O-free); agents.ts re-audits the result
// at the runStage choke point before any spawn.
// ---------------------------------------------------------------------------

const SUBAGENT_TOOL_BASE_RE = /\(.*$/;

/**
 * The TRIPLE INTERSECTION for one delegate's tools:
 *
 *     parent stage's resolved allowlist ∩ the entry's own tools: selection ∩ its role ceiling
 *
 * built so ⊆-parent holds BY CONSTRUCTION for arbitrary register declarations
 * (fuzzed in tests/routing.test.ts): the role ceiling is filtered down to what
 * the parent holds, and the entry's `tools:` line is resolved with routing.ts's
 * resolveTools over THAT base — resolveTools is a filter of its ceiling, so the
 * result is a filter of a filter of parentTools. A delegate can never hold a
 * tool its parent lacks (no privilege escalation via delegation).
 *
 * The ceiling is the entry's declared `role:` ceiling — or, when no role is
 * declared, the ceiling of the entry's own NAME (routing.ts's convention: roles
 * are named after their default card). An unknown/absent role resolves to []
 * exactly like ROLE_CEILINGS does (fail closed: no ceiling, no tools). Finally
 * Task/Agent are stripped even when the intersection contains them — depth 1 by
 * construction in the tools list, on top of the delegate's own deny list.
 */
export function delegateTools(parentTools: readonly string[], name: string, frontmatter: Record<string, string>): string[] {
  const role = (frontmatter.role ?? "").trim() || name;
  const ceiling = (ceilingForRole(role) ?? []).filter((t) => parentTools.includes(t));
  return resolveTools(ceiling, frontmatter.tools).tools
    .filter((t) => !SUBAGENT_TOOL_BASES.has(t.replace(SUBAGENT_TOOL_BASE_RE, "")));
}

/** Structural superset of DelegableCandidate carrying the register prompt —
 *  matches db.ts AgentRegisterRow without importing it (leaf-testable). */
export interface DelegableAgentRow extends DelegableCandidate {
  prompt: string;
}

export interface DelegateExclusion { name: string; reason: string }

export interface DelegateRosterBuild {
  /** What StageOptions.delegates receives — {} agents/pins when nothing is
   *  delegable, so runStage's agents map stays exactly { worker }. */
  roster: DelegateRoster;
  /** Rows that DECLARED delegable: true but were refused, and why — loop.ts
   *  logs these LOUDLY (the judges-never-delegable pin demands a visible
   *  refusal, not a silent drop). */
  excluded: DelegateExclusion[];
}

/**
 * Build the delegate roster for one orchestrating stage from the agent
 * register rows. Selection is delegableSpecialists() — the SAME filter, order
 * and cap as the index's specialists section, so every advertised
 * subagent_type is spawnable and vice versa: enabled rows with a bare
 * `delegable: true` (fail-closed like every such flag: "True"/"yes"/"1" are
 * NOT true), judges excluded by the in-code constant, "worker" reserved.
 * Each def is pinned to the invariants agents.ts re-audits:
 *   - prompt: the register prompt (operator-authored, trusted tier)
 *   - model: "inherit" ALWAYS (the 502-storm lesson)
 *   - maxTurns: SUBAGENT_MAX_TURNS (the existing in-code subagent cap)
 *   - disallowedTools: side-channels + Task/Agent (depth 1 holds)
 *   - tools: delegateTools() above (⊆ parent by construction)
 * A judge row with delegable: true lands in `excluded` — ignored LOUDLY. Gate
 * verdicts stay daemon-only by construction: a def carries no outputFormat
 * (DelegateAgentDef has no such field), and gate.ts reads only the parent
 * stage's own StageResult.
 */
export function buildDelegateRoster(rows: readonly DelegableAgentRow[], parentTools: readonly string[]): DelegateRosterBuild {
  const agents: Record<string, DelegateAgentDef> = {};
  const pins: Record<string, string> = {};
  const excluded: DelegateExclusion[] = [];
  // A non-orchestrating parent gets NO roster at all — delegates ride only on
  // stages whose allowlist grants Task/Agent (same predicate as the index).
  if (!orchestratesTools(parentTools)) return { roster: { agents, pins }, excluded };

  for (const r of rows) {
    if (r.enabled !== true || (r.frontmatter.delegable ?? "").trim() !== "true") continue;
    if (isJudgeName(r.name) || isJudgeName((r.frontmatter.role ?? "").trim())) {
      excluded.push({ name: r.name, reason: "judges are never delegable (in-code constant: security-reviewer, design-reviewer, reviewer-*) — delegable: true IGNORED; gate verdicts only count when the daemon runs the stage" });
    } else if (r.name === "worker") {
      excluded.push({ name: r.name, reason: '"worker" is the reserved built-in subagent name — a register row cannot shadow it' });
    } else if (r.prompt.trim() === "") {
      // delegableSpecialists filters this row out of the INDEX too (single
      // source: never advertise what cannot spawn) — the loud exclusion
      // lives here so the operator still learns WHY the row is inert.
      excluded.push({ name: r.name, reason: "register prompt is empty — nothing to run the delegate on" });
    }
  }

  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const s of delegableSpecialists(rows)) {
    const row = byName.get(s.name);
    if (row === undefined) continue;
    const prompt = row.prompt.trim();
    if (prompt === "") { excluded.push({ name: s.name, reason: "register prompt is empty — nothing to run the delegate on" }); continue; }
    agents[s.name] = {
      description: oneLine(s.when) || `Register specialist ${s.name} (operator-authored).`,
      prompt,
      model: "inherit",
      maxTurns: SUBAGENT_MAX_TURNS,
      disallowedTools: [...SUBAGENT_DISALLOWED_TOOLS],
      tools: delegateTools(parentTools, s.name, row.frontmatter),
    };
    pins[s.name] = `${s.name}@${displayVersion(row.version)}`;
  }
  return { roster: { agents, pins }, excluded };
}

// ---------------------------------------------------------------------------
// Materialization (the one I/O half). <worktree>/.factory/ is factory-owned
// scratch: repos.ts excludes it from commitAll and from guarded-path
// classification, so nothing written here can reach a commit, a diff, or a PR.
// ---------------------------------------------------------------------------

export const FACTORY_SCRATCH_DIRNAME = ".factory";
/** Worktree-relative directory the skills land in (posix-shaped on every
 *  platform this daemon runs on; also the path the index block advertises). */
export const MATERIALIZED_SKILLS_SUBDIR = `${FACTORY_SCRATCH_DIRNAME}/skills`;

/** Worktree-relative path of one materialized skill. */
export function materializedSkillRelPath(name: string): string {
  return `${MATERIALIZED_SKILLS_SUBDIR}/${name}.md`;
}

/** The materialized file body: a one-line name@version header (the pin a
 *  Read's tool-use event is attributed against), then the register content
 *  verbatim. */
export function skillFileContent(name: string, version: number, content: string): string {
  return `<!-- factory skill ${name}@${displayVersion(version)} — materialized from the skill register (operator-authored, TRUSTED reference). Read-only: never edit; .factory/ never reaches a commit or PR. -->\n\n${content.trim()}\n`;
}

/** Structural subset of db.ts SkillRegisterRow (no db.ts import — see above). */
export interface MaterializableSkill {
  name: string;
  version: number;
  enabled: boolean;
  content: string;
}

export interface MaterializedSkill { name: string; version: number; relPath: string }

export interface MaterializeReport {
  /** Skills present on disk after this call (sorted by name) — what the index
   *  may advertise. */
  materialized: MaterializedSkill[];
  /** Names actually (re)written this call — [] on an idempotent re-run. */
  written: string[];
  /** Stale filenames deleted (skill disabled/removed since the last run). */
  removed: string[];
  /** Skills refused at the write, and why (secret-like content, size, name).
   *  A rejected skill's stale file is also removed — never serve old content
   *  under a new version's name. */
  rejected: Array<{ skill: string; reason: string }>;
}

/** Atomic tmp+rename write (same pattern as register-io.ts) — a worker reading
 *  a skill mid-refresh must never see a torn file. */
function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // Unlink any existing tmp entry FIRST: writeFileSync follows symlinks, so a
  // planted `<name>.md.tmp` link would otherwise redirect this write outside
  // the worktree (same class as the .factory symlink guard; unlinking a link
  // never touches its target). Also clears a stale tmp from a crashed write.
  try { unlinkSync(tmp); } catch { /* absent — the normal case */ }
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** True when `file` resolves inside `baseDir` — belt-and-braces on top of the
 *  charset lock (register-io.ts insideDir, same check). LEXICAL only (path
 *  algebra, no filesystem) — symlink escapes are handled separately below. */
function insideDir(file: string, baseDir: string): boolean {
  const resolvedFile = resolve(file);
  const resolvedBase = resolve(baseDir);
  return resolvedFile === resolvedBase || resolvedFile.startsWith(resolvedBase + sep);
}

/** True when `p` exists and is a symlink (lstat — never follows). */
function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * Symlink guard: issue worktrees are REUSED across runs with no reset, so a
 * prior run's ticket-steered implementer (WRITER_BASH grants node/bun) can
 * plant `.factory` — or `.factory/skills` — as a symlink pointing OUTSIDE the
 * worktree. Every later fs op in materializeSkills would then resolve THROUGH
 * the link: the stale-cleanup rm and the empty-register recursive rm would
 * delete files in the target, and writes would land there — as the daemon
 * user, into e.g. a sibling worktree or the daemon's own checkout. insideDir()
 * above is lexical and does not defeat this. So: before ANY mutation, lstat
 * both path components; a symlink is UNLINKED (removing a symlink never
 * touches its target) and reported loudly, and this run materializes nothing —
 * the next run starts from a clean, link-free path. Returns true when the
 * guard tripped (caller must stop).
 */
function refuseSymlinkedScratch(worktreeDir: string, reject: (skill: string, reason: string) => void): boolean {
  let tripped = false;
  for (const rel of [FACTORY_SCRATCH_DIRNAME, join(FACTORY_SCRATCH_DIRNAME, "skills")]) {
    const p = join(worktreeDir, rel);
    if (!isSymlink(p)) continue;
    tripped = true;
    let removed = "removed";
    try { unlinkSync(p); } catch (error) { removed = `removal failed: ${error instanceof Error ? error.message : error}`; }
    reject("*", `refusing to materialize: ${rel} is a SYMLINK (planted link would redirect factory writes/deletes outside the worktree) — link ${removed}; no skills materialized this run`);
  }
  return tripped;
}

/**
 * Materialize the enabled register skills into `<worktreeDir>/.factory/skills/`.
 *
 * Idempotent per run (unchanged content is not rewritten) and self-refreshing
 * on workspace REUSE: files for skills that are now disabled, renamed, removed
 * or rejected are deleted, and when nothing at all is enabled the whole
 * `.factory/skills/` dir (and an empty `.factory/`) is removed — a register
 * that materializes nothing leaves the worktree byte-identical to post-#16.
 *
 * Redaction re-scan AT WRITE (defense in depth on top of the register write's
 * own hard reject): secret-like content refuses to materialize. Never throws —
 * a broken skill is a rejected entry, not a parked run.
 */
export function materializeSkills(worktreeDir: string, skills: readonly MaterializableSkill[]): MaterializeReport {
  const report: MaterializeReport = { materialized: [], written: [], removed: [], rejected: [] };
  const dir = join(worktreeDir, FACTORY_SCRATCH_DIRNAME, "skills");
  const reject = (skill: string, reason: string): void => { report.rejected.push({ skill, reason }); };

  // BEFORE any mutation: a planted `.factory` (or `.factory/skills`) symlink
  // would make every op below act outside the worktree — refuse, loudly.
  if (refuseSymlinkedScratch(worktreeDir, reject)) return report;

  // Decide the expected file set (pure part first, deterministic name order).
  const expected = new Map<string, { name: string; version: number; body: string }>();
  for (const s of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    if (s.enabled !== true) continue; // disabled is normal, not noise
    if (!NAME_RE.test(s.name)) { reject(s.name, "name fails the charset lock — refusing to build a path from it"); continue; }
    if (expected.size >= MAX_MATERIALIZED_SKILLS) { reject(s.name, `materialization cap — at most ${MAX_MATERIALIZED_SKILLS} skills per worktree`); continue; }
    if (Buffer.byteLength(s.content, "utf8") > MAX_MATERIALIZED_BYTES) { reject(s.name, `content exceeds the ${MAX_MATERIALIZED_BYTES / 1024}KB cap`); continue; }
    const scan = redactSecrets(s.content);
    if (scan.found > 0) { reject(s.name, `content contains ${scan.found} secret-like string(s) — refusing to materialize`); continue; }
    const file = join(dir, `${s.name}.md`);
    if (!insideDir(file, dir)) { reject(s.name, "path escapes the skills dir — refusing"); continue; }
    expected.set(`${s.name}.md`, { name: s.name, version: s.version, body: skillFileContent(s.name, s.version, s.content) });
  }

  try {
    // Refresh: drop every stale .md the expected set no longer contains.
    let current: string[] = [];
    // `.md.tmp` included: orphans from a crashed atomic write (or planted
    // links — rm removes the link itself) must not accumulate (review finding).
    try { current = readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".md.tmp")); } catch { /* no dir yet */ }
    for (const f of current.sort()) {
      if (expected.has(f)) continue;
      try { rmSync(join(dir, f), { force: true }); report.removed.push(f); }
      catch (error) { reject(f, `stale file removal failed: ${error instanceof Error ? error.message : error}`); }
    }

    if (expected.size === 0) {
      // Nothing enabled → no .factory/skills at all (additive guarantee), and
      // best-effort removal of a now-empty .factory/ from an earlier run.
      rmSync(dir, { recursive: true, force: true });
      try { rmdirSync(join(worktreeDir, FACTORY_SCRATCH_DIRNAME)); } catch { /* non-empty or absent — fine */ }
      return report;
    }

    for (const [file, entry] of expected) {
      const abs = join(dir, file);
      let currentBody: string | null = null;
      try { currentBody = readFileSync(abs, "utf8"); } catch { /* new file */ }
      try {
        if (currentBody !== entry.body) {
          writeFileAtomic(abs, entry.body);
          report.written.push(entry.name);
        }
        report.materialized.push({ name: entry.name, version: displayVersion(entry.version), relPath: materializedSkillRelPath(entry.name) });
      } catch (error) {
        reject(entry.name, `write failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) {
    // Materialization is best-effort by contract: a filesystem surprise must
    // degrade to "skills unavailable this run", never park the pipeline.
    reject("*", `materialization failed: ${error instanceof Error ? error.message : error}`);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Stage-boundary refresh: materialization runs at workspace setup, but WRITE
// stages (the implementer holds bare Write; the fixer family too) run in the
// same worktree BEFORE later stages read the files. A ticket-steered overwrite
// of .factory/skills/<name>.md would otherwise be read by the fixer/tester —
// a GATE stage — under the file's "operator-authored, TRUSTED" header, and it
// is invisible everywhere a human looks (.factory/ never reaches a commit,
// diff, or PR). materializeSkills is idempotent and self-repairing (a file is
// rewritten only when its on-disk body differs from the register), so
// re-running it at each stage boundary restores tampered content, deletes
// planted extra files, and costs a stat+read when nothing was touched.
// ---------------------------------------------------------------------------

export interface SkillRefresh {
  /** The refresh's MaterializeReport. Because the register snapshot is the
   *  same one setup materialized from, ANY `written` entry here means the
   *  on-disk file DIFFERED from the register — i.e. something in the worktree
   *  tampered with it (or a prior write failed); `removed` means a planted
   *  extra file was deleted. Callers log both LOUDLY. */
  report: MaterializeReport;
  /** The register index rebuilt from the FRESH report, so a skill that no
   *  longer materializes (e.g. the symlink refusal above) is no longer
   *  advertised to the stage about to run. */
  index: string;
}

/** Re-materialize the register skills and rebuild the index at a stage
 *  boundary. `descriptions` maps skill name → register description (the index
 *  line text); `specialists` is the delegable set (unchanged by the refresh —
 *  it never touches disk). */
export function refreshMaterializedSkills(
  worktreeDir: string,
  skills: readonly MaterializableSkill[],
  descriptions: ReadonlyMap<string, string>,
  specialists: readonly SpecialistIndexEntry[],
): SkillRefresh {
  const report = materializeSkills(worktreeDir, skills);
  const index = buildRegisterIndex(
    report.materialized.map((m) => ({ name: m.name, version: m.version, description: descriptions.get(m.name) ?? "" })),
    specialists);
  return { report, index };
}
