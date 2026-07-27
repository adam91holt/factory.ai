import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChildren, createChildren, findUndeclaredGlueTouches, type ChildSpec } from "../src/plan.ts";
import { config } from "../src/config.ts";

// A model in the configured roster (parseFactoryMeta drops unlisted models — a
// security allowlist), so this test survives any roster (e.g. all-gpt-5.6-sol).
const ROSTER_MODEL = Object.values(config.models)[0]!;
import { parseFactoryMeta } from "../src/meta.ts";

// Minimal body that clears readChildren's `description.length > 50` filter.
const FILLER = "## Goal\nDeliver a slice of the epic that stands on its own here.";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "plan-test-")); mkdirSync(dir, { recursive: true }); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeChild(name: string, body: string): void {
  writeFileSync(join(dir, name), body);
}

describe("readChildren — Depends-on / Touches parsing", () => {
  test("parses ordinals and globs from the sections", () => {
    writeChild("01-base.md", `# Base\n${FILLER}\n\n## Touches\nsrc/a/**, src/b.ts`);
    writeChild("02-dep.md", `# Dep\n${FILLER}\n\n## Depends-on\n01\n\n## Touches\nsrc/c/**`);
    const children = readChildren(dir);
    const first = children.find((c) => c.ordinal === 1)!;
    const second = children.find((c) => c.ordinal === 2)!;
    expect(first.dependsOn).toEqual([]);
    expect(first.touches).toEqual(["src/a/**", "src/b.ts"]);
    expect(second.dependsOn).toEqual([1]);
    expect(second.touches).toEqual(["src/c/**"]);
  });

  test("tolerates bulleted / multi-ordinal Depends-on like '01, 02'", () => {
    writeChild("01-a.md", `# A\n${FILLER}`);
    writeChild("02-b.md", `# B\n${FILLER}`);
    writeChild("03-c.md", `# C\n${FILLER}\n\n## Depends-on\n- 01\n- 02`);
    const c = readChildren(dir).find((x) => x.ordinal === 3)!;
    expect(c.dependsOn).toEqual([1, 2]);
  });

  test("a child declaring neither section yields empty dependsOn/touches", () => {
    writeChild("01-a.md", `# A\n${FILLER}`);
    writeChild("02-b.md", `# B\n${FILLER}`);
    const children = readChildren(dir);
    expect(children.every((c) => c.dependsOn.length === 0 && c.touches.length === 0)).toBe(true);
  });
});

describe("readChildren — DAG validation (fail-closed → epic parks)", () => {
  test("forward-ref throws", () => {
    writeChild("01-a.md", `# A\n${FILLER}\n\n## Depends-on\n02`);
    writeChild("02-b.md", `# B\n${FILLER}`);
    expect(() => readChildren(dir)).toThrow(/forward\/equal dependency/);
  });

  test("self-ref throws", () => {
    writeChild("01-a.md", `# A\n${FILLER}`);
    writeChild("02-b.md", `# B\n${FILLER}\n\n## Depends-on\n02`);
    expect(() => readChildren(dir)).toThrow(/depends on itself/);
  });

  test("missing-ref throws (a lower ordinal that no file declares)", () => {
    // 03 depends on 02, but only 01 and 03 exist — a backward edge to a gap.
    writeChild("01-a.md", `# A\n${FILLER}`);
    writeChild("03-c.md", `# C\n${FILLER}\n\n## Depends-on\n02`);
    expect(() => readChildren(dir)).toThrow(/missing ordinal/);
  });

  test("a cyclic declaration is impossible — an edge to an equal/higher ordinal throws", () => {
    // A→B and B→A cannot both be expressed with backward-only edges: whichever
    // is numbered second must forward-reference, which the validator rejects.
    writeChild("01-a.md", `# A\n${FILLER}\n\n## Depends-on\n02`);
    writeChild("02-b.md", `# B\n${FILLER}\n\n## Depends-on\n01`);
    expect(() => readChildren(dir)).toThrow();
  });
});

describe("findUndeclaredGlueTouches — Gap 9 advisory shared/glue check", () => {
  test("flags a child that mentions a glue file in its body but not in ## Touches", () => {
    const children: ChildSpec[] = [
      {
        title: "Add nav", ordinal: 1, dependsOn: [], touches: ["src/nav/**"],
        description: "## Implementation approach\nAdd a NavBar and wire it into src/index.css for the new theme colors.",
      },
    ];
    const warnings = findUndeclaredGlueTouches(children);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('child 1 ("Add nav")');
    expect(warnings[0]).toContain("index.css");
  });

  test("does not flag a child that DID declare the glue file in ## Touches", () => {
    const children: ChildSpec[] = [
      {
        title: "Theme", ordinal: 1, dependsOn: [], touches: ["src/index.css"],
        description: "## Implementation approach\nUpdate src/index.css with the new palette.",
      },
    ];
    expect(findUndeclaredGlueTouches(children)).toEqual([]);
  });

  test("does not flag a child whose body never mentions any known glue file", () => {
    const children: ChildSpec[] = [
      { title: "Widget", ordinal: 1, dependsOn: [], touches: ["src/widget/**"], description: "## Goal\nBuild a standalone widget." },
    ];
    expect(findUndeclaredGlueTouches(children)).toEqual([]);
  });

  test("flags each undeclared glue mention across multiple children", () => {
    const children: ChildSpec[] = [
      { title: "A", ordinal: 1, dependsOn: [], touches: [], description: "Adds a dependency, so it edits package.json too." },
      { title: "B", ordinal: 2, dependsOn: [], touches: [], description: "Adds a new route to the router." },
    ];
    const warnings = findUndeclaredGlueTouches(children);
    expect(warnings.some((w) => w.includes("package.json"))).toBe(true);
    expect(warnings.some((w) => w.includes("router.ts") || w.includes("router.tsx"))).toBe(false); // "router" alone isn't a basename match — only exact known filenames trigger
  });

  test("is case-insensitive and matches by basename regardless of declared path form", () => {
    const children: ChildSpec[] = [
      { title: "Layout", ordinal: 1, dependsOn: [], touches: ["app/Layout.tsx"], description: "Edits the shared layout.tsx shell." },
    ];
    // Declared as "app/Layout.tsx" (basename "layout.tsx" after lowercasing) — matches the mention, no warning.
    expect(findUndeclaredGlueTouches(children)).toEqual([]);
  });
});

