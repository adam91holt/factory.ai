import { config } from "./config.ts";
import { bus } from "./events.ts";

// Linear GraphQL client. Personal API keys: raw key as Authorization (no
// "Bearer"). Hardened per code-review verdict 2026-07-20: HTTP status checks +
// rate-limit tagging (C25), state resolution by TYPE not name (C13/M4), claim
// rollback on partial failure (C8), park/needs-human labels filtered from the
// queue (C6), oldest-first ordering client-side (C21).

const ENDPOINT = "https://api.linear.app/graphql";
export const EXECUTING_LABEL = "Factory-Executing";
// #13: a parked ticket is deliberately left in Todo (queue) state — only the
// Factory-Parked label keeps it out of fetchQueue/fetchTeamQueue's skip-set
// below. Re-queue = remove the label; no state transition is required or
// taken, keeping parked→requeue a single reversible edit (the park report
// says this explicitly — see report.ts buildReport).
export const PARKED_LABEL = "Factory-Parked";
export const NEEDS_HUMAN_LABEL = "Factory-Needs-Human";
export const EPIC_LABEL = "Factory-Epic";
export const PLANNED_LABEL = "Factory-Planned";
export const STEWARDED_LABEL = "Factory-Stewarded";
// Gap-4: a ticket the freshness gate auto-resolved as stale (its goal already
// exists in the world) is moved to Done AND labeled Factory-Stale so it never
// requeues — added to every fetch skip-set below. Reversible: a human removes
// the label (and reopens) to requeue.
export const STALE_LABEL = "Factory-Stale";
// Gap-5 bookend labels. INTAKE marks a rough-idea ticket the intake author is
// turning into a full epic contract; BOOTSTRAP marks an idea→repo ticket the
// bootstrap module owns. AWAITING_ANSWER marks an intake ticket that posted
// clarifying questions and is waiting on the human — added to every fetch
// skip-set below so an awaiting ticket does not re-loop through the interview
// each tick (a human's answer comment + label removal requeues it).
export const INTAKE_LABEL = "Factory-Intake";
export const BOOTSTRAP_LABEL = "Factory-Bootstrap";
export const AWAITING_ANSWER_LABEL = "Factory-Awaiting-Answer";
export const SENTINEL = "🤖 **Factory report**";

export class LinearRateLimited extends Error {
  constructor(status: number) { super(`Linear rate-limited/unavailable (HTTP ${status})`); }
}

// --- Connection hygiene (recycle the pool after repeated 5xx/network failures) ---
//
// Observed in prod 2026-08-02: after ~24h uptime EVERY Linear request returned
// 503/504 for hours while a fresh curl with the SAME key from the SAME machine
// got 200 with rate limits untouched — a poisoned kept-alive connection pool in
// the long-running Bun process, which the tick backoff then faithfully retried
// over the same dead sockets forever. Bun's fetch has no pool-bypass option
// (bun-types 1.3.x: BunFetchRequestInit adds tls/proxy/verbose only; standard
// `keepalive` governs page-unload semantics, not pooling), so the lever is the
// request header: "Connection: close" makes Bun open a fresh socket for that
// request and drop it afterward instead of reusing/parking a pooled one.
// This is HYGIENE only — backoff timing (LinearBackoff in index.ts) is untouched.

/** Consecutive 5xx/network failures before requests refuse the pooled socket. */
export const FRESH_CONNECTION_AFTER = 3;
/** Consecutive failures before the ONE loud operator-facing log line fires —
 * the per-tick "[tick] … backing off Ns" line repeats identically forever, so
 * without a distinct escalation an operator cannot tell a wedge from a blip. */
export const LOUD_LOG_AFTER = 10;

/** Tracks consecutive transport-level failures (HTTP 5xx or fetch throwing —
 * NOT 429, NOT 4xx, NOT GraphQL errors: those prove the connection is alive
 * and the request reached Linear). Injectable log for tests; the counter is
 * process-wide (one shared pool → one shared health) via `defaultDeps` below. */
