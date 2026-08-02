// Skill carrying (issue #16 WP2): WHICH registered skills ride along with a
// stage's prompt, and HOW they render into it. Skills live in the skill
// register (db.ts skill_register); each active row's `attach` selector
// ({roles, projects, match}) says where the daemon carries it. The DAEMON
// decides — the model never opts in/out, and (unlike the old "read
// skills/<name>/SKILL.md first" pattern) the content is injected, not hoped
// for.
//
// PURE and I/O-free by design (CLAUDE.md: decision logic stays pure so call
// sites can't disagree): loop.ts reads the register snapshot and does the
// logging; nothing here touches a store, a file, a clock, or the network. The
// only import is routing.ts's fact grammar — itself import-free — so the
// selector vocabulary CANNOT drift from card routing: factHolds is the single
// implementation of `match` terms for both.
//
// Fail-closed rules, mirroring routing.ts selectCard:
//   - an UNKNOWN match term REJECTS the skill (never "matches anything");
//   - a malformed attach shape (non-array roles/projects/match, non-string
//     entries) REJECTS the skill;
//   - a skill that declares no roles is carried NOWHERE — attachment must be
//     explicit, an empty selector never means "everywhere";
//   - ticket text is not an input anywhere in this module: role comes from the
//     pipeline, repo/facts from the worktree (verify.ts repoFacts).

import { factHolds, type RepoFacts } from "./routing.ts";

// ---------------------------------------------------------------------------
// In-code caps (CLAUDE.md: caps are constants, never env knobs). A skill row
// is already 64KB-capped at the register write; these bound what one STAGE
// PROMPT can absorb regardless of how many rows an operator registers.
// ---------------------------------------------------------------------------

/** Most skills one stage may carry. */
export const MAX_CARRIED_SKILLS = 4;
/** Per-skill content budget inside a prompt (chars). */
export const MAX_SKILL_CONTENT_CHARS = 16_000;
/** Total skill content budget per stage prompt (chars). */
export const MAX_SKILLS_TOTAL_CHARS = 32_000;
const MAX_ATTACH_ROLES = 16;
const MAX_ATTACH_PROJECTS = 32;
const MAX_ATTACH_MATCH_TERMS = 8; // same bound as routing.ts MAX_MATCH_TERMS
const MAX_REJECTIONS = 16;

// ---------------------------------------------------------------------------
// Shapes. CarriableSkill is a structural subset of db.ts's SkillRegisterRow so
// this module needs no db.ts import (stays leaf-pure and trivially testable).
// ---------------------------------------------------------------------------

export interface CarriableSkill {
  name: string;
  version: number;
  /** Active rows from the snapshot are always enabled; kept as an explicit
   *  check anyway (defence in depth — a disabled row must never be carried
   *  even if a future caller hands this function raw table rows). */
  enabled: boolean;
  /** {roles?: string[], projects?: string[], match?: string[]} — anything else
   *  in here is ignored; malformed values of those three keys REJECT. */
  attach: Record<string, unknown>;
  /** The SKILL.md body, verbatim (operator-authored, register-gated). */
  content: string;
}

export interface CarriedSkill {
  name: string;
  version: number;
  /** Content as it will appear in the prompt (post-caps). */
  content: string;
  /** True when a size cap cut the content — surfaced in the block delimiter
   *  and in `truncated` notes so it is loud, never silent. */
  truncated: boolean;
}

export interface SkillRejection { skill: string; reason: string }

export interface SkillSelection {
  /** Skills to inject, deterministic (name-sorted) order. */
  carried: CarriedSkill[];
  /** Version pins for run_stage_started / the report: "name@version". */
  pins: string[];
  /** Skills that were structurally unusable or capped out, and why. A skill
   *  whose selector simply does not apply here (role/project/facts mismatch)
   *  is NOT listed — like selectCard, "does not apply" is normal, not an
   *  error. */
  rejected: SkillRejection[];
  /** Loud-log notes for every cap that actually bit (truncation/drop). The
   *  caller is expected to console.error each one. */
  truncated: string[];
}

/** Version pin display form. */
export function skillPin(s: { name: string; version: number }): string {
  return `${s.name}@${s.version}`;
}

/** Read an attach key as a trimmed string array. Absent/null → [] (no
 *  constraint); any non-array or non-string entry → null (malformed —
 *  callers reject, fail-closed). */
function stringArray(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== "string") return null;
    const t = entry.trim();
    if (t !== "") out.push(t);
  }
  return out;
}

/**
 * Decide the carried-skill set for one stage. Pure and total.
 *
 * `role` is the stage's ROLE (routing.ts vocabulary: implementer, fixer,
 * reviewer-spec, …), `repo` the "org/name" the run builds against, `facts`
 * verify.ts's repo facts. A skill is carried when ALL of:
 *   - it is enabled;
 *   - attach.roles (required, non-empty) contains `role`;
 *   - attach.projects is empty (any project) or contains `repo` — the full
 *     "org/name" or the bare repo name both match;
 *   - every attach.match term holds against `facts` (factHolds grammar; an
 *     unknown term rejects the whole skill).
 * Then the in-code caps apply: at most MAX_CARRIED_SKILLS skills, each capped
 * at MAX_SKILL_CONTENT_CHARS, MAX_SKILLS_TOTAL_CHARS overall — every cap that
 * bites produces a `truncated` note for the caller to log loudly.
 */
