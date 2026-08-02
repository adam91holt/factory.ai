import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getActiveAgentRegisterRow, getActiveSkillRegisterRow,
  insertSkillRegisterVersion,
  listAgentRegisterRows, listSkillRegisterRows,
  setAgentRegisterEnabled, setSkillRegisterEnabled,
  type AgentRegisterRow, type SkillRegisterRow,
} from "./db.ts";
import { parseCardText } from "./catalog.ts";
import { validateAgentRoutingAgainst } from "./catalog-manager.ts";
import {
  saveAgentRegisterVersionFromContent, saveSkillRegisterVersionFromContent,
  serializeAgentCard, skillContentHash,
} from "./register-io.ts";
import { loadProjects } from "./registry.ts";
import { factHolds, KNOWN_GATE_NAMES, ROLE_CEILINGS, type RepoFacts } from "./routing.ts";
import { selectSkills, type CarriableSkill } from "./skills.ts";

// Register manager (issue #16 WP3) — the mission-control surface over the PG
// agent/skill registers. Same architectural split as project-config.ts: every
// function here returns { status, json } and does NO http; src/server.ts's
// handleRegisterRoutes mounts them behind the ONE shared guardedJsonBody()
// gate (POST-only, JSON-only, loopback/trusted-origin). Nothing in this module
// reads ticket text — attach selectors are validated against the SAME closed
// vocabularies routing.ts uses (ROLE_CEILINGS keys, the factHolds grammar),
// and the preview is computed by the SAME pure selectSkills the daemon runs at
// stage assembly, so the UI can never disagree with the pipeline about where a
// skill carries.
//
// Write posture (all established invariants, none new):
//   - saves are APPEND-ONLY new versions through register-io's write gate
//     (NAME_RE charset lock, 64KB cap, redactSecrets HARD reject);
//   - agent routing declarations (`role:`/`match:`/`tools:`) are locked to the
//     trusted baseline — the ACTIVE register row, else the on-disk file — via
//     the same validator /catalog/save uses (validateAgentRoutingAgainst), so
//     a browser POST can never mint or repoint a specialist;
//   - rollback is "re-enable version N" (db.ts setRegisterEnabled — the
//     exactly-one-active partial index does the enforcement);
//   - file + git stays available ONLY as the export action (the existing
//     /catalog/save route) — this module never touches the filesystem or git.

export interface RouteResult { status: number; json: unknown }

const bad = (status: number, error: string): RouteResult => ({ status, json: { error } });

// Same charset posture as every register name. Projects are free-entry
// ("org/name" or bare repo name — the two forms selectSkills matches), so the
// server validates shape + caps here rather than against a closed set.
const PROJECT_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Attach caps — mirror skills.ts's in-code caps (a selector the write route
// accepts must never be one selectSkills rejects for size).
const MAX_ATTACH_ROLES = 16;
const MAX_ATTACH_PROJECTS = 32;
const MAX_ATTACH_MATCH_TERMS = 8;

/** The closed `match` vocabulary the attach editor may offer — every term the
 *  factHolds grammar defines, and nothing else. Derived from the same
 *  KNOWN_GATE_NAMES routing.ts evaluates, so the two cannot drift. */
export function matchTermVocabulary(): string[] {
  return [
    "ui", "no-ui", "playwright", "no-playwright",
    ...KNOWN_GATE_NAMES.map((g) => `gate:${g}`),
    ...KNOWN_GATE_NAMES.map((g) => `no-gate:${g}`),
  ];
}

/** Roles the attach editor may offer — exactly the wired stage slots. */
export function attachableRoles(): string[] {
  return Object.keys(ROLE_CEILINGS);
}

// ---------------------------------------------------------------------------
// View.
// ---------------------------------------------------------------------------

export interface RegisterVersionInfo {
  version: number;
  createdAt: number;
  createdBy: string;
  active: boolean;
}