export class ConnectionHealth {
  private consecutive = 0;
  constructor(private readonly log: (msg: string) => void = console.error) {}

  get consecutiveFailures(): number { return this.consecutive; }

  /** Should the NEXT request bypass the kept-alive pool? Stays true until a
   * success resets — once we suspect the pool, every retry gets a fresh socket
   * (each "Connection: close" response also evicts one possibly-dead socket). */
  get forceFresh(): boolean { return this.consecutive >= FRESH_CONNECTION_AFTER; }

  recordFailure(): void {
    this.consecutive += 1;
    // Exactly-at-threshold so the loud line fires ONCE per wedge, not per
    // request; a recovery then re-wedge legitimately fires it again.
    if (this.consecutive === LOUD_LOG_AFTER) {
      this.log(`[linear] ${this.consecutive} consecutive 5xx/network failures — likely stale connection pool or Linear outage; forcing fresh connections`);
    }
  }

  recordSuccess(): void { this.consecutive = 0; }
}

// Injectable seam (postmerge.ts's DeployDeps pattern) so the fresh-connection
// escalation is testable without a network: tests pass a fake fetch + their own
// ConnectionHealth; production shares ONE health instance across all queries
// because they share one connection pool.
export interface LinearTransportDeps {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  health: ConnectionHealth;
}

const defaultDeps: LinearTransportDeps = {
  fetchImpl: (url, init) => fetch(url, init),
  health: new ConnectionHealth(),
};

/** Transport layer of every Linear query — exported for tests only (production
 * callers go through the module's typed query functions, which use gql below). */
