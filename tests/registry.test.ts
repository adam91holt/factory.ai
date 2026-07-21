import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { loadProjects, parseProjectCard, projectForRepo } from "../src/registry.ts";

// Point the registry at a throwaway dir so tests never depend on repo state.
let dir = "";
const originalProjectsDir = config.projectsDir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "factory-projects-"));
  config.projectsDir = dir;
});
afterEach(() => {
  config.projectsDir = originalProjectsDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content: string) => writeFileSync(join(dir, `${name}.md`), content);

describe("parseProjectCard", () => {
  test("parses a well-formed card into a ProjectCard", () => {
    const card = parseProjectCard(
      ["---", "name: kiwi", "team: FAC", "repos: [acme/kiwi, acme/kiwi-api]", "merge: shadow",
        "deploy: bun run deploy", "smoke: bun run smoke", "deployEnabled: true", "---", "", "Notes."].join("\n"),
      "kiwi",
    );
    expect(card).toEqual({
      name: "kiwi", team: "FAC", repos: ["acme/kiwi", "acme/kiwi-api"], merge: "shadow",
      deploy: "bun run deploy", smoke: "bun run smoke", deployEnabled: true,
    });
  });

  test("an unknown merge value defaults to the SAFEST (review), never widens authority", () => {
    const card = parseProjectCard(["---", "name: x", "team: FAC", "repos: [a/b]", "merge: superauto", "---"].join("\n"), "x");
    expect(card?.merge).toBe("review");
  });

  test("deployEnabled fails closed — only a bare `true` arms it", () => {
    for (const v of ["yes", "1", '"true"', "TRUE ok", ""]) {
      const card = parseProjectCard(["---", "name: x", "team: FAC", "repos: [a/b]", `deployEnabled: ${v}`, "---"].join("\n"), "x");
      expect(card?.deployEnabled).toBe(false);
    }
    const armed = parseProjectCard(["---", "name: x", "team: FAC", "repos: [a/b]", "deployEnabled: true", "---"].join("\n"), "x");
    expect(armed?.deployEnabled).toBe(true);
  });

  test("no frontmatter → null (tolerant, never throws)", () => {
    expect(parseProjectCard("just prose", "x")).toBeNull();
  });
});

describe("loadProjects / projectForRepo", () => {
  test("loads a well-formed card and finds the owning card for a repo", () => {
    write("kiwi", ["---", "name: kiwi", "team: FAC", "repos: [acme/kiwi]", "merge: review", "---"].join("\n"));
    const cards = loadProjects();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.name).toBe("kiwi");
    expect(projectForRepo("acme/kiwi")?.name).toBe("kiwi");
    expect(projectForRepo("acme/unknown")).toBeNull();
  });

  test("a deployEnabled:false card yields no deploy (deploy stays off by default)", () => {
    write("kiwi", ["---", "name: kiwi", "team: FAC", "repos: [acme/kiwi]", "merge: review", "deploy: echo go", "---"].join("\n"));
    const card = projectForRepo("acme/kiwi");
    expect(card?.deployEnabled).toBe(false);
  });

  test("malformed / missing-field cards are tolerated (skipped), never throw", () => {
    write("broken", "no frontmatter here");
    write("nofields", ["---", "name: nofields", "---"].join("\n")); // missing team/repos
    write("good", ["---", "name: good", "team: FAC", "repos: [a/b]", "---"].join("\n"));
    const cards = loadProjects();
    expect(cards.map((c) => c.name)).toEqual(["good"]);
  });

  test("missing projects dir → [] (never throws)", () => {
    config.projectsDir = join(dir, "does-not-exist");
    expect(loadProjects()).toEqual([]);
    expect(projectForRepo("a/b")).toBeNull();
  });

  test("empty repo argument → null", () => {
    expect(projectForRepo("")).toBeNull();
  });
});
