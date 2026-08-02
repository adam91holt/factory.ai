import { describe, expect, test } from "bun:test";
import {
  isReviewLane, queueLane, resolveBoardStates, taggedKind, transitionTarget,
  OPTIONAL_STATE_KINDS, REQUIRED_STATE_KINDS, STATE_NAME, STATE_TAG, STATE_TYPE,
  type StateKind, type TeamState,
} from "../src/linear.ts";
import { planBoard } from "../scripts/board-setup.ts";

// WP3 board stages. Linear exposes only SIX state TYPES, so three of our lanes
// (Todo / Blocked / Needs Human) necessarily share `unstarted` and two (In
// Progress / In Review) share `started`. The tests below pin the two properties
// that make that safe:
//
//   (a) the TYPE is still the outer filter — a `[factory:queue]` tag on a
//       started-type column is INERT, so no human-editable string can move an
//       issue across a type boundary (the C13/M4 hardening, unchanged); and
//   (b) every resolution DEGRADES to the exact pre-WP3 behaviour when a state is
//       missing, renamed, or untagged — an un-migrated board must keep working.

let nextId = 0;
function st(name: string, type: string, position: number, description = ""): TeamState {
  return { id: `state-${++nextId}-${name}`, name, type, position, description };
}

/** The board scripts/board-setup.ts produces. */
const tagged = (): TeamState[] => [
  st("Backlog", "backlog", 0),
  st("Todo", "unstarted", 1, "queue blurb\n\n[factory:queue]"),
  st("Blocked", "unstarted", 2, "blurb\n\n[factory:blocked]"),
  st("Needs Human", "unstarted", 3, "blurb\n\n[factory:needs_human]"),
  st("In Progress", "started", 4, "blurb\n\n[factory:working]"),
  st("In Review", "started", 5, "blurb\n\n[factory:review]"),
  st("Done", "completed", 6, "blurb\n\n[factory:done]"),
  st("Canceled", "canceled", 7),
  st("Duplicate", "duplicate", 8),
];

/** The FAC board as it exists BEFORE board-setup runs (verified live 2026-08-02:
 *  In Review really does sit at position 1002, after Duplicate). */
const legacy = (): TeamState[] => [
  st("Backlog", "backlog", 0),
  st("Todo", "unstarted", 1),
  st("In Progress", "started", 2),
  st("Done", "completed", 3),
  st("Canceled", "canceled", 4),
  st("Duplicate", "duplicate", 5),
  st("In Review", "started", 1002, "Pull request is being reviewed"),
];

const nameOf = (s: TeamState | null): string | null => s?.name ?? null;

describe("taggedKind", () => {
  test("finds each kind's tag anywhere in the description", () => {
    for (const kind of Object.keys(STATE_TAG) as StateKind[]) {
      expect(taggedKind(`some prose\n\n${STATE_TAG[kind]}`)).toBe(kind);
    }
  });

  test("is case-insensitive (a human re-capitalising the line cannot break it)", () => {
    expect(taggedKind("[FACTORY:NEEDS_HUMAN]")).toBe("needs_human");
  });

  test("empty / null / untagged descriptions are null", () => {
    expect(taggedKind("")).toBeNull();
    expect(taggedKind(null)).toBeNull();
    expect(taggedKind(undefined)).toBeNull();
    expect(taggedKind("Pull request is being reviewed")).toBeNull();
  });

  test("does not confuse needs_human with the queue tag (no substring bleed)", () => {
    expect(taggedKind("[factory:needs_human]")).toBe("needs_human");
    expect(taggedKind("[factory:queue]")).toBe("queue");
  });
});

describe("resolveBoardStates — the fully tagged board", () => {
  test("every kind resolves to its own column", () => {
    const r = resolveBoardStates(tagged());
    expect(nameOf(r.queue)).toBe("Todo");
    expect(nameOf(r.blocked)).toBe("Blocked");
    expect(nameOf(r.needs_human)).toBe("Needs Human");
    expect(nameOf(r.working)).toBe("In Progress");
    expect(nameOf(r.review)).toBe("In Review");
    expect(nameOf(r.done)).toBe("Done");
  });

  test("resolution is order-independent (the API may return states in any order)", () => {
    const shuffled = [...tagged()].reverse();
    expect(Object.fromEntries(Object.entries(resolveBoardStates(shuffled)).map(([k, v]) => [k, nameOf(v)])))
      .toEqual(Object.fromEntries(Object.entries(resolveBoardStates(tagged())).map(([k, v]) => [k, nameOf(v)])));
  });

  test("every resolved state sits in the TYPE its kind demands", () => {
    const r = resolveBoardStates(tagged());
    for (const kind of Object.keys(STATE_TYPE) as StateKind[]) {
      expect(r[kind]?.type).toBe(STATE_TYPE[kind]);
    }
  });
});