export interface AgentRegisterEntry {
  name: string;
  /** null = no active version (all disabled) — the file fallback applies. */
  activeVersion: number | null;
  /** Newest-first append-only history: who/when per version. */
  versions: RegisterVersionInfo[];
  /** ACTIVE version rendered back to card-file form (editor baseline), or
   *  null when nothing is active. */
  content: string | null;
  frontmatter: Record<string, string>;
}

export interface NormalizedAttach {
  roles: string[];
  projects: string[];
  match: string[];
}

export interface SkillRegisterEntry {
  name: string;
  activeVersion: number | null;
  versions: RegisterVersionInfo[];
  content: string | null;
  description: string;
  /** The ACTIVE version's attach, normalized for the editor ({} → empty
   *  arrays; malformed values surface as empty so the editor starts clean —
   *  selectSkills itself still fail-closes on the raw row). */
  attach: NormalizedAttach;
  enabled: boolean;
}

export interface RegistersPayload {
  agents: AgentRegisterEntry[];
  skills: SkillRegisterEntry[];
  /** Editor vocabularies — closed sets the UI multi-selects from. */
  roles: string[];
  matchTerms: string[];
  /** Known repos (project cards) for the preview + projects suggestions. */
  repos: string[];
}

function versionInfos(rows: Array<AgentRegisterRow | SkillRegisterRow>): RegisterVersionInfo[] {
  return rows
    .slice()
    .sort((a, b) => b.version - a.version)
    .map((r) => ({ version: r.version, createdAt: r.createdAt, createdBy: r.createdBy, active: r.enabled }));
}

function looseStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

/** Normalize a stored attach object for DISPLAY. Read-side tolerance only —
 *  the write side (validateAttachInput) rejects malformed shapes outright. */
export function normalizeAttach(attach: Record<string, unknown>): NormalizedAttach {
  return {
    roles: looseStringArray(attach.roles),
    projects: looseStringArray(attach.projects),
    match: looseStringArray(attach.match),
  };
}

function groupByName<T extends { name: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const bucket = out.get(r.name) ?? [];
    bucket.push(r);
    out.set(r.name, bucket);
  }
  return out;
}

function knownRepos(): string[] {
  const repos = new Set<string>();
  for (const card of loadProjects()) for (const r of card.repos) repos.add(r);
  return [...repos].sort();
}

export async function registersView(): Promise<RouteResult> {
  const agentRows = await listAgentRegisterRows();
  const skillRows = await listSkillRegisterRows();

  const agents: AgentRegisterEntry[] = [];
  for (const [name, rows] of [...groupByName(agentRows)].sort(([a], [b]) => a.localeCompare(b))) {
    const active = rows.find((r) => r.enabled) ?? null;
    agents.push({
      name,
      activeVersion: active?.version ?? null,
      versions: versionInfos(rows),
      content: active ? serializeAgentCard(active.frontmatter, active.prompt) : null,
      frontmatter: active ? { ...active.frontmatter } : {},
    });
  }

  const skills: SkillRegisterEntry[] = [];
  for (const [name, rows] of [...groupByName(skillRows)].sort(([a], [b]) => a.localeCompare(b))) {
    const active = rows.find((r) => r.enabled) ?? null;
    skills.push({
      name,
      activeVersion: active?.version ?? null,
      versions: versionInfos(rows),
      content: active?.content ?? null,
      description: active?.description ?? "",
      attach: normalizeAttach(active?.attach ?? {}),
      enabled: active !== null,
    });
  }

  const payload: RegistersPayload = {
    agents, skills,
    roles: attachableRoles(),
    matchTerms: matchTermVocabulary(),
    repos: knownRepos(),
  };
  return { status: 200, json: payload };
}

// ---------------------------------------------------------------------------
// Saves (append-only new version — PG, never a file).
// ---------------------------------------------------------------------------

