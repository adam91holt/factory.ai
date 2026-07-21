import { describe, expect, test } from "bun:test";
import { isEligible, missingSections, wantsBrowserVerification } from "../src/loop.ts";
import { decideFreshness, parsePrecondition, type PerCheck } from "../src/precondition.ts";
import type { Issue } from "../src/linear.ts";

const issue = (description: string): Issue => ({
  id: "id-1", identifier: "FAC-1", title: "t", description, url: "https://linear.app/x",
  teamKey: "FAC", teamId: "team-1", stateName: "Todo", stateType: "unstarted",
  labels: [], createdAt: "2026-07-01T00:00:00.000Z",
});

const FULL_CONTRACT = [
  "## Goal", "do the thing", "",
  "## Outcomes", "- [ ] it works", "",
  "## Repo", "acme/widgets", "",
  "## Verifications", "* Automated: none",
].join("\n");

describe("missingSections", () => {
  test("a contract-complete ticket is missing nothing", () => {
    expect(missingSections(issue(FULL_CONTRACT))).toEqual([]);
  });

  test("an empty description is missing every required section", () => {
    expect(missingSections(issue(""))).toEqual(["## Goal", "## Outcomes", "## Repo", "## Verifications"]);
  });

  test("reports exactly the absent sections", () => {
    expect(missingSections(issue("## Goal\nx\n## Repo\nacme/w")))
      .toEqual(["## Outcomes", "## Verifications"]);
  });
});

describe("isEligible", () => {
  test("complete sections + parseable repo → eligible", () => {
    expect(isEligible(issue(FULL_CONTRACT))).toBe(true);
  });

  test("all sections present but no parseable org/name → NOT eligible", () => {
    const desc = FULL_CONTRACT.replace("acme/widgets", "(decide later)");
    expect(missingSections(issue(desc))).toEqual([]); // sections are fine…
    expect(isEligible(issue(desc))).toBe(false);      // …but the repo gate fails
  });

  test("missing a section → not eligible", () => {
    expect(isEligible(issue("## Repo\nacme/widgets"))).toBe(false);
  });
});

describe("wantsBrowserVerification", () => {
  test("explicit needs:browser-test marker triggers, case-insensitive", () => {
    expect(wantsBrowserVerification("please needs:browser-test this")).toBe(true);
    expect(wantsBrowserVerification("NEEDS:BROWSER-TEST")).toBe(true);
  });

  test("a Visual item under ## Verifications triggers", () => {
    expect(wantsBrowserVerification("## Verifications\n* Visual: check the dashboard renders")).toBe(true);
    expect(wantsBrowserVerification("## Verifications\n* visual: lowercase too")).toBe(true);
  });

  test("'visual' BEFORE the Verifications section does not trigger", () => {
    expect(wantsBrowserVerification("A visual overhaul.\n\n## Verifications\n* Automated: bun test")).toBe(false);
  });

  test("no Verifications section and no marker → false", () => {
    expect(wantsBrowserVerification("plain ticket text")).toBe(false);
    expect(wantsBrowserVerification("")).toBe(false);
  });

  test("'Visual: n/a' still triggers (gate is textual; hasPlaywright re-gates)", () => {
    // Documents current behavior: any 'visual' token inside the section counts.
    expect(wantsBrowserVerification("## Verifications\n* Visual: n/a")).toBe(true);
  });
});

// The freshness gate the loop consults before the implementer (Gap 4). processIssue
// maps decideFreshness's action → { cancel: resolveStale, park: park, proceed:
// build }. We assert the mapping decision here (pure), consistent with the other
// loop tests not spinning up the pipeline.
describe("freshness gate decision mapping", () => {
  const row = (raw: string, status: PerCheck) => {
    const p = parsePrecondition(raw);
    if (!p) throw new Error(`bad fixture: ${raw}`);
    return { p, status, reason: `${raw}: ${status}` };
  };

  test("proceed: the normal case — branch not yet delivered, no world-premise flipped", () => {
    expect(decideFreshness([row("undelivered factory/fac-1", "hold")]).action).toBe("proceed");
  });

  test("cancel: the ticket's own branch PR already merged (FAC-20 at ticket level) → resolveStale", () => {
    expect(decideFreshness([row("undelivered factory/fac-1", "moot")]).action).toBe("cancel");
  });

  test("cancel: a steward follow-up whose authored premise is fully satisfied → resolveStale", () => {
    expect(decideFreshness([row("undelivered factory/fac-99", "hold"), row("pr-open acme/w#4", "moot")]).action).toBe("cancel");
  });

  test("park: partial staleness — one premise flipped, another still holds → human decides", () => {
    expect(decideFreshness([row("pr-open acme/w#4", "moot"), row("path-missing src/x.ts", "hold")]).action).toBe("park");
  });

  test("park: an authored premise can't be confirmed (no moot) → human decides", () => {
    expect(decideFreshness([row("pr-open acme/w#4", "unknown"), row("path-exists src/x.ts", "hold")]).action).toBe("park");
  });
});
