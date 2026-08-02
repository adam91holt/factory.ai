import { config } from "./config.ts";
import { bus, type Lane } from "./events.ts";
import { parseFactoryMeta } from "./meta.ts";

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
  /** The workflow state's DESCRIPTION — carries the immutable `[factory:<kind>]`
   *  tag (see "Board stages" below) so pipeline position survives a rename. "" when
   *  the board has not been tagged; every consumer degrades to the pre-tag name
   *  heuristic in that case. */
  stateDescription: string;
  labels: string[];
  createdAt: string;
}

interface RawIssue {
  id: string; identifier: string; title: string; description: string | null; url: string;
  createdAt: string;
  team: { id: string; key: string };
  state: { name: string; type: string; description?: string | null };
  labels: { nodes: Array<{ name: string }> };
}

function toIssue(raw: RawIssue): Issue {
  return {
    id: raw.id, identifier: raw.identifier, title: raw.title,
    description: raw.description ?? "", url: raw.url, teamKey: raw.team.key, teamId: raw.team.id,
    stateName: raw.state.name, stateType: raw.state.type,
    stateDescription: raw.state.description ?? "",
    labels: raw.labels.nodes.map((l) => l.name),
    createdAt: raw.createdAt,
  };
}

const ISSUE_FIELDS = `id identifier title description url createdAt team { id key } state { name type description } labels { nodes { name } }`;

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
 * groundskeeper attention cap (started-type states tagged `[factory:review]`,
 * or named "…review…" on an untagged board). */
export async function fetchTeamInReview(teamKey: string): Promise<Issue[]> {
  const data = await gql<{ issues: { nodes: RawIssue[] } }>(
    `query($team: String!) {
      issues(first: 50, filter: { team: { key: { eq: $team } }, state: { type: { eq: "started" } } }) { nodes { ${ISSUE_FIELDS} } }
    }`, { team: teamKey });
  return data.issues.nodes.map(toIssue).filter((i) => isReviewLane(i.stateName, i.stateDescription));
}

/** Dashboard lane for one queued issue. LABELS ARE AUTHORITATIVE — they are what
 *  fetchQueue's skip-set actually acts on, so the lane must never disagree with
 *  whether the factory will pick the issue up. The state tag is consulted only
 *  when no factory label is present, which is precisely the "a human dragged the
 *  card into Blocked / Needs Human by hand" case: without this the card would
 *  render as plain `todo` while visibly sitting in a human-owned column. Pure so
 *  the mapping is testable without a network. */
export function queueLane(labels: readonly string[], stateDescription: string | null | undefined): Lane {
  if (labels.includes(PARKED_LABEL)) return "parked";
  if (labels.includes(NEEDS_HUMAN_LABEL)) return "needs_human";
  if (labels.includes(EXECUTING_LABEL)) return "claimed";
  const kind = taggedKind(stateDescription);
  if (kind === "blocked") return "parked";
  if (kind === "needs_human") return "needs_human";
  return "todo";
}

/** How many unstarted issues one queue poll reads. Server-side truncation, so it
 *  bounds the queue BEFORE the client-side skip-filter runs — see the starvation
 *  warning in fetchQueue. An in-code constant, never an env knob. */
const QUEUE_PAGE = 50;

/** Every label that holds an issue OUT of the claimable queue. This is BOTH the
 *  server-side `labels: { every: { name: { nin } } }` exclusion in fetchQueue's GraphQL filter
 *  AND the client-side skip-set (belt-and-braces) — one list, so the two can
 *  never disagree about what "held" means. */
export const HOLD_LABELS: readonly string[] = [
  EXECUTING_LABEL, PARKED_LABEL, NEEDS_HUMAN_LABEL, PLANNED_LABEL, STALE_LABEL, AWAITING_ANSWER_LABEL,
];

