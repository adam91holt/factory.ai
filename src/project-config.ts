import { config } from "./config.ts";
import { loadProjects, applyPolicyOverlay, type ProjectCard } from "./registry.ts";
import { effectiveMergeTier } from "./merge-ladder.ts";
import { drainInfo } from "./control.ts";
import {
  ensureProjectRow, getProjectRowByName, listProjectRows, updateProjectDescriptive,
  isProjectDescriptiveField, replaceProjectRepos, listProjectRepos,
  upsertProjectModel, deleteProjectModel, listProjectModels,
  upsertProjectGroundskeeper, listProjectGroundskeepers,
  insertPendingPolicy, getProjectPolicy, listProjectPolicies,
  approveProjectPolicy, rejectProjectPolicy, listProjectAudit, getLadderState,
  type ProjectModelRow, type ProjectRow,
} from "./db.ts";

// Project-config brain (issue #7): the DECISION layer between the dashboard's
// loopback routes (server.ts, all behind guardedJsonBody — no new gate) and the
// row helpers in db.ts. Everything authority-shaped here follows the two-tier
// model:
//
//   DESCRIPTIVE (goal, description, status, team, per-role models, per-project
//   groundskeeper rows) — applied immediately; db.ts writes the audit row in
//   the same statement as the change.
//
//   AUTHORITY (repos, deploy, smoke, deployEnabled, merge — the in-code
//   AUTHORITY_KEYS set, never a knob) — lands as a PENDING project_policy
//   revision. The config in force is unchanged until a human approves it via
//   the atomic claim in db.ts (claimApproval's pattern). Note deploy/smoke
//   policy rows are stored but INERT: registry.ts's overlay deliberately never
//   feeds them to `sh -c` — commands come from the human-reviewed card only,
//   until typed deploy actions land (owner-deferred).
//
// Input provenance: these functions are reachable ONLY from the guarded
// loopback POST routes — a human in the dashboard. Ticket text has no path
// here (pinned by the static lint in tests/project-config.test.ts: none of the
// ticket-consuming modules import these writers), so untrusted input still
// cannot reach any config field.

/** Who a guarded loopback write is attributed to in project_config_audit. The
 *  dashboard is single-owner and loopback-bound; there is no user model to
 *  name, so the actor records the CHANNEL, not an identity claim. */
const DASHBOARD_ACTOR = "dashboard";
/** Actor for the daemon's own card→PG reconcile writes. */
const SYNC_ACTOR = "card-sync";

/** The authority keys — IN-CODE constant (CLAUDE.md: caps and authority
 *  boundaries are never env knobs). Everything else is descriptive. */
export const AUTHORITY_KEYS = ["repos", "deploy", "smoke", "deployEnabled", "merge"] as const;
export type AuthorityKey = (typeof AUTHORITY_KEYS)[number];

const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);
const PROJECT_STATUSES = new Set(["active", "paused", "archived"]);
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// Same charset-lock registry.ts/groundskeepers.ts apply to card names.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface HandlerResult { status: number; json: unknown }
const bad = (status: number, error: string): HandlerResult => ({ status, json: { error } });

// ---------------------------------------------------------------------------
// Pure validation — exported for tests.
// ---------------------------------------------------------------------------

/** Validate one authority key's proposed value. Returns the NORMALIZED value
 *  (the exact shape that will be JSON-stored and later overlaid) or an error.
 *  Deliberately strict: an unknown key or a malformed value is refused at the
 *  door, never stored for a later reader to trip on. */