describe("resolveBoardStates — degrades to pre-WP3 behaviour", () => {
  test("an UNTAGGED legacy board resolves exactly as the old name+position code did", () => {
    const r = resolveBoardStates(legacy());
    expect(nameOf(r.queue)).toBe("Todo");          // unstarted + name "Todo"
    expect(nameOf(r.working)).toBe("In Progress"); // started + name "In Progress"
    expect(nameOf(r.review)).toBe("In Review");    // started + /review/i
    expect(nameOf(r.done)).toBe("Done");           // completed + name "Done"
  });

  test("the two NEW kinds are simply absent on a board that has no such column", () => {
    const r = resolveBoardStates(legacy());
    expect(r.blocked).toBeNull();
    expect(r.needs_human).toBeNull();
  });

  test("a Blocked column that was DELETED again degrades back to null (not to Todo)", () => {
    const r = resolveBoardStates(tagged().filter((s) => s.name !== "Blocked"));
    expect(r.blocked).toBeNull();
    expect(nameOf(r.queue)).toBe("Todo"); // and queue is unharmed
  });

  test("a RENAMED but still-tagged column keeps resolving", () => {
    const board = tagged().map((s) => s.name === "Needs Human" ? { ...s, name: "Escalated \u{1F6A8}" } : s);
    expect(nameOf(resolveBoardStates(board).needs_human)).toBe("Escalated \u{1F6A8}");
  });

  test("a renamed AND untagged review column still falls back to /review/i", () => {
    const board = legacy().map((s) => s.name === "In Review" ? { ...s, name: "Awaiting review by a human" } : s);
    expect(nameOf(resolveBoardStates(board).review)).toBe("Awaiting review by a human");
  });

  test("a renamed, untagged review column with NO 'review' in the name falls back to the LAST started state", () => {
    const board = legacy().map((s) => s.name === "In Review" ? { ...s, name: "Awaiting merge" } : s);
    expect(nameOf(resolveBoardStates(board).review)).toBe("Awaiting merge"); // position 1002 = last
  });

  test("a team with a single started state uses it for BOTH working and review (unchanged)", () => {
    const board = [st("Todo", "unstarted", 1), st("Doing", "started", 2), st("Done", "completed", 3)];
    const r = resolveBoardStates(board);
    expect(nameOf(r.working)).toBe("Doing");
    expect(nameOf(r.review)).toBe("Doing");
  });

  test("an empty state list resolves everything to null rather than throwing", () => {
    const r = resolveBoardStates([]);
    for (const kind of [...REQUIRED_STATE_KINDS, ...OPTIONAL_STATE_KINDS]) expect(r[kind]).toBeNull();
  });
});

describe("resolveBoardStates — the tag is honoured only INSIDE the right type (C13/M4)", () => {
  test("a started-type column tagged [factory:queue] is INERT — queue stays unstarted", () => {
    const board = [
      ...legacy().filter((s) => s.name !== "In Progress"),
      st("In Progress", "started", 2, "[factory:queue]"),
    ];
    const r = resolveBoardStates(board);
    expect(nameOf(r.queue)).toBe("Todo");
    expect(r.queue?.type).toBe("unstarted");
  });

  test("a completed-type column tagged [factory:needs_human] cannot pull the lane out of unstarted", () => {
    const board = [...tagged(), st("Archived", "completed", 9, "[factory:needs_human]")];
    expect(nameOf(resolveBoardStates(board).needs_human)).toBe("Needs Human");
  });

  test("no forged tag can make `done` resolve to a non-completed state", () => {
    const board = [
      st("Todo", "unstarted", 1, "[factory:done]"),
      st("Working", "started", 2, "[factory:done]"),
    ];
    expect(resolveBoardStates(board).done).toBeNull(); // no completed-type state exists at all
  });
});