/** Queue = unstarted issues in watched teams, minus claimed/parked/needs-human, oldest first.
 *
 * TWO server-side pages in ONE request (issue #8 F1). WP3 moved Blocked /
 * Needs Human into unstarted-TYPE states, so a backlog of held issues used to
 * share the single `first: 50` unstarted page with real queue items and could
 * crowd fresh Todo tickets past the page boundary (label filtering only
 * happened client-side, AFTER server truncation). Now:
 *   - `queue`: unstarted MINUS hold labels, excluded SERVER-side
 *     (`labels: { every: { name: { nin: HOLD_LABELS } } }`) — held backlog can no
 *     NOTE the shape: Linear's IssueLabelCollectionFilter has NO `none` field
 *     (live 400, first live tick 2026-08-02 — the unit tests pin the query
 *     string, not Linear's acceptance of it). `every.nin` is the exclusion
 *     form Linear accepts, and its vacuous truth on unlabeled issues is
 *     load-bearing: a fresh unlabeled ticket must be eligible.
 *     longer crowd this page, however large it grows.
 *   - `held`: the complement (`labels: { some: ... }`), fetched ONLY so the
 *     queue_snapshot keeps rendering parked/needs-human cards on the dashboard
 *     board — the WP3 promise ("blocked/needs-human issues keep rendering...
 *     instead of vanishing") survives the filter split. Never claimable.
 * The client-side skip below stays as belt-and-braces: if the server-side
 * exclusion ever regresses (API change, filter typo), held issues still never
 * reach a claim — worst case is the old crowding, made LOUD by the warning. */