export function validatePolicyValue(key: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (key) {
    case "repos": {
      if (!Array.isArray(value) || value.length > 50) return { ok: false, error: "repos must be an array of at most 50 org/name strings" };
      const repos: string[] = [];
      for (const r of value) {
        // Charset lock + explicit dot-segment refusal: "." is legal inside a
        // GitHub name (".github") but a segment of ONLY dots is a path
        // traversal, never a repo. (The overlay intersects with the card's
        // repos anyway, so a smuggled string would be inert — this refusal is
        // belt & braces at the door.)
        const segments = typeof r === "string" ? r.split("/") : [];
        const traversal = segments.some((s) => /^\.+$/.test(s));
        if (typeof r !== "string" || !REPO_RE.test(r) || traversal) return { ok: false, error: `repos entries must match org/name (got ${JSON.stringify(r).slice(0, 80)})` };
        repos.push(r);
      }
      return { ok: true, value: [...new Set(repos)].sort() };
    }
    case "deploy":
    case "smoke": {
      if (typeof value !== "string" || value.trim() === "" || value.length > 500) return { ok: false, error: `${key} must be a non-empty string of at most 500 chars` };
      return { ok: true, value: value.trim() };
    }
    case "deployEnabled":
      // Fail closed: ONLY a bare boolean. "true"/1/"yes" are refused, not coerced.
      if (value !== true && value !== false) return { ok: false, error: "deployEnabled must be a bare boolean" };
      return { ok: true, value };
    case "merge":
      if (value !== "review" && value !== "shadow" && value !== "auto") return { ok: false, error: "merge must be one of review | shadow | auto" };
      return { ok: true, value };
    default:
      return { ok: false, error: `unknown authority key ${JSON.stringify(String(key).slice(0, 40))} (allowed: ${AUTHORITY_KEYS.join(", ")})` };
  }
}

/** Drop model rows that no longer resolve against config.models — the meta.ts
 *  isKnownModel discipline applied on READ, so a stale row can never hand an
 *  unvetted model id to the SDK. Unknown efforts degrade to null (the SDK
 *  default), not a rejection of the whole row. Pure; exported for tests. */
