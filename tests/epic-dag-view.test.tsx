import { describe, expect, test } from "bun:test";
import {
  buildEpicDag,
  globsOverlap,
  parseDagMeta,
  staticPrefix,
  type DagContext,
  type DagTicket,
} from "../ui/src/lib/epicdag.ts";

// The epic-DAG view's pure logic. The daemon's scheduler (src/dag.ts +
// src/index.ts) stays the only AUTHORITY — this module re-derives the same
// classification for DISPLAY, so these tests pin that the view can only
// explain what the daemon would do, never contradict it:
//   • meta parsing is START-ANCHORED like src/meta.ts (an injected block in
//     prose draws no edges), malformed ids are dropped;
//   • the overlap test is the same conservative approximation as src/dag.ts;
//   • unknown dependencies BLOCK (fail-closed, like selectRunnable);
//   • touches-overlap produces a MUTEX edge (a constraint), never a dep edge,
//     and never when a dependency path already orders the pair.

function ticket(overrides: Partial<DagTicket> & { identifier: string }): DagTicket {
  return {
    title: overrides.identifier,
    stateType: "unstarted",
    stateName: "Todo",
    labels: [],
    dependsOn: [],
    touches: [],
    ...overrides,
  };
}

function ctx(overrides: Partial<DagContext> = {}): DagContext {
  return { inFlightKeys: [], wipLimit: 4, activeRunCount: 0, draining: false, drainReason: null, ...overrides };
}

function laneOf(view: ReturnType<typeof buildEpicDag>, id: string) {
  return view.nodes.find((n) => n.identifier === id)!;
}

describe("parseDagMeta — the display-side subset of src/meta.ts", () => {
  test("parses depends_on + touches from a start-anchored factory block", () => {
    const meta = parseDagMeta("<!-- factory\nrepo: acme/api\ndepends_on: FAC-1, FAC-2\ntouches: src/a/**, src/b.ts\n-->\n\nbody");
    expect(meta.dependsOn).toEqual(["FAC-1", "FAC-2"]);
    expect(meta.touches).toEqual(["src/a/**", "src/b.ts"]);
  });

  test("a block buried in prose is IGNORED — injected content draws no edges", () => {
    const meta = parseDagMeta("Some text first.\n<!-- factory\ndepends_on: FAC-1\n-->");
    expect(meta.dependsOn).toEqual([]);
  });

  test("malformed identifiers are dropped, well-formed survive", () => {
    const meta = parseDagMeta("<!-- factory\ndepends_on: FAC-1, ../evil, fac-2, FAC-3\n-->");
    expect(meta.dependsOn).toEqual(["FAC-1", "FAC-3"]);
  });

  test("no block → empty arrays, never a throw", () => {
    expect(parseDagMeta("")).toEqual({ dependsOn: [], touches: [] });
    expect(parseDagMeta("plain prose")).toEqual({ dependsOn: [], touches: [] });
  });

  test("array caps hold (32 entries) so a bloated block cannot flood the view", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `FAC-${i + 1}`).join(", ");
    expect(parseDagMeta(`<!-- factory\ndepends_on: ${ids}\n-->`).dependsOn.length).toBe(32);
  });
});

describe("globsOverlap — same conservative approximation as src/dag.ts", () => {
  test("string-equal globs overlap; static-prefix containment overlaps", () => {
    expect(globsOverlap(["src/lessons.ts"], ["src/lessons.ts"])).toBe(true);
    expect(globsOverlap(["src/a/**"], ["src/a/b.ts"])).toBe(true);
  });

  test("segment-aware: src/a does NOT spuriously match src/ab", () => {
    expect(globsOverlap(["src/a"], ["src/ab"])).toBe(false);
    expect(globsOverlap(["src/a"], ["src/a/b"])).toBe(true);
  });

  test("a bare ** overlaps everything (bias toward overlap); empty lists overlap nothing", () => {
    expect(globsOverlap(["**"], ["anything/at/all.ts"])).toBe(true);
    expect(globsOverlap([], ["src/a.ts"])).toBe(false);
    expect(staticPrefix("src/a/**")).toBe("src/a/");
    expect(staticPrefix("**/x")).toBe("");
  });
});

