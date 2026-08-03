import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChildren, createChildren, findUndeclaredGlueTouches, glueTokensFor, type ChildSpec } from "../src/plan.ts";
import { deriveImplicitDeps } from "../src/dag.ts";
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

// The WCC conflict cascade (2026-08-03): 6 children all edited
// index.html/main.ts/style.css but declared only their feature files, so the
// DAG ran them in parallel and they collided at merge. glueTokensFor +
// readChildren augmentation serialise glue-sharing children by construction.
describe("glue serialisation — the anti-collision fix", () => {
  test("glueTokensFor picks up the glue files the WCC conflict was on (declared OR mentioned)", () => {
    const tokens = glueTokensFor({
      description: "Wire the map into main.ts and add styles to style.css; edits index.html for the mount.",
      touches: ["src/map.ts"],
    });
    expect(tokens).toContain("main.ts");
    expect(tokens).toContain("style.css");
    expect(tokens).toContain("index.html");
    expect(tokens).not.toContain("router.ts"); // unmentioned glue is not added
  });

  test("readChildren augments touches with referenced glue, so two glue-sharing siblings OVERLAP", () => {
    writeChild("01-map.md", `# Map\n${FILLER}\n\nWire it into src/main.ts and src/style.css.\n\n## Touches\nsrc/map.ts`);
    writeChild("02-detail.md", `# Detail\n${FILLER}\n\nMount from src/main.ts; add src/style.css rules.\n\n## Touches\nsrc/detail.ts`);
    const children = readChildren(dir);
    const map = children.find((c) => c.ordinal === 1)!;
    const detail = children.find((c) => c.ordinal === 2)!;
    // each keeps its own feature file AND gains the shared glue tokens
    expect(map.touches).toContain("src/map.ts");
    expect(map.touches).toEqual(expect.arrayContaining(["main.ts", "style.css"]));
    expect(detail.touches).toEqual(expect.arrayContaining(["main.ts", "style.css"]));
  });

  test("integration: glue-sharing siblings get a derived depends_on edge (serialised, not parallel)", () => {
    writeChild("01-map.md", `# Map\n${FILLER}\n\nEdits src/main.ts.\n\n## Touches\nsrc/map.ts`);
    writeChild("02-detail.md", `# Detail\n${FILLER}\n\nAlso edits src/main.ts.\n\n## Touches\nsrc/detail.ts`);
    const children = readChildren(dir);
    const schedulable = children.map((c) => ({ identifier: `FAC-${c.ordinal}`, dependsOn: c.dependsOn.map((d) => `FAC-${d}`), touches: c.touches }));
    const { added } = deriveImplicitDeps(schedulable);
    // FAC-2 now waits for FAC-1 because they share the main.ts token
    expect(added.some((a) => a.identifier === "FAC-2" && a.dependsOn === "FAC-1")).toBe(true);
  });

  test("non-glue-sharing siblings still run in parallel (no over-serialisation)", () => {
    writeChild("01-a.md", `# A\n${FILLER}\n\n## Touches\nsrc/a/**`);
    writeChild("02-b.md", `# B\n${FILLER}\n\n## Touches\nsrc/b/**`);
    const children = readChildren(dir);
    const schedulable = children.map((c) => ({ identifier: `FAC-${c.ordinal}`, dependsOn: [] as string[], touches: c.touches }));
    expect(deriveImplicitDeps(schedulable).added).toHaveLength(0);
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

// execution-profiles: the epic's WHOLE per-stage models map propagates to every
// child alongside (not instead of) the legacy single `model` override.
describe("createChildren — propagates the epic's per-stage models map (execution-profiles)", () => {
  const ROSTER_VALUES = Object.values(config.models) as string[];
  const ROSTER_MODEL_2 = ROSTER_VALUES.find((m) => m !== ROSTER_MODEL) ?? ROSTER_MODEL;

  test("every child is stamped with the epic's models map", async () => {
    const children: ChildSpec[] = [
      { title: "A", description: "body A", ordinal: 1, dependsOn: [], touches: [] },
      { title: "B", description: "body B", ordinal: 2, dependsOn: [], touches: [] },
    ];
    const stamped = new Map<string, string>();
    await createChildren(
      children,
      { repo: "acme/w", models: { "*": ROSTER_MODEL, reviewerClaude: ROSTER_MODEL_2 } },
      async (child, body) => { stamped.set(child.title, body); return `FAC-${child.title}`; },
    );
    for (const title of ["A", "B"]) {
      expect(parseFactoryMeta(stamped.get(title)!).models).toEqual({ "*": ROSTER_MODEL, reviewerClaude: ROSTER_MODEL_2 });
    }
  });

  test("models and the legacy model field propagate TOGETHER when both are set", async () => {
    let body = "";
    const children: ChildSpec[] = [{ title: "Only", description: "body", ordinal: 1, dependsOn: [], touches: [] }];
    await createChildren(
      children,
      { repo: "acme/w", model: ROSTER_MODEL, models: { fixer: ROSTER_MODEL_2 } },
      async (_c, stampedBody) => { body = stampedBody; return "FAC-1"; },
    );
    const meta = parseFactoryMeta(body);
    expect(meta.model).toBe(ROSTER_MODEL);
    expect(meta.models).toEqual({ fixer: ROSTER_MODEL_2 });
  });

  test("an absent/empty models map on the epic omits the models: key on children entirely (back-compat)", async () => {
    let body = "";
    const children: ChildSpec[] = [{ title: "Only", description: "body", ordinal: 1, dependsOn: [], touches: [] }];
    await createChildren(children, { repo: "acme/w", models: {} }, async (_c, stampedBody) => { body = stampedBody; return "FAC-1"; });
    expect(parseFactoryMeta(body).models).toBeUndefined();
    expect(body).not.toContain("models:");
  });
});

// execution-profiles: the epic's effort (single default or per-stage map)
// propagates to every child alongside models, mirroring the block above.
describe("createChildren — propagates the epic's effort (execution-profiles)", () => {
  test("a scalar effort default is stamped onto every child", async () => {
    const children: ChildSpec[] = [
      { title: "A", description: "body A", ordinal: 1, dependsOn: [], touches: [] },
      { title: "B", description: "body B", ordinal: 2, dependsOn: [], touches: [] },
    ];
    const stamped = new Map<string, string>();
    await createChildren(children, { repo: "acme/w", effort: "high" },
      async (child, body) => { stamped.set(child.title, body); return `FAC-${child.title}`; });
    for (const title of ["A", "B"]) {
      expect(parseFactoryMeta(stamped.get(title)!).effort).toBe("high");
    }
  });

  test("a per-stage effort map is stamped onto every child", async () => {
    let body = "";
    const children: ChildSpec[] = [{ title: "Only", description: "body", ordinal: 1, dependsOn: [], touches: [] }];
    await createChildren(children, { repo: "acme/w", effort: { fixer: "low", implementer: "high" } },
      async (_c, stampedBody) => { body = stampedBody; return "FAC-1"; });
    expect(parseFactoryMeta(body).effort).toEqual({ fixer: "low", implementer: "high" });
  });

  test("effort and models propagate TOGETHER when both are set", async () => {
    let body = "";
    const children: ChildSpec[] = [{ title: "Only", description: "body", ordinal: 1, dependsOn: [], touches: [] }];
    await createChildren(children, { repo: "acme/w", models: { fixer: ROSTER_MODEL }, effort: "low" },
      async (_c, stampedBody) => { body = stampedBody; return "FAC-1"; });
    const meta = parseFactoryMeta(body);
    expect(meta.models).toEqual({ fixer: ROSTER_MODEL });
    expect(meta.effort).toBe("low");
  });

  test("an absent/empty effort on the epic omits the effort: key on children entirely (back-compat)", async () => {
    let body = "";
    const children: ChildSpec[] = [{ title: "Only", description: "body", ordinal: 1, dependsOn: [], touches: [] }];
    await createChildren(children, { repo: "acme/w", effort: {} }, async (_c, stampedBody) => { body = stampedBody; return "FAC-1"; });
    expect(parseFactoryMeta(body).effort).toBeUndefined();
    expect(body).not.toContain("effort:");
  });

  test("no effort field at all (undefined) omits the effort: key too", async () => {
    let body = "";
    const children: ChildSpec[] = [{ title: "Only", description: "body", ordinal: 1, dependsOn: [], touches: [] }];
    await createChildren(children, { repo: "acme/w" }, async (_c, stampedBody) => { body = stampedBody; return "FAC-1"; });
    expect(parseFactoryMeta(body).effort).toBeUndefined();
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
