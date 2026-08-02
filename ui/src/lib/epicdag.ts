import { isMockMode } from "./fixtures";

// ---------------------------------------------------------------------------
// Epic DAG view — pure, client-side scheduling mirror.
//
// The daemon's real scheduler lives in src/dag.ts (+ src/index.ts's tick) and
// stays the single AUTHORITY: nothing here decides anything. This module
// re-derives, for DISPLAY, the same frontier/mutex classification from data
// the dashboard already has:
//   • GET /issue?key=<epic>  → the epic's children (identifier/title/state);
//   • GET /issue?key=<child> → each child's description, whose START-ANCHORED
//     factory meta block carries depends_on + touches (src/meta.ts);
//   • MissionState           → in-flight runs + wipLimit (live from /state+SSE).
// The overlap test is the SAME conservative approximation as src/dag.ts
// (duplicated by design, like the events shared block): biased toward
// "overlap", because under-reporting a serialisation the daemon WILL apply
// would make the view lie.
//
// No graph library: layout is a longest-path layering computed here and drawn
// as plain SVG by DagView.tsx.
// ---------------------------------------------------------------------------

export type DagLane = "ready" | "deferred" | "in-flight" | "blocked" | "needs-human" | "done";

export interface DagTicket {
  identifier: string;
  title: string;
  /** Linear state TYPE ("unstarted" | "started" | "completed" | "canceled" | …). */
  stateType: string;
  stateName: string;
  labels: string[];
  dependsOn: string[];
  touches: string[];
}

export interface DagNode extends DagTicket {
  lane: DagLane;
  /** WHY a not-running node is not running (unmet dep / WIP / touches / drain);
   *  null for in-flight, done and plain-ready nodes. */
  reason: string | null;
  /** Topological column (longest dep path from a root). */
  layer: number;
  /** Row inside the column (stable ticket order). */
  row: number;
}

export interface DagEdge {
  from: string;
  to: string;
  /** "dep" = declared depends_on (a real dependency). "mutex" = touches-overlap
   *  serialisation — a SCHEDULING CONSTRAINT, not a dependency; rendered in a
   *  visually distinct style. */
  kind: "dep" | "mutex";
  /** For mutex edges: the overlapping glob pair ("src/a/** ∩ src/a/b.ts"). */
  overlap?: string;
}

export interface DagContext {
  /** issueKeys with an ACTIVE run in MissionState. */
  inFlightKeys: string[];
  /** daemon wipLimit, or null when no daemon_started has been seen. */
  wipLimit: number | null;
  /** count of active runs across the whole factory (WIP is global, not per-epic). */
  activeRunCount: number;
  draining: boolean;
  drainReason?: string | null;
}

export interface DagView {
  nodes: DagNode[];
  edges: DagEdge[];
  layerCount: number;
  maxRows: number;
}

// ---------------------------------------------------------------------------
// Meta parsing — the display-side subset of src/meta.ts parseFactoryMeta.
// START-ANCHORED like the authoritative parser: a block buried in prose (or in
// pasted/injected content) is ignored, so the graph can only show edges the
// daemon itself would honor. Malformed identifiers are dropped; both arrays
// are capped (same constants as meta.ts).
// ---------------------------------------------------------------------------

const BLOCK = /^\s*<!--\s*factory\b([\s\S]*?)-->/i;
const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;
const MAX_ARRAY_ENTRIES = 32;
const MAX_ENTRY_LENGTH = 200;

