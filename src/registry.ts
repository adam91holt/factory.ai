import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { activePoliciesByProjectName } from "./db.ts";

// Project registry (Gap 5). A projects/<name>.md card makes "project" literal:
// it names the team a project files into, the repos it owns, the merge policy a
// bootstrapped repo starts at, and — OPTIONALLY — the deploy + smoke commands
// the post-merge watch runs. It is modeled on the groundskeepers/*.md loader
// (tolerant YAML frontmatter, never throws, malformed cards skipped) because it
// is the same KIND of object: human-authored, factory-controlled routing config.
//
// SAFETY (non-negotiable):
//   - projects/ is a GUARDED PATH (repos.ts): a card is a human-gated self-mod,
//     so bootstrap registers a NEW card via a review PR, never a direct commit.
//   - `deploy` and `smoke` are TRUSTED shell commands sourced ONLY from the card
//     (the human-reviewed file), NEVER from ticket text — the meta.ts start-
//     anchor confused-deputy defense applied to shell (safety envelope d).
//   - `deployEnabled` fails CLOSED (only a bare `true` arms it) AND the global
//     DEPLOY_ENABLED kill-switch must also hold — the groundskeeper double-gate.

export interface ProjectCard {
  name: string;
  team: string;                       // Linear team KEY the project files into
  repos: string[];                    // org/name repos this project owns
  merge: "review" | "shadow" | "auto"; // merge policy a bootstrapped repo STARTS at
  deploy?: string;                    // TRUSTED deploy command (from the card only)
  smoke?: string;                     // TRUSTED smoke/verify command (from the card only)
  deployEnabled: boolean;             // per-card deploy arm (fail-closed; bare `true`)
}

// name flows into file paths and logs; charset-lock it like the groundskeeper
// NAME_RE so a traversal (`../..`) can never aim reads/writes outside projects/.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The projects/ directory: config override (FACTORY_PROJECTS_DIR) else the
 *  module-relative projects/ dir, exactly like groundskeepers/. */
function projectsDir(): string {
  return config.projectsDir || join(dirname(fileURLToPath(import.meta.url)), "..", "projects");
}

function stripQuotes(s: string): string {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

function parseList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner.split(",").map((x) => stripQuotes(x)).filter((x) => x !== "");
}

/** Parse a single card's raw markdown. Tolerant: returns null only when there is
 * no frontmatter at all; individual malformed fields fall back to safe defaults.
 * Exported so the (future) catalog manager can validate a card before writing
 * it — same shape as validateGroundskeeperContent. */
export function parseProjectCard(raw: string, fallbackName: string): ProjectCard | null {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) return null;
  const fields: Record<string, string> = {};
  for (const line of (fm[1] ?? "").split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && m[1]) fields[m[1]] = (m[2] ?? "").trim();
  }
  // merge policy: only the three known values; anything else defaults to the
  // SAFEST ("review") — a typo must never silently widen merge authority. A
  // bootstrapped repo must START at review (Gap-2 ladder earns auto over time).
  const mergeRaw = stripQuotes(fields.merge ?? "").toLowerCase();
  const merge: ProjectCard["merge"] = mergeRaw === "auto" ? "auto" : mergeRaw === "shadow" ? "shadow" : "review";
  // deployEnabled: fail closed — ONLY a bare, unquoted `true` arms it (identical
  // discipline to the groundskeeper `enabled` field); anything else is FALSE.
  const deployEnabledRaw = (fields.deployEnabled ?? "").trim();
  if (deployEnabledRaw !== "" && !["true", "false"].includes(deployEnabledRaw.toLowerCase())) {
    console.error(`[registry] ${fallbackName}: unrecognized deployEnabled value ${JSON.stringify(deployEnabledRaw)} — treating as FALSE (only a bare \`true\` enables)`);
  }
  const deploy = stripQuotes(fields.deploy ?? "");
  const smoke = stripQuotes(fields.smoke ?? "");
  return {
    name: stripQuotes(fields.name ?? fallbackName) || fallbackName,
    team: stripQuotes(fields.team ?? ""),
    repos: parseList(fields.repos ?? "[]"),
    merge,
    ...(deploy ? { deploy } : {}),
    ...(smoke ? { smoke } : {}),
    deployEnabled: deployEnabledRaw.toLowerCase() === "true",
  };
}

/** Load every projects/<name>.md. Malformed/missing → skipped (logged), never
 *  fatal: a broken card must not take the daemon down. Returns [] when there is
 *  no projects/ dir at all. */
