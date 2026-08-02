import { isMockMode } from "./fixtures";
import type { RunRecord } from "./events";
import type { ApprovalItem } from "./approvals";

// ---------------------------------------------------------------------------
// Projects client + pure helpers for the /projects views.
//
// CONTRACT (src/project-config.ts ProjectsPayload via GET /projects — the
// backend is the authority; this file is the ONLY place the wire shape lives
// UI-side, duplicated by design like approvals.ts / telemetry.ts):
//
//   GET  /projects                       → ProjectsWirePayload
//   POST /projects/save                  {name, goal?, description?, status?, team?}
//   POST /projects/model                 {name, role, model|null, effort?}
//   POST /projects/groundskeeper         {name, card, enabled, cadence?}
//   POST /projects/policy/:id/approve    {}
//   POST /projects/policy/:id/reject     {}
//
// TWO-TIER invariant mirrored from the backend: descriptive fields (goal,
// description, status, team, models, groundskeeper rows) save immediately;
// AUTHORITY fields (repos, merge, deploy, smoke, deployEnabled) are READ-ONLY
// here — the page renders the value in force plus any PENDING policy revision
// as an awaiting-approval diff. This UI never edits an authority value
// directly; the model dropdown offers ONLY roster models (the backend refuses
// free text anyway — belt to its braces).
// ---------------------------------------------------------------------------

export interface RepoTier {
  repo: string;
  /** "human" | "shadow" | "auto-low-risk" | "auto" — display-only. */
  tier: string;
  cleanStreak: number;
}

export interface ProjectPolicy {
  id: number;
  key: string;
  value: unknown;
  state: string; // "pending" | "active" | "rejected" | "superseded"
  approvedBy: string | null;
  approvedAt: number | null;
  createdAt: number;
}

export interface ProjectAuditRow {
  id: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  actor: string;
  at: number;
}

export interface ProjectModelRow { role: string; model: string; effort: string | null }
export interface ProjectGroundskeeperRow { card: string; enabled: boolean; cadence: string | null }

/** The card/effective authority slice the diff panel renders. */
export interface ProjectCardView {
  name: string;
  team: string;
  repos: string[];
  merge: string;
  deploy?: string;
  smoke?: string;
  deployEnabled: boolean;
}

export interface ProjectView {
  name: string;
  goal: string;
  description: string;
  team: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  repos: string[];
  ladder: RepoTier[];
  card: ProjectCardView | null;
  effective: ProjectCardView | null;
  models: ProjectModelRow[];
  groundskeepers: ProjectGroundskeeperRow[];
  policies: ProjectPolicy[];
  audit: ProjectAuditRow[];
}

export interface ProjectsPayload {
  projects: ProjectView[];
  /** The operator's config.models roster — the model dropdown's ONLY options. */
  roster: { roles: string[]; models: string[] };
  /** GLOBAL env gate — false means every per-project toggle below is inert. */
  groundskeepersEnabled: boolean;
  drain: { draining: boolean; reason: string | null };
}

/** SDK effort levels — fixed enum, mirrors src/meta.ts EFFORT_VALUES. */
export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The authority keys — mirrors src/project-config.ts AUTHORITY_KEYS. These
 *  render read-only with a pending-state diff; everything else is descriptive. */
export const AUTHORITY_KEYS = ["repos", "deploy", "smoke", "deployEnabled", "merge"] as const;

// ---------------------------------------------------------------------------
// Wire tolerance: a payload from an older backend (no ladder/roster/drain)
// must still render — missing fields degrade to empty, never to undefined
// leaking into renders.
// ---------------------------------------------------------------------------

export function mapProject(w: Partial<ProjectView> & { name: string }): ProjectView {
  return {
    name: w.name,
    goal: w.goal ?? "",
    description: w.description ?? "",
    team: w.team ?? "",
    status: w.status ?? "active",
    createdAt: w.createdAt ?? 0,
    updatedAt: w.updatedAt ?? 0,
    repos: w.repos ?? [],
    ladder: w.ladder ?? [],
    card: w.card ?? null,
    effective: w.effective ?? null,
    models: w.models ?? [],
    groundskeepers: w.groundskeepers ?? [],
    policies: w.policies ?? [],
    audit: w.audit ?? [],
  };
}