export function parseDagMeta(description: string): { dependsOn: string[]; touches: string[] } {
  const block = description.match(BLOCK);
  const out = { dependsOn: [] as string[], touches: [] as string[] };
  if (!block?.[1]) return out;
  for (const line of block[1].split("\n")) {
    const kv = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    if (key === "depends_on") {
      out.dependsOn = value.split(",").map((s) => s.trim()).filter((s) => IDENTIFIER.test(s)).slice(0, MAX_ARRAY_ENTRIES);
    } else if (key === "touches") {
      out.touches = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= MAX_ENTRY_LENGTH).slice(0, MAX_ARRAY_ENTRIES);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Glob overlap — the same conservative approximation as src/dag.ts. When
// unsure, overlap (over-serialising in the VIEW only ever over-explains).
// ---------------------------------------------------------------------------

const WILDCARD = /[*?[{]/;

export function staticPrefix(glob: string): string {
  const m = glob.match(WILDCARD);
  return m ? glob.slice(0, m.index) : glob;
}

function isPathPrefix(short: string, long: string): boolean {
  if (short === "") return true;
  if (!long.startsWith(short)) return false;
  if (short.length === long.length) return true;
  return short.endsWith("/") || long[short.length] === "/";
}

export function globsOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      const px = staticPrefix(x);
      const py = staticPrefix(y);
      if (isPathPrefix(px, py) || isPathPrefix(py, px)) return true;
    }
  }
  return false;
}

/** First overlapping glob pair, for the reason/edge label. */
function overlapPair(a: string[], b: string[]): string {
  for (const x of a) {
    for (const y of b) {
      if (globsOverlap([x], [y])) return `${x} ∩ ${y}`;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Classification + layout.
// ---------------------------------------------------------------------------

const EXECUTING_LABEL = "Factory-Executing";
const NEEDS_HUMAN_LABEL = "Factory-Needs-Human";
const PARKED_LABEL = "Factory-Parked";

/** TEAM-123 → 123; unparseable sorts last (mirrors src/dag.ts ticketNumber). */
function ticketNumber(identifier: string): number {
  const m = identifier.match(/-(\d+)$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function isTerminal(stateType: string | undefined): boolean {
  return stateType === "completed" || stateType === "canceled";
}

export function buildEpicDag(tickets: DagTicket[], ctx: DagContext): DagView {
  const byId = new Map(tickets.map((t) => [t.identifier, t]));
  const inFlight = new Set(ctx.inFlightKeys);

  // ---- base lanes (everything except the ready/deferred split) -------------
  const lanes = new Map<string, DagLane>();
  const reasons = new Map<string, string | null>();
  for (const t of tickets) {
    if (isTerminal(t.stateType)) {
      lanes.set(t.identifier, "done");
      reasons.set(t.identifier, null);
    } else if (t.labels.includes(NEEDS_HUMAN_LABEL) || t.labels.includes(PARKED_LABEL)) {
      lanes.set(t.identifier, "needs-human");
      reasons.set(t.identifier, t.labels.includes(PARKED_LABEL) ? "parked — see ticket for the park reason" : "escalated to a human");
    } else if (inFlight.has(t.identifier) || t.labels.includes(EXECUTING_LABEL) || t.stateType === "started") {
      lanes.set(t.identifier, "in-flight");
      reasons.set(t.identifier, null);
    }
  }

  // ---- frontier: every dep must be terminal; unknown deps BLOCK (fail-closed,
  // exactly like the daemon's selectRunnable treating undefined as blocking) --
  const unclassified = tickets.filter((t) => !lanes.has(t.identifier));
  const ready: DagTicket[] = [];
  for (const t of unclassified) {
    const unmet = t.dependsOn.filter((dep) => !isTerminal(byId.get(dep)?.stateType));
    if (unmet.length > 0) {
      lanes.set(t.identifier, "blocked");
      const parts = unmet.map((dep) => {
        const d = byId.get(dep);
        return d ? `${dep} (${d.stateName})` : `${dep} (not in this epic — treated as blocking)`;
      });
      reasons.set(t.identifier, `unmet dependency: ${parts.join(", ")}`);
    } else {
      ready.push(t);
    }
  }

  // ---- deferred vs ready: simulate one admission tick the way selectRunnable
  // does — FIFO in ticket order, mutex set accumulating admitted touches ------
  ready.sort((a, b) => ticketNumber(a.identifier) - ticketNumber(b.identifier) || a.identifier.localeCompare(b.identifier));
  const busy: Array<{ key: string; touches: string[] }> = tickets
    .filter((t) => lanes.get(t.identifier) === "in-flight" && t.touches.length > 0)
    .map((t) => ({ key: t.identifier, touches: t.touches }));
  const capacity = ctx.draining
    ? 0
    : ctx.wipLimit === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, ctx.wipLimit - ctx.activeRunCount);
  let admitted = 0;
  for (const t of ready) {
    const collision = t.touches.length > 0
      ? busy.find((b) => globsOverlap(t.touches, b.touches))
      : undefined;
    if (collision) {
      lanes.set(t.identifier, "deferred");
      reasons.set(t.identifier, `touches overlap with ${collision.key} (${overlapPair(t.touches, collision.touches)}) — serialised, not dependent`);
      continue;
    }
    if (ctx.draining) {
      lanes.set(t.identifier, "deferred");
      reasons.set(t.identifier, ctx.drainReason
        ? `drain mode — not claiming new work (${ctx.drainReason})`
        : "drain mode — daemon is not claiming new work");
      continue;
    }
    if (admitted >= capacity) {
      lanes.set(t.identifier, "deferred");
      reasons.set(t.identifier, `WIP limit reached (${ctx.activeRunCount}/${ctx.wipLimit} in flight)`);
      continue;
    }
    lanes.set(t.identifier, "ready");
    reasons.set(t.identifier, null);
    admitted += 1;
    busy.push({ key: t.identifier, touches: t.touches });
  }

  // ---- edges ---------------------------------------------------------------
  const edges: DagEdge[] = [];
  const depAdj = new Map<string, string[]>(); // child → its deps (within the set)
  for (const t of tickets) {
    const deps = t.dependsOn.filter((d) => byId.has(d));
    depAdj.set(t.identifier, deps);
    for (const dep of deps) edges.push({ from: dep, to: t.identifier, kind: "dep" });
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of depAdj.get(cur) ?? []) stack.push(d);
    }
    return false;
  };
  // Mutex edges: sibling pairs whose touches overlap and that are NOT already
  // ordered by a dependency path in either direction. Drawn earlier → later
  // (the order the daemon's implicit-dep derivation would impose), styled as a
  // constraint, never an arrowed dependency.
  const order = [...tickets].sort((a, b) => ticketNumber(a.identifier) - ticketNumber(b.identifier) || a.identifier.localeCompare(b.identifier));
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i]!;
      const b = order[j]!;
      if (a.touches.length === 0 || b.touches.length === 0) continue;
      if (!globsOverlap(a.touches, b.touches)) continue;
      if (reaches(a.identifier, b.identifier) || reaches(b.identifier, a.identifier)) continue;
      edges.push({ from: a.identifier, to: b.identifier, kind: "mutex", overlap: overlapPair(a.touches, b.touches) });
    }
  }

  // ---- layout: longest-path layering over DEP edges only (mutex edges are
  // constraints, not order) — cycle-safe (a cycle falls back to layer 0) ------
  const layerMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const memo = layerMemo.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return 0; // cycle guard — mirror the daemon's fail-open
    visiting.add(id);
    const deps = depAdj.get(id) ?? [];
    const layer = deps.length === 0 ? 0 : Math.max(...deps.map((d) => layerOf(d) + 1));
    visiting.delete(id);
    layerMemo.set(id, layer);
    return layer;
  };

  const rowCounters = new Map<number, number>();
  const nodes: DagNode[] = order.map((t) => {
    const layer = layerOf(t.identifier);
    const row = rowCounters.get(layer) ?? 0;
    rowCounters.set(layer, row + 1);
    return {
      ...t,
      lane: lanes.get(t.identifier) ?? "ready",
      reason: reasons.get(t.identifier) ?? null,
      layer,
      row,
    };
  });

  return {
    nodes,
    edges,
    layerCount: nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.layer)) + 1,
    maxRows: nodes.length === 0 ? 0 : Math.max(...[...rowCounters.values()]),
  };
}