describe("resolveBoardStates — reserved-set exclusion", () => {
  test("queue never falls back onto Blocked or Needs Human when Todo is renamed AND untagged", () => {
    // Position 9 puts the renamed queue column AFTER Blocked (2) and Needs
    // Human (3), so the pre-WP3 "first unstarted state" fallback would have
    // picked Blocked and the factory would have started claiming work straight
    // out of a human-owned column.
    const board = tagged().map((s) => s.name === "Todo" ? { ...s, name: "Ready", description: "", position: 9 } : s);
    const r = resolveBoardStates(board);
    expect(nameOf(r.queue)).toBe("Ready");
    expect(nameOf(r.blocked)).toBe("Blocked");
    expect(nameOf(r.needs_human)).toBe("Needs Human");
  });

  test("even with Todo GONE, queue prefers an unreserved unstarted column over Blocked", () => {
    const board = [
      ...tagged().filter((s) => s.name !== "Todo"),
      st("Icebox", "unstarted", 9),
    ];
    expect(nameOf(resolveBoardStates(board).queue)).toBe("Icebox");
  });

  test("a hand-made, UNTAGGED 'Blocked' column is still reserved away from the queue lane", () => {
    // The name match is what reserves it: it is not authoritative enough to be
    // transitioned INTO (see the transition test below), but it must not become
    // the queue by positional accident.
    const board = [
      st("Blocked", "unstarted", 1),   // first by position — the old code's pick
      st("Ready", "unstarted", 2),
      st("In Progress", "started", 3),
      st("Done", "completed", 4),
    ];
    const r = resolveBoardStates(board);
    expect(nameOf(r.queue)).toBe("Ready");
    expect(nameOf(r.blocked)).toBe("Blocked");
  });

  test("DEGENERATE board: when the only unstarted column is Blocked, queue relaxes onto it", () => {
    // Reachable-but-odd beats unreachable — a park with nowhere to go would
    // return false and strand the ticket. This is also exactly what the pre-WP3
    // code did (first unstarted state, whatever it is called).
    const board = [st("Blocked", "unstarted", 1, "[factory:blocked]"), st("Doing", "started", 2), st("Done", "completed", 3)];
    const r = resolveBoardStates(board);
    expect(nameOf(r.blocked)).toBe("Blocked");
    expect(nameOf(r.queue)).toBe("Blocked");
  });

  test("blocked and needs_human never resolve to the SAME column", () => {
    const board = [
      st("Todo", "unstarted", 1, "[factory:queue]"),
      st("Held", "unstarted", 2, "[factory:blocked] [factory:needs_human]"), // a human pasted both
      st("Doing", "started", 3),
      st("Done", "completed", 4),
    ];
    const r = resolveBoardStates(board);
    expect(nameOf(r.blocked)).toBe("Held");
    expect(r.needs_human).toBeNull();
  });
});

describe("resolveBoardStates — multiple columns of one type", () => {
  test("done name-anchors 'Done' ahead of an earlier-positioned completed state", () => {
    const board = [
      st("Todo", "unstarted", 1),
      st("Doing", "started", 2),
      st("Released", "completed", 3),
      st("Done", "completed", 4),
    ];
    expect(nameOf(resolveBoardStates(board).done)).toBe("Done");
  });

  test("a [factory:done] tag beats the 'Done' name anchor", () => {
    const board = [
      st("Todo", "unstarted", 1),
      st("Doing", "started", 2),
      st("Released", "completed", 3, "[factory:done]"),
      st("Done", "completed", 4),
    ];
    expect(nameOf(resolveBoardStates(board).done)).toBe("Released");
  });

  test("working takes the FIRST started column by position when nothing is named 'In Progress'", () => {
    const board = [st("Todo", "unstarted", 1), st("Building", "started", 3), st("Verifying", "started", 2), st("Done", "completed", 9)];
    expect(nameOf(resolveBoardStates(board).working)).toBe("Verifying"); // position 2
  });

  test("duplicate tags on one type resolve deterministically to the lowest position", () => {
    const board = [
      st("Todo B", "unstarted", 5, "[factory:queue]"),
      st("Todo A", "unstarted", 2, "[factory:queue]"),
      st("Doing", "started", 6),
      st("Done", "completed", 7),
    ];
    expect(nameOf(resolveBoardStates(board).queue)).toBe("Todo A");
  });
});