export async function gqlWith<T>(deps: LinearTransportDeps, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { fetchImpl, health } = deps;
  const headers: Record<string, string> = { Authorization: config.linearApiKey, "Content-Type": "application/json" };
  if (health.forceFresh) headers.Connection = "close";
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  } catch (error) {
    // Network-level failure (e.g. ECONNRESET/timeout on a dead pooled socket)
    // counts toward recycling — this is exactly the poisoned-pool signature.
    health.recordFailure();
    throw error;
  }
  if (res.status >= 500) {
    health.recordFailure();
    throw new LinearRateLimited(res.status);
  }
  // Any sub-500 response proves the socket + server path are alive, so the
  // consecutive counter resets BEFORE status handling: a genuine 429 rate
  // limit must not push us into (pointless) connection recycling.
  health.recordSuccess();
  if (res.status === 429) throw new LinearRateLimited(res.status);
  if (!res.ok) throw new Error(`Linear HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const payload = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (payload.errors?.length) throw new Error(`Linear: ${payload.errors.map((e) => e.message).join("; ")}`);
  if (!payload.data) throw new Error("Linear: empty response");
  return payload.data;
}

const gql = <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> =>
  gqlWith<T>(defaultDeps, query, variables);

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  teamKey: string;
  teamId: string;
  stateName: string;
  stateType: string;
  labels: string[];
  createdAt: string;
}

interface RawIssue {
  id: string; identifier: string; title: string; description: string | null; url: string;
  createdAt: string;
  team: { id: string; key: string };
  state: { name: string; type: string };
  labels: { nodes: Array<{ name: string }> };
}

function toIssue(raw: RawIssue): Issue {
  return {
    id: raw.id, identifier: raw.identifier, title: raw.title,
    description: raw.description ?? "", url: raw.url, teamKey: raw.team.key, teamId: raw.team.id,
    stateName: raw.state.name, stateType: raw.state.type,
    labels: raw.labels.nodes.map((l) => l.name),
    createdAt: raw.createdAt,
  };
}

const ISSUE_FIELDS = `id identifier title description url createdAt team { id key } state { name type } labels { nodes { name } }`;

/** Issues in the given teams (default: all watched) carrying a label (any state). */
export async function fetchByLabel(label: string, teamKeys: string[] = config.teamKeys): Promise<Issue[]> {
  const data = await gql<{ issues: { nodes: RawIssue[] } }>(
    `query($teams: [String!]!, $label: String!) {
      issues(first: 25, filter: { team: { key: { in: $teams } }, labels: { name: { eq: $label } } }) { nodes { ${ISSUE_FIELDS} } }
    }`, { teams: teamKeys, label });
  return data.issues.nodes.map(toIssue);
}

/** The unclaimed Todo queue for ONE team — same filter as fetchQueue (unstarted
 * minus factory-owned labels, FIFO) but scoped to a single team key and WITHOUT
 * the queue_snapshot emit, so a groundskeeper reading the board to decide
 * whether humans have pending work never perturbs the dashboard's snapshot. */
export async function fetchTeamQueue(teamKey: string): Promise<Issue[]> {
  const data = await gql<{ issues: { nodes: RawIssue[] } }>(
    `query($team: String!) {
      issues(first: 50, filter: { team: { key: { eq: $team } }, state: { type: { eq: "unstarted" } } }) { nodes { ${ISSUE_FIELDS} } }
    }`, { team: teamKey });
  const skip = new Set([EXECUTING_LABEL, PARKED_LABEL, NEEDS_HUMAN_LABEL, PLANNED_LABEL, STALE_LABEL, AWAITING_ANSWER_LABEL]);
  return data.issues.nodes.map(toIssue)
    .filter((issue) => !issue.labels.some((l) => skip.has(l)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Issues in a review-type state for ONE team — the "PR open" leg of the
 * groundskeeper attention cap (started-type states whose name reads "review"). */
export async function fetchTeamInReview(teamKey: string): Promise<Issue[]> {
  const data = await gql<{ issues: { nodes: RawIssue[] } }>(
    `query($team: String!) {
      issues(first: 50, filter: { team: { key: { eq: $team } }, state: { type: { eq: "started" } } }) { nodes { ${ISSUE_FIELDS} } }
    }`, { team: teamKey });
  return data.issues.nodes.map(toIssue).filter((i) => /review/i.test(i.stateName));
}

/** Queue = unstarted issues in watched teams, minus claimed/parked/needs-human, oldest first. */
export async function fetchQueue(): Promise<Issue[]> {
  const data = await gql<{ issues: { nodes: RawIssue[] } }>(
    `query($teams: [String!]!) {
      issues(first: 50, filter: {
        team: { key: { in: $teams } },
        state: { type: { eq: "unstarted" } }
      }) { nodes { ${ISSUE_FIELDS} } }
    }`,
    { teams: config.teamKeys },
  );
  const all = data.issues.nodes.map(toIssue);
  const skip = new Set([EXECUTING_LABEL, PARKED_LABEL, NEEDS_HUMAN_LABEL, PLANNED_LABEL, STALE_LABEL, AWAITING_ANSWER_LABEL]);
  bus.emit({
    type: "queue_snapshot",
    issues: all.map((i) => ({
      id: i.id, identifier: i.identifier, title: i.title, url: i.url, teamKey: i.teamKey,
      stateName: i.stateName, stateType: i.stateType, labels: i.labels, createdAt: i.createdAt,
      lane: i.labels.includes(PARKED_LABEL) ? "parked"
        : i.labels.includes(NEEDS_HUMAN_LABEL) ? "needs_human"
        : i.labels.includes(EXECUTING_LABEL) ? "claimed" : "todo",
    })),
  });
  return all
    .filter((issue) => !issue.labels.some((l) => skip.has(l)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // FIFO regardless of server order (C21)
}

/** All issues of a given state TYPE in a team (e.g. "started" = In Progress + In Review). */
export async function fetchIssuesByStateType(stateType: string, teamKey: string): Promise<Issue[]> {
  const data = await gql<{ issues: { nodes: RawIssue[] } }>(
    `query($team: String!, $st: String!) {
      issues(first: 50, filter: { team: { key: { eq: $team } }, state: { type: { eq: $st } } }) {
        nodes { ${ISSUE_FIELDS} } } }`, { team: teamKey, st: stateType });
  return data.issues.nodes.map(toIssue);
}

/** Resolve a set of sibling identifiers (e.g. ["FAC-123","FAC-124"]) to their
 * current state TYPE (identifier → "completed" | "started" | …). One GraphQL
 * query filtering by team key + issue number; the returned identifier is
 * authoritative so cross-team number collisions can't mismap. The scheduler
 * calls this each tick to test the DAG frontier against LIVE Linear state (the
 * stillOurs() freshness pattern generalized to dependencies — Gap 4). An
 * identifier that resolves to nothing is simply absent from the map, which the
 * scheduler treats as "not completed" (fail-closed). Tolerates the
 * LinearRateLimited path like every other query — it throws up to tick()'s
 * existing backoff. */
export async function fetchStatesByIdentifiers(ids: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  // Parse TEAM-123 → { key, number }; drop anything malformed so a junk id
  // never reaches the query. Collect the distinct team keys and numbers.
  const numbers: number[] = [];
  const teamKeys = new Set<string>();
  for (const id of ids) {
    const m = id.match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
    if (!m) continue;
    teamKeys.add(m[1]!);
    numbers.push(Number(m[2]!));
  }
  if (numbers.length === 0) return result;
  const data = await gql<{ issues: { nodes: Array<{ identifier: string; state: { type: string } }> } }>(
    `query($teams: [String!]!, $numbers: [Float!]!) {
      issues(first: 100, filter: { team: { key: { in: $teams } }, number: { in: $numbers } }) {
        nodes { identifier state { type } } } }`,
    { teams: [...teamKeys], numbers },
  );
  for (const node of data.issues.nodes) result.set(node.identifier, node.state.type);
  return result;
}

export async function getIssue(id: string): Promise<Issue> {
  const data = await gql<{ issue: RawIssue }>(
    `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id });
  return toIssue(data.issue);
}