// ---------------------------------------------------------------------------
// Fetch: assemble DagTickets for one epic from GET /issue (the epic's children,
// then each child's description for its meta block). Read-only, loopback.
// ---------------------------------------------------------------------------

interface WireIssueDetail {
  identifier: string;
  title: string;
  description: string;
  stateName: string;
  labels: string[];
  children: Array<{ identifier: string; title: string; stateName: string; stateType?: string; labels?: string[] }>;
}

/** Children fetched per epic — a display cap, not a scheduling one. */
const MAX_CHILDREN = 40;

async function fetchIssue(key: string): Promise<WireIssueDetail> {
  const res = await fetch(`/issue?key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`GET /issue?key=${key} → ${res.status}`);
  return (await res.json()) as WireIssueDetail;
}

export async function fetchEpicDag(epicKey: string): Promise<{ epic: { identifier: string; title: string }; tickets: DagTicket[] }> {
  if (isMockMode()) return mockEpicDag();
  const epic = await fetchIssue(epicKey);
  const children = epic.children.slice(0, MAX_CHILDREN);
  const tickets = await Promise.all(children.map(async (c) => {
    let meta = { dependsOn: [] as string[], touches: [] as string[] };
    try {
      meta = parseDagMeta((await fetchIssue(c.identifier)).description);
    } catch {
      // A child whose detail read fails still renders as a node — just with no
      // declared edges (the daemon would fail closed; the VIEW degrades open
      // because it decides nothing).
    }
    return {
      identifier: c.identifier,
      title: c.title,
      stateType: c.stateType ?? "",
      stateName: c.stateName,
      labels: c.labels ?? [],
      dependsOn: meta.dependsOn,
      touches: meta.touches,
    };
  }));
  return { epic: { identifier: epic.identifier, title: epic.title }, tickets };
}

// ---------------------------------------------------------------------------
// Mock fixture (?mock=1): one epic exercising every lane and both edge kinds.
// ---------------------------------------------------------------------------

function mockEpicDag(): { epic: { identifier: string; title: string }; tickets: DagTicket[] } {
  return {
    epic: { identifier: "FAC-30", title: "Portal invoicing epic" },
    tickets: [
      { identifier: "FAC-31", title: "Schema: invoices + line items tables", stateType: "completed", stateName: "Done", labels: [], dependsOn: [], touches: ["src/db/schema.ts"] },
      { identifier: "FAC-32", title: "API: invoice CRUD endpoints", stateType: "started", stateName: "In Progress", labels: ["Factory-Executing"], dependsOn: ["FAC-31"], touches: ["src/routes/invoices.ts", "src/db/queries/**"] },
      { identifier: "FAC-33", title: "API: invoice PDF rendering", stateType: "unstarted", stateName: "Todo", labels: [], dependsOn: ["FAC-31"], touches: ["src/db/queries/**", "src/pdf/**"] },
      { identifier: "FAC-34", title: "Portal: invoice list + detail views", stateType: "unstarted", stateName: "Todo", labels: [], dependsOn: ["FAC-32"], touches: ["ui/src/pages/**"] },
      { identifier: "FAC-35", title: "Portal: export & email flows", stateType: "unstarted", stateName: "Todo", labels: ["Factory-Needs-Human"], dependsOn: ["FAC-33", "FAC-34"], touches: ["ui/src/pages/**"] },
      { identifier: "FAC-36", title: "Docs: invoicing runbook", stateType: "unstarted", stateName: "Todo", labels: [], dependsOn: [], touches: ["docs/invoicing.md"] },
    ],
  };
}

/** The mock DagContext the page uses in ?mock=1 (wipLimit 2, one active run —
 *  so FAC-36 is ready and the touches collision on FAC-33 shows as deferred). */
export function mockDagContext(): DagContext {
  return { inFlightKeys: ["FAC-32"], wipLimit: 2, activeRunCount: 1, draining: false, drainReason: null };
}