describe("createChildren — ordinal→identifier resolution", () => {
  test("resolves depends_on ordinals to sequential Linear identifiers", async () => {
    const children: ChildSpec[] = [
      { title: "A", description: "body A", ordinal: 1, dependsOn: [], touches: ["src/a/**"] },
      { title: "B", description: "body B", ordinal: 2, dependsOn: [1], touches: ["src/b/**"] },
      { title: "C", description: "body C", ordinal: 3, dependsOn: [1, 2], touches: [] },
    ];
    // Stubbed create returning sequential keys, capturing each stamped body.
    const stamped = new Map<string, string>();
    let n = 100;
    const created = await createChildren(children, { repo: "acme/w" }, async (child, body) => {
      const id = `FAC-${n++}`;
      stamped.set(child.title, body);
      return id;
    });
    expect(created).toEqual(["FAC-100", "FAC-101", "FAC-102"]);
    // B depends on A → FAC-100; C depends on A,B → FAC-100, FAC-101.
    expect(parseFactoryMeta(stamped.get("B")!).depends_on).toEqual(["FAC-100"]);
    expect(parseFactoryMeta(stamped.get("C")!).depends_on).toEqual(["FAC-100", "FAC-101"]);
    expect(parseFactoryMeta(stamped.get("A")!).touches).toEqual(["src/a/**"]);
  });

  test("a child declaring neither section produces an unchanged stamp (no depends_on/touches keys)", async () => {
    const children: ChildSpec[] = [
      { title: "Only", description: "just a body", ordinal: 1, dependsOn: [], touches: [] },
    ];
    let body = "";
    await createChildren(children, { repo: "acme/w", model: ROSTER_MODEL }, async (_c, stampedBody) => { body = stampedBody; return "FAC-7"; });
    const meta = parseFactoryMeta(body);
    expect(meta.depends_on).toBeUndefined();
    expect(meta.touches).toBeUndefined();
    expect(meta.repo).toBe("acme/w");
    expect(meta.model).toBe(ROSTER_MODEL);
  });
});

describe("createChildren — Gap 1 merge-race: implicit overlap edges", () => {
  async function stampAll(children: ChildSpec[]): Promise<Map<string, string>> {
    const stamped = new Map<string, string>();
    let n = 100;
    await createChildren(children, { repo: "acme/w" }, async (child, body) => {
      const id = `FAC-${n++}`;
      stamped.set(child.title, body);
      return id;
    });
    return stamped;
  }

  test("two siblings with overlapping touches and NO declared deps: the later gains an implicit depends_on", async () => {
    const children: ChildSpec[] = [
      { title: "A", description: "body A", ordinal: 1, dependsOn: [], touches: ["src/x/**"] },
      { title: "B", description: "body B", ordinal: 2, dependsOn: [], touches: ["src/x/y.ts"] },
    ];
    const stamped = await stampAll(children);
    // B touches a path under A's glob → B waits for A to MERGE, not merely leave inFlight.
    expect(parseFactoryMeta(stamped.get("A")!).depends_on).toBeUndefined();
    expect(parseFactoryMeta(stamped.get("B")!).depends_on).toEqual(["FAC-100"]);
  });

  test("non-overlapping siblings gain no implicit edge (stays parallel)", async () => {
    const children: ChildSpec[] = [
      { title: "A", description: "body A", ordinal: 1, dependsOn: [], touches: ["src/x/**"] },
      { title: "B", description: "body B", ordinal: 2, dependsOn: [], touches: ["src/y/**"] },
    ];
    const stamped = await stampAll(children);
    expect(parseFactoryMeta(stamped.get("B")!).depends_on).toBeUndefined();
  });

  test("an explicit dep that also overlaps is listed exactly once (de-duped, sorted)", async () => {
    const children: ChildSpec[] = [
      { title: "A", description: "body A", ordinal: 1, dependsOn: [], touches: ["src/x/**"] },
      { title: "B", description: "body B", ordinal: 2, dependsOn: [], touches: ["src/z/**"] },
      // C explicitly depends on B (ordinal 2) AND overlaps A (ordinal 1) via touches.
      { title: "C", description: "body C", ordinal: 3, dependsOn: [2], touches: ["src/x/deep.ts"] },
    ];
    const stamped = await stampAll(children);
    // Union of {2} explicit and {1} overlap → both, ascending, no duplicates.
    expect(parseFactoryMeta(stamped.get("C")!).depends_on).toEqual(["FAC-100", "FAC-101"]);
  });

  test("a child with empty touches neither attracts nor gains an overlap edge", async () => {
    const children: ChildSpec[] = [
      { title: "A", description: "body A", ordinal: 1, dependsOn: [], touches: [] },
      { title: "B", description: "body B", ordinal: 2, dependsOn: [], touches: ["src/x/**"] },
    ];
    const stamped = await stampAll(children);
    expect(parseFactoryMeta(stamped.get("B")!).depends_on).toBeUndefined();
  });
});
