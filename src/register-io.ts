import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./agents.ts";
import { parseCardText } from "./catalog.ts";
import {
  getActiveAgentRegisterRow, getActiveSkillRegisterRow,
  insertAgentRegisterVersion, insertSkillRegisterVersion,
  listActiveAgentRegisterRows, listActiveSkillRegisterRows,
} from "./db.ts";

// Register import/export (issue #16 WP1) — the file⇄register seam.
//
//   importRegistersFromFiles()  seeds agent_register from agents/*.md and
//     skill_register from skills/<name>/SKILL.md. IDEMPOTENT by content hash:
//     a re-run creates NO new versions while the file content is unchanged.
//   exportRegistersToFiles()    writes every ACTIVE version back to its file —
//     the disaster-recovery path and the reviewable git trail (a human commits
//     the export; this module never touches git).
//
// The hash is CANONICAL, not raw-bytes: an agent card hashes its parsed
// (frontmatter-sorted, prompt-trimmed) form, so import → export → import is a
// fixed point even though jsonb does not preserve key order; a skill hashes its
// content verbatim because the content IS the file and is exported byte-for-
// byte. Validation mirrors catalog-manager.ts's save route exactly — name
// charset lock, 64KB cap, and a HARD redactSecrets reject (a secret must never
// land in a register row any more than in a tracked file) — and is layered on
// top of db.ts's own structural checks, not instead of them.
//
// The importer treats FILES as the source when they disagree with the register:
// that is the seed/disaster-recovery direction (after an export the two agree
// again). It is a plain function — the daemon, not a model, decides when to
// call it, and a closed store makes every save report a failure rather than
// throw.

const FACTORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_AGENTS_DIR = join(FACTORY_ROOT, "agents");
const DEFAULT_SKILLS_DIR = join(FACTORY_ROOT, "skills");

// Same lock and cap as catalog-manager.ts's POST /catalog/save (kept local:
// catalog-manager does not export them, and importing it here would drag the
// dashboard's git machinery onto this module's graph for two constants).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_CONTENT_BYTES = 64 * 1024;

const sha256 = (...parts: string[]): string => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p, "utf8");
  return h.digest("hex");
};

/** Canonical hash of an agent card: sorted frontmatter entries + trimmed
 *  prompt. Order-insensitive so a jsonb round trip (which re-orders keys)
 *  still compares equal to the file it came from. */
export function agentContentHash(frontmatter: Record<string, string>, prompt: string): string {
  const fm = Object.keys(frontmatter).sort().map((k) => `${k}: ${frontmatter[k] ?? ""}`).join("\n");
  return sha256(fm, "\u0000", prompt.trim());
}

/** Canonical hash of a skill pack: the SKILL.md content verbatim (the content
 *  is stored and exported byte-for-byte, so raw bytes ARE canonical here). */
export function skillContentHash(content: string): string {
  return sha256(content);
}

export type RegisterSaveResult =
  | { ok: true; name: string; version: number; unchanged: boolean }
  | { ok: false; name: string; error: string };

const fail = (name: string, error: string): RegisterSaveResult => ({ ok: false, name, error });

// Control characters have no place in a card or skill body: tab/newline/CR are
// the only whitespace a prompt file legitimately carries, and a NUL byte is a
// hard Postgres TEXT error that must be a clear 422 at the gate, never a
// database failure mid-write.
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Shared write-route validation. Returns an error string or null. */
function contentViolation(name: string, content: string): string | null {
  if (!NAME_RE.test(name)) return `name must match ${NAME_RE}`;
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return `content exceeds the ${MAX_CONTENT_BYTES / 1024}KB cap`;
  }
  if (CONTROL_CHAR_RE.test(content)) {
    return "content contains control characters (only tab, newline and carriage return are allowed)";
  }
  const scan = redactSecrets(content);
  if (scan.found > 0) return `content contains ${scan.found} secret-like string(s)`;
  return null;
}

