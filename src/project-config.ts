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
  approveProjectPolicy, rejectProjectPolicy, listProjectAudit, getLadderState, activeMergePolicyForRepo, listCatalogModels,
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

/** Drop model rows that no longer resolve against the vetted set — the meta.ts
 *  isKnownModel discipline applied on READ, so a stale row can never hand an
 *  unvetted model id to the SDK. The vetted set is the env roster's values
 *  PLUS the PG model catalog (ids the proxy itself serves — factory-controlled
 *  via docker/cliproxy config, never ticket-reachable). Unknown efforts degrade
 *  to null (the SDK default), not a rejection of the whole row. Pure; exported
 *  for tests. */
export function validateProjectModels(rows: ProjectModelRow[], roster: Record<string, string> = config.models, catalog: readonly string[] = []): ProjectModelRow[] {
  const knownModels = new Set([...Object.values(roster), ...catalog]);
  const knownRoles = new Set(Object.keys(roster));
  const out: ProjectModelRow[] = [];
  for (const r of rows) {
    if (!knownRoles.has(r.role)) {
      console.warn(`[projects] dropping model config for unknown role "${r.role}"`);
      continue;
    }
    if (!knownModels.has(r.model)) {
      console.warn(`[projects] dropping model config for role "${r.role}": unknown model "${r.model}" (not in the env roster or the model catalog)`);
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
      tier: effectiveMergeTier(repo, earned, { autoDefault: config.autoMergeDefault, overrideAll: config.autoMergeAll, policyMerge: await activeMergePolicyForRepo(repo) }),
      cleanStreak: earned?.cleanStreak ?? 0,
    };
  }));
}

/** Dropdown allowlist: env roster ∪ PG model catalog. `catalog` is passed in
 *  by projectsView (one read per payload, not per row). */
function rosterView(catalog: readonly string[] = []): ProjectsPayload["roster"] {
  return {
    roles: Object.keys(config.models),
    models: [...new Set([...Object.values(config.models), ...catalog])].sort(),
  };
}

export async function projectsView(): Promise<ProjectsPayload> {
  await syncProjectsFromCards();
  const cards = new Map(loadProjects().map((c) => [c.name, c]));
  const rows = await listProjectRows();
  const catalog = await listCatalogModels();
  const shared = {
    roster: rosterView(catalog),
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
      models: validateProjectModels(models, config.models, catalog),
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

/** POST /projects/create — register a NEW project (name, team, repos) in
 *  Postgres, the authoritative registry the loop.ts/plan.ts work gate reads
 *  (projectOwningRepo): a repo not registered here is never worked. Duplicate
 *  names 409 (edits go through /projects/save and the policy lane), repo slugs
 *  are charset-locked to org/name, and every write lands with an audit row.
 *  deploy/smoke deliberately have NO place in this body — shell-reaching
 *  strings must never enter through a dashboard POST (registry.ts safety
 *  envelope d). */
export async function createProject(body: unknown): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!NAME_RE.test(name)) return bad(400, "name must be 1-64 chars of [A-Za-z0-9_-], starting alphanumeric");
  const team = typeof b.team === "string" ? b.team.trim() : "";
  if (team === "" || team.length > 200) return bad(400, "team must be a non-empty string ≤ 200 chars");
  if (!Array.isArray(b.repos) || b.repos.length === 0) return bad(400, "repos must be a non-empty array of org/name slugs");
  const repos = [...new Set(b.repos.map((r) => (typeof r === "string" ? r.trim() : "")))];
  const invalid = repos.filter((r) => !REPO_RE.test(r));
  if (invalid.length > 0) return bad(400, `invalid repo slug(s): ${invalid.map((r) => JSON.stringify(r)).join(", ")} (want org/name)`);
  if (await getProjectRowByName(name)) return bad(409, `project ${JSON.stringify(name)} already exists — edit it via /projects/save`);
  const id = await ensureProjectRow(name, team, DASHBOARD_ACTOR);
  if (id === null) return bad(503, "project store unavailable");
  await replaceProjectRepos(id, repos, DASHBOARD_ACTOR);
  return { status: 200, json: { ok: true, name, id, repos } };
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
  // Allowlist = env roster ∪ PG model catalog (proxy-served ids synced at boot).
  // Still never free text: an id neither the env nor the proxy vouches for is
  // refused at the door, same as before the catalog existed.
  if (!new Set([...Object.values(config.models), ...(await listCatalogModels())]).has(model)) {
    return bad(400, "model is not in the env roster or the model catalog — the dropdown roster is the allowlist, never free text");
  }
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

/** POST /projects/policy/:id/approve {key, value} — the atomic claim (db.ts),
 *  BOUND to the evidence the approver saw (the approvals.ts gatedHeadSha
 *  pattern applied to config authority). The body must restate the reviewed
 *  key AND proposed value; a mismatch refuses. This makes a blind approve-by-
 *  id impossible: a stale tab, a retried POST, or an id pointing at a
 *  revision the dashboard never rendered cannot activate a value no human
 *  actually reviewed. 409 when the row was already decided (double-click,
 *  superseded, rejected) or the evidence does not match. */
export async function approvePolicyItem(id: number, body: unknown): Promise<HandlerResult> {
  const existing = await getProjectPolicy(id);
  if (!existing) return bad(404, "no such policy revision");
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.key !== "string" || !Object.hasOwn(b, "value")) {
    return bad(400, "approve must restate the reviewed revision as {key, value} — blind approval by id is refused");
  }
  // Canonical-JSON compare against the STORED revision (values are the
  // normalized output of validatePolicyValue: strings, bare booleans, sorted
  // string arrays — JSON.stringify is stable for all of them).
  if (b.key !== existing.key || JSON.stringify(b.value) !== JSON.stringify(existing.value)) {
    return bad(409, "approve evidence mismatch: the pending revision is not the {key, value} you reviewed — reload and re-review");
  }
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
