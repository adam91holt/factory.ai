import { describe, expect, test } from "bun:test";
import { staticPrefix, globsOverlap, selectRunnable, deriveImplicitDeps, type Schedulable } from "../src/dag.ts";

describe("staticPrefix", () => {
  test("stops at the first wildcard", () => {
    expect(staticPrefix("src/a/**")).toBe("src/a/");
    expect(staticPrefix("src/*.ts")).toBe("src/");
    expect(staticPrefix("src/a/file?.ts")).toBe("src/a/file");
  });
  test("brace and bracket are wildcards", () => {
    expect(staticPrefix("src/{a,b}.ts")).toBe("src/");
    expect(staticPrefix("src/[ab].ts")).toBe("src/");
  });
  test("a literal path with no wildcard is its own prefix", () => {
    expect(staticPrefix("src/lessons.ts")).toBe("src/lessons.ts");
  });
});

describe("globsOverlap", () => {
  test("a directory glob overlaps a file beneath it", () => {
    expect(globsOverlap(["src/a/**"], ["src/a/b.ts"])).toBe(true);
  });
  test("disjoint directories do not overlap", () => {
    expect(globsOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
  });
  test("identical globs overlap", () => {
    expect(globsOverlap(["src/x.ts"], ["src/x.ts"])).toBe(true);
  });
  test("a broad glob overlaps anything under it", () => {
    expect(globsOverlap(["src/**"], ["src/deep/thing.ts"])).toBe(true);
  });
  test("empty list overlaps nothing", () => {
    expect(globsOverlap([], ["src/x.ts"])).toBe(false);
    expect(globsOverlap(["src/x.ts"], [])).toBe(false);
  });
  test("segment-aware: a shared string prefix that is NOT a path boundary does not overlap", () => {
    expect(globsOverlap(["src/a"], ["src/ab"])).toBe(false);
    expect(globsOverlap(["src/foo/**"], ["src/foobar/**"])).toBe(false);
  });
});

const s = (identifier: string, dependsOn: string[] = [], touches: string[] = []): Schedulable => ({ identifier, dependsOn, touches });
const noDeps = () => undefined;

describe("selectRunnable", () => {
  test("(a) no deps / no touches: all run up to capacity in FIFO order", () => {
    const cands = [s("A"), s("B"), s("C")];
    const { run, blocked, deferred } = selectRunnable(cands, noDeps, [], 2);
    expect(run).toEqual(["A", "B"]);
    expect(deferred).toEqual(["C"]);
    expect(blocked).toEqual([]);
  });

  test("(b) a child is blocked until its dependency reaches completed", () => {
    const cands = [s("B", ["A-1"])];
    // dep not complete → blocked
    expect(selectRunnable(cands, (id) => (id === "A-1" ? "started" : undefined), [], 4).blocked).toEqual(["B"]);
    // dep completed → runs
    expect(selectRunnable(cands, (id) => (id === "A-1" ? "completed" : undefined), [], 4).run).toEqual(["B"]);
  });

  test("(c) an unknown dependency state blocks (fail-closed)", () => {
    const cands = [s("B", ["A-1"])];
    const { run, blocked } = selectRunnable(cands, noDeps, [], 4);
    expect(run).toEqual([]);
    expect(blocked).toEqual(["B"]);
  });

  test("(c') a CANCELED dependency satisfies the frontier (terminal, won't wedge)", () => {
    const cands = [s("B", ["A-1"])];
    // A-1 canceled (steward dropped it as redundant) → B must not block forever.
    expect(selectRunnable(cands, (id) => (id === "A-1" ? "canceled" : undefined), [], 4).run).toEqual(["B"]);
    // Mixed: one completed, one canceled → both terminal, dependent runs.
    const two = [s("C", ["A-1", "A-2"])];
    const state = (id: string) => (id === "A-1" ? "completed" : "canceled");
    expect(selectRunnable(two, state, [], 4).run).toEqual(["C"]);
  });

  test("(c'') a non-terminal dep state (started/backlog) still blocks", () => {
    const cands = [s("B", ["A-1"])];
    expect(selectRunnable(cands, () => "backlog", [], 4).blocked).toEqual(["B"]);
    expect(selectRunnable(cands, () => "started", [], 4).blocked).toEqual(["B"]);
  });

  test("(d) two frontier-ready siblings with overlapping touches: only the FIFO-first runs", () => {
    const cands = [s("A", [], ["src/x/**"]), s("B", [], ["src/x/y.ts"])];
    const { run, deferred } = selectRunnable(cands, noDeps, [], 4); // spare capacity, still serialized
    expect(run).toEqual(["A"]);
    expect(deferred).toEqual(["B"]);
  });

  test("(d') non-overlapping touches both run", () => {
    const cands = [s("A", [], ["src/x/**"]), s("B", [], ["src/y/**"])];
    expect(selectRunnable(cands, noDeps, [], 4).run).toEqual(["A", "B"]);
  });

  test("(e) a candidate overlapping a busy in-flight sibling is deferred", () => {
    const cands = [s("A", [], ["src/x/a.ts"])];
    const { run, deferred } = selectRunnable(cands, noDeps, [["src/x/**"]], 4);
    expect(run).toEqual([]);
    expect(deferred).toEqual(["A"]);
  });

  test("(f) capacity 0 runs nothing (all deferred, none blocked)", () => {
    const cands = [s("A"), s("B")];
    const { run, deferred, blocked } = selectRunnable(cands, noDeps, [], 0);
    expect(run).toEqual([]);
    expect(deferred).toEqual(["A", "B"]);
    expect(blocked).toEqual([]);
  });

  test("multiple deps: all must be completed", () => {
    const cands = [s("C", ["A-1", "A-2"])];
    const state = (id: string) => (id === "A-1" ? "completed" : "started");
    expect(selectRunnable(cands, state, [], 4).blocked).toEqual(["C"]);
    expect(selectRunnable(cands, () => "completed", [], 4).run).toEqual(["C"]);
  });
});

// ---------------------------------------------------------------------------
// deriveImplicitDeps (issue #6 Part 2): ordering derived from touches overlap
// when the decomposer omitted the edge — additive, cycle-safe, logged upstream.
// ---------------------------------------------------------------------------

describe("deriveImplicitDeps", () => {
  const c = (identifier: string, touches: string[] = [], dependsOn: string[] = []): Schedulable =>
    ({ identifier, dependsOn, touches });

  test("overlapping touches derive an edge: the LATER ticket waits for the EARLIER one", () => {
    const { augmented, added } = deriveImplicitDeps([c("FAC-1", ["src/a/**"]), c("FAC-2", ["src/a/util.ts"])]);
    expect(augmented[1]!.dependsOn).toEqual(["FAC-1"]);
    expect(augmented[0]!.dependsOn).toEqual([]);
    expect(added).toEqual([{ identifier: "FAC-2", dependsOn: "FAC-1", overlap: "src/a/util.ts ∩ src/a/**" }]);
  });

  test("no overlap → the SAME objects come back, nothing added (additive guarantee)", () => {
    const a = c("FAC-1", ["src/a/**"]);
    const b = c("FAC-2", ["src/b/**"]);
    const { augmented, added } = deriveImplicitDeps([a, b]);
    expect(augmented[0]).toBe(a);
    expect(augmented[1]).toBe(b);
    expect(added).toEqual([]);
  });

  test("children declaring no touches are never touched (mutex-free today, mutex-free after)", () => {
    const a = c("FAC-1");
    const b = c("FAC-2");
    const { augmented, added } = deriveImplicitDeps([a, b]);
    expect(augmented[0]).toBe(a);
    expect(augmented[1]).toBe(b);
    expect(added).toEqual([]);
  });

  test("an existing explicit edge is preserved verbatim and never duplicated", () => {
    const { augmented, added } = deriveImplicitDeps([c("FAC-1", ["src/a/**"]), c("FAC-2", ["src/a/x.ts"], ["FAC-1"])]);
    expect(augmented[1]!.dependsOn).toEqual(["FAC-1"]);
    expect(added).toEqual([]);
  });

  test("explicit deps are NEVER removed — implicit edges union on top", () => {
    const { augmented } = deriveImplicitDeps([c("FAC-1", ["src/a/**"]), c("FAC-2", ["src/a/x.ts"], ["FAC-99"])]);
    expect(augmented[1]!.dependsOn).toEqual(["FAC-99", "FAC-1"]);
  });

  test("a reverse EXPLICIT edge wins: no implicit edge that would create a cycle", () => {
    // The decomposer explicitly said the EARLIER ticket waits for the LATER one.
    const { augmented, added } = deriveImplicitDeps([c("FAC-1", ["src/a/**"], ["FAC-2"]), c("FAC-2", ["src/a/x.ts"])]);
    expect(added).toEqual([]);
    expect(augmented[0]!.dependsOn).toEqual(["FAC-2"]);
    expect(augmented[1]!.dependsOn).toEqual([]);
  });

  test("a TRANSITIVE explicit path also blocks the implicit edge (no cycle through a middleman)", () => {
    // FAC-1 → FAC-9 → FAC-3 explicitly; FAC-1 and FAC-3 overlap. Adding
    // FAC-3 → FAC-1 would close the loop — must be skipped.
    const { added } = deriveImplicitDeps([
      c("FAC-1", ["src/a/**"], ["FAC-9"]),
      c("FAC-9", [], ["FAC-3"]),
      c("FAC-3", ["src/a/x.ts"]),
    ]);
    expect(added.filter((a) => a.identifier === "FAC-3" && a.dependsOn === "FAC-1")).toEqual([]);
  });

  test("ordering is NUMERIC, not lexicographic: FAC-10 waits for FAC-9", () => {
    const { added } = deriveImplicitDeps([c("FAC-10", ["src/a/**"]), c("FAC-9", ["src/a/**"])]);
    expect(added).toEqual([{ identifier: "FAC-10", dependsOn: "FAC-9", overlap: "src/a/** ∩ src/a/**" }]);
  });

  test("an unparseable identifier sorts LAST — it can wait, but nothing waits on it becoming everyone's prerequisite", () => {
    const { added } = deriveImplicitDeps([c("weird", ["src/a/**"]), c("FAC-2", ["src/a/**"])]);
    expect(added).toEqual([{ identifier: "weird", dependsOn: "FAC-2", overlap: "src/a/** ∩ src/a/**" }]);
  });

  test("three overlapping siblings chain: each later one waits for every earlier one", () => {
    const { augmented } = deriveImplicitDeps([c("FAC-1", ["src/a/**"]), c("FAC-2", ["src/a/**"]), c("FAC-3", ["src/a/**"])]);
    expect(augmented[1]!.dependsOn).toEqual(["FAC-1"]);
    expect(augmented[2]!.dependsOn).toEqual(["FAC-1", "FAC-2"]);
  });

  test("original candidate ORDER is preserved (selectRunnable admits FIFO on it)", () => {
    const { augmented } = deriveImplicitDeps([c("FAC-3", ["src/a/**"]), c("FAC-1", ["src/a/**"]), c("FAC-2", ["src/b/**"])]);
    expect(augmented.map((x) => x.identifier)).toEqual(["FAC-3", "FAC-1", "FAC-2"]);
  });

  test("end-to-end with selectRunnable: the derived edge BLOCKS the later sibling until the earlier completes", () => {
    const { augmented } = deriveImplicitDeps([c("FAC-1", ["src/a/**"]), c("FAC-2", ["src/a/x.ts"])]);
    // While FAC-1 is not complete, FAC-2 is BLOCKED (ordering — before this
    // feature it was merely deferred by the mutex, with no order guarantee).
    const pending = selectRunnable(augmented, () => "unstarted", [], 4);
    expect(pending.run).toEqual(["FAC-1"]);
    expect(pending.blocked).toEqual(["FAC-2"]);
    // Once FAC-1 has COMPLETED (a later tick, where it is no longer a
    // candidate), FAC-2 is on the frontier and runs.
    const later = selectRunnable(augmented.filter((x) => x.identifier === "FAC-2"), () => "completed", [], 4);
    expect(later.run).toEqual(["FAC-2"]);
  });
});
