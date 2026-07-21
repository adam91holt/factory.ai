import { describe, expect, test } from "bun:test";
import { parseFactoryMeta, renderFactoryMeta, withFactoryMeta, type FactoryMeta } from "../src/meta.ts";

describe("depends_on / touches round-trip", () => {
  test("render→parse preserves both array keys", () => {
    const meta: FactoryMeta = { repo: "acme/w", type: "task", depends_on: ["FAC-123", "FAC-124"], touches: ["src/a/**", "src/b.ts"] };
    const rendered = renderFactoryMeta(meta);
    expect(rendered).toContain("depends_on: FAC-123, FAC-124");
    expect(rendered).toContain("touches: src/a/**, src/b.ts");
    const parsed = parseFactoryMeta(`${rendered}\n\nbody`);
    expect(parsed.depends_on).toEqual(["FAC-123", "FAC-124"]);
    expect(parsed.touches).toEqual(["src/a/**", "src/b.ts"]);
  });

  test("the [a-z_] key fix actually parses depends_on (the bug being fixed)", () => {
    // With the old /^\s*([a-z]+)…/ regex the "_" broke the key match and this
    // line was silently dropped. Prove it parses now.
    const parsed = parseFactoryMeta("<!-- factory\ndepends_on: FAC-9\n-->");
    expect(parsed.depends_on).toEqual(["FAC-9"]);
  });
});

describe("depends_on validation", () => {
  test("malformed identifiers are dropped, well-formed ones kept", () => {
    const parsed = parseFactoryMeta("<!-- factory\ndepends_on: FAC-1, garbage, foo-2, ABC-42, -3\n-->");
    expect(parsed.depends_on).toEqual(["FAC-1", "ABC-42"]);
  });

  test("a depends_on with no valid entries yields undefined (not [])", () => {
    const parsed = parseFactoryMeta("<!-- factory\ndepends_on: nope, also-nope\n-->");
    expect(parsed.depends_on).toBeUndefined();
  });
});

describe("touches caps", () => {
  test("entries longer than 200 chars are dropped", () => {
    const long = "src/" + "a".repeat(210);
    const parsed = parseFactoryMeta(`<!-- factory\ntouches: src/ok.ts, ${long}\n-->`);
    expect(parsed.touches).toEqual(["src/ok.ts"]);
  });

  test("no more than 32 entries survive", () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`).join(", ");
    const parsed = parseFactoryMeta(`<!-- factory\ntouches: ${many}\n-->`);
    expect(parsed.touches).toHaveLength(32);
  });
});

describe("backward-compatibility", () => {
  test("a description with NO new keys renders a byte-identical block to today", () => {
    // The pre-Gap-1 shape: repo + type + model only. Its rendered block must be
    // unchanged so existing children's descriptions are never rewritten.
    const meta: FactoryMeta = { repo: "acme/widgets", type: "task", model: "sonnet" };
    expect(renderFactoryMeta(meta)).toBe("<!-- factory\nrepo: acme/widgets\ntype: task\nmodel: sonnet\n-->");
  });

  test("empty arrays are omitted from the block", () => {
    const meta: FactoryMeta = { repo: "acme/w", type: "task", depends_on: [], touches: [] };
    expect(renderFactoryMeta(meta)).toBe("<!-- factory\nrepo: acme/w\ntype: task\n-->");
  });

  test("withFactoryMeta stamp is unchanged when no DAG keys are supplied", () => {
    const stamped = withFactoryMeta("## Goal\ndo it", { repo: "acme/w", type: "task" });
    expect(stamped.startsWith("<!-- factory\nrepo: acme/w\ntype: task\n-->")).toBe(true);
    expect(stamped).not.toContain("depends_on");
    expect(stamped).not.toContain("touches");
  });
});

describe("start-anchored guarantee still holds for the new keys", () => {
  test("a depends_on line buried in prose is ignored", () => {
    // Only a block at offset 0 is authoritative — a "depends_on:" line inside the
    // body (or a pasted example) must never confer scheduling edges.
    const desc = "Some prose.\n\n<!-- factory\ndepends_on: FAC-99\n-->\n\nmore";
    expect(parseFactoryMeta(desc).depends_on).toBeUndefined();
  });

  test("touches only honored from a start-anchored block", () => {
    const desc = "intro\n<!-- factory\ntouches: src/x.ts\n-->";
    expect(parseFactoryMeta(desc).touches).toBeUndefined();
  });
});