export async function fetchQueue(deps: LinearTransportDeps = defaultDeps): Promise<Issue[]> {
  const data = await gqlWith<{ queue: { nodes: RawIssue[] }; held: { nodes: RawIssue[] } }>(deps,
    `query($teams: [String!]!, $first: Int!, $hold: [String!]!) {
      queue: issues(first: $first, filter: {
        team: { key: { in: $teams } },
        state: { type: { eq: "unstarted" } },
        labels: { every: { name: { nin: $hold } } }
      }) { nodes { ${ISSUE_FIELDS} } }
      held: issues(first: $first, filter: {
        team: { key: { in: $teams } },
        state: { type: { eq: "unstarted" } },
        labels: { some: { name: { in: $hold } } }
      }) { nodes { ${ISSUE_FIELDS} } }
    }`,
    { teams: config.teamKeys, first: QUEUE_PAGE, hold: [...HOLD_LABELS] },
  );
  const queuePage = data.queue.nodes.map(toIssue);
  const heldPage = data.held.nodes.map(toIssue);
  // The two filters are disjoint by construction; the dedupe is defensive only
  // (an issue labelled between the two page evaluations server-side).
  const seen = new Set<string>();
  const all = [...queuePage, ...heldPage].filter((i) => !seen.has(i.id) && (seen.add(i.id), true));
  const skip = new Set(HOLD_LABELS);
  bus.emit({
    type: "queue_snapshot",
    issues: all.map((i) => ({
      id: i.id, identifier: i.identifier, title: i.title, url: i.url, teamKey: i.teamKey,
      stateName: i.stateName, stateType: i.stateType, labels: i.labels, createdAt: i.createdAt,
      lane: queueLane(i.labels, i.stateDescription),
    })),
  });
  const eligible = queuePage
    .filter((issue) => !issue.labels.some((l) => skip.has(l)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // FIFO regardless of server order (C21)
  // STARVATION WARNING (belt-and-braces alarm). With the server-side label
  // exclusion above, a full queue page whose issues ALL carry hold labels can
  // only mean the exclusion regressed — the client-side skip still protects
  // claims, but page crowding is back, so say so LOUDLY instead of letting the
  // queue look empty for no visible reason.
  if (queuePage.length >= QUEUE_PAGE && eligible.length === 0) {
    console.error(`[queue] the ${QUEUE_PAGE}-issue queue page is FULL and every issue in it is held (parked / needs-human / awaiting-answer / planned / stale) — the server-side label exclusion is not working; fresh Todo tickets past the page boundary are invisible to the daemon until some are cleared`);
  }
  return eligible;
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

// ---------------------------------------------------------------------------
// Epic DAG (dashboard). ONE GraphQL request serves the whole panel: the epic
// plus every child's description, whose start-anchored factory meta block
// carries depends_on/touches. Before this, the UI issued 1 + N /issue calls
// (N ≤ 40) every 30s refetch on the daemon's own API key — a single open tab
// on a 40-child epic burned ~4,900 requests/hour against Linear's ~1,500/hour
// budget and pushed the PIPELINE into rate-limit backoff. The meta parse now
// happens daemon-side through the AUTHORITATIVE meta.ts parser (the same one
// the scheduler uses), and raw descriptions never cross to the browser.
// ---------------------------------------------------------------------------

/** Children served per epic — a display cap, IN-CODE (CLAUDE.md: caps are
 *  constants, never env knobs). Matches the UI's previous MAX_CHILDREN. */
export const MAX_EPIC_DAG_CHILDREN = 40;

export interface EpicDagPayload {
  epic: { identifier: string; title: string };
  tickets: Array<{
    identifier: string; title: string; stateType: string; stateName: string;
    labels: string[]; dependsOn: string[]; touches: string[];
  }>;
}

interface RawEpicDagChild {
  identifier: string; title: string; description: string | null;
  state: { name: string; type?: string }; labels?: { nodes: Array<{ name: string }> };
}
export interface RawEpicDagIssue {
  identifier: string; title: string;
  children: { nodes: RawEpicDagChild[] };
}

/** Pure assembly of the wire payload from one GraphQL result — exported so
 *  tests pin the cap and the start-anchored meta discipline without a network. */
export function buildEpicDagPayload(issue: RawEpicDagIssue): EpicDagPayload {
  const tickets = issue.children.nodes.slice(0, MAX_EPIC_DAG_CHILDREN).map((c) => {
    // Authoritative parser (meta.ts): start-anchored, identifier-validated,
    // count/length-capped — a block buried in prose or injected content draws
    // no edges, exactly what the scheduler itself would honor.
    const meta = parseFactoryMeta(c.description ?? "");
    return {
      identifier: c.identifier,
      title: c.title,
      stateType: c.state.type ?? "",
      stateName: c.state.name,
      labels: (c.labels?.nodes ?? []).map((l) => l.name),
      dependsOn: meta.depends_on ?? [],
      touches: meta.touches ?? [],
    };
  });
  return { epic: { identifier: issue.identifier, title: issue.title }, tickets };
}

/** The epic + child meta for GET /epic-dag — exactly ONE Linear request. */
export async function getEpicDag(key: string): Promise<EpicDagPayload> {
  const data = await gql<{ issue: RawEpicDagIssue }>(
    `query($key: String!) { issue(id: $key) {
      identifier title
      children { nodes { identifier title description state { name type } labels { nodes { name } } } } } }`, { key });
  return buildEpicDagPayload(data.issue);
}

// ---------------------------------------------------------------------------
// Board stages (WP3).
//
// Linear offers exactly SIX state TYPES — backlog, unstarted, started,
// completed, canceled, triage — so pipeline position CANNOT come from the type
// alone: Todo, Blocked and Needs Human are all `unstarted`, and In Progress and
// In Review are both `started`. Distinguishing them needs a second anchor, and
// a state NAME is human-editable (someone renames a column and the daemon
// silently starts driving the wrong one). So every factory-owned state carries
// an immutable tag in its DESCRIPTION: `[factory:queue]`, `[factory:blocked]`,
// `[factory:needs_human]`, `[factory:working]`, `[factory:review]`,
// `[factory:done]`. scripts/board-setup.ts is what puts them there.
//
// C13/M4 IS PRESERVED VERBATIM: the state TYPE is still the outer filter, and a
// tag is only ever honoured INSIDE the correct type. No human-editable string
// can move an issue across a type boundary — the worst a wrong/forged tag can
// do is pick a different column of the RIGHT type. Untagged boards degrade to
// exactly the pre-WP3 name+position heuristics (see resolveBoardStates).
//
// Blocked and Needs Human are deliberately `unstarted`, NOT `started`:
//   * fetchQueue filters on `type == unstarted`, so an issue parked into a
//     started-type "Needs Human" would be unreachable and "remove the label to
//     requeue" (the promise in every park/needs-human comment) would be a lie.
//     Unstarted + the existing label skip-set keeps requeue a SINGLE reversible
//     edit, exactly how Factory-Parked already works.
//   * queue_snapshot is built from the same unstarted fetch and derives its
//     lanes from labels, so blocked/needs-human issues keep rendering on the
//     dashboard board instead of vanishing from it.
// The LABEL, never the state, is what holds an issue out of the queue.

export type StateKind = "queue" | "blocked" | "needs_human" | "working" | "review" | "done";

/** Kinds the pipeline cannot run without — resolveBoardStates always returns a
 *  state for these when the team has ANY state of the matching type. */
export const REQUIRED_STATE_KINDS = ["queue", "working", "review", "done"] as const;
/** Kinds that are a board UPGRADE, not a requirement. Absent (board-setup never
 *  run, state deleted, tag stripped) → transition() degrades to "queue", which
 *  is precisely the pre-WP3 behaviour. */
export const OPTIONAL_STATE_KINDS = ["blocked", "needs_human"] as const;

/** The immutable description tag for each kind. Lower-case; matched
 *  case-insensitively so a human re-capitalising the line cannot break it. */
export const STATE_TAG: Record<StateKind, string> = {
  queue: "[factory:queue]",
  blocked: "[factory:blocked]",
  needs_human: "[factory:needs_human]",
  working: "[factory:working]",
  review: "[factory:review]",
  done: "[factory:done]",
};

/** The Linear state TYPE each kind must live in — the outer filter that keeps
 *  the by-TYPE hardening (C13/M4) intact. */
export const STATE_TYPE: Record<StateKind, string> = {
  queue: "unstarted", blocked: "unstarted", needs_human: "unstarted",
  working: "started", review: "started", done: "completed",
};

/** Canonical column names. Used only BELOW the tag: as a name tiebreak for the
 *  required kinds (pre-WP3 behaviour), and — for the optional kinds — to RESERVE
 *  a hand-made "Blocked"/"Needs Human" column even when it carries no tag. */
export const STATE_NAME: Record<StateKind, string> = {
  queue: "Todo", blocked: "Blocked", needs_human: "Needs Human",
  working: "In Progress", review: "In Review", done: "Done",
};

/** One workflow state as the board resolver sees it. */
export interface TeamState {
  id: string;
  name: string;
  type: string;
  position: number;
  description?: string | null;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** The kind a state description CLAIMS, or null when it carries no factory tag.
 *  First tag wins (a description with two tags is a board-setup bug that
 *  scripts/board-setup.ts reports; it must still resolve deterministically). */
export function taggedKind(description: string | null | undefined): StateKind | null {
  const d = norm(description ?? "");
  if (d === "") return null;
  for (const kind of Object.keys(STATE_TAG) as StateKind[]) {
    if (d.includes(STATE_TAG[kind])) return kind;
  }
  return null;
}

/** Is this state the REVIEW lane (PR open, waiting on a human)? Tag first — so
 *  renaming "In Review" to "Awaiting merge" cannot silently break reconcile's
 *  merge→Done link — with the pre-WP3 name regex as the fallback for untagged
 *  boards. A state that carries a DIFFERENT factory tag is authoritatively not
 *  the review lane, whatever it is called. Pure so reconcile.ts, steward.ts and
 *  fetchTeamInReview cannot drift apart. */
export function isReviewLane(stateName: string, stateDescription: string | null | undefined = ""): boolean {
  const kind = taggedKind(stateDescription);
  if (kind !== null) return kind === "review";
  return /review/i.test(stateName);
}

/**
 * Pure, I/O-free board resolution: one team's raw state list → the state each
 * kind maps to (null = the board has no state of that kind).
 *
 * Precedence per kind, all of it INSIDE the kind's required type:
 *   1. the `[factory:<kind>]` description tag (rename-proof),
 *   2. the canonical name (`review` keeps its historical /review/i match),
 *   3. position: first state of the type, except `review` which takes the last
 *      — byte-for-byte the pre-WP3 fallbacks.
 *
 * RESERVED-SET EXCLUSION. With three unstarted states, `queue`'s positional
 * fallback ("any unstarted state") can now land on Blocked or Needs Human if
 * "Todo" is ever renamed or untagged — which would make the factory claim work
 * straight out of the two human-owned columns. So the OPTIONAL kinds resolve
 * FIRST and their ids are subtracted from every required kind's candidate set.
 * This is why the optional lookup also matches on name: a hand-made, untagged
 * "Blocked" column must be reserved even though it is not authoritative enough
 * to be transitioned INTO.
 *
 * The subtraction relaxes only in the degenerate case where it would leave a
 * required kind with no candidate at all (a board whose ONLY unstarted state is
 * Blocked). Reachable-but-odd beats unreachable, and it is exactly what the
 * pre-WP3 code did.
 */
export function resolveBoardStates(raw: readonly TeamState[]): Record<StateKind, TeamState | null> {
  const states = [...raw].sort((a, b) => a.position - b.position);
  const ofType = (kind: StateKind): TeamState[] => states.filter((s) => s.type === STATE_TYPE[kind]);
  const result = {} as Record<StateKind, TeamState | null>;
  const reserved = new Set<string>();

  for (const kind of OPTIONAL_STATE_KINDS) {
    const pool = ofType(kind).filter((s) => !reserved.has(s.id));
    const found = pool.find((s) => taggedKind(s.description) === kind)
      ?? pool.find((s) => norm(s.name) === norm(STATE_NAME[kind]))
      ?? null;
    result[kind] = found;
    if (found) reserved.add(found.id);
  }

  const nameAnchor = (kind: StateKind, s: TeamState): boolean =>
    kind === "review" ? /review/i.test(s.name) : norm(s.name) === norm(STATE_NAME[kind]);
  const positional = (kind: StateKind, pool: TeamState[]): TeamState | null =>
    (kind === "review" ? pool[pool.length - 1] : pool[0]) ?? null;
  const pick = (kind: StateKind, pool: TeamState[]): TeamState | null =>
    pool.find((s) => taggedKind(s.description) === kind)
    ?? pool.find((s) => nameAnchor(kind, s))
    ?? positional(kind, pool);

  for (const kind of REQUIRED_STATE_KINDS) {
    const all = ofType(kind);
    result[kind] = pick(kind, all.filter((s) => !reserved.has(s.id))) ?? pick(kind, all);
  }
  return result;
}

/** Fetch + resolve one team's whole board (via an issue, which is the only
 *  handle most callers have). One query, all six kinds. */
async function boardStatesForIssue(issue: Issue): Promise<Record<StateKind, TeamState | null>> {
  const data = await gql<{ issue: { team: { states: { nodes: TeamState[] } } } }>(
    `query($id: String!) { issue(id: $id) { team { states { nodes { id name type position description } } } } }`,
    { id: issue.id });
  return resolveBoardStates(data.issue.team.states.nodes);
}

/** Resolve a team state by TYPE with tag/name as tiebreaks only (C13/M4). */
async function resolveState(issue: Issue, kind: StateKind): Promise<TeamState | null> {
  return (await boardStatesForIssue(issue))[kind];
}

/**
 * Which state a transition to `kind` must actually target. Pure, so the degrade
 * path is testable without a network.
 *
 * DEGRADE SAFELY. When one of the two OPTIONAL columns is unreachable — the
 * board was never upgraded (scripts/board-setup.ts not run), the column was
 * renamed AND untagged, or a human deleted it — fall back to the QUEUE state.
 * That is byte-for-byte the pre-WP3 behaviour for a park, and it keeps "remove
 * the label to requeue" true, because the LABEL (never the state) is what holds
 * an issue out of fetchQueue. Required kinds never degrade: a missing one is a
 * genuine "this team has no state of that type", which the caller must see as
 * `false` exactly as before.
 *
 * TAG-ANCHORED for the optional kinds (issue #8 F5). The transition target for
 * Blocked / Needs Human is unified on the `[factory:<kind>]` description tag —
 * the SAME anchor resolveBoardStates trusts first — so a renamed-but-tagged
 * column stays a first-class target (the rename never mattered to reads, and
 * now provably never matters to writes either). A NAME-ONLY match is the read
 * side's reservation trick: it keeps a hand-made, untagged "Blocked" column
 * out of the queue lane, but that column belongs to a human and is not
 * authoritative enough to be transitioned INTO — parking degrades to the queue
 * state exactly as if the column were absent. Required kinds keep their
 * name/position fallbacks verbatim: those ARE the pre-WP3 contract.
 */
export function transitionTarget(
  board: Readonly<Record<StateKind, TeamState | null>>,
  kind: StateKind,
): { state: TeamState; degradedFrom: StateKind | null } | null {
  const direct = board[kind];
  const optional = kind === "blocked" || kind === "needs_human";
  if (direct && (!optional || taggedKind(direct.description) === kind)) {
    return { state: direct, degradedFrom: null };
  }
  if (!optional) return null;
  const fallback = board.queue;
  return fallback ? { state: fallback, degradedFrom: kind } : null;
}

export async function transition(issue: Issue, kind: StateKind): Promise<boolean> {
  const target = transitionTarget(await boardStatesForIssue(issue), kind);
  if (!target) return false;
  if (target.degradedFrom !== null) {
    console.log(`[${issue.identifier}] team ${issue.teamKey} has no "${STATE_NAME[target.degradedFrom]}" state — using "${target.state.name}" instead (run \`bun run board:setup\` to add it)`);
  }
  await gql(`mutation($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`, { id: issue.id, stateId: target.state.id });
  return true;
}

/** The one post-MERGE ticket transition, shared so the auto-merge path
 * (loop.ts) and the approvals inbox's human merge (approvals.ts) cannot drift:
 * a merged change moves to done; a team without a completed-type state falls
 * back to review (best-effort) so the ticket at least leaves the working lane. */
export async function transitionAfterMerge(issue: Issue): Promise<void> {
  const moved = await transition(issue, "done");
  if (!moved) await transition(issue, "review").catch(() => {});
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
  const data = await gql<{ teams: { nodes: Array<{ id: string; states: { nodes: TeamState[] } }> } }>(
    `query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) {
       nodes { id states { nodes { id name type position description } } } } }`, { key: teamKey });
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`no Linear team with key ${teamKey}`);
  // ONE resolver, shared with resolveState(kind:"queue") — this used to be a
  // hand-copied duplicate of the old "unstarted/Todo else any unstarted" rule,
  // which is exactly the fallback that can now land on Blocked / Needs Human.
  // Going through resolveBoardStates means the reserved-set exclusion applies
  // here too, so a filed ticket can never be created straight into a
  // human-owned column (issueCreate's own default is Backlog, which fetchQueue
  // deliberately never reads).
  const queue = resolveBoardStates(team.states.nodes).queue;
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