export async function saveRegisterEntry(input: unknown): Promise<RouteResult> {
  if (typeof input !== "object" || input === null) return bad(400, "body must be a JSON object");
  const { kind, name, content } = input as Record<string, unknown>;
  if (kind !== "agent" && kind !== "skill") {
    return bad(400, `kind must be agent|skill (got ${JSON.stringify(kind)})`);
  }
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return bad(400, `name must match ${NAME_RE} (got ${JSON.stringify(name)})`);
  }
  if (typeof content !== "string") return bad(400, "content must be a string");

  // Same frontmatter discipline as /catalog/save — the register must never
  // accept a card the file route would refuse.
  const { frontmatter } = parseCardText(content);
  if (!/^---\n/.test(content)) return bad(422, "content must open with a YAML frontmatter block (--- ... ---)");
  if (!frontmatter.name) return bad(422, "frontmatter is missing a name field");
  if (frontmatter.name !== name) {
    return bad(422, `frontmatter name ${JSON.stringify(frontmatter.name)} must equal the save name ${JSON.stringify(name)}`);
  }
  if (kind === "skill" && !frontmatter.description) return bad(422, "skill frontmatter is missing a description field");

  if (kind === "agent") {
    // Routing lock, identical to /catalog/save: baseline = the ACTIVE register
    // row when there is one (it is what routing actually reads), else the
    // on-disk file the register would fall back to. Same pure validator, so
    // the two write paths refuse identically.
    const active = await getActiveAgentRegisterRow(name);
    let baseline: Record<string, string>;
    if (active) {
      baseline = active.frontmatter;
    } else {
      baseline = {};
      try {
        // `name` is charset-locked above, so this path cannot traverse.
        const file = fileURLToPath(new URL(`../agents/${name}.md`, import.meta.url));
        baseline = parseCardText(readFileSync(file, "utf8")).frontmatter;
      } catch { /* new card — declares nothing */ }
    }
    const violation = validateAgentRoutingAgainst(name, frontmatter, baseline);
    if (violation) return bad(422, violation);
  }

  const result = kind === "agent"
    ? await saveAgentRegisterVersionFromContent(name, content, "dashboard")
    : await saveSkillRegisterVersionFromContent(name, content, "dashboard");
  if (!result.ok) return bad(422, result.error);
  return { status: 200, json: { ok: true, name: result.name, version: result.version, unchanged: result.unchanged } };
}

// ---------------------------------------------------------------------------
// Rollback — "re-enable version N". The DB's exactly-one-active partial index
// is the enforcement; db.ts's setRegisterEnabled does the atomic swap.
// ---------------------------------------------------------------------------

export async function rollbackRegisterVersion(input: unknown): Promise<RouteResult> {
  if (typeof input !== "object" || input === null) return bad(400, "body must be a JSON object");
  const { kind, name, version } = input as Record<string, unknown>;
  if (kind !== "agent" && kind !== "skill") return bad(400, "kind must be agent|skill");
  if (typeof name !== "string" || !NAME_RE.test(name)) return bad(400, `name must match ${NAME_RE}`);
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return bad(400, "version must be a positive integer");
  }
  const ok = kind === "agent"
    ? await setAgentRegisterEnabled(name, version, true)
    : await setSkillRegisterEnabled(name, version, true);
  if (!ok) return bad(404, `no ${kind} register version ${name}@${version} to enable (or the write was refused)`);
  return { status: 200, json: { ok: true, name, version } };
}

// ---------------------------------------------------------------------------
// Skill attach editing + enabled toggle.
// ---------------------------------------------------------------------------

/** Validate an untrusted attach body against the CLOSED vocabularies. Returns
 *  the normalized attach or an error string — fail-closed: an unknown role, an
 *  unknown match term, or a malformed shape rejects the whole write (nothing
 *  is dropped silently; the operator fixes the selector, not the daemon). */