describe("buildEpicDag — lanes", () => {
  test("completed AND canceled are both done (a canceled dep must satisfy edges)", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1", stateType: "completed" }),
      ticket({ identifier: "FAC-2", stateType: "canceled" }),
      ticket({ identifier: "FAC-3", dependsOn: ["FAC-1", "FAC-2"] }),
    ], ctx());
    expect(laneOf(view, "FAC-1").lane).toBe("done");
    expect(laneOf(view, "FAC-2").lane).toBe("done");
    expect(laneOf(view, "FAC-3").lane).toBe("ready");
  });

  test("in-flight via active run key, Executing label, or started state", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1" }),
      ticket({ identifier: "FAC-2", labels: ["Factory-Executing"] }),
      ticket({ identifier: "FAC-3", stateType: "started" }),
    ], ctx({ inFlightKeys: ["FAC-1"], activeRunCount: 1 }));
    expect(laneOf(view, "FAC-1").lane).toBe("in-flight");
    expect(laneOf(view, "FAC-2").lane).toBe("in-flight");
    expect(laneOf(view, "FAC-3").lane).toBe("in-flight");
  });

  test("needs-human via label; parked folds into the same lane with its own reason", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1", labels: ["Factory-Needs-Human"] }),
      ticket({ identifier: "FAC-2", labels: ["Factory-Parked"] }),
    ], ctx());
    expect(laneOf(view, "FAC-1").lane).toBe("needs-human");
    expect(laneOf(view, "FAC-2").lane).toBe("needs-human");
    expect(laneOf(view, "FAC-2").reason).toContain("parked");
  });

  test("an unmet dependency blocks, and the reason names it with its live state", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1", stateType: "started", stateName: "In Progress" }),
      ticket({ identifier: "FAC-2", dependsOn: ["FAC-1"] }),
    ], ctx({ activeRunCount: 1 }));
    const n = laneOf(view, "FAC-2");
    expect(n.lane).toBe("blocked");
    expect(n.reason).toBe("unmet dependency: FAC-1 (In Progress)");
  });

  test("a dependency OUTSIDE the epic blocks fail-closed (mirrors selectRunnable's undefined)", () => {
    const view = buildEpicDag([ticket({ identifier: "FAC-2", dependsOn: ["ZZZ-9"] })], ctx());
    const n = laneOf(view, "FAC-2");
    expect(n.lane).toBe("blocked");
    expect(n.reason).toContain("ZZZ-9");
    expect(n.reason).toContain("treated as blocking");
  });
});