const labelCache = new Map<string, string>();

async function labelId(teamKey: string, name: string): Promise<string> {
  const cached = labelCache.get(`${teamKey}/${name}`);
  if (cached) return cached;
  const data = await gql<{ issueLabels: { nodes: Array<{ id: string; name: string; team: { key: string } | null }> } }>(
    `query($name: String!) { issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 10) {
       nodes { id name team { key } } } }`, { name });
  const scoped = data.issueLabels.nodes.find((l) => l.team?.key === teamKey) ?? data.issueLabels.nodes[0];
  if (scoped) { labelCache.set(`${teamKey}/${name}`, scoped.id); return scoped.id; }
  try {
    const created = await gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
      `mutation($name: String!) { issueLabelCreate(input: { name: $name }) { issueLabel { id } } }`, { name });
    labelCache.set(`${teamKey}/${name}`, created.issueLabelCreate.issueLabel.id);
    return created.issueLabelCreate.issueLabel.id;
  } catch (error) {
    // Concurrent-create race ("duplicate label name"): another claim created it
    // between our query and create — re-query instead of failing the claim.
    if (String(error).includes("duplicate")) {
      const retry = await gql<{ issueLabels: { nodes: Array<{ id: string }> } }>(
        `query($name: String!) { issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 1) { nodes { id } } }`, { name });
      const id = retry.issueLabels.nodes[0]?.id;
      if (id) { labelCache.set(`${teamKey}/${name}`, id); return id; }
    }
    throw error;
  }
}

export async function addLabel(issue: Issue, name: string): Promise<void> {
  const id = await labelId(issue.teamKey, name);
  await gql(`mutation($issueId: String!, $labelId: String!) {
    issueAddLabel(id: $issueId, labelId: $labelId) { success } }`, { issueId: issue.id, labelId: id });
}

