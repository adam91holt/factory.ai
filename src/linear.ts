import { config } from "./config.ts";
import { bus } from "./events.ts";

// Linear GraphQL client. Personal API keys: raw key as Authorization (no
// "Bearer"). Hardened per code-review verdict 2026-07-20: HTTP status checks +
// rate-limit tagging (C25), state resolution by TYPE not name (C13/M4), claim
// rollback on partial failure (C8), park/needs-human labels filtered from the
// queue (C6), oldest-first ordering client-side (C21).

const ENDPOINT = "https://api.linear.app/graphql";
export const EXECUTING_LABEL = "Factory-Executing";
export const PARKED_LABEL = "Factory-Parked";
export const NEEDS_HUMAN_LABEL = "Factory-Needs-Human";
export const EPIC_LABEL = "Factory-Epic";
export const PLANNED_LABEL = "Factory-Planned";
export const STEWARDED_LABEL = "Factory-Stewarded";
export const SENTINEL = "🤖 **Factory report**";

export class LinearRateLimited extends Error {
  constructor(status: number) { super(`Linear rate-limited/unavailable (HTTP ${status})`); }
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: config.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429 || res.status >= 500) throw new LinearRateLimited(res.status);
  if (!res.ok) throw new Error(`Linear HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const payload = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (payload.errors?.length) throw new Error(`Linear: ${payload.errors.map((e) => e.message).join("; ")}`);
  if (!payload.data) throw new Error("Linear: empty response");
  return payload.data;
}

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

/** Issues in watched teams carrying a label (any state). */
export async function fetchByLabel(label: string): Promise<Issue[]> {
  const data = await gql<{ issues: { nodes: RawIssue[] } }>(
    `query($teams: [String!]!, $label: String!) {
      issues(first: 25, filter: { team: { key: { in: $teams } }, labels: { name: { eq: $label } } }) { nodes { ${ISSUE_FIELDS} } }
    }`, { teams: config.teamKeys, label });
  return data.issues.nodes.map(toIssue);
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
  const skip = new Set([EXECUTING_LABEL, PARKED_LABEL, NEEDS_HUMAN_LABEL, PLANNED_LABEL]);
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

export type StateKind = "queue" | "working" | "review";

/** Resolve a team state by TYPE with name as tiebreak only (C13/M4). */
async function resolveState(issue: Issue, kind: StateKind): Promise<{ id: string; name: string } | null> {
  const data = await gql<{ issue: { team: { states: { nodes: Array<{ id: string; name: string; type: string; position: number }> } } } }>(
    `query($id: String!) { issue(id: $id) { team { states { nodes { id name type position } } } } }`, { id: issue.id });
  const states = data.issue.team.states.nodes;
  if (kind === "queue") {
    return states.find((s) => s.type === "unstarted" && s.name === "Todo")
      ?? states.find((s) => s.type === "unstarted") ?? null;
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

export async function postComment(issue: Issue, body: string): Promise<void> {
  await gql(`mutation($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success } }`, { issueId: issue.id, body });
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

export async function release(issue: Issue): Promise<void> {
  await removeLabel(issue, EXECUTING_LABEL).catch(() => {});
}