describe("buildEpicDag — why a READY node is not running", () => {
  test("WIP limit: ready beyond capacity defers with the N/N reason", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1" }),
      ticket({ identifier: "FAC-2" }),
    ], ctx({ wipLimit: 2, activeRunCount: 1 }));
    expect(laneOf(view, "FAC-1").lane).toBe("ready");
    const deferred = laneOf(view, "FAC-2");
    expect(deferred.lane).toBe("deferred");
    expect(deferred.reason).toBe("WIP limit reached (1/2 in flight)");
  });

  test("touches collision with an IN-FLIGHT sibling defers and names the pair", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1", stateType: "started", touches: ["src/db/**"] }),
      ticket({ identifier: "FAC-2", touches: ["src/db/queries.ts"] }),
    ], ctx({ wipLimit: 4, activeRunCount: 1 }));
    const n = laneOf(view, "FAC-2");
    expect(n.lane).toBe("deferred");
    expect(n.reason).toContain("touches overlap with FAC-1");
    expect(n.reason).toContain("src/db/queries.ts ∩ src/db/**");
    expect(n.reason).toContain("serialised, not dependent");
  });

  test("two READY siblings that overlap: the earlier is admitted, the later defers naming it", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1", touches: ["src/x.ts"] }),
      ticket({ identifier: "FAC-2", touches: ["src/x.ts"] }),
    ], ctx({ wipLimit: 4 }));
    expect(laneOf(view, "FAC-1").lane).toBe("ready");
    const n = laneOf(view, "FAC-2");
    expect(n.lane).toBe("deferred");
    expect(n.reason).toContain("touches overlap with FAC-1");
  });

  test("drain mode defers every ready node with the drain reason", () => {
    const view = buildEpicDag([ticket({ identifier: "FAC-1" })], ctx({ draining: true, drainReason: "manual /stop" }));
    const n = laneOf(view, "FAC-1");
    expect(n.lane).toBe("deferred");
    expect(n.reason).toBe("drain mode — not claiming new work (manual /stop)");
  });

  test("no daemon seen (wipLimit null) → no WIP inference, node is plain ready", () => {
    const view = buildEpicDag([ticket({ identifier: "FAC-1" })], ctx({ wipLimit: null }));
    expect(laneOf(view, "FAC-1").lane).toBe("ready");
    expect(laneOf(view, "FAC-1").reason).toBeNull();
  });
});

describe("buildEpicDag — edges", () => {
  test("depends_on draws dep edges; touches overlap draws a DISTINCT mutex edge with the pair", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1", touches: ["src/a/**"] }),
      ticket({ identifier: "FAC-2", dependsOn: ["FAC-1"] }),
      ticket({ identifier: "FAC-3", touches: ["src/a/b.ts"] }),
    ], ctx());
    const dep = view.edges.filter((e) => e.kind === "dep");
    const mutex = view.edges.filter((e) => e.kind === "mutex");
    expect(dep).toEqual([{ from: "FAC-1", to: "FAC-2", kind: "dep" }]);
    expect(mutex).toEqual([{ from: "FAC-1", to: "FAC-3", kind: "mutex", overlap: "src/a/** ∩ src/a/b.ts" }]);
  });

  test("NO mutex edge when a dependency path already orders the pair (either direction)", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1", touches: ["src/a/**"] }),
      ticket({ identifier: "FAC-2", dependsOn: ["FAC-1"], touches: ["src/a/x.ts"] }),
      ticket({ identifier: "FAC-3", dependsOn: ["FAC-2"], touches: ["src/a/y.ts"] }),
    ], ctx());
    expect(view.edges.filter((e) => e.kind === "mutex")).toEqual([]);
  });

  test("a dep on a ticket outside the epic draws no edge (but still blocks — see lanes)", () => {
    const view = buildEpicDag([ticket({ identifier: "FAC-1", dependsOn: ["ZZZ-9"] })], ctx());
    expect(view.edges).toEqual([]);
  });
});

describe("buildEpicDag — layout", () => {
  test("layers are longest dep path; rows are stable within a layer", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1" }),
      ticket({ identifier: "FAC-2" }),
      ticket({ identifier: "FAC-3", dependsOn: ["FAC-1"] }),
      ticket({ identifier: "FAC-4", dependsOn: ["FAC-1", "FAC-3"] }),
    ], ctx());
    expect(laneOf(view, "FAC-1").layer).toBe(0);
    expect(laneOf(view, "FAC-2").layer).toBe(0);
    expect(laneOf(view, "FAC-3").layer).toBe(1);
    expect(laneOf(view, "FAC-4").layer).toBe(2); // longest path, not shortest
    expect(view.layerCount).toBe(3);
    expect(laneOf(view, "FAC-1").row).toBe(0);
    expect(laneOf(view, "FAC-2").row).toBe(1);
  });

  test("a dependency cycle cannot hang or crash the layout (falls back, mirrors fail-open)", () => {
    const view = buildEpicDag([
      ticket({ identifier: "FAC-1", dependsOn: ["FAC-2"] }),
      ticket({ identifier: "FAC-2", dependsOn: ["FAC-1"] }),
    ], ctx());
    expect(view.nodes.length).toBe(2);
    expect(view.layerCount).toBeGreaterThanOrEqual(1);
  });

  test("never mutates its input", () => {
    const input = [
      ticket({ identifier: "FAC-2", touches: ["src/x.ts"] }),
      ticket({ identifier: "FAC-1", touches: ["src/x.ts"] }),
    ];
    const before = JSON.stringify(input);
    buildEpicDag(input, ctx());
    expect(JSON.stringify(input)).toBe(before);
    expect(input.map((t) => t.identifier)).toEqual(["FAC-2", "FAC-1"]);
  });
});