export async function removeLabel(issue: Issue, name: string): Promise<void> {
  const id = await labelId(issue.teamKey, name);
  await gql(`mutation($issueId: String!, $labelId: String!) {
    issueRemoveLabel(id: $issueId, labelId: $labelId) { success } }`, { issueId: issue.id, labelId: id });
}

export interface IssueDetail {
  identifier: string; title: string; description: string; url: string;
  stateName: string; labels: string[];
  parent: { identifier: string; title: string; stateName: string } | null;
  children: Array<{ identifier: string; title: string; stateName: string; stateType?: string; labels?: string[] }>;
  siblings: Array<{ identifier: string; title: string; stateName: string; stateType?: string; labels?: string[] }>;
}

/** Full ticket content + lineage for the dashboard's run view. */
export async function getIssueDetail(key: string): Promise<IssueDetail> {
  interface Node { identifier: string; title: string; state: { name: string; type?: string }; labels?: { nodes: Array<{ name: string }> } }
  const data = await gql<{ issue: {
    identifier: string; title: string; description: string | null; url: string;
    state: { name: string }; labels: { nodes: Array<{ name: string }> };
    parent: (Node & { children: { nodes: Node[] } }) | null;
    children: { nodes: Node[] };
  } }>(
    `query($key: String!) { issue(id: $key) {
      identifier title description url state { name } labels { nodes { name } }
      parent { identifier title state { name } children { nodes { identifier title state { name } } } }
      children { nodes { identifier title state { name type } labels { nodes { name } } } } } }`, { key });
  const i = data.issue;
  const flat = (n: Node) => ({ identifier: n.identifier, title: n.title, stateName: n.state.name, stateType: n.state.type ?? "", labels: (n.labels?.nodes ?? []).map((l) => l.name) });
  return {
    identifier: i.identifier, title: i.title, description: i.description ?? "", url: i.url,
    stateName: i.state.name, labels: i.labels.nodes.map((l) => l.name),
    parent: i.parent ? flat(i.parent) : null,
    children: i.children.nodes.map(flat),
    siblings: (i.parent?.children.nodes ?? []).filter((n) => n.identifier !== i.identifier).map(flat),
  };
}

export type StateKind = "queue" | "working" | "review" | "done";

/** Resolve a team state by TYPE with name as tiebreak only (C13/M4). */
async function resolveState(issue: Issue, kind: StateKind): Promise<{ id: string; name: string } | null> {
  const data = await gql<{ issue: { team: { states: { nodes: Array<{ id: string; name: string; type: string; position: number }> } } } }>(
    `query($id: String!) { issue(id: $id) { team { states { nodes { id name type position } } } } }`, { id: issue.id });
  const states = data.issue.team.states.nodes;
  if (kind === "queue") {
    return states.find((s) => s.type === "unstarted" && s.name === "Todo")
      ?? states.find((s) => s.type === "unstarted") ?? null;
  }
  if (kind === "done") {
    // Name-anchor "Done" before first-completed (mirrors queue→"Todo",
    // working→"In Progress"): a team with multiple completed-type states (e.g.
    // "Released" ordered before "Done") must not land closures in the wrong one.
    return states.find((s) => s.type === "completed" && s.name === "Done")
      ?? states.find((s) => s.type === "completed") ?? null;
  }
  const started = states.filter((s) => s.type === "started").sort((a, b) => a.position - b.position);
  if (kind === "working") {
    return started.find((s) => s.name === "In Progress") ?? started[0] ?? null;
  }
  return started.find((s) => /review/i.test(s.name)) ?? started[started.length - 1] ?? null;
}

export async function transition(issue: Issue, kind: StateKind): Promise<boolean> {
  const state = await resolveState(issue, kind);
  if (!state) return false;
  await gql(`mutation($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`, { id: issue.id, stateId: state.id });
  return true;
}