describe("transitionTarget — the degrade-safely path", () => {
  test("on an upgraded board every kind targets its own column, undegraded", () => {
    const board = resolveBoardStates(tagged());
    for (const kind of [...REQUIRED_STATE_KINDS, ...OPTIONAL_STATE_KINDS]) {
      const t = transitionTarget(board, kind);
      expect(t?.state.name).toBe(STATE_NAME[kind]);
      expect(t?.degradedFrom).toBeNull();
    }
  });

  test("blocked/needs_human on an un-upgraded board fall back to the QUEUE column", () => {
    // This is the pre-WP3 behaviour: park moved the ticket to Todo. Falling back
    // to the queue state (unstarted) is what keeps every "remove the label to
    // requeue" comment honest on a board that was never migrated.
    const board = resolveBoardStates(legacy());
    for (const kind of OPTIONAL_STATE_KINDS) {
      const t = transitionTarget(board, kind);
      expect(t?.state.name).toBe("Todo");
      expect(t?.degradedFrom).toBe(kind);
    }
  });

  test("the fallback target is UNSTARTED, so a degraded park is still reachable by fetchQueue", () => {
    const t = transitionTarget(resolveBoardStates(legacy()), "blocked");
    expect(t?.state.type).toBe("unstarted");
  });

  test("a REQUIRED kind never degrades — a team with no completed state returns null", () => {
    const board = resolveBoardStates([st("Todo", "unstarted", 1), st("Doing", "started", 2)]);
    expect(transitionTarget(board, "done")).toBeNull();
    expect(transitionTarget(board, "queue")?.state.name).toBe("Todo");
  });

  test("with no queue column either, an optional kind returns null instead of guessing", () => {
    const board = resolveBoardStates([st("Doing", "started", 2), st("Done", "completed", 3)]);
    expect(transitionTarget(board, "needs_human")).toBeNull();
    expect(transitionTarget(board, "blocked")).toBeNull();
  });

  test("a half-migrated board degrades only the column that is missing", () => {
    const board = resolveBoardStates(tagged().filter((s) => s.name !== "Needs Human"));
    expect(transitionTarget(board, "blocked")?.degradedFrom).toBeNull();
    expect(transitionTarget(board, "blocked")?.state.name).toBe("Blocked");
    expect(transitionTarget(board, "needs_human")?.degradedFrom).toBe("needs_human");
    expect(transitionTarget(board, "needs_human")?.state.name).toBe("Todo");
  });
});

describe("isReviewLane", () => {
  test("the tag identifies the review lane regardless of the column name", () => {
    expect(isReviewLane("Awaiting merge", "blurb\n\n[factory:review]")).toBe(true);
  });

  test("a column carrying a DIFFERENT factory tag is authoritatively not the review lane", () => {
    expect(isReviewLane("In Progress — review pending", "[factory:working]")).toBe(false);
  });

  test("untagged boards fall back to the pre-WP3 /review/i name match", () => {
    expect(isReviewLane("In Review", "")).toBe(true);
    expect(isReviewLane("in review", "")).toBe(true);
    expect(isReviewLane("In Progress", "")).toBe(false);
    expect(isReviewLane("In Review")).toBe(true); // description omitted (getIssueDetail children)
  });
});

describe("queueLane", () => {
  test("labels win — they are what fetchQueue's skip-set actually acts on", () => {
    expect(queueLane(["Factory-Parked"], "[factory:needs_human]")).toBe("parked");
    expect(queueLane(["Factory-Needs-Human"], "[factory:blocked]")).toBe("needs_human");
    expect(queueLane(["Factory-Executing"], "[factory:blocked]")).toBe("claimed");
  });

  test("with no factory label, the state tag reveals a hand-dragged card", () => {
    expect(queueLane([], "[factory:blocked]")).toBe("parked");
    expect(queueLane([], "[factory:needs_human]")).toBe("needs_human");
  });

  test("a plain queued ticket is 'todo'", () => {
    expect(queueLane([], "[factory:queue]")).toBe("todo");
    expect(queueLane([], "")).toBe("todo");
    expect(queueLane(["some-human-label"], null)).toBe("todo");
  });
});

describe("board contract constants", () => {
  test("Blocked and Needs Human are UNSTARTED — the property the requeue promise depends on", () => {
    // A started-type column would be invisible to fetchQueue (which filters
    // `state.type == unstarted`), so removing the label would NOT requeue and
    // every park/needs-human comment would be lying.
    expect(STATE_TYPE.blocked).toBe("unstarted");
    expect(STATE_TYPE.needs_human).toBe("unstarted");
    expect(STATE_TYPE.queue).toBe("unstarted");
  });

  test("every kind has a distinct tag, a type and a canonical name", () => {
    const kinds = [...REQUIRED_STATE_KINDS, ...OPTIONAL_STATE_KINDS];
    expect(new Set(kinds).size).toBe(6);
    expect(new Set(kinds.map((k) => STATE_TAG[k])).size).toBe(6);
    expect(new Set(kinds.map((k) => STATE_NAME[k])).size).toBe(6);
    for (const k of kinds) expect(STATE_TAG[k]).toBe(`[factory:${k}]`);
  });
});

// ---------------------------------------------------------------------------
// scripts/board-setup.ts — the plan is pure, so the diff the owner reviews in
// the dry run is the same object --apply executes.
// ---------------------------------------------------------------------------

