import { describe, expect, test } from "bun:test";
import { isEligible, missingSections, wantsBrowserVerification, mapBrowserEvidence, parseSecurityVerdict, securityReviewOutstanding, countDiffLines, budgetExpired, budgetExpiredReason } from "../src/loop.ts";
import { decideFreshness, parsePrecondition, type PerCheck } from "../src/precondition.ts";
import { buildMergeEvidence, decideMerge } from "../src/merge-ladder.ts";
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

// Gap 2 browser-evidence mapping — the loop maps the tester's verdict (or its
// absence) to a BrowserEvidence value the merge ladder consumes. Pure helper,
// derived from the REPO's requirement and the tester output, never ticket text.
describe("mapBrowserEvidence", () => {
  test("a UI repo that REQUIRES browser evidence but ran no tester → missing (blocks auto)", () => {
    expect(mapBrowserEvidence(true, null)).toBe("missing");
  });

  test("a non-UI repo with no tester → not-required", () => {
    expect(mapBrowserEvidence(false, null)).toBe("not-required");
  });

  test("tester verdicts map pass/partial/fail", () => {
    expect(mapBrowserEvidence(true, "drove the screen\nVERDICT: pass")).toBe("pass");
    expect(mapBrowserEvidence(true, "some items manual\nVERDICT: partial")).toBe("partial");
    expect(mapBrowserEvidence(true, "the button 404s\nVERDICT: fail")).toBe("fail");
  });

  test("a tester that ran but produced no verdict falls back to missing/not-required", () => {
    expect(mapBrowserEvidence(true, "I could not determine anything")).toBe("missing");
    expect(mapBrowserEvidence(false, "I could not determine anything")).toBe("not-required");
  });
});

describe("parseSecurityVerdict", () => {
  test("maps an explicit SECURITY: fail to fail (folds into holdReasons/needsHuman)", () => {
    expect(parseSecurityVerdict("found an injection\nSECURITY: fail")).toBe("fail");
  });
  test("anything else is pass (a missing verdict must not silently block)", () => {
    expect(parseSecurityVerdict("no issues found\nSECURITY: pass")).toBe("pass");
    expect(parseSecurityVerdict("no line at all")).toBe("pass");
  });
});

// Gap-2 fail-open fix: a security review that was WARRANTED (non-trivial diff) but
// never produced a verdict (budget/deadline expiry or a stage error left it null)
// must block the merge ACTION, not slip past decideMerge (which blocks only on an
// explicit "fail"). The loop folds a true result into needsHuman so the PR degrades
// to human review instead of auto-merging with the security gate silently skipped.
describe("securityReviewOutstanding", () => {
  test("non-trivial diff with a null verdict is outstanding (blocks auto-merge)", () => {
    expect(securityReviewOutstanding(20, null)).toBe(true);
    expect(securityReviewOutstanding(500, null)).toBe(true);
  });

  test("a completed verdict (pass or fail) is NOT outstanding — it already gated", () => {
    expect(securityReviewOutstanding(500, "pass")).toBe(false);
    expect(securityReviewOutstanding(500, "fail")).toBe(false);
  });

  test("a trivial diff below the threshold never warranted a review → not outstanding", () => {
    expect(securityReviewOutstanding(19, null)).toBe(false);
    expect(securityReviewOutstanding(0, null)).toBe(false);
  });

  test("an outstanding review folds into needsHuman → decideMerge cannot act", () => {
    // The loop passes needsHuman:true when securityReviewOutstanding is true; assert
    // that this alone forces wouldMerge=false even at the most permissive tier.
    const ev = buildMergeEvidence({
      summary: { green: true, strength: "strong" }, guarded: [], needsHuman: true,
      security: null, browser: "not-required", diffLines: 500,
    });
    const d = decideMerge("auto", ev, { lowRiskMaxDiff: 40 });
    expect(d.wouldMerge).toBe(false);
    expect(d.act).toBe(false);
  });
});

describe("countDiffLines", () => {
  test("counts changed lines, excluding the +++/--- file headers", () => {
    const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1,2 @@", "-old", "+new", "+added", " context"].join("\n");
    expect(countDiffLines(diff)).toBe(3);
  });
});

// G2-prereq0 (kill switch drain awareness): processIssue's Budget class folds
// isDraining() into `expired` so every existing "if (budget.expired) park" guard
// and "!budget.expired" loop/gate ALREADY sprinkled through the pipeline also
// halts once a human hits /stop — a drained issue must not spend on the NEXT
// stage. budgetExpired/budgetExpiredReason are the pure decision Budget
// delegates to; asserted directly here since Budget itself isn't exported and
// isDraining() reads control.ts's module-level flag (out of scope for a pure
// unit test — control.test.ts covers that flag's own transitions).
describe("budgetExpired (G2-prereq0: kill switch must halt an in-flight issue)", () => {
  const future = Date.now() + 60_000;
  const past = Date.now() - 1;

  test("draining forces expired even with time and budget both remaining", () => {
    expect(budgetExpired(Date.now(), future, 5, true)).toBe(true);
  });

  test("not draining, deadline and budget both fine → not expired", () => {
    expect(budgetExpired(Date.now(), future, 5, false)).toBe(false);
  });

  test("not draining but past the deadline → expired", () => {
    expect(budgetExpired(Date.now(), past, 5, false)).toBe(true);
  });

  test("not draining but budget exhausted → expired", () => {
    expect(budgetExpired(Date.now(), future, 0, false)).toBe(true);
    expect(budgetExpired(Date.now(), future, -0.01, false)).toBe(true);
  });
});

describe("budgetExpiredReason", () => {
  const future = Date.now() + 60_000;
  const past = Date.now() - 1;

  test("draining wins over an also-expired deadline — a human reading the park reason sees WHY", () => {
    expect(budgetExpiredReason(Date.now(), past, true)).toBe("factory is draining (kill switch or spend cap) — halting before the next stage");
  });

  test("not draining: distinguishes wall-clock cap from budget exhaustion by deadline alone", () => {
    expect(budgetExpiredReason(Date.now(), past, false)).toBe("wall-clock cap reached");
    expect(budgetExpiredReason(Date.now(), future, false)).toBe("issue budget exhausted");
  });
});

// The critical construction guarantee of Gap 2: the merge decision the loop makes
// is derived from VERIFICATION EVIDENCE, not from issue.description. We assert the
// evidence built for decideMerge carries only gate/security/browser/diff signals,
// and that decideMerge's arity leaves no room for a ticket argument.
describe("merge decision is evidence-derived, never ticket-derived", () => {
  test("buildMergeEvidence consumes gate summary + security/browser/diff — no description", () => {
    const ev = buildMergeEvidence({
      summary: { green: true, strength: "strong" }, guarded: [], needsHuman: false,
      security: "pass", browser: "pass", diffLines: 12,
    });
    // A clean strong bundle would-merge at auto; the input had no ticket text.
    expect(decideMerge("auto", ev, { lowRiskMaxDiff: 40 }).wouldMerge).toBe(true);
    expect(decideMerge.length).toBe(3); // (tier, evidence, opts) — no description slot
  });
});