export function loadProjects(): ProjectCard[] {
  let files: string[];
  try {
    files = readdirSync(projectsDir()).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const cards: ProjectCard[] = [];
  const seen = new Set<string>();
  for (const f of files.sort()) {
    try {
      const card = parseProjectCard(readFileSync(join(projectsDir(), f), "utf8"), f.slice(0, -3));
      if (!card || !card.name || !card.team || card.repos.length === 0) {
        console.error(`[registry] ${f}: missing name/team/repos — skipped`);
        continue;
      }
      if (!NAME_RE.test(card.name)) {
        console.error(`[registry] ${f}: invalid name ${JSON.stringify(card.name)} — skipped`);
        continue;
      }
      if (seen.has(card.name)) {
        console.error(`[registry] ${f}: duplicate name "${card.name}" — skipped`);
        continue;
      }
      seen.add(card.name);
      cards.push(card);
    } catch (error) {
      console.error(`[registry] failed to read ${f}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return cards;
}

/** The card that owns `repo`, or null. First match wins (loadProjects is name-
 *  sorted, so it is deterministic). Never throws. */
export function projectForRepo(repo: string): ProjectCard | null {
  if (!repo) return null;
  for (const card of loadProjects()) {
    if (card.repos.includes(repo)) return card;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Issue #7: PG-first effective config. The daemon reads Postgres-approved
// AUTHORITY overrides (project_policy rows a human approved through the
// approvals-inbox pattern) layered over the card, and falls back to the card
// alone when a project has no rows / the store is closed — a fresh checkout
// with no DB behaves EXACTLY as today (additive-only).
//
// applyPolicyOverlay is PURE and I/O-free (CLAUDE.md: decision logic stays
// pure) and deliberately conservative:
//   - merge: only the three known values are accepted; anything else keeps the
//     card's value — a corrupt row can never widen merge authority.
//   - repos: INTERSECTION with the card's repos — a DB row can only NARROW the
//     repo set, never widen it (the projection in project_repos is likewise
//     reconciled one-way FROM cards by project-config.ts).
//   - deployEnabled: NARROW-ONLY, like repos. A policy row may DISARM a card
//     (false wins over a card's true) but can never ARM one: a true value is
//     honoured only when the CARD already declares deployEnabled: true. The
//     card file lives on a guarded path, so arming deploy keeps requiring a
//     human-reviewed PR — two loopback POSTs from the single 'dashboard'
//     actor (propose + approve, no proposer/approver separation) must never
//     substitute for that second gate. The global DEPLOY_ENABLED kill-switch
//     in postmerge.ts still sits above all of it.
//   - deploy/smoke are DELIBERATELY NOT overlaid: those strings reach `sh -c`
//     (postmerge.ts runShellGate), so until typed deploy actions land
//     (deferred by the owner), the shell command comes ONLY from the
//     human-reviewed card file — a DB row must never become a code-execution
//     surface. An approved deploy/smoke policy row is stored but inert.
// ---------------------------------------------------------------------------

export function applyPolicyOverlay(card: ProjectCard, policies: Record<string, unknown>): ProjectCard {
  const out: ProjectCard = { ...card, repos: [...card.repos] };
  const merge = policies.merge;
  if (merge === "review" || merge === "shadow" || merge === "auto") out.merge = merge;
  const repos = policies.repos;
  if (Array.isArray(repos)) {
    const allowed = new Set(repos.filter((r): r is string => typeof r === "string"));
    out.repos = card.repos.filter((r) => allowed.has(r)); // narrow-only: ∩ card repos
  }
  // Narrow-only (see header): a row can disarm, never arm. The card's own
  // deployEnabled — from the guarded-path, human-reviewed file — is the AND
  // gate a policy true cannot bypass.
  if (Object.hasOwn(policies, "deployEnabled")) out.deployEnabled = card.deployEnabled && policies.deployEnabled === true;
  // deploy / smoke intentionally untouched — see header note.
  return out;
}

/** Cards with any APPROVED authority overrides applied. Store closed / no rows
 *  → byte-equivalent to loadProjects(). Never throws (a failed read falls back
 *  to cards — the safe baseline). */
export async function effectiveProjects(): Promise<ProjectCard[]> {
  const cards = loadProjects();
  let active: Array<{ name: string; key: string; value: unknown }>;
  try {
    active = await activePoliciesByProjectName();
  } catch (error) {
    console.error(`[registry] active-policy read failed — using cards alone: ${error instanceof Error ? error.message : error}`);
    return cards;
  }
  if (active.length === 0) return cards;
  const byName = new Map<string, Record<string, unknown>>();
  for (const p of active) {
    const bucket = byName.get(p.name) ?? {};
    bucket[p.key] = p.value;
    byName.set(p.name, bucket);
  }
  return cards.map((card) => {
    const overlay = byName.get(card.name);
    return overlay ? applyPolicyOverlay(card, overlay) : card;
  });
}

/** effectiveProjects()'s answer to projectForRepo — same first-match-wins
 *  determinism over the overlaid cards. */
export async function effectiveProjectForRepo(repo: string): Promise<ProjectCard | null> {
  if (!repo) return null;
  for (const card of await effectiveProjects()) {
    if (card.repos.includes(repo)) return card;
  }
  return null;
}
