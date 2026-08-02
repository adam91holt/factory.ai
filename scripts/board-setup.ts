#!/usr/bin/env bun
/**
 * scripts/board-setup.ts — bring a Linear team's workflow states in line with the
 * factory board contract (WP3). DRY-RUN BY DEFAULT.
 *
 *   bun run board:setup                 # dry run against every watched team
 *   bun run board:setup -- --team=FAC   # dry run, one team
 *   bun run board:setup -- --apply      # actually mutate (owner runs this)
 *   bun run board:setup -- --apply --no-reorder   # create/tag only, never move columns
 *
 * WHAT IT DOES
 *   1. CREATE the two new human-owned columns when they are missing:
 *        Blocked      (unstarted) — paused, retryable; the factory will resume
 *        Needs Human  (unstarted) — the factory STOPPED; a human must act
 *      Both are deliberately `unstarted`, the same TYPE as Todo, because
 *      fetchQueue filters on `unstarted` and the Factory-* LABEL — never the
 *      state — is what holds an issue out of the queue. That keeps requeue a
 *      single reversible edit (remove the label) and keeps the issues visible on
 *      the dashboard board. See the "Board stages" block in src/linear.ts.
 *   2. TAG every factory-owned column with its immutable `[factory:<kind>]`
 *      marker in the state DESCRIPTION, so the daemon keeps resolving the right
 *      column after a human renames one. Existing description text is preserved;
 *      the tag is appended on its own line.
 *   3. Optionally REORDER the columns so the board reads in pipeline order
 *      (Backlog → Todo → Blocked → Needs Human → In Progress → In Review → Done
 *      → Canceled → …). Skip with --no-reorder.
 *
 * WHAT IT NEVER DOES
 *   - It NEVER deletes or archives a workflow state. There is no delete mutation
 *     anywhere in this file, so "never delete a state that has issues in it" holds
 *     by construction rather than by a check that could be edited away later. The
 *     plan output reports every unmanaged state and whether it currently holds
 *     issues, so the owner can decide about them by hand.
 *   - It NEVER changes a state's TYPE (Linear's WorkflowStateUpdateInput cannot,
 *     and a type change would silently move issues between the daemon's lanes).
 *     A column whose type disagrees with the contract is reported as a CONFLICT
 *     and left untouched.
 *   - It NEVER renames an existing column. If the team calls its queue "Ready",
 *     the script adopts and tags "Ready" rather than imposing "Todo".
 *   - It NEVER strips a tag. Duplicate/inert tags are reported for a human.
 *
 * IDEMPOTENT: a second run against an aligned board plans zero changes.
 */

import {
  ConnectionHealth, gqlWith, resolveBoardStates, taggedKind,
  STATE_NAME, STATE_TAG, STATE_TYPE,
  type StateKind, type TeamState,
} from "../src/linear.ts";
import { config } from "../src/config.ts";

const deps = { fetchImpl: (url: string, init: RequestInit) => fetch(url, init), health: new ConnectionHealth() };
const gql = <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => gqlWith<T>(deps, query, variables);

// ---------------------------------------------------------------------------
// The contract. `color` and `name` apply to CREATE only — an existing column is
// adopted as-is (tagged, never renamed, never recoloured), because the operator's
// board is the source of truth for what a column is CALLED and the tag is the
// source of truth for what it MEANS.
// ---------------------------------------------------------------------------

interface KindSpec { kind: StateKind; color: string; blurb: string }

const BOARD: readonly KindSpec[] = [
  { kind: "queue", color: "#e2e2e2",
    blurb: "The factory queue — the daemon claims the oldest eligible ticket here." },
  { kind: "blocked", color: "#f2994a",
    blurb: "Paused, retryable: a budget/wall-clock cap, a dependency or gate failure, a failed plan/bootstrap, or intake waiting on an answer. The worktree is kept. Remove the Factory-Parked / Factory-Awaiting-Answer label to requeue." },
  { kind: "needs_human", color: "#eb5757",
    // Kept under Linear's 255-char state-description cap INCLUDING the tag
    // (see describe()): the original longer blurb drew a bare "Argument
    // Validation Error" on workflowStateCreate, 2026-08-02.
    blurb: "The factory STOPPED: guarded paths, taste/security/verification fail, test-count drop, merge-integrity refusal, or contract breach. Remove the Factory-Needs-Human label to requeue." },
  { kind: "working", color: "#f2c94c",
    blurb: "Claimed — the factory is running the pipeline in a worktree." },
  { kind: "review", color: "#0f783c",
    blurb: "PR is open and waiting on a human merge (or on the merge ladder)." },
  { kind: "done", color: "#5e6ad2",
    blurb: "Merged, closed out, or resolved as already-satisfied." },
];