export function validateProjectModels(rows: ProjectModelRow[], roster: Record<string, string> = config.models): ProjectModelRow[] {
  const knownModels = new Set(Object.values(roster));
  const knownRoles = new Set(Object.keys(roster));
  const out: ProjectModelRow[] = [];
  for (const r of rows) {
    if (!knownRoles.has(r.role)) {
      console.warn(`[projects] dropping model config for unknown role "${r.role}"`);
      continue;
    }
    if (!knownModels.has(r.model)) {
      console.warn(`[projects] dropping model config for role "${r.role}": unknown model "${r.model}" (not in config.models)`);
      continue;
    }
    out.push(r.effort !== null && !EFFORT_VALUES.has(r.effort) ? { ...r, effort: null } : r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Card → PG sync (bootstrap/import path). Cards seed rows; the repos table is
// a one-way projection the cards always win.
// ---------------------------------------------------------------------------

export async function syncProjectsFromCards(): Promise<void> {
  for (const card of loadProjects()) {
    const id = await ensureProjectRow(card.name, card.team, SYNC_ACTOR);
    if (id === null) return; // store closed — cards alone govern, nothing to sync
    await replaceProjectRepos(id, card.repos, SYNC_ACTOR);
  }
}

// ---------------------------------------------------------------------------
// GET /projects payload.
// ---------------------------------------------------------------------------

export interface ProjectView {
  name: string; goal: string; description: string; team: string; status: string;
  createdAt: number; updatedAt: number;
  /** One-way projection reconciled from the card. */
  repos: string[];
  /** Per-repo merge-ladder tier ACTUALLY IN FORCE (merge-ladder.ts
   *  effectiveMergeTier over the evidence-earned DB state) — display-only.
   *  Nothing in this payload can move a tier; the ladder climbs on
   *  verification evidence alone (ADR-0001 / CLAUDE.md). */
  ladder: Array<{ repo: string; tier: string; cleanStreak: number }>;
  /** Card-declared values, for the UI's pending-diff display. */
  card: ProjectCard | null;
  /** The config actually in force (card + approved overlays). */
  effective: ProjectCard | null;
  models: ProjectModelRow[];
  groundskeepers: Array<{ card: string; enabled: boolean; cadence: string | null }>;
  policies: Array<{ id: number; key: string; value: unknown; state: string; approvedBy: string | null; approvedAt: number | null; createdAt: number }>;
  audit: Array<{ id: number; field: string; oldValue: string | null; newValue: string | null; actor: string; at: number }>;
}

/** GET /projects wire shape. Everything beyond `projects` is additive context
 *  the dashboard cannot derive on its own, all READ-ONLY:
 *    roster            — config.models, so the model dropdown is constrained to
 *                        the operator's allowlist (never free text; the write
 *                        route re-validates anyway — belt and braces);
 *    groundskeepersEnabled — the GLOBAL env gate; false means every per-project
 *                        toggle is INERT and the UI must say so;
 *    drain             — control.ts drainInfo(), so the DAG view can explain
 *                        "ready but nothing is being claimed". */
export interface ProjectsPayload {
  projects: ProjectView[];
  roster: { roles: string[]; models: string[] };
  groundskeepersEnabled: boolean;
  drain: { draining: boolean; reason: string | null };
}

/** Display-only ladder read per repo: evidence-earned DB state folded through
 *  the SAME pure effectiveMergeTier the loop uses — never a second policy. */
async function repoLadder(repos: string[]): Promise<ProjectView["ladder"]> {
  return Promise.all(repos.map(async (repo) => {
    const earned = await getLadderState(repo);
    return {
      repo,
      tier: effectiveMergeTier(repo, earned, { autoDefault: config.autoMergeDefault }),
      cleanStreak: earned?.cleanStreak ?? 0,
    };
  }));
}

function rosterView(): ProjectsPayload["roster"] {
  return {
    roles: Object.keys(config.models),
    models: [...new Set(Object.values(config.models))].sort(),
  };
}

export async function projectsView(): Promise<ProjectsPayload> {
  await syncProjectsFromCards();
  const cards = new Map(loadProjects().map((c) => [c.name, c]));
  const rows = await listProjectRows();
  const shared = {
    roster: rosterView(),
    groundskeepersEnabled: config.groundskeepersEnabled,
    drain: drainInfo(),
  };
  // Store closed / never synced: show the cards alone so the page still works
  // on a fresh checkout (additive-only fallback, same rule as effectiveProjects).
  if (rows.length === 0) {
    return {
      projects: await Promise.all([...cards.values()].map(async (card) => ({
        name: card.name, goal: "", description: "", team: card.team, status: "active",
        createdAt: 0, updatedAt: 0, repos: [...card.repos],
        ladder: await repoLadder(card.repos), card, effective: card,
        models: [], groundskeepers: [], policies: [], audit: [],
      }))),
      ...shared,
    };
  }
  const projects: ProjectView[] = [];
  for (const row of rows) {
    const card = cards.get(row.name) ?? null;
    const [repos, models, groundskeepers, policies, audit] = await Promise.all([
      listProjectRepos(row.id), listProjectModels(row.id), listProjectGroundskeepers(row.id),
      listProjectPolicies(row.id), listProjectAudit(row.id, 50),
    ]);
    const activeOverlay: Record<string, unknown> = {};
    for (const p of policies) {
      if (p.state === "active") activeOverlay[p.key] = p.value;
    }
    projects.push({
      name: row.name, goal: row.goal, description: row.description, team: row.team, status: row.status,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      repos, ladder: await repoLadder(repos), card,
      effective: card ? applyPolicyOverlay(card, activeOverlay) : null,
      models: validateProjectModels(models),
      groundskeepers,
      policies: policies.map((p) => ({ id: p.id, key: p.key, value: p.value, state: p.state, approvedBy: p.approvedBy, approvedAt: p.approvedAt, createdAt: p.createdAt })),
      audit: audit.map((a) => ({ id: a.id, field: a.field, oldValue: a.oldValue, newValue: a.newValue, actor: a.actor, at: a.at })),
    });
  }
  return { projects, ...shared };
}

// ---------------------------------------------------------------------------
// Write handlers — each returns { status, json } for server.ts to emit.
// All of them sit BEHIND guardedJsonBody (POST-only, same-origin JSON,
// loopback host) — the same single gate as every other mutation route.
// ---------------------------------------------------------------------------

/** Resolve a project name to its row, auto-seeding from the card when the row
 *  does not exist yet (fresh setup). Card-anchored on purpose: a project no
 *  card declares owns no repos (the projection is card-sourced), so inventing
 *  PG-only projects would only create dead rows. */
async function resolveProject(nameRaw: unknown): Promise<{ row: ProjectRow } | { error: HandlerResult }> {
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!NAME_RE.test(name)) return { error: bad(400, "body must carry a valid project name") };
  let row = await getProjectRowByName(name);
  if (!row) {
    const card = loadProjects().find((c) => c.name === name);
    if (!card) return { error: bad(404, `no project named ${JSON.stringify(name)} (no PG row and no projects/${name}.md card)`) };
    const id = await ensureProjectRow(card.name, card.team, SYNC_ACTOR);
    if (id === null) return { error: bad(503, "project store unavailable") };
    await replaceProjectRepos(id, card.repos, SYNC_ACTOR);
    row = await getProjectRowByName(name);
  }
  return row ? { row } : { error: bad(503, "project store unavailable") };
}

/** POST /projects/save — DESCRIPTIVE fields only, effective immediately.
 *  Authority-shaped fields in the body are refused loudly, never silently
 *  applied (the pending-policy lane exists for them). */
export async function saveProjectDescriptive(body: unknown): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const resolved = await resolveProject(b.name);
  if ("error" in resolved) return resolved.error;
  const updates: Array<[field: "goal" | "description" | "status" | "team", value: string]> = [];
  for (const field of ["goal", "description", "status", "team"] as const) {
    if (!Object.hasOwn(b, field)) continue;
    const v = b[field];
    if (typeof v !== "string" || v.length > (field === "goal" || field === "description" ? 4000 : 200)) {
      return bad(400, `${field} must be a string (goal/description ≤ 4000 chars, status/team ≤ 200)`);
    }
    if (field === "status" && !PROJECT_STATUSES.has(v)) return bad(400, "status must be one of active | paused | archived");
    updates.push([field, v]);
  }
  const rejected = AUTHORITY_KEYS.filter((k) => Object.hasOwn(b, k));
  if (rejected.length > 0) return bad(400, `authority fields (${rejected.join(", ")}) cannot be saved directly — propose them via /projects/policy/propose`);
  if (updates.length === 0) return bad(400, "no descriptive fields in body (goal, description, status, team)");
  let changed = 0;
  for (const [field, value] of updates) {
    if (!isProjectDescriptiveField(field)) continue; // unreachable; typed above
    if (await updateProjectDescriptive(resolved.row.id, field, value, DASHBOARD_ACTOR)) changed += 1;
  }
  return { status: 200, json: { ok: true, name: resolved.row.name, changed } };
}

/** POST /projects/model — set or clear one role's model. Validated against
 *  config.models at WRITE time (and again on read). Never free text into the
 *  SDK: role must be a known roster role, model a known roster model. */
export async function setProjectModel(body: unknown): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const resolved = await resolveProject(b.name);
  if ("error" in resolved) return resolved.error;
  const role = typeof b.role === "string" ? b.role : "";
  if (!Object.hasOwn(config.models, role)) return bad(400, `role must be one of: ${Object.keys(config.models).join(", ")}`);
  if (b.model === null) {
    const deleted = await deleteProjectModel(resolved.row.id, role, DASHBOARD_ACTOR);
    return { status: 200, json: { ok: true, name: resolved.row.name, role, cleared: deleted } };
  }
  const model = typeof b.model === "string" ? b.model : "";
  if (!new Set(Object.values(config.models)).has(model)) return bad(400, "model is not in config.models — the dropdown roster is the allowlist, never free text");
  let effort: string | null = null;
  if (b.effort !== undefined && b.effort !== null) {
    if (typeof b.effort !== "string" || !EFFORT_VALUES.has(b.effort)) return bad(400, "effort must be one of low | medium | high | xhigh | max");
    effort = b.effort;
  }
  const ok = await upsertProjectModel(resolved.row.id, role, model, effort, DASHBOARD_ACTOR);
  return ok ? { status: 200, json: { ok: true, name: resolved.row.name, role, model, effort } } : bad(503, "project store unavailable");
}

