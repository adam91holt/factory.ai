import { describe, expect, test } from "bun:test";
import { staticPrefix, globsOverlap, selectRunnable, type Schedulable } from "../src/dag.ts";

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