/** Column ordering, coarse to fine. Factory kinds are placed by kind; every other
 *  state keeps its relative order within its type bucket. */
const TYPE_ORDER = ["backlog", "unstarted", "started", "completed", "canceled", "duplicate", "triage"];

// Linear caps a workflow-state description at 255 chars and rejects longer
// with a bare "Argument Validation Error" (measured: 243 chars created fine,
// ~267 failed). Truncate the BLURB, never the tag — the tag is what
// resolveBoardStates anchors on, so it must always survive intact.
const LINEAR_STATE_DESCRIPTION_MAX = 255;
const describe = (spec: KindSpec): string => {
  const tag = STATE_TAG[spec.kind];
  const room = LINEAR_STATE_DESCRIPTION_MAX - tag.length - 2; // "\n\n"
  const blurb = spec.blurb.length > room ? `${spec.blurb.slice(0, room - 1)}…` : spec.blurb;
  return `${blurb}\n\n${tag}`;
};

/** Append the tag to an existing description without disturbing what is there. */
function withTag(existing: string | null | undefined, kind: StateKind): string {
  const base = (existing ?? "").trim();
  return base === "" ? STATE_TAG[kind] : `${base}\n\n${STATE_TAG[kind]}`;
}

// ---------------------------------------------------------------------------
// Plan (pure): current states → the exact list of mutations. No I/O, so the
// dry-run print and the --apply execution are driven by the SAME object and can
// never disagree about what is about to happen.
// ---------------------------------------------------------------------------

interface RawState extends TeamState { color?: string; hasIssues?: boolean }

type Change =
  | { op: "create"; kind: StateKind; name: string; type: string; color: string; description: string; position: number }
  | { op: "tag"; kind: StateKind; state: RawState; description: string }
  | { op: "move"; state: RawState; from: number; to: number };

interface Plan {
  changes: Change[];
  /** Already correct — printed so a re-run visibly proves idempotency. */
  aligned: Array<{ kind: StateKind; state: RawState }>;
  /** Cannot be fixed automatically; reported for a human. */
  conflicts: string[];
  /** States the script does not manage. Never touched except for ordering. */
  unmanaged: RawState[];
}