export function validateAttachInput(input: unknown): { ok: true; attach: NormalizedAttach } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "attach must be a JSON object {roles, projects, match}" };
  }
  const raw = input as Record<string, unknown>;
  const readArray = (key: "roles" | "projects" | "match", cap: number): string[] | string => {
    const v = raw[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return `attach.${key} must be an array of strings`;
    const out: string[] = [];
    for (const entry of v) {
      if (typeof entry !== "string") return `attach.${key} must be an array of strings`;
      const t = entry.trim();
      if (t !== "") out.push(t);
    }
    if (out.length > cap) return `attach.${key} exceeds the cap of ${cap}`;
    if (new Set(out).size !== out.length) return `attach.${key} has duplicate entries`;
    return out;
  };

  const roles = readArray("roles", MAX_ATTACH_ROLES);
  if (typeof roles === "string") return { ok: false, error: roles };
  for (const r of roles) {
    if (!Object.prototype.hasOwnProperty.call(ROLE_CEILINGS, r)) {
      return { ok: false, error: `unknown role ${JSON.stringify(r)} — roles must come from the wired stage slots (${attachableRoles().join(", ")})` };
    }
  }

  const projects = readArray("projects", MAX_ATTACH_PROJECTS);
  if (typeof projects === "string") return { ok: false, error: projects };
  for (const p of projects) {
    const segments = p.split("/");
    if (segments.length > 2 || !segments.every((s) => PROJECT_SEGMENT_RE.test(s))) {
      return { ok: false, error: `invalid project ${JSON.stringify(p)} — expected "org/name" or a bare repo name (letters, digits, . _ -)` };
    }
  }

  const match = readArray("match", MAX_ATTACH_MATCH_TERMS);
  if (typeof match === "string") return { ok: false, error: match };
  const probe: RepoFacts = { ui: false, playwright: false, gates: [] };
  for (const t of match) {
    if (factHolds(t, probe) === null) {
      return { ok: false, error: `unknown match term ${JSON.stringify(t)} — terms must come from the factHolds grammar (${matchTermVocabulary().join(", ")})` };
    }
  }

  return { ok: true, attach: { roles, projects, match } };
}

export async function setSkillAttach(input: unknown): Promise<RouteResult> {
  if (typeof input !== "object" || input === null) return bad(400, "body must be a JSON object");
  const { name, attach } = input as Record<string, unknown>;
  if (typeof name !== "string" || !NAME_RE.test(name)) return bad(400, `name must match ${NAME_RE}`);
  const validated = validateAttachInput(attach);
  if (!validated.ok) return bad(422, validated.error);
  const active = await getActiveSkillRegisterRow(name);
  if (!active) return bad(404, `no active skill register version for ${JSON.stringify(name)} — save (or re-enable) the skill first`);
  const inserted = await insertSkillRegisterVersion({
    name,
    description: active.description,
    content: active.content,
    attach: { ...validated.attach },
    // Content is unchanged, so the canonical content hash carries over — a
    // later file re-import still recognises this version as "same content".
    contentHash: skillContentHash(active.content),
    createdBy: "dashboard",
  });
  if (!inserted) return bad(500, "register write refused (closed store or a lost concurrent-write race)");
  return { status: 200, json: { ok: true, name, version: inserted.version, attach: validated.attach } };
}

export async function setSkillEnabledState(input: unknown): Promise<RouteResult> {
  if (typeof input !== "object" || input === null) return bad(400, "body must be a JSON object");
  const { name, enabled } = input as Record<string, unknown>;
  if (typeof name !== "string" || !NAME_RE.test(name)) return bad(400, `name must match ${NAME_RE}`);
  if (typeof enabled !== "boolean") return bad(400, "enabled must be a boolean");
  const rows = await listSkillRegisterRows(name);
  if (rows.length === 0) return bad(404, `no skill register rows for ${JSON.stringify(name)}`);
  const active = rows.find((r) => r.enabled) ?? null;
  if (enabled) {
    if (active) return { status: 200, json: { ok: true, name, version: active.version, enabled: true } };
    const newest = rows.reduce((a, b) => (b.version > a.version ? b : a));
    const ok = await setSkillRegisterEnabled(name, newest.version, true);
    if (!ok) return bad(500, "enable refused (closed store or a lost concurrent-write race)");
    return { status: 200, json: { ok: true, name, version: newest.version, enabled: true } };
  }
  if (!active) return { status: 200, json: { ok: true, name, version: null, enabled: false } };
  const ok = await setSkillRegisterEnabled(name, active.version, false);
  if (!ok) return bad(500, "disable refused (closed store or a lost concurrent-write race)");
  return { status: 200, json: { ok: true, name, version: null, enabled: false } };
}