describe("planBoard", () => {
  const ops = (cs: ReturnType<typeof planBoard>["changes"]): string[] => cs.map((c) => c.op);

  test("a legacy board is tagged, gains the two new columns, and is reordered", () => {
    const plan = planBoard(legacy(), { reorder: true });
    const creates = plan.changes.filter((c) => c.op === "create");
    expect(creates.map((c) => c.op === "create" && c.name)).toEqual(["Blocked", "Needs Human"]);
    expect(creates.every((c) => c.op === "create" && c.type === "unstarted")).toBe(true);
    const tags = plan.changes.filter((c) => c.op === "tag");
    expect(tags.map((c) => c.op === "tag" && c.kind).sort()).toEqual(["done", "queue", "review", "working"]);
  });

  test("existing description text is PRESERVED when the tag is appended", () => {
    const plan = planBoard(legacy(), { reorder: false });
    const review = plan.changes.find((c) => c.op === "tag" && c.kind === "review");
    expect(review?.op === "tag" && review.description).toBe("Pull request is being reviewed\n\n[factory:review]");
  });

  test("new columns are positioned BETWEEN Todo and In Progress, not appended at the end", () => {
    const plan = planBoard(legacy(), { reorder: true });
    const pos = new Map<string, number>();
    for (const c of plan.changes) {
      if (c.op === "create") pos.set(c.name, c.position);
      if (c.op === "move") pos.set(c.state.name, c.to);
    }
    expect(pos.get("Blocked")).toBe(2);
    expect(pos.get("Needs Human")).toBe(3);
    expect(pos.get("In Progress")).toBe(4);
    expect(pos.get("In Review")).toBe(5);
    expect(pos.get("Done")).toBe(6);
  });

  test("IDEMPOTENT: re-planning an aligned board produces zero changes", () => {
    const plan = planBoard(tagged(), { reorder: true });
    expect(plan.changes).toEqual([]);
    expect(plan.aligned.map((a) => a.kind).sort()).toEqual(["blocked", "done", "needs_human", "queue", "review", "working"]);
  });

  test("--no-reorder plans no MOVE at all", () => {
    const plan = planBoard(legacy(), { reorder: false });
    expect(ops(plan.changes)).not.toContain("move");
  });

  test("the plan can NEVER contain a delete/archive operation", () => {
    // "never delete a state that has issues in it" holds by construction: the
    // Change union has no destructive variant, so there is nothing to bypass.
    for (const board of [legacy(), tagged(), []]) {
      for (const c of planBoard(board, { reorder: true }).changes) {
        expect(["create", "tag", "move"]).toContain(c.op);
      }
    }
  });

  test("an existing column is ADOPTED, never renamed", () => {
    const board = legacy().map((s) => s.name === "Todo" ? { ...s, name: "Ready" } : s);
    const plan = planBoard(board, { reorder: false });
    const queue = plan.changes.find((c) => c.op === "tag" && c.kind === "queue");
    expect(queue?.op === "tag" && queue.state.name).toBe("Ready");
    expect(plan.changes.some((c) => c.op === "create" && c.kind === "queue")).toBe(false);
  });

  test("a tag on the WRONG type is reported as a conflict and nothing is mutated for it", () => {
    const board = [...legacy(), st("Shipped", "completed", 6, "[factory:review]")];
    const plan = planBoard(board, { reorder: false });
    expect(plan.conflicts.some((c) => c.includes("INERT"))).toBe(true);
    expect(plan.changes.some((c) => c.op === "tag" && c.state.name === "Shipped")).toBe(false);
  });

  test("a duplicated tag is reported, and the script never strips one", () => {
    const board = tagged().map((s) => s.name === "Backlog" ? { ...s, description: "[factory:queue]", type: "unstarted" } : s);
    const plan = planBoard(board, { reorder: false });
    expect(plan.conflicts.some((c) => c.includes("appears on 2 columns"))).toBe(true);
    expect(plan.changes.every((c) => c.op !== "tag" || c.description.includes("[factory:"))).toBe(true);
  });

  test("refuses to overwrite a foreign tag on a column a lane resolves to", () => {
    // "In Review" is name-anchored for the review lane but already claims to be
    // the working column — a human must sort that out, not this script.
    const board = legacy().map((s) => s.name === "In Review" ? { ...s, description: "[factory:working]" } : s);
    const plan = planBoard(board, { reorder: false });
    expect(plan.conflicts.some((c) => c.includes("refusing to overwrite"))).toBe(true);
  });

  test("columns the factory does not own are listed as unmanaged and left alone", () => {
    const plan = planBoard(tagged(), { reorder: true });
    expect(plan.unmanaged.map((s) => s.name).sort()).toEqual(["Backlog", "Canceled", "Duplicate"]);
  });
});
