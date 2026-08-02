import { describe, expect, test } from "bun:test";
import { buildProjectCard, parseBootstrapPlan, scaffoldGatesGreen, slugify } from "../src/bootstrap.ts";
import type { Issue } from "../src/linear.ts";

function mkIssue(partial: Partial<Issue>): Issue {
  return {
    id: "id", identifier: "FAC-1", title: "Untitled", description: "", url: "https://x",
    teamKey: "FAC", teamId: "team", stateName: "Todo", stateType: "unstarted",
    stateDescription: "[factory:queue]", labels: [],
    createdAt: "2026-07-22T00:00:00.000Z", ...partial,
  };
}

describe("slugify", () => {
  test("lowercases, dashes non-alnum, trims", () => {
    expect(slugify("My Cool App!")).toBe("my-cool-app");
    expect(slugify("  Spaces  &  Symbols  ")).toBe("spaces-symbols");
  });
  test("empty / all-symbol input → 'project'", () => {
    expect(slugify("")).toBe("project");
    expect(slugify("!!!")).toBe("project");
  });
});

describe("parseBootstrapPlan", () => {
  test("slugifies the title and applies the default org", () => {
    const plan = parseBootstrapPlan(mkIssue({ title: "Kiwi Quest Tracker" }), "acme");
    expect(plan.org).toBe("acme");
    expect(plan.slug).toBe("kiwi-quest-tracker");
  });

  test("ALWAYS sets visibility private — a public repo can never be produced", () => {
    // Even a title screaming "public" yields a private repo (safety envelope a).
    const plan = parseBootstrapPlan(mkIssue({ title: "Public Marketing Site" }), "acme");
    expect(plan.visibility).toBe("private");
    // The type is the literal "private"; there is no representable public value.
    const asString: string = plan.visibility;
    expect(asString).not.toBe("public");
  });

  test("an explicit ## Repo org/name overrides the title + default org", () => {
    const plan = parseBootstrapPlan(mkIssue({ title: "ignored", description: "## Repo\nwidgets-inc/Dashboard-X" }), "acme");
    expect(plan.org).toBe("widgets-inc");
    expect(plan.slug).toBe("dashboard-x");
    expect(plan.visibility).toBe("private");
  });

  test("stack defaults to bun-typescript, or reads a ## Stack section", () => {
    expect(parseBootstrapPlan(mkIssue({ title: "x" }), "acme").stack).toBe("bun-typescript");
    expect(parseBootstrapPlan(mkIssue({ title: "x", description: "## Stack\nNext.js + Postgres" }), "acme").stack).toBe("Next.js + Postgres");
  });
});

describe("scaffoldGatesGreen — REAL green gates required (Gap-2 un-gameable)", () => {
  const green = new Map([["typecheck", true], ["build", true], ["test", true]]);

  test("typecheck+build+test all present and baseline-green → green", () => {
    const r = scaffoldGatesGreen(["typecheck", "build", "test", "lint"], green);
    expect(r.green).toBe(true);
  });

  test("a failing baseline gate → NOT green (parks; nothing pushed/registered)", () => {
    const baselines = new Map([["typecheck", true], ["build", true], ["test", false]]);
    const r = scaffoldGatesGreen(["typecheck", "build", "test"], baselines);
    expect(r.green).toBe(false);
    expect(r.reason).toContain("test");
  });

  test("a missing required gate script → NOT green", () => {
    const r = scaffoldGatesGreen(["typecheck", "test"], new Map([["typecheck", true], ["test", true]]));
    expect(r.green).toBe(false);
    expect(r.reason).toContain("build");
  });
});

describe("buildProjectCard — the proposed registry card", () => {
  test("starts at merge:review, ships deployEnabled:false, names the repo", () => {
    const card = buildProjectCard({ org: "acme", slug: "kiwi", stack: "bun-typescript", visibility: "private" });
    expect(card).toContain("merge: review");        // earns auto-merge; never starts there
    expect(card).toContain("deployEnabled: false");  // deploy is opt-in + behind the kill-switch
    expect(card).toContain("repos: [acme/kiwi]");
    // deploy/smoke are left for a human to fill (trusted, never ticket text).
    expect(card).not.toMatch(/^deploy:/m);
    expect(card).not.toMatch(/^smoke:/m);
  });
});