/** Create a contract-conforming child under an epic (PLAN stage). Lands in the
 * default triage-less backlog state; the factory picks it up like any ticket. */
export async function createSubIssue(parent: Issue, title: string, description: string): Promise<string> {
  // Pin the queue (unstarted/Todo) state at creation — issueCreate's default is
  // the team's Backlog state, which fetchQueue deliberately does not read.
  const queueState = await resolveState(parent, "queue");
  const data = await gql<{ issueCreate: { success: boolean; issue: { identifier: string } } }>(
    `mutation($teamId: String!, $parentId: String!, $title: String!, $description: String!, $stateId: String) {
      issueCreate(input: { teamId: $teamId, parentId: $parentId, title: $title, description: $description, stateId: $stateId }) {
        success issue { identifier } } }`,
    { teamId: parent.teamId, parentId: parent.id, title, description, stateId: queueState?.id ?? null });
  if (!data.issueCreate.success) throw new Error(`issueCreate failed for "${title}"`);
  return data.issueCreate.issue.identifier;
}

// Team id + queue-state resolution keyed by team KEY (createIssue has no Issue
// object to hang off, unlike createSubIssue). Cached per key for the process.
const teamCache = new Map<string, { id: string; queueStateId: string | null }>();

async function resolveTeamByKey(teamKey: string): Promise<{ id: string; queueStateId: string | null }> {
  const cached = teamCache.get(teamKey);
  if (cached) return cached;
  const data = await gql<{ teams: { nodes: Array<{ id: string; states: { nodes: Array<{ id: string; name: string; type: string; position: number }> } }> } }>(
    `query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) {
       nodes { id states { nodes { id name type position } } } } }`, { key: teamKey });
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`no Linear team with key ${teamKey}`);
  const states = team.states.nodes;
  // Same rule as resolveState(kind:"queue"): prefer unstarted/"Todo", else any
  // unstarted state — issueCreate would otherwise default to Backlog, which
  // fetchQueue deliberately never reads.
  const queue = states.find((s) => s.type === "unstarted" && s.name === "Todo")
    ?? states.find((s) => s.type === "unstarted") ?? null;
  const resolved = { id: team.id, queueStateId: queue?.id ?? null };
  teamCache.set(teamKey, resolved);
  return resolved;
}

/** Create a top-level (non-child) contract-conforming issue in a team, pinned to
 * the queue (unstarted/Todo) state so the factory picks it up like any ticket —
 * the groundskeeper's ticket-filing primitive. Returns the new identifier. */
export async function createIssue(teamKey: string, title: string, description: string): Promise<string> {
  const team = await resolveTeamByKey(teamKey);
  const data = await gql<{ issueCreate: { success: boolean; issue: { identifier: string } } }>(
    `mutation($teamId: String!, $title: String!, $description: String!, $stateId: String) {
      issueCreate(input: { teamId: $teamId, title: $title, description: $description, stateId: $stateId }) {
        success issue { identifier } } }`,
    { teamId: team.id, title, description, stateId: team.queueStateId });
  if (!data.issueCreate.success) throw new Error(`issueCreate failed for "${title}"`);
  return data.issueCreate.issue.identifier;
}

export async function postComment(issue: Issue, body: string): Promise<void> {
  await gql(`mutation($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success } }`, { issueId: issue.id, body });
}

/** Rewrite an issue's description (and optionally its title). The intake author
 * (Gap 5) uses this to UPGRADE a rough-idea ticket into a full epic contract in
 * place — the new description carries a start-anchored factory block stamping
 * type:epic, so the next tick routes it to the planner. Title update is opt-in. */
export async function updateIssueDescription(issue: Issue, description: string, title?: string): Promise<void> {
  await gql(`mutation($id: String!, $description: String!, $title: String) {
    issueUpdate(id: $id, input: { description: $description, title: $title }) { success } }`,
    { id: issue.id, description, title: title ?? null });
}