/** POST /projects/groundskeeper — per-project third-gate row. Restrictive or
 *  neutral only: enabled=true here arms nothing by itself (both existing gates
 *  must still hold — pinned by projectGroundskeeperGate's tests). */
export async function setProjectGroundskeeper(body: unknown): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const resolved = await resolveProject(b.name);
  if ("error" in resolved) return resolved.error;
  const card = typeof b.card === "string" ? b.card.trim() : "";
  if (!NAME_RE.test(card)) return bad(400, "card must be a valid groundskeeper card name");
  if (b.enabled !== true && b.enabled !== false) return bad(400, "enabled must be a bare boolean (fail-closed — nothing is coerced)");
  let cadence: string | null = null;
  if (b.cadence !== undefined && b.cadence !== null) {
    if (typeof b.cadence !== "string" || b.cadence.length > 100) return bad(400, "cadence must be a string of at most 100 chars");
    cadence = b.cadence.trim() || null;
  }
  const ok = await upsertProjectGroundskeeper(resolved.row.id, card, b.enabled, cadence, DASHBOARD_ACTOR);
  return ok ? { status: 200, json: { ok: true, name: resolved.row.name, card, enabled: b.enabled } } : bad(503, "project store unavailable");
}

/** POST /projects/policy/propose — AUTHORITY tier. Lands a PENDING revision;
 *  the config in force is unchanged until approval. */
