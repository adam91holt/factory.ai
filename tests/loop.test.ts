import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isEligible, missingSections, wantsBrowserVerification, mapBrowserEvidence, parseSecurityVerdict, securityReviewOutstanding, parseTasteVerdict, countDiffLines, budgetExpired, budgetExpiredReason, retryMutation, pushOnPark,
  securityTokenVerdict, tasteTokenVerdict, testerTokenVerdict, reviewerTokenVerdict, securityVerdictFromGate, browserEvidenceFromGate, reviewerGateHolds, tasteFixRoundWarranted, gateStageText, toGateVerdictEntry, GATE_STAGE_OUTPUT_FORMAT } from "../src/loop.ts";
import { resolveGateOutput, GATE_OUTPUT_SCHEMA, type GateOutput } from "../src/gate.ts";
import { decideFreshness, parsePrecondition, type PerCheck } from "../src/precondition.ts";
import { buildMergeEvidence, decideMerge } from "../src/merge-ladder.ts";
import type { Issue } from "../src/linear.ts";
import type { Workspace } from "../src/repos.ts";

const issue = (description: string): Issue => ({
  id: "id-1", identifier: "FAC-1", title: "t", description, url: "https://linear.app/x",
  teamKey: "FAC", teamId: "team-1", stateName: "Todo", stateType: "unstarted",
  stateDescription: "[factory:queue]", labels: [], createdAt: "2026-07-01T00:00:00.000Z",
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

// Fail-closed verdict parsing: the prompt mandates exactly one explicit verdict
// line, so the parser REQUIRES one. The old `fail-token ? fail : pass` let a
// truncated review, one that drifted off-script, or one steered by injected diff
// content into never saying "fail" count as an implicit PASS. An unrecognizable
// verdict routes nowhere — it folds into the null-verdict path (needsHuman via
// securityReviewOutstanding), never defaults to pass.
describe("parseSecurityVerdict (fail-closed)", () => {
  test("maps an explicit SECURITY: fail to fail (folds into holdReasons/needsHuman)", () => {
    expect(parseSecurityVerdict("found an injection\nSECURITY: fail")).toBe("fail");
  });
  test("maps an explicit SECURITY: pass to pass", () => {
    expect(parseSecurityVerdict("no issues found\nSECURITY: pass")).toBe("pass");
    expect(parseSecurityVerdict("security: PASS")).toBe("pass"); // case-insensitive, matching the old regex
  });
  test("fail wins when both tokens appear — a steered review never upgrades itself", () => {
    expect(parseSecurityVerdict("SECURITY: pass\n...on reflection, actually\nSECURITY: fail")).toBe("fail");
    expect(parseSecurityVerdict("SECURITY: fail\nSECURITY: pass")).toBe("fail");
  });
  test("NO explicit verdict token is 'error', never an implicit pass", () => {
    expect(parseSecurityVerdict("no line at all")).toBe("error");
    expect(parseSecurityVerdict("")).toBe("error"); // truncated/empty review
    expect(parseSecurityVerdict("SECURITY: probably fine")).toBe("error"); // off-script verdict
  });
  test("token match requires a word boundary — 'passable'/'failing' prose is not a verdict", () => {
    expect(parseSecurityVerdict("SECURITY: passable but odd")).toBe("error");
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

// B22: the taste gate must fail CLOSED on an errored design reviewer (no
// verdict produced — deadline/budget-killed mid-run, or any other stage
// error), matching securityReviewOutstanding's fail-closed fold. The old
// `r.error !== undefined || !/TASTE:\s*fail/.test(r.text)` treated an errored
// reviewer as an implicit PASS — this held the PR open with zero taste
// coverage instead of forcing needs_human.
describe("parseTasteVerdict (B22)", () => {
  test("an errored stage (no verdict produced) is its own outcome, not a pass", () => {
    expect(parseTasteVerdict({ error: "stage deadline reached", text: "" })).toBe("error");
  });

  test("an errored stage with leftover partial text is still 'error', never inferred from text", () => {
    expect(parseTasteVerdict({ error: "stage deadline reached", text: "TASTE: pass" })).toBe("error");
  });

  test("an explicit TASTE: fail (no error) is 'fail'", () => {
    expect(parseTasteVerdict({ text: "found template-default soup\nTASTE: fail" })).toBe("fail");
  });

  test("an explicit TASTE: pass (no error) is 'pass'", () => {
    expect(parseTasteVerdict({ text: "looks distinctive\nTASTE: pass" })).toBe("pass");
  });

  test("no error and NO explicit verdict token is 'error' (mirrors parseSecurityVerdict) — a verdict-less review never passes by omission", () => {
    expect(parseTasteVerdict({ text: "no verdict line at all" })).toBe("error");
    expect(parseTasteVerdict({ text: "" })).toBe("error"); // truncated/empty review
  });

  test("fail wins when both tokens appear — a steered review never upgrades itself", () => {
    expect(parseTasteVerdict({ text: "TASTE: pass\n...wait, the score never springs\nTASTE: fail" })).toBe("fail");
  });

  test("'error' folds into needsHuman just like a genuine 'fail' would", () => {
    // The loop sets designReviewOutstanding=true on "error" and pushes a holdReason
    // exactly as it does for tasteFindings on "fail" — either alone forces needsHuman,
    // which forces wouldMerge=false even at the most permissive tier.
    const ev = buildMergeEvidence({
      summary: { green: true, strength: "strong" }, guarded: [], needsHuman: true,
      security: "pass", browser: "not-required", diffLines: 10,
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

// B3: park's own Linear mutations (label / transition / release) used to be
// one-shot `.catch(() => {})`, so a transient Linear outage during THAT SAME
// park() call silently stranded the ticket (Executing label attached, no
// Parked label). retryMutation is the bounded-backoff wrapper closing that
// gap; `sleep` is injected so these tests never wait on a real timer.
describe("retryMutation (B3: bounded retry for park's own mutations)", () => {
  test("succeeds on the first try — never sleeps, never retries", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await retryMutation(async () => { calls += 1; }, { sleep: async (ms) => { sleeps.push(ms); } });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("recovers on a later attempt after transient failures, with exponential backoff between tries", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await retryMutation(
      async () => { calls += 1; if (calls < 3) throw new Error(`transient ${calls}`); },
      { attempts: 5, baseDelayMs: 100, sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]); // doubles each attempt: 100 * 2^0, 100 * 2^1
  });

  test("exhausting every attempt reports ok:false with the LAST error — never throws", async () => {
    let calls = 0;
    const result = await retryMutation(
      async () => { calls += 1; throw new Error(`fail ${calls}`); },
      { attempts: 3, baseDelayMs: 1, sleep: async () => {} },
    );
    expect(result).toEqual({ ok: false, error: "fail 3" });
    expect(calls).toBe(3);
  });

  test("attempts:1 tries exactly once and never sleeps, even on failure", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await retryMutation(
      async () => { calls += 1; throw new Error("nope"); },
      { attempts: 1, sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(result).toEqual({ ok: false, error: "nope" });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("a non-Error throw is stringified rather than crashing", async () => {
    const result = await retryMutation(async () => { throw "plain string failure"; },
      { attempts: 1, sleep: async () => {} });
    expect(result).toEqual({ ok: false, error: "plain string failure" });
  });
});

// #12b (FAC-34): a park must never silently strand committed work — if the
// worktree has commits ahead of base, push the branch anyway (best-effort) and
// surface its URL for the report. `hasCommits`/`push` are injected so this is
// unit-testable without a real git remote (mirrors retryMutation's injected
// `sleep`) — this IS the "mock the git push seam" for park().
describe("pushOnPark (#12b: park with commits pushes the branch, best-effort)", () => {
  const ws: Workspace = { repo: "acme/widgets", dir: "/tmp/factory-ws", branch: "factory/fac-1", baseRef: "refs/remotes/origin/main" };

  test("no commits ahead of base → never pushes, returns null", () => {
    let pushed = false;
    const url = pushOnPark(ws, { hasCommits: () => false, push: () => { pushed = true; } });
    expect(pushed).toBe(false);
    expect(url).toBeNull();
  });

  test("commits ahead of base → pushes and returns the branch URL for the park report", () => {
    let pushed = false;
    const url = pushOnPark(ws, { hasCommits: () => true, push: () => { pushed = true; } });
    expect(pushed).toBe(true);
    expect(url).toBe("https://github.com/acme/widgets/tree/factory/fac-1");
  });

  test("a push failure is swallowed — best-effort, park must never throw on a failed push", () => {
    const url = pushOnPark(ws, { hasCommits: () => true, push: () => { throw new Error("network down"); } });
    expect(url).toBeNull();
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

// ---------------------------------------------------------------------------
// Structured gate outputs (issue #6 Part 1). One fail-closed test per gate
// stage: malformed/absent structured output routes to needs-human (or the
// evidence-missing merge block), NEVER an implicit pass. Plus the two
// non-negotiables: uncertain ≠ fail (only a genuine fail buys a fixer round),
// and recommendedAction is advisory-only (merge-ladder.ts untouched).
// ---------------------------------------------------------------------------

const gate = (over: Partial<GateOutput> = {}): GateOutput => ({
  verdict: "pass", findings: [], evidence: [], recommendedAction: "continue",
  prose: "clean", source: "structured", dropped: 0, ...over,
});

describe("gate stage token adapters (the documented legacy fallback)", () => {
  test("security: SECURITY: pass/fail map, anything else null (fail-closed)", () => {
    expect(securityTokenVerdict("…\nSECURITY: pass")).toBe("pass");
    expect(securityTokenVerdict("…\nSECURITY: fail")).toBe("fail");
    expect(securityTokenVerdict("no verdict emitted")).toBeNull();
  });
  test("taste: TASTE tokens map, fail wins on both, none is null", () => {
    expect(tasteTokenVerdict("TASTE: pass")).toBe("pass");
    expect(tasteTokenVerdict("TASTE: pass\nTASTE: fail")).toBe("fail");
    expect(tasteTokenVerdict("nothing")).toBeNull();
  });
  test("tester: VERDICT: partial is the token spelling of 'uncertain'", () => {
    expect(testerTokenVerdict("VERDICT: pass")).toBe("pass");
    expect(testerTokenVerdict("VERDICT: partial")).toBe("uncertain");
    expect(testerTokenVerdict("VERDICT: fail")).toBe("fail");
    expect(testerTokenVerdict("ran stuff")).toBeNull();
  });
  test("reviewers: NO-FINDINGS is a pass, prose findings are a fail (fixer's job, same as today), empty is null", () => {
    expect(reviewerTokenVerdict("Checked everything. NO-FINDINGS")).toBe("pass");
    expect(reviewerTokenVerdict("1. off-by-one in x.ts")).toBe("fail");
    expect(reviewerTokenVerdict("   ")).toBeNull();
  });
});

describe("security-reviewer: schema violation/absence fails CLOSED to needs-human", () => {
  test("malformed structured output + no token → null verdict → outstanding → decideMerge cannot act", () => {
    // The stage completed but its structured output is garbage and its text
    // carries no legacy token — exactly the shape a steered/truncated review has.
    const resolved = resolveGateOutput({ text: "review that drifted off-script", structured: { verdict: "approved" } }, securityTokenVerdict);
    expect(resolved).toBeNull();
    const verdict = securityVerdictFromGate(resolved);
    expect(verdict).toBeNull();
    expect(securityReviewOutstanding(50, verdict)).toBe(true);
    const ev = buildMergeEvidence({ summary: { green: true, strength: "strong" }, guarded: [],
      needsHuman: true, security: verdict, browser: "not-required", diffLines: 50 });
    expect(decideMerge("auto", ev, { lowRiskMaxDiff: 40 }).wouldMerge).toBe(false);
  });
  test("uncertain ≠ fail: an UNCERTAIN security verdict never reads as pass OR fail — it holds as null", () => {
    expect(securityVerdictFromGate(gate({ verdict: "uncertain" }))).toBeNull();
    expect(securityVerdictFromGate(gate({ verdict: "fail" }))).toBe("fail");
    expect(securityVerdictFromGate(gate({ verdict: "pass" }))).toBe("pass");
    expect(securityVerdictFromGate(null)).toBeNull();
  });
});

describe("design-reviewer: schema violation/absence fails CLOSED; only genuine fail buys a fixer round", () => {
  test("an unresolvable design review (error/garbage) is the B22 outstanding fold, not a pass and not a fixer round", () => {
    const resolved = resolveGateOutput({ error: "stage deadline reached", text: "" }, tasteTokenVerdict);
    expect(resolved).toBeNull();
    expect(tasteFixRoundWarranted(resolved)).toBe(false); // nothing to fix in an empty review
    // The loop folds null → designReviewOutstanding → needsHuman: assert that
    // hold blocks the merge exactly like the pre-structured path did.
    const ev = buildMergeEvidence({ summary: { green: true, strength: "strong" }, guarded: [],
      needsHuman: true, security: "pass", browser: "not-required", diffLines: 10 });
    expect(decideMerge("auto", ev, { lowRiskMaxDiff: 40 }).wouldMerge).toBe(false);
  });
  test("only a genuine 'fail' buys a design-fixer round — uncertain routes to a human instead", () => {
    expect(tasteFixRoundWarranted(gate({ verdict: "fail" }))).toBe(true);
    expect(tasteFixRoundWarranted(gate({ verdict: "uncertain" }))).toBe(false);
    expect(tasteFixRoundWarranted(gate({ verdict: "pass" }))).toBe(false);
    expect(tasteFixRoundWarranted(null)).toBe(false);
  });
});

describe("tester: schema violation/absence counts as not-run — missing evidence, never a pass", () => {
  test("null gate → 'missing' where the repo requires browser evidence (blocks auto-merge), 'not-required' otherwise", () => {
    expect(browserEvidenceFromGate(true, null)).toBe("missing");
    expect(browserEvidenceFromGate(false, null)).toBe("not-required");
    const ev = buildMergeEvidence({ summary: { green: true, strength: "strong" }, guarded: [],
      needsHuman: false, security: "pass", browser: browserEvidenceFromGate(true, null), diffLines: 10 });
    expect(decideMerge("auto", ev, { lowRiskMaxDiff: 40 }).wouldMerge).toBe(false);
    expect(decideMerge("auto", ev, { lowRiskMaxDiff: 40 }).reasons).toContain("required browser evidence missing");
  });
  test("uncertain ≠ fail: structured 'uncertain' maps to 'partial' (the old VERDICT: partial), not 'fail'", () => {
    expect(browserEvidenceFromGate(true, gate({ verdict: "uncertain" }))).toBe("partial");
    expect(browserEvidenceFromGate(true, gate({ verdict: "fail" }))).toBe("fail");
    expect(browserEvidenceFromGate(true, gate({ verdict: "pass" }))).toBe("pass");
  });
});

describe("reviewer legs: an unresolvable review can no longer be waved through to auto-merge", () => {
  test("null gate on either leg produces a hold reason → needsHuman → decideMerge cannot act", () => {
    const holds = reviewerGateHolds(null, gate());
    expect(holds).toHaveLength(1);
    expect(holds[0]).toContain("spec-lens");
    expect(reviewerGateHolds(gate(), null)[0]).toContain("repo-lens");
    expect(reviewerGateHolds(null, null)).toHaveLength(2);
    const ev = buildMergeEvidence({ summary: { green: true, strength: "strong" }, guarded: [],
      needsHuman: holds.length > 0, security: "pass", browser: "not-required", diffLines: 10 });
    expect(decideMerge("auto", ev, { lowRiskMaxDiff: 40 }).wouldMerge).toBe(false);
  });
  test("a resolved review — even verdict 'fail' (findings exist) — is NOT a hold: findings are the fixer round's job, same as today", () => {
    expect(reviewerGateHolds(gate({ verdict: "fail" }), gate({ verdict: "uncertain" }))).toHaveLength(0);
  });
});

describe("recommendedAction is ADVISORY ONLY — a stage cannot recommend its way to a merge", () => {
  test("merge-ladder.ts never mentions recommendedAction (signature/inputs unchanged — source pin)", () => {
    const src = readFileSync(join(import.meta.dir, "../src/merge-ladder.ts"), "utf8");
    expect(src.includes("recommendedAction")).toBe(false);
    expect(src.includes("GateOutput")).toBe(false); // the structured type never crosses into merge policy
    expect(decideMerge.length).toBe(3); // (tier, evidence, opts) — unchanged arity
  });
  test("buildMergeEvidence's input has no recommendedAction slot (compile-time pin)", () => {
    buildMergeEvidence({ summary: { green: true, strength: "strong" }, guarded: [], needsHuman: false,
      security: "pass", browser: "pass", diffLines: 1,
      // @ts-expect-error — recommendedAction must never become an evidence input;
      // if someone adds it, this directive stops erroring and the typecheck gate fails.
      recommendedAction: "continue" });
  });
  test("a failing gate that recommends 'continue' still blocks: the verdict gates, the recommendation is ignored", () => {
    const g = gate({ verdict: "fail", recommendedAction: "continue" });
    expect(securityVerdictFromGate(g)).toBe("fail");
    const ev = buildMergeEvidence({ summary: { green: true, strength: "strong" }, guarded: [],
      needsHuman: false, security: securityVerdictFromGate(g), browser: "not-required", diffLines: 10 });
    const d = decideMerge("auto", ev, { lowRiskMaxDiff: 40 });
    expect(d.wouldMerge).toBe(false);
    expect(d.reasons).toContain("security review failed");
  });
  test("a passing gate that recommends 'escalate' cannot force a merge either way — the recommendation simply is not an input", () => {
    const g = gate({ verdict: "pass", recommendedAction: "escalate" });
    const ev = buildMergeEvidence({ summary: { green: true, strength: "strong" }, guarded: [],
      needsHuman: false, security: securityVerdictFromGate(g), browser: "pass", diffLines: 10 });
    // Identical evidence → identical decision, whatever the stage "recommended".
    expect(decideMerge("auto", ev, { lowRiskMaxDiff: 40 }).wouldMerge).toBe(true);
  });
});

describe("gate stage plumbing (report + prompts stay human-readable)", () => {
  test("GATE_STAGE_OUTPUT_FORMAT is the json_schema outputFormat over gate.ts's schema", () => {
    expect(GATE_STAGE_OUTPUT_FORMAT.type).toBe("json_schema");
    expect(GATE_STAGE_OUTPUT_FORMAT.schema).toBe(GATE_OUTPUT_SCHEMA);
  });
  test("gateStageText renders prose + findings digest for structured results, raw text otherwise — never a JSON dump", () => {
    const g = gate({ verdict: "fail", prose: "Two problems.", evidence: ["ran bun test"],
      findings: [{ severity: "high", file: "src/x.ts", line: 7, summary: "boom", failureScenario: "", fix: "" }] });
    const text = gateStageText(g, { text: '{"verdict":"fail"}' });
    expect(text).toContain("Two problems.");
    expect(text).toContain("- [high] src/x.ts:7 boom");
    expect(text).toContain("ran bun test");
    expect(text).not.toContain('{"verdict"');
    expect(gateStageText(null, { text: "plain prose review" })).toBe("plain prose review");
  });
  test("toGateVerdictEntry records verdict/source/findings; null becomes 'unresolved' (visible in telemetry, routed to a human by the folds)", () => {
    expect(toGateVerdictEntry("security-reviewer", gate({ verdict: "uncertain", source: "fenced-json" })))
      .toEqual({ stage: "security-reviewer", verdict: "uncertain", source: "fenced-json", findings: 0, action: "continue" });
    expect(toGateVerdictEntry("tester", null))
      .toEqual({ stage: "tester", verdict: "unresolved", source: "none", findings: 0, action: "none" });
  });
});
