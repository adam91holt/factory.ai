import { describe, expect, test } from "bun:test";
import { childrenAllTerminal, stewardEligible, sanitizeFollowUpTitle } from "../src/steward.ts";
import { liftPreconditions, parsePreconditions } from "../src/precondition.ts";
import { withFactoryMeta } from "../src/meta.ts";

type Detail = Parameters<typeof childrenAllTerminal>[0];
type Child = Detail["children"][number];

const child = (over: Partial<Child> = {}): Child => ({
  identifier: "FAC-2", title: "child", stateName: "Todo", stateType: "unstarted", labels: [],
  ...over,
});

const detail = (children: Child[]): Detail => ({
  identifier: "FAC-1", title: "epic", description: "", url: "",
  stateName: "In Progress", labels: [], parent: null, children, siblings: [],
});

describe("childrenAllTerminal", () => {
  test("no children → false (nothing to steward)", () => {
    expect(childrenAllTerminal(detail([]))).toBe(false);
  });

  test("an executing child is never terminal — even in a review-named state", () => {
    expect(childrenAllTerminal(detail([
      child({ stateType: "started", stateName: "In Review", labels: ["Factory-Executing"] }),
    ]))).toBe(false);
  });

  test("parked and needs-human labels are terminal", () => {
    expect(childrenAllTerminal(detail([
      child({ labels: ["Factory-Parked"] }),
      child({ labels: ["Factory-Needs-Human"] }),
    ]))).toBe(true);
  });

  test("completed and canceled states are terminal", () => {
    expect(childrenAllTerminal(detail([
      child({ stateType: "completed", stateName: "Done" }),
      child({ stateType: "canceled", stateName: "Canceled" }),
    ]))).toBe(true);
  });

  test("started + review-named state counts as terminal (PR open)", () => {
    expect(childrenAllTerminal(detail([
      child({ stateType: "started", stateName: "In Review" }),
      child({ stateType: "started", stateName: "Code review" }),
    ]))).toBe(true);
  });

  test("started but NOT review-named is still in flight", () => {
    expect(childrenAllTerminal(detail([
      child({ stateType: "started", stateName: "In Progress" }),
    ]))).toBe(false);
  });

  test("queued children block: one straggler flips the whole epic to false", () => {
    expect(childrenAllTerminal(detail([
      child({ stateType: "completed", stateName: "Done" }),
      child({ stateType: "unstarted", stateName: "Todo" }),
    ]))).toBe(false);
  });

  test("missing labels array is tolerated", () => {
    const c = child({ stateType: "completed", stateName: "Done" });
    delete (c as { labels?: string[] }).labels;
    expect(childrenAllTerminal(detail([c]))).toBe(true);
  });
});

// The steward stamps each follow-up it files with a re-checkable precondition
// lifted from the model-authored "## Precondition" section (Gap 4). This mirrors
// steward.ts's `liftPreconditions(description)` → `withFactoryMeta({...})` path.
describe("steward follow-up precondition stamping", () => {
  // A realistic follow-up body the steward would write to tickets/<NN>-*.md.
  const FOLLOWUP = [
    "## Goal", "Resolve the merge conflict PR #4 hit against main", "",
    "## Precondition",
    "- pr-open acme/w#4",
    "- (skip this bullet — not DSL, just a human note)", "",
    "## Repo", "acme/w", "",
    "## Verifications", "* Automated: bun test",
  ].join("\n");

  test("valid '## Precondition' entries are lifted; non-DSL bullets dropped", () => {
    expect(liftPreconditions(FOLLOWUP)).toEqual(["pr-open acme/w#4"]);
  });

  test("a follow-up with no precondition section lifts to []", () => {
    expect(liftPreconditions("## Goal\ndo it\n\n## Repo\nacme/w")).toEqual([]);
  });

  test("lifted preconditions survive the withFactoryMeta stamp the daemon applies", () => {
    const preconditions = liftPreconditions(FOLLOWUP);
    const stamped = withFactoryMeta(FOLLOWUP, { type: "task", repo: "acme/w", ...(preconditions.length ? { preconditions } : {}) });
    // The stamped, trusted, start-anchored block carries the premise the loop
    // will re-check when the follow-up is later picked up.
    expect(parsePreconditions(stamped).map((p) => p.arg)).toEqual(["acme/w#4"]);
    expect(stamped.startsWith("<!-- factory\n")).toBe(true);
  });
});

describe("stewardEligible — canceled epics are never closed out (live bug 2026-08-02)", () => {
  const base = { labels: [] as string[], stateType: "started" };

  test("an open Factory-Planned epic is eligible", () => {
    expect(stewardEligible(base)).toBe(true);
  });

  test("already-stewarded epics are skipped (pre-existing behaviour)", () => {
    expect(stewardEligible({ ...base, labels: ["Factory-Stewarded"] })).toBe(false);
  });

  test("THE PIN: a canceled epic is skipped — no closeout, no follow-up tickets", () => {
    // The live repro: FAC-42 was Canceled by the owner, kept Factory-Planned,
    // its children were all terminal (canceled counts), and the steward filed
    // resurrection tickets against it. Cancellation must end the epic's story.
    expect(stewardEligible({ ...base, stateType: "canceled" })).toBe(false);
  });

  test("completed epics remain eligible — closeout of finished work is the steward's job", () => {
    expect(stewardEligible({ ...base, stateType: "completed" })).toBe(true);
  });
});

describe("sanitizeFollowUpTitle — model-guessed identifiers never reach a title (live bug 2026-08-02)", () => {
  test("THE PIN: the exact live shapes — predicted FAC-49/FAC-50 prefixes stripped", () => {
    expect(sanitizeFollowUpTitle("FAC-49 — Verify merged-but-canceled Stack Attack"))
      .toBe("Verify merged-but-canceled Stack Attack");
    expect(sanitizeFollowUpTitle("FAC-50 — Rebuild missing FAC-42 scope: Royal Roll minigame"))
      .toBe("Rebuild missing FAC-42 scope: Royal Roll minigame"); // mid-title FAC-42 reference kept
  });

  test("bracketed / colon / stacked prefixes all strip; plain titles untouched", () => {
    expect(sanitizeFollowUpTitle("[FAC-12] Fix the flaky gate")).toBe("Fix the flaky gate");
    expect(sanitizeFollowUpTitle("FAC-9: FAC-10 - Chained guesses")).toBe("Chained guesses");
    expect(sanitizeFollowUpTitle("Ship the DAG view")).toBe("Ship the DAG view");
  });

  test("a genuine reference later in the title survives", () => {
    expect(sanitizeFollowUpTitle("Clean up worktrees left by FAC-42")).toBe("Clean up worktrees left by FAC-42");
  });
});