/** Newest-last comment bodies on an issue (bounded). The intake author reads
 * these on a re-run so a human's answers to its earlier QUESTIONS are seen; the
 * bodies are UNTRUSTED (human/agent text) and delimited before reaching a model. */
export async function fetchComments(issueId: string, limit = 30): Promise<string[]> {
  const data = await gql<{ issue: { comments: { nodes: Array<{ body: string; createdAt: string }> } } }>(
    `query($id: String!, $limit: Int!) { issue(id: $id) {
      comments(first: $limit) { nodes { body createdAt } } } }`, { id: issueId, limit });
  return data.issue.comments.nodes
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => c.body);
}

/**
 * Claim: set label + working state, then RE-READ and verify (Linear has no CAS).
 * Any partial failure rolls the label back so the issue can never become
 * invisible-but-unclaimed (C8). Verification is by state TYPE (M4).
 */
export async function claim(issue: Issue): Promise<boolean> {
  const fresh = await getIssue(issue.id);
  if (fresh.stateType !== "unstarted" || fresh.labels.includes(EXECUTING_LABEL)) return false;
  try {
    await addLabel(issue, EXECUTING_LABEL);
    const moved = await transition(issue, "working");
    if (!moved) throw new Error("no started-type state on team");
    const verify = await getIssue(issue.id);
    if (verify.labels.includes(EXECUTING_LABEL) && verify.stateType === "started") return true;
    throw new Error("claim re-read failed verification");
  } catch (error) {
    console.error(`[${issue.identifier}] claim rollback: ${error instanceof Error ? error.message : error}`);
    await removeLabel(issue, EXECUTING_LABEL).catch(() => {});
    return false;
  }
}

/** Pure exclusion filter, extracted so the "which Executing-labeled issues are
 * ACTUALLY orphaned" decision is unit-testable without a network mock — the
 * surrounding fetchByLabel/removeLabel/transition calls are integration-only. */
export function filterOrphanedIssues(issues: Issue[], excludeIdentifiers: ReadonlySet<string>): Issue[] {
  return issues.filter((issue) => !excludeIdentifiers.has(issue.identifier));
}

/** Startup recovery (and the runtime orphan sweep, index.ts): a fresh daemon
 * owns no in-flight work, and the single-instance lease guarantees no live
 * sibling holds a claim — so any Executing-labeled issue that is NOT one of
 * THIS process's own in-flight claims is an orphan from a process that died
 * (e.g. a restart mid-run) or a mutation that failed silently mid-pipeline.
 * Reset each to the queue so it re-claims and resumes (resume-safe commit
 * gate + git-retry handle committed-but-unpushed work). Without this, a
 * restart — or an invisible in-flight ticket the daemon never restarts for —
 * strands In-Progress tickets forever.
 *
 * `excludeIdentifiers` is empty at startup (nothing is in flight yet, so
 * every Executing-labeled issue found IS an orphan); index.ts's periodic
 * runtime sweep passes its live `inFlight` keys so genuinely-running claims
 * are never reset out from under themselves. */
export async function recoverOrphanedClaims(excludeIdentifiers: ReadonlySet<string> = new Set()): Promise<string[]> {
  const orphans = filterOrphanedIssues(await fetchByLabel(EXECUTING_LABEL).catch(() => [] as Issue[]), excludeIdentifiers);
  const recovered: string[] = [];
  for (const issue of orphans) {
    try {
      await removeLabel(issue, EXECUTING_LABEL);
      await transition(issue, "queue");
      recovered.push(issue.identifier);
    } catch (error) {
      console.error(`[recover] ${issue.identifier} reset failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  return recovered;
}

export async function release(issue: Issue): Promise<void> {
  await removeLabel(issue, EXECUTING_LABEL).catch(() => {});
}