// ---------------------------------------------------------------------------
// "Where would this carry?" — the preview, computed by the SAME pure
// selectSkills the daemon runs at stage assembly (skills.ts). No I/O beyond
// reading the known project cards for the repo universe.
// ---------------------------------------------------------------------------

/** Construct the RepoFacts a repo would need for every match term to hold, or
 *  null when the terms contradict each other (ui + no-ui) — such a selector
 *  carries nowhere. Unconstrained facts default to true/present so the preview
 *  answers "in a repo satisfying these terms, where does it carry?". */
export function factsSatisfying(match: readonly string[]): RepoFacts | null {
  let ui: boolean | null = null;
  let playwright: boolean | null = null;
  const gates = new Set<string>();
  const noGates = new Set<string>();
  for (const t of match) {
    if (t === "ui") { if (ui === false) return null; ui = true; }
    else if (t === "no-ui") { if (ui === true) return null; ui = false; }
    else if (t === "playwright") { if (playwright === false) return null; playwright = true; }
    else if (t === "no-playwright") { if (playwright === true) return null; playwright = false; }
    else if (t.startsWith("gate:")) { const g = t.slice("gate:".length); if (noGates.has(g)) return null; gates.add(g); }
    else if (t.startsWith("no-gate:")) { const g = t.slice("no-gate:".length); if (gates.has(g)) return null; noGates.add(g); }
    else return null; // unknown — validateAttachInput refuses these before we get here
  }
  return { ui: ui ?? true, playwright: playwright ?? true, gates: [...gates] };
}

export interface AttachPreview {
  /** role → repos the skill would carry into (repo universe below). */
  carries: Array<{ role: string; repos: string[] }>;
  /** The repo universe the preview evaluated ("org/name" strings). */
  repos: string[];
  /** Match terms as carry CONDITIONS (facts of the eventual worktree). */
  conditions: string[];
  /** True when the match terms contradict each other → carries nowhere. */
  contradictory: boolean;
  /** Structural rejections selectSkills reported (e.g. no roles declared). */
  rejected: Array<{ skill: string; reason: string }>;
}

export async function previewSkillAttach(input: unknown): Promise<RouteResult> {
  if (typeof input !== "object" || input === null) return bad(400, "body must be a JSON object");
  const { name, attach } = input as Record<string, unknown>;
  const skillName = typeof name === "string" && NAME_RE.test(name) ? name : "preview";
  const validated = validateAttachInput(attach);
  if (!validated.ok) return bad(422, validated.error);

  const universe = new Set<string>(knownRepos());
  for (const p of validated.attach.projects) universe.add(p);
  const repos = universe.size > 0 ? [...universe].sort() : ["org/repo"];

  const facts = factsSatisfying(validated.attach.match);
  const skill: CarriableSkill = {
    name: skillName, version: 0, enabled: true,
    attach: { ...validated.attach },
    content: "x",
  };

  const carries: AttachPreview["carries"] = [];
  const rejected = new Map<string, { skill: string; reason: string }>();
  if (facts !== null) {
    for (const role of attachableRoles()) {
      const carriedRepos: string[] = [];
      for (const repo of repos) {
        const sel = selectSkills(role, repo, facts, [skill]);
        if (sel.carried.length > 0) carriedRepos.push(repo);
        for (const r of sel.rejected) rejected.set(`${r.skill}:${r.reason}`, r);
      }
      if (carriedRepos.length > 0) carries.push({ role, repos: carriedRepos });
    }
  }

  const preview: AttachPreview = {
    carries,
    repos,
    conditions: [...validated.attach.match],
    contradictory: facts === null,
    rejected: [...rejected.values()],
  };
  return { status: 200, json: preview };
}