/** Validate + parse one agent card file text and append it to the register as
 *  the new active version — unless the ACTIVE version already has the same
 *  canonical hash, in which case nothing is written (the idempotency leg).
 *  This is THE write path for agent register content; the importer is a loop
 *  over it and any future dashboard save should call it too. */
export async function saveAgentRegisterVersionFromContent(name: string, content: string, createdBy: string): Promise<RegisterSaveResult> {
  const violation = contentViolation(name, content);
  if (violation) return fail(name, violation);
  const { frontmatter, prompt } = parseCardText(content);
  const contentHash = agentContentHash(frontmatter, prompt);
  const active = await getActiveAgentRegisterRow(name);
  if (active && active.contentHash === contentHash) {
    return { ok: true, name, version: active.version, unchanged: true };
  }
  const inserted = await insertAgentRegisterVersion({ name, frontmatter, prompt, contentHash, createdBy });
  if (!inserted) return fail(name, "register write refused (closed store, a database error, or a concurrent write — see the daemon log)");
  return { ok: true, name, version: inserted.version, unchanged: false };
}

/** Skill twin of saveAgentRegisterVersionFromContent: content is the whole
 *  SKILL.md, description is lifted from its frontmatter. `attach` CARRIES
 *  FORWARD from the active version (a content edit must never silently detach
 *  a skill that an operator wired up — issue #16 WP3); a name with no active
 *  version starts at {} (nothing is attached implicitly). */
export async function saveSkillRegisterVersionFromContent(name: string, content: string, createdBy: string): Promise<RegisterSaveResult> {
  const violation = contentViolation(name, content);
  if (violation) return fail(name, violation);
  const { frontmatter } = parseCardText(content);
  const contentHash = skillContentHash(content);
  const active = await getActiveSkillRegisterRow(name);
  if (active && active.contentHash === contentHash) {
    return { ok: true, name, version: active.version, unchanged: true };
  }
  const inserted = await insertSkillRegisterVersion({
    name, description: frontmatter.description ?? "", content, attach: active?.attach ?? {}, contentHash, createdBy,
  });
  if (!inserted) return fail(name, "register write refused (closed store, a database error, or a concurrent write — see the daemon log)");
  return { ok: true, name, version: inserted.version, unchanged: false };
}

export interface RegisterImportReport {
  agents: RegisterSaveResult[];
  skills: RegisterSaveResult[];
}

export interface RegisterIoOptions {
  /** Test seams — default to the real agents/ and skills/ directories. */
  agentsDir?: string;
  skillsDir?: string;
  createdBy?: string;
}

/** Seed/refresh both registers from the card files. Idempotent: a name whose
 *  file content canonically equals its ACTIVE register version is skipped
 *  (`unchanged: true`), so a re-run creates no versions. Files the validation
 *  rejects (or a closed store) come back as ok:false entries — never a throw. */
export async function importRegistersFromFiles(opts: RegisterIoOptions = {}): Promise<RegisterImportReport> {
  const agentsDir = opts.agentsDir ?? DEFAULT_AGENTS_DIR;
  const skillsDir = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
  const createdBy = opts.createdBy ?? "import";
  const report: RegisterImportReport = { agents: [], skills: [] };

  let agentFiles: string[] = [];
  try {
    agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort();
  } catch { /* no agents dir — nothing to import */ }
  for (const file of agentFiles) {
    const name = file.slice(0, -3);
    let raw: string;
    try {
      raw = readFileSync(join(agentsDir, file), "utf8");
    } catch (error) {
      report.agents.push(fail(name, `unreadable: ${error instanceof Error ? error.message : error}`));
      continue;
    }
    report.agents.push(await saveAgentRegisterVersionFromContent(name, raw, createdBy));
  }

  let skillNames: string[] = [];
  try {
    skillNames = readdirSync(skillsDir).filter((d) => {
      try { return statSync(join(skillsDir, d)).isDirectory(); } catch { return false; }
    }).sort();
  } catch { /* no skills dir — nothing to import */ }
  for (const name of skillNames) {
    let raw: string;
    try {
      raw = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
    } catch { continue; } // dir without a SKILL.md — same skip as readCatalog
    report.skills.push(await saveSkillRegisterVersionFromContent(name, raw, createdBy));
  }

  return report;
}