export function planBoard(states: readonly RawState[], opts: { reorder: boolean }): Plan {
  const resolved = resolveBoardStates(states);
  const changes: Change[] = [];
  const aligned: Plan["aligned"] = [];
  const conflicts: string[] = [];
  const claimed = new Map<StateKind, RawState>();

  // --- tag hygiene over the WHOLE board, before deciding anything.
  const tagOwners = new Map<StateKind, RawState[]>();
  for (const s of states) {
    const k = taggedKind(s.description);
    if (k === null) continue;
    tagOwners.set(k, [...(tagOwners.get(k) ?? []), s]);
    if (s.type !== STATE_TYPE[k]) {
      conflicts.push(`"${s.name}" is type ${s.type} but carries ${STATE_TAG[k]}, which only ever resolves inside type ${STATE_TYPE[k]} — the tag is INERT. Move the tag to the right column by hand.`);
    }
  }
  for (const [kind, owners] of tagOwners) {
    if (owners.length > 1) {
      conflicts.push(`${STATE_TAG[kind]} appears on ${owners.length} columns (${owners.map((o) => `"${o.name}"`).join(", ")}) — the daemon resolves the first by position. Remove the tag from the wrong one by hand (this script never strips tags).`);
    }
  }

  // --- one decision per factory kind.
  let nextNewPosition = states.reduce((m, s) => Math.max(m, s.position), 0) + 1;
  for (const spec of BOARD) {
    const current = resolved[spec.kind] as RawState | null;
    if (!current) {
      changes.push({ op: "create", kind: spec.kind, name: STATE_NAME[spec.kind], type: STATE_TYPE[spec.kind],
        color: spec.color, description: describe(spec), position: nextNewPosition++ });
      continue;
    }
    const tag = taggedKind(current.description);
    if (tag === spec.kind) { aligned.push({ kind: spec.kind, state: current }); claimed.set(spec.kind, current); continue; }
    if (tag !== null) {
      conflicts.push(`the ${spec.kind} lane resolves to "${current.name}", but that column is tagged ${STATE_TAG[tag]} — refusing to overwrite someone else's tag. Fix by hand.`);
      continue;
    }
    changes.push({ op: "tag", kind: spec.kind, state: current, description: withTag(current.description, spec.kind) });
    claimed.set(spec.kind, current);
  }

  const managedIds = new Set<string>([...claimed.values()].map((s) => s.id));
  const unmanaged = states.filter((s) => !managedIds.has(s.id));

  // --- ordering. Factory columns in pipeline order; everything else keeps its
  // relative order inside its own type bucket. Columns being CREATED take part
  // in the sort (their position is set at CREATE time rather than by a move), so
  // Blocked and Needs Human land between Todo and In Progress on the first run
  // instead of being appended after Duplicate. Only real moves are emitted, so a
  // second run against an ordered board plans nothing.
  if (opts.reorder) {
    const kindOfState = new Map<string, StateKind>();
    for (const [kind, s] of claimed) kindOfState.set(s.id, kind);
    const rankOf = (type: string, kind: StateKind | null): string => {
      const t = TYPE_ORDER.indexOf(type);
      const k = kind ? BOARD.findIndex((b) => b.kind === kind) : 99;
      return `${String(t < 0 ? TYPE_ORDER.length : t).padStart(3, "0")}/${String(k).padStart(3, "0")}`;
    };
    type Slot = { rank: string; position: number; existing: RawState | null; create: Extract<Change, { op: "create" }> | null };
    const slots: Slot[] = [
      ...states.map((s) => ({ rank: rankOf(s.type, kindOfState.get(s.id) ?? null), position: s.position, existing: s, create: null })),
      ...changes.filter((c): c is Extract<Change, { op: "create" }> => c.op === "create")
        .map((c) => ({ rank: rankOf(c.type, c.kind), position: c.position, existing: null, create: c })),
    ];
    slots.sort((a, b) => a.rank.localeCompare(b.rank) || a.position - b.position);
    slots.forEach((slot, index) => {
      if (slot.create) { slot.create.position = index; return; }
      // Linear refuses position updates on its RESERVED per-team states
      // ("unable to update reserved state", observed live 2026-08-02 on the
      // duplicate-type state). Leave them where Linear put them — their
      // position is cosmetic and unmanaged here anyway.
      if (slot.existing && ["duplicate", "triage"].includes(slot.existing.type)) return;
      if (slot.existing && slot.existing.position !== index) {
        changes.push({ op: "move", state: slot.existing, from: slot.existing.position, to: index });
      }
    });
  }

  return { changes, aligned, conflicts, unmanaged };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

interface Team { id: string; key: string; name: string; states: RawState[] }

const STATE_FIELDS = "id name type color position description";

async function fetchTeam(key: string): Promise<Team> {
  interface Node { id: string; key: string; name: string; states: { nodes: Array<RawState & { issues?: { nodes: Array<{ id: string }> } }> } }
  let nodes: Node[];
  try {
    const data = await gql<{ teams: { nodes: Node[] } }>(
      `query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) {
         nodes { id key name states { nodes { ${STATE_FIELDS} issues(first: 1) { nodes { id } } } } } } }`, { key });
    nodes = data.teams.nodes;
  } catch (error) {
    // The nested issues connection is only used to annotate the report; if the
    // API refuses it (complexity), fall back to the lean query rather than
    // failing the whole run.
    console.error(`[board-setup] issue-occupancy probe unavailable (${error instanceof Error ? error.message : error}); continuing without it`);
    const data = await gql<{ teams: { nodes: Node[] } }>(
      `query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) {
         nodes { id key name states { nodes { ${STATE_FIELDS} } } } } }`, { key });
    nodes = data.teams.nodes;
  }
  const team = nodes[0];
  if (!team) throw new Error(`no Linear team with key ${key}`);
  return {
    id: team.id, key: team.key, name: team.name,
    states: team.states.nodes.map((s) => ({
      id: s.id, name: s.name, type: s.type, color: s.color, position: s.position,
      description: s.description ?? "",
      ...(s.issues ? { hasIssues: s.issues.nodes.length > 0 } : {}),
    })),
  };
}

async function applyChange(team: Team, change: Change): Promise<void> {
  if (change.op === "create") {
    await gql(`mutation($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success workflowState { id } } }`,
      { input: { teamId: team.id, name: change.name, type: change.type, color: change.color, description: change.description, position: change.position } });
    return;
  }
  if (change.op === "tag") {
    await gql(`mutation($id: String!, $input: WorkflowStateUpdateInput!) { workflowStateUpdate(id: $id, input: $input) { success } }`,
      { id: change.state.id, input: { description: change.description } });
    return;
  }
  await gql(`mutation($id: String!, $input: WorkflowStateUpdateInput!) { workflowStateUpdate(id: $id, input: $input) { success } }`,
    { id: change.state.id, input: { position: change.to } });
}

function renderChange(c: Change): string {
  if (c.op === "create") return `  CREATE  "${c.name}" (type ${c.type}, color ${c.color}, position ${c.position})\n            description: ${JSON.stringify(c.description)}`;
  if (c.op === "tag") return `  TAG     "${c.state.name}" (type ${c.state.type}) as ${STATE_TAG[c.kind]}\n            description: ${JSON.stringify(c.state.description ?? "")} -> ${JSON.stringify(c.description)}`;
  return `  MOVE    "${c.state.name}" position ${c.from} -> ${c.to}`;
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const reorder = !argv.includes("--no-reorder");
  const teamArg = argv.filter((a) => a.startsWith("--team=")).flatMap((a) => a.slice("--team=".length).split(",")).map((s) => s.trim()).filter(Boolean);
  const teamKeys = teamArg.length > 0 ? teamArg : config.teamKeys;
  if (apply && argv.includes("--dry-run")) {
    console.error("board-setup: --apply and --dry-run are contradictory; refusing.");
    return 2;
  }

  console.log(`board-setup ${apply ? "APPLY" : "DRY RUN (nothing will be changed — pass --apply to mutate)"} · teams: ${teamKeys.join(", ")} · reorder: ${reorder ? "yes" : "no"}`);

  let exitCode = 0;
  for (const key of teamKeys) {
    const team = await fetchTeam(key);
    const plan = planBoard(team.states, { reorder });
    console.log(`\n=== ${team.key} (${team.name}) — ${team.states.length} workflow states`);
    for (const s of [...team.states].sort((a, b) => a.position - b.position)) {
      const kind = taggedKind(s.description);
      console.log(`  · ${String(s.position).padStart(5)} ${s.name.padEnd(14)} type=${s.type.padEnd(10)} ${kind ? STATE_TAG[kind] : "(untagged)"}${s.hasIssues === undefined ? "" : s.hasIssues ? " [has issues]" : " [empty]"}`);
    }

    if (plan.conflicts.length > 0) {
      console.log(`\n  CONFLICTS — not fixable automatically, nothing below touches them:`);
      for (const c of plan.conflicts) console.log(`  !! ${c}`);
      exitCode = 1;
    }
    if (plan.aligned.length > 0) {
      console.log(`\n  already aligned: ${plan.aligned.map((a) => `${a.kind}="${a.state.name}"`).join(", ")}`);
    }
    if (plan.unmanaged.length > 0) {
      console.log(`  unmanaged (never created, tagged, renamed or DELETED by this script): ${plan.unmanaged.map((s) => `"${s.name}"${s.hasIssues ? " [has issues]" : ""}`).join(", ")}`);
    }

    if (plan.changes.length === 0) {
      console.log(`\n  no changes — ${team.key} already matches the factory board contract.`);
      continue;
    }
    console.log(`\n  ${plan.changes.length} change(s)${apply ? "" : " that WOULD be applied"}:`);
    for (const c of plan.changes) console.log(renderChange(c));

    if (!apply) continue;
    for (const c of plan.changes) {
      try {
        await applyChange(team, c);
        console.log(`  ✓ ${c.op}`);
      } catch (firstError) {
        // One bounded retry after a beat: two same-shaped creates seconds apart
        // produced success-then-"Argument Validation Error" live (2026-08-02),
        // which smells like a server-side settling issue, not our input.
        try {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await applyChange(team, c);
          console.log(`  ✓ ${c.op} (on retry)`);
          continue;
        } catch { /* fall through to report the ORIGINAL error */ }
        const error = firstError;
        // Full input dump so a validation failure is diagnosable from the log.
        if (c.op === "create") console.error(`    input: ${JSON.stringify({ name: c.name, type: c.type, color: c.color, position: c.position })}`);
        console.error(`  ✗ ${c.op} failed: ${error instanceof Error ? error.message : error}`);
        exitCode = 1;
      }
    }

    // Re-read and prove the daemon's own resolver now maps every kind where we
    // intended. This is the check that matters — the script and src/linear.ts
    // share resolveBoardStates, so a green verification here IS the daemon's
    // behaviour, not a restatement of the plan.
    const after = await fetchTeam(key);
    const resolved = resolveBoardStates(after.states);
    console.log(`\n  verification (src/linear.ts resolveBoardStates against the live board):`);
    for (const spec of BOARD) {
      const s = resolved[spec.kind];
      console.log(`    ${spec.kind.padEnd(12)} -> ${s ? `"${s.name}" (${s.type})` : "MISSING"}`);
      if (!s) exitCode = 1;
    }
  }

  if (!apply) console.log(`\nDry run complete. Re-run with --apply to make these changes.`);
  return exitCode;
}

if (import.meta.main) {
  run().then((code) => process.exit(code)).catch((error) => {
    console.error(`board-setup failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