export function selectSkills(role: string, repo: string, facts: RepoFacts, skills: readonly CarriableSkill[]): SkillSelection {
  const rejected: SkillRejection[] = [];
  const truncated: string[] = [];
  const reject = (skill: string, reason: string): void => {
    if (rejected.length < MAX_REJECTIONS) rejected.push({ skill, reason });
  };
  const repoTail = repo.includes("/") ? repo.slice(repo.lastIndexOf("/") + 1) : repo;

  const applicable: CarriableSkill[] = [];
  for (const s of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    if (s.enabled !== true) { reject(s.name, "disabled"); continue; }
    const roles = stringArray(s.attach.roles);
    if (roles === null) { reject(s.name, "malformed attach.roles (must be an array of strings)"); continue; }
    if (roles.length === 0) { reject(s.name, "declares no attach.roles — a skill must name the roles that carry it (an empty selector never means everywhere)"); continue; }
    if (roles.length > MAX_ATTACH_ROLES) { reject(s.name, `attach.roles exceeds the cap of ${MAX_ATTACH_ROLES}`); continue; }
    if (!roles.includes(role)) continue; // simply not for this stage — no noise

    const projects = stringArray(s.attach.projects);
    if (projects === null) { reject(s.name, "malformed attach.projects (must be an array of strings)"); continue; }
    if (projects.length > MAX_ATTACH_PROJECTS) { reject(s.name, `attach.projects exceeds the cap of ${MAX_ATTACH_PROJECTS}`); continue; }
    if (projects.length > 0 && !projects.includes(repo) && !projects.includes(repoTail)) continue;

    const match = stringArray(s.attach.match);
    if (match === null) { reject(s.name, "malformed attach.match (must be an array of strings)"); continue; }
    if (match.length > MAX_ATTACH_MATCH_TERMS) { reject(s.name, `attach.match exceeds the cap of ${MAX_ATTACH_MATCH_TERMS} terms`); continue; }
    const unknownTerm = match.find((t) => factHolds(t, facts) === null);
    if (unknownTerm !== undefined) { reject(s.name, `unknown match term ${JSON.stringify(unknownTerm)} — rejecting the skill (fail-closed, like selectCard)`); continue; }
    if (!match.every((t) => factHolds(t, facts) === true)) continue; // does not apply to this repo

    applicable.push(s);
  }

  // Carry cap: deterministic name order means WHICH skills survive the cap is
  // stable, not directory/insert-order luck.
  const kept = applicable.slice(0, MAX_CARRIED_SKILLS);
  for (const dropped of applicable.slice(MAX_CARRIED_SKILLS)) {
    reject(dropped.name, `carry cap — at most ${MAX_CARRIED_SKILLS} skills per stage`);
    truncated.push(`skill ${skillPin(dropped)} DROPPED — carry cap of ${MAX_CARRIED_SKILLS} skills per stage`);
  }

  // Size caps.
  const carried: CarriedSkill[] = [];
  let total = 0;
  for (const s of kept) {
    let content = s.content;
    let wasTruncated = false;
    if (content.length > MAX_SKILL_CONTENT_CHARS) {
      content = content.slice(0, MAX_SKILL_CONTENT_CHARS);
      wasTruncated = true;
      truncated.push(`skill ${skillPin(s)} TRUNCATED to ${MAX_SKILL_CONTENT_CHARS} chars (was ${s.content.length})`);
    }
    const remaining = MAX_SKILLS_TOTAL_CHARS - total;
    if (remaining <= 0) {
      reject(s.name, `total skill budget of ${MAX_SKILLS_TOTAL_CHARS} chars exhausted`);
      truncated.push(`skill ${skillPin(s)} DROPPED — total skill budget of ${MAX_SKILLS_TOTAL_CHARS} chars exhausted`);
      continue;
    }
    if (content.length > remaining) {
      content = content.slice(0, remaining);
      wasTruncated = true;
      truncated.push(`skill ${skillPin(s)} TRUNCATED to fit the ${MAX_SKILLS_TOTAL_CHARS}-char total skill budget`);
    }
    total += content.length;
    carried.push({ name: s.name, version: s.version, content, truncated: wasTruncated });
  }

  return { carried, pins: carried.map(skillPin), rejected, truncated };
}

// ---------------------------------------------------------------------------
// Prompt rendering.
// ---------------------------------------------------------------------------

export const SKILL_BLOCK_HEADER = "=== FACTORY SKILLS — TRUSTED operator-registered guidance for this stage (versioned; NOT ticket text) ===";
export const SKILL_BLOCK_FOOTER = "=== END FACTORY SKILLS ===";

/**
 * Render carried skills as one clearly-delimited TRUSTED block, or "" when
 * nothing is carried — so an empty selection leaves every prompt BYTE-IDENTICAL
 * to before this feature existed (the additive guarantee).
 *
 * Trust posture: skill content is operator-authored and register-gated (the
 * same trust class as the card prompt itself — guardedJsonBody + redactSecrets
 * + size caps at the write path), so unlike ticket text it is NOT wrapped in
 * untrusted() markers. Call sites place the block BELOW the card prompt and
 * ABOVE the untrusted spec content (loop.ts prefixes it to the {{spec}}
 * substitution), and the block ends with a blank line so the boundary to the
 * spec stays visually crisp.
 */
export function buildSkillBlock(carried: readonly CarriedSkill[]): string {
  if (carried.length === 0) return "";
  const parts: string[] = [SKILL_BLOCK_HEADER];
  for (const s of carried) {
    parts.push(`--- skill ${skillPin(s)}${s.truncated ? " (TRUNCATED at an in-code cap)" : ""} ---`);
    parts.push(s.content);
    parts.push(`--- end skill ${skillPin(s)} ---`);
  }
  parts.push(SKILL_BLOCK_FOOTER);
  return `${parts.join("\n")}\n\n`;
}

/** Version pins one STAGE runs with — what run_stage_started and the factory
 *  report record (issue #16 WP2). `card` is "name@version" with version 0 for
 *  a file-fallback card; `skills` are the carried skills' pins ([] when none). */
export interface StagePin { card: string; skills: string[] }