export function mapProjectsPayload(raw: unknown): ProjectsPayload {
  const w = (raw ?? {}) as Partial<ProjectsPayload>;
  return {
    projects: (w.projects ?? []).map((p) => mapProject(p)),
    roster: {
      roles: w.roster?.roles ?? [],
      models: w.roster?.models ?? [],
    },
    groundskeepersEnabled: w.groundskeepersEnabled === true,
    drain: { draining: w.drain?.draining === true, reason: w.drain?.reason ?? null },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — kept out of the components so the list-page derivations and
// the two-tier display logic are unit-testable without a DOM (approvals.ts
// pattern).
// ---------------------------------------------------------------------------

const THIRTY_DAYS_MS = 30 * 24 * 3_600_000;

/** 30-day spend for a project: durable run history (GET /runs) filtered to the
 *  project's repos. Rows without a repo (older records) count for NO project —
 *  never guessed into one. Pure. */
export function spend30d(records: RunRecord[], repos: string[], now: number): number {
  const set = new Set(repos);
  let sum = 0;
  for (const r of records) {
    if (!r.repo || !set.has(r.repo)) continue;
    if (now - r.finishedAt > THIRTY_DAYS_MS) continue;
    if (Number.isFinite(r.costUsd)) sum += r.costUsd;
  }
  return sum;
}

/** Most recent distinct park/needs-human reasons for a project's repos —
 *  newest first, deduped verbatim, capped. Pure. */
export function recentParkReasons(records: RunRecord[], repos: string[], limit = 3): string[] {
  const set = new Set(repos);
  const out: string[] = [];
  const seen = new Set<string>();
  const relevant = records
    .filter((r) => r.repo !== undefined && set.has(r.repo)
      && (r.outcome === "parked" || r.outcome === "needs_human")
      && typeof r.reason === "string" && r.reason.trim() !== "")
    .sort((a, b) => b.finishedAt - a.finishedAt);
  for (const r of relevant) {
    const reason = (r.reason ?? "").trim();
    if (seen.has(reason)) continue;
    seen.add(reason);
    out.push(reason);
    if (out.length >= limit) break;
  }
  return out;
}

/** Open (pending) review-queue items whose repo belongs to this project. */
export function openApprovalsCount(items: ApprovalItem[], repos: string[]): number {
  const set = new Set(repos);
  return items.filter((i) => i.status === "pending" && set.has(i.repo)).length;
}

/** Pending authority revisions, newest first. */
export function pendingPolicies(policies: ProjectPolicy[]): ProjectPolicy[] {
  return policies
    .filter((p) => p.state === "pending")
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Render one authority value for display (repos join, booleans, strings). */
export function formatPolicyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** The authority value currently IN FORCE for a key (effective card wins; the
 *  raw card is the fallback; no card at all → "—"). */
export function currentAuthorityValue(project: ProjectView, key: string): string {
  const src = project.effective ?? project.card;
  if (!src) return "—";
  switch (key) {
    case "repos": return formatPolicyValue(src.repos);
    case "merge": return formatPolicyValue(src.merge);
    case "deploy": return formatPolicyValue(src.deploy ?? null);
    case "smoke": return formatPolicyValue(src.smoke ?? null);
    case "deployEnabled": return formatPolicyValue(src.deployEnabled);
    default: return "—";
  }
}

export interface AuthorityRow {
  key: string;
  current: string;
  /** Awaiting-approval revision, when one is pending for this key. */
  pending: { policyId: number; proposed: string; createdAt: number } | null;
}

/** The read-only authority table: one row per authority key, each carrying the
 *  value in force and (when a revision awaits approval) the pending diff.
 *  When several revisions of one key are pending, the NEWEST is shown. Pure. */
export function authorityRows(project: ProjectView): AuthorityRow[] {
  const pending = pendingPolicies(project.policies);
  return AUTHORITY_KEYS.map((key) => {
    const p = pending.find((x) => x.key === key) ?? null;
    return {
      key,
      current: currentAuthorityValue(project, key),
      pending: p ? { policyId: p.id, proposed: formatPolicyValue(p.value), createdAt: p.createdAt } : null,
    };
  });
}

export type GroundskeeperToggleState = "armed" | "inert" | "off";

/** What a per-project groundskeeper toggle MEANS right now. enabled=true only
 *  arms anything when the GLOBAL env gate is also on — with
 *  GROUNDSKEEPERS_ENABLED=0 the row is INERT and the UI must say so visibly
 *  (the double-gate is the safety property; this never weakens it, it only
 *  reports it). */
export function groundskeeperToggleState(enabled: boolean, globallyEnabled: boolean): GroundskeeperToggleState {
  if (!enabled) return "off";
  return globallyEnabled ? "armed" : "inert";
}

/** Is this model id offered by the roster? The dropdown only ever renders
 *  roster options, so this is the belt on the backend's braces. */
export function isRosterModel(roster: ProjectsPayload["roster"], model: string): boolean {
  return roster.models.includes(model);
}

// ---------------------------------------------------------------------------
// Fetch/POST clients. In ?mock=1 the payload is served (and mutated) from an
// in-memory wire-shaped fixture flowing through the SAME mapping — the
// convention of every view.
// ---------------------------------------------------------------------------

export type ProjectActionResponse = { ok: true } | { error: string };

export async function fetchProjects(): Promise<ProjectsPayload> {
  if (isMockMode()) return mapProjectsPayload(mockPayload());
  const res = await fetch("/projects", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /projects → ${res.status}`);
  return mapProjectsPayload(await res.json());
}

async function post(path: string, body: Record<string, unknown>): Promise<ProjectActionResponse> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
  if (res.ok && json?.ok === true) return { ok: true };
  const error = typeof json?.error === "string" && json.error !== ""
    ? json.error
    : `POST ${path} → ${res.status}`;
  return { error };
}

export async function saveProjectFields(
  name: string,
  fields: Partial<Record<"goal" | "description" | "status" | "team", string>>,
): Promise<ProjectActionResponse> {
  if (isMockMode()) return mockSave(name, fields);
  return post("/projects/save", { name, ...fields });
}

export async function setProjectModel(
  name: string,
  role: string,
  model: string | null,
  effort: string | null,
): Promise<ProjectActionResponse> {
  if (isMockMode()) return mockSetModel(name, role, model, effort);
  return post("/projects/model", { name, role, model, ...(effort !== null ? { effort } : {}) });
}

export async function setProjectGroundskeeper(
  name: string,
  card: string,
  enabled: boolean,
  cadence: string | null,
): Promise<ProjectActionResponse> {
  if (isMockMode()) return mockSetGroundskeeper(name, card, enabled, cadence);
  return post("/projects/groundskeeper", { name, card, enabled, cadence });
}

export async function decidePolicy(policyId: number, action: "approve" | "reject"): Promise<ProjectActionResponse> {
  if (isMockMode()) return mockDecidePolicy(policyId, action);
  return post(`/projects/policy/${policyId}/${action}`, {});
}

// ---------------------------------------------------------------------------
// Mock fixtures (?mock=1) — two believable projects: one with a pending
// authority diff + per-role models + an inert groundskeeper toggle, one bare.
// Session-local mutation state so saves visibly land without a backend.
// ---------------------------------------------------------------------------

let mockState: ProjectsPayload | null = null;

function mockPayload(): ProjectsPayload {
  if (mockState) return mockState;
  const now = Date.now();
  const HOUR = 3_600_000;
  const rapidoCard: ProjectCardView = {
    name: "rapido", team: "FAC", repos: ["rapido/api", "rapido/portal"],
    merge: "review", deploy: "fly deploy --config fly.api.toml", smoke: "bun scripts/smoke.ts",
    deployEnabled: false,
  };
  mockState = {
    projects: [
      {
        name: "rapido",
        goal: "Ship the client portal + API the factory dogfoods against.",
        description: "Two repos: the public API (Express, Postgres) and the client portal (React). The factory owns routine backlog burn-down; humans own product direction.",
        team: "FAC", status: "active",
        createdAt: now - 40 * 24 * HOUR, updatedAt: now - 2 * HOUR,
        repos: ["rapido/api", "rapido/portal"],
        ladder: [
          { repo: "rapido/api", tier: "auto-low-risk", cleanStreak: 2 },
          { repo: "rapido/portal", tier: "shadow", cleanStreak: 4 },
        ],
        card: rapidoCard,
        effective: rapidoCard,
        models: [
          { role: "implementer", model: "sonnet", effort: "high" },
          { role: "fixer", model: "sonnet", effort: null },
        ],
        groundskeepers: [
          { card: "rapido", enabled: true, cadence: "0 7 * * 1" },
        ],
        policies: [
          { id: 4, key: "merge", value: "shadow", state: "pending", approvedBy: null, approvedAt: null, createdAt: now - 5 * HOUR },
          { id: 3, key: "deployEnabled", value: true, state: "rejected", approvedBy: "dashboard", approvedAt: now - 30 * HOUR, createdAt: now - 31 * HOUR },
          { id: 1, key: "repos", value: ["rapido/api", "rapido/portal"], state: "active", approvedBy: "dashboard", approvedAt: now - 39 * 24 * HOUR, createdAt: now - 39 * 24 * HOUR },
        ],
        audit: [
          { id: 11, field: "policy:merge", oldValue: null, newValue: '{"state":"pending","value":"shadow"}', actor: "dashboard", at: now - 5 * HOUR },
          { id: 10, field: "model:fixer", oldValue: null, newValue: '{"model":"sonnet"}', actor: "dashboard", at: now - 26 * HOUR },
          { id: 9, field: "goal", oldValue: "Ship the portal.", newValue: "Ship the client portal + API the factory dogfoods against.", actor: "dashboard", at: now - 2 * 24 * HOUR },
          { id: 8, field: "groundskeeper:rapido", oldValue: '{"enabled":false}', newValue: '{"enabled":true,"cadence":"0 7 * * 1"}', actor: "dashboard", at: now - 3 * 24 * HOUR },
        ],
      },
      {
        name: "kiwi-quest",
        goal: "",
        description: "",
        team: "FAC", status: "paused",
        createdAt: now - 10 * 24 * HOUR, updatedAt: now - 10 * 24 * HOUR,
        repos: ["adam91holt/kiwi-quest"],
        ladder: [{ repo: "adam91holt/kiwi-quest", tier: "human", cleanStreak: 0 }],
        card: { name: "kiwi-quest", team: "FAC", repos: ["adam91holt/kiwi-quest"], merge: "review", deployEnabled: false },
        effective: { name: "kiwi-quest", team: "FAC", repos: ["adam91holt/kiwi-quest"], merge: "review", deployEnabled: false },
        models: [],
        groundskeepers: [{ card: "kiwi-quest", enabled: false, cadence: null }],
        policies: [],
        audit: [],
      },
    ],
    roster: {
      roles: ["implementer", "reviewerClaude", "reviewerCodex", "fixer", "scout", "planner", "steward", "designReviewer", "tester", "securityReviewer", "distiller"],
      models: ["gpt-5.6-sol", "haiku", "opus", "sonnet"],
    },
    groundskeepersEnabled: false,
    drain: { draining: false, reason: null },
  };
  return mockState;
}

function delay<T>(value: T): Promise<T> {
  return new Promise((r) => setTimeout(() => r(value), 250));
}

function mockSave(name: string, fields: Partial<Record<string, string>>): Promise<ProjectActionResponse> {
  const p = mockPayload().projects.find((x) => x.name === name);
  if (!p) return delay({ error: `no project named "${name}"` });
  for (const f of ["goal", "description", "status", "team"] as const) {
    const v = fields[f];
    if (typeof v === "string") p[f] = v;
  }
  p.updatedAt = Date.now();
  return delay({ ok: true });
}

function mockSetModel(name: string, role: string, model: string | null, effort: string | null): Promise<ProjectActionResponse> {
  const state = mockPayload();
  const p = state.projects.find((x) => x.name === name);
  if (!p) return delay({ error: `no project named "${name}"` });
  if (model !== null && !isRosterModel(state.roster, model)) {
    return delay({ error: "model is not in config.models — the dropdown roster is the allowlist, never free text" });
  }
  p.models = p.models.filter((m) => m.role !== role);
  if (model !== null) p.models.push({ role, model, effort });
  return delay({ ok: true });
}

function mockSetGroundskeeper(name: string, card: string, enabled: boolean, cadence: string | null): Promise<ProjectActionResponse> {
  const p = mockPayload().projects.find((x) => x.name === name);
  if (!p) return delay({ error: `no project named "${name}"` });
  const row = p.groundskeepers.find((g) => g.card === card);
  if (row) {
    row.enabled = enabled;
    row.cadence = cadence;
  } else {
    p.groundskeepers.push({ card, enabled, cadence });
  }
  return delay({ ok: true });
}

function mockDecidePolicy(policyId: number, action: "approve" | "reject"): Promise<ProjectActionResponse> {
  for (const p of mockPayload().projects) {
    const pol = p.policies.find((x) => x.id === policyId);
    if (!pol) continue;
    if (pol.state !== "pending") return delay({ error: "policy revision is not pending (already decided, superseded, or claimed)" });
    pol.state = action === "approve" ? "active" : "rejected";
    pol.approvedBy = "dashboard";
    pol.approvedAt = Date.now();
    if (action === "approve" && pol.key === "merge" && p.effective && typeof pol.value === "string") {
      p.effective = { ...p.effective, merge: pol.value };
    }
    return delay({ ok: true });
  }
  return delay({ error: "no such policy revision" });
}