export async function proposeProjectPolicy(body: unknown): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const resolved = await resolveProject(b.name);
  if ("error" in resolved) return resolved.error;
  const key = typeof b.key === "string" ? b.key : "";
  const validated = validatePolicyValue(key, b.value);
  if (!validated.ok) return bad(400, validated.error);
  const id = await insertPendingPolicy(resolved.row.id, key, JSON.stringify(validated.value), DASHBOARD_ACTOR);
  if (id === null) return bad(503, "project store unavailable");
  return { status: 200, json: { ok: true, name: resolved.row.name, policyId: id, key, state: "pending" } };
}

/** POST /projects/policy/:id/approve — the atomic claim (db.ts). 409 when the
 *  row was already decided (double-click, superseded, rejected). */
export async function approvePolicyItem(id: number): Promise<HandlerResult> {
  const existing = await getProjectPolicy(id);
  if (!existing) return bad(404, "no such policy revision");
  const activated = await approveProjectPolicy(id, DASHBOARD_ACTOR);
  if (!activated) return bad(409, "policy revision is not pending (already decided, superseded, or claimed)");
  return { status: 200, json: { ok: true, policyId: activated.id, key: activated.key, state: activated.state } };
}

/** POST /projects/policy/:id/reject — atomic, audited. */
export async function rejectPolicyItem(id: number): Promise<HandlerResult> {
  const existing = await getProjectPolicy(id);
  if (!existing) return bad(404, "no such policy revision");
  const rejected = await rejectProjectPolicy(id, DASHBOARD_ACTOR);
  if (!rejected) return bad(409, "policy revision is not pending (already decided or claimed)");
  return { status: 200, json: { ok: true, policyId: id, state: "rejected" } };
}