/** Serialize an agent register row back to card-file form. Deterministic
 *  (sorted frontmatter keys) so an export is stable and re-imports as
 *  unchanged — parseCardText(serialize(fm, prompt)) round-trips to the same
 *  canonical hash. */
export function serializeAgentCard(frontmatter: Record<string, string>, prompt: string): string {
  const fm = Object.keys(frontmatter).sort().map((k) => `${k}: ${frontmatter[k] ?? ""}`).join("\n");
  return `---\n${fm}\n---\n\n${prompt.trim()}\n`;
}

export interface RegisterExportReport {
  /** Names whose file was actually (re)written — an already-matching file is
   *  skipped so an export into a clean checkout stays a no-op diff-wise. */
  agents: string[];
  skills: string[];
  /** Rows that could not be exported (bad name from an old row, write error). */
  failed: Array<{ name: string; error: string }>;
}

/** Atomic tmp+rename write, mirroring catalog-manager.ts — a concurrent
 *  reader (the daemon ticks while an export runs) must never see a torn file. */
function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** True when `file` resolves inside `baseDir` — belt-and-braces on top of the
 *  charset lock, same check as catalog-manager's save route. */
function insideDir(file: string, baseDir: string): boolean {
  const resolvedFile = resolve(file);
  const resolvedBase = resolve(baseDir);
  return resolvedFile === resolvedBase || resolvedFile.startsWith(resolvedBase + sep);
}

/** Write every ACTIVE register version back to its file (agents/<name>.md,
 *  skills/<name>/SKILL.md) — disaster recovery and the reviewable git trail.
 *  Touches ONLY files whose content differs; commits are a human's job. */
export async function exportRegistersToFiles(opts: RegisterIoOptions = {}): Promise<RegisterExportReport> {
  const agentsDir = opts.agentsDir ?? DEFAULT_AGENTS_DIR;
  const skillsDir = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
  const report: RegisterExportReport = { agents: [], skills: [], failed: [] };

  for (const row of await listActiveAgentRegisterRows()) {
    const file = join(agentsDir, `${row.name}.md`);
    if (!NAME_RE.test(row.name) || !insideDir(file, agentsDir)) {
      report.failed.push({ name: row.name, error: "name fails the charset lock — refusing to build a path from it" });
      continue;
    }
    const next = serializeAgentCard(row.frontmatter, row.prompt);
    let current: string | null = null;
    try { current = readFileSync(file, "utf8"); } catch { /* new file */ }
    if (current === next) continue;
    try {
      writeFileAtomic(file, next);
      report.agents.push(row.name);
    } catch (error) {
      report.failed.push({ name: row.name, error: `write failed: ${error instanceof Error ? error.message : error}` });
    }
  }

  for (const row of await listActiveSkillRegisterRows()) {
    const file = join(skillsDir, row.name, "SKILL.md");
    if (!NAME_RE.test(row.name) || !insideDir(file, skillsDir)) {
      report.failed.push({ name: row.name, error: "name fails the charset lock — refusing to build a path from it" });
      continue;
    }
    let current: string | null = null;
    try { current = readFileSync(file, "utf8"); } catch { /* new file */ }
    if (current === row.content) continue;
    try {
      writeFileAtomic(file, row.content);
      report.skills.push(row.name);
    } catch (error) {
      report.failed.push({ name: row.name, error: `write failed: ${error instanceof Error ? error.message : error}` });
    }
  }

  return report;
}
