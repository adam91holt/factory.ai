import { describe, expect, test } from "bun:test";
import type { FactoryEvent, RunRecord } from "../ui/src/lib/events.ts";
import { classifyOutcome, summarizeRuns } from "../ui/src/lib/history.ts";
import { reconstructRun } from "../ui/src/lib/reconstruct.ts";
import { mockRunRecords } from "../ui/src/lib/fixtures.ts";

// The routed-vs-escalated outcomes ledger derives its classification from the
// reason strings loop.ts already records (zero new event state), so these
// tests pin BOTH sides of the contract: the exact daemon phrasings classify to
// the intended bucket, and everything unknown/absent falls back to ESCALATED —
// the tighten-only default. A regression here means the dashboard would either
// bury genuine friction under "routed" (the failure mode the ledger exists to
// prevent) or silently misfile by-design handoffs.
//
// NOTE: like every test that imports ui/src, this file needs BOTH installs:
// `bun install && (cd ui && bun install)` — root alone leaves react unresolved.

describe("classifyOutcome — routed: by-design human handoffs", () => {
  test("guarded-paths hold (C17) is routed", () => {
    expect(classifyOutcome("needs_human", "guarded paths touched: .github/workflows/ci.yml")).toBe("routed");
  });

  test("categorical test-deletion park is routed", () => {
    expect(classifyOutcome("parked", "change DELETES test files (tests/loop.test.ts) — categorical human review")).toBe("routed");
  });

  test("pr_open is routed — human-merge tier / merge:review IS the design", () => {
    expect(classifyOutcome("pr_open", undefined)).toBe("routed");
  });

  test("awaiting_answer is routed — intake asked the human by design", () => {
    expect(classifyOutcome("awaiting_answer", "posted 3 clarifying questions")).toBe("routed");
  });
});

describe("classifyOutcome — escalated: genuine friction", () => {
  const cases: Array<[Parameters<typeof classifyOutcome>[0], string]> = [
    ["needs_human", "security review returned a FAIL verdict"],
    ["needs_human", "security review did not complete on a 812-line diff (wall-clock cap reached) — cannot auto-merge unreviewed"],
    ["needs_human", "design taste gate failed (see design review)"],
    ["needs_human", "design review did not complete on a UI-touching diff — cannot auto-merge unreviewed"],
    ["needs_human", "verification agent returned an explicit FAIL verdict"],
    ["parked", "gates still failing after 3 repair rounds"],
    ["parked", "wall-clock cap reached"],
    ["parked", "issue budget exhausted"],
    ["parked", "factory is draining (kill switch or spend cap) — halting before the next stage"],
    ["parked", "implementer: SDK stream errored"],           // stage error → default
    ["parked", "workspace: clone failed"],                   // setup failure → default
    ["parked", "dependency install failed: ENOTFOUND"],      // setup failure → default
    ["parked", "implementer produced no committable changes"],
    ["needs_human", "ticket is missing required sections: ## Verifications (see factory docs/ticket-contract.md)"],
  ];
  for (const [outcome, reason] of cases) {
    test(`${outcome}: "${reason.slice(0, 60)}" escalates`, () => {
      expect(classifyOutcome(outcome, reason)).toBe("escalated");
    });
  }

  test("aborted (external move) is always escalated", () => {
    expect(classifyOutcome("aborted", "moved externally during review")).toBe("escalated");
  });

  // guardedPathsTouched returns the <diff-failed> sentinel when git itself
  // fails (repos.ts) and loop.ts folds it into the guarded hold phrasing — an
  // errored stage wearing the routed marker's clothing. Escalated markers are
  // checked first, so the sentinel must win over "guarded paths touched".
  test("DIFF_FAILED sentinel inside the guarded hold escalates — errored stage, not a C17 stop", () => {
    expect(classifyOutcome("needs_human", "guarded paths touched: <diff-failed>")).toBe("escalated");
  });

  test("a failed auto-merge attempt on pr_open escalates — the system tried and failed", () => {
    expect(classifyOutcome("pr_open", "auto-merge failed: pull request is not mergeable (conflicts)")).toBe("escalated");
  });
});

describe("classifyOutcome — tighten-only defaults", () => {
  test("a MIXED holdReason (routed + friction) escalates — friction wins", () => {
    expect(classifyOutcome("needs_human",
      "guarded paths touched: src/auth.ts; security review returned a FAIL verdict")).toBe("escalated");
  });

  test("an unrecognized reason escalates, never routes", () => {
    expect(classifyOutcome("needs_human", "some brand-new phrasing nobody has seen")).toBe("escalated");
  });

  test("a missing reason on a handoff outcome escalates", () => {
    expect(classifyOutcome("needs_human", undefined)).toBe("escalated");
    expect(classifyOutcome("parked", "")).toBe("escalated");
  });

  test("an outcome the union does not know yet still classifies (old/new rows)", () => {
    // Simulates a history row written by a future/older daemon version.
    expect(classifyOutcome("totally_new_outcome" as never, "whatever")).toBe("escalated");
  });
});

describe("classifyOutcome — no human handoff at all", () => {
  for (const outcome of ["merged", "planned", "bootstrapped", "authored", "stale"] as const) {
    test(`${outcome} is neither routed nor escalated`, () => {
      expect(classifyOutcome(outcome, undefined)).toBeNull();
    });
  }
});

describe("summarizeRuns — routed/escalated ledger counts", () => {
  test("fixture rows split into the expected buckets", () => {
    const runs = mockRunRecords();
    const s = summarizeRuns(runs);
    // Every classified row lands in exactly one bucket; merged/planned/… in neither.
    const expectRouted = runs.filter((r) => classifyOutcome(r.outcome, r.reason) === "routed").length;
    const expectEscalated = runs.filter((r) => classifyOutcome(r.outcome, r.reason) === "escalated").length;
    expect(s.routed).toBe(expectRouted);
    expect(s.escalated).toBe(expectEscalated);
    expect(s.routed + s.escalated).toBeLessThanOrEqual(s.total);
    // The fixtures deliberately carry both kinds of handoff.
    expect(s.routed).toBeGreaterThan(0);     // FAC-14 guarded paths + pr_open rows
    expect(s.escalated).toBeGreaterThan(0);  // FAC-15 gates, FAC-11 external move, FAC-9 wall clock
  });

  test("hand-built records: routed + escalated partition the handoffs", () => {
    const rec = (outcome: RunRecord["outcome"], reason?: string): RunRecord => ({
      issueKey: "T-1", outcome, ...(reason !== undefined ? { reason } : {}),
      prUrl: null, costUsd: 1, stages: [], gateStrength: "real", guardedPaths: [],
      finishedAt: 1,
    });
    const s = summarizeRuns([
      rec("merged"),
      rec("needs_human", "guarded paths touched: infra/"),
      rec("needs_human", "security review returned a FAIL verdict"),
      rec("parked", "gates still failing after 3 repair rounds"),
      rec("pr_open"),
    ]);
    expect(s.routed).toBe(2);      // guarded hold + pr_open
    expect(s.escalated).toBe(2);   // security fail + gates
    expect(s.total).toBe(5);       // merged classifies as neither
  });
});

describe("reconstructRun — outcomeClass on the drill-down", () => {
  const base = (outcome: "needs_human" | "parked", reason: string): FactoryEvent[] => [
    { type: "run_started", issueKey: "FAC-Y", title: "t", repo: "r/y", dryRun: false, seq: 1, at: 1000 },
    { type: "run_finished", issueKey: "FAC-Y", outcome, reason, prUrl: null, costUsd: 0,
      stages: [], gateStrength: "none", guardedPaths: [], dryRun: false, seq: 2, at: 2000 },
  ];

  test("classifies from the terminal run_finished event", () => {
    expect(reconstructRun(base("needs_human", "guarded paths touched: ops/")).outcomeClass).toBe("routed");
    expect(reconstructRun(base("parked", "wall-clock cap reached")).outcomeClass).toBe("escalated");
  });

  test("null while the run has no terminal event yet (active)", () => {
    const active: FactoryEvent[] = [
      { type: "run_started", issueKey: "FAC-Y", title: "t", repo: "r/y", dryRun: false, seq: 1, at: 1000 },
    ];
    expect(reconstructRun(active).outcomeClass).toBeNull();
  });

  // pr_open + an ACTED merge_decision = the daemon tried to auto-merge and
  // mergePr failed (loop.ts B16 merges BEFORE run_finished, so success would
  // have produced "merged"). Old rows carry no "auto-merge failed" reason, but
  // the durable stream still proves the attempt — the reconstruction must
  // escalate it. An unacted (shadow/human-tier) decision must NOT: that is the
  // by-design human-merge path.
  const prOpen = (acted: boolean): FactoryEvent[] => [
    { type: "run_started", issueKey: "FAC-Y", title: "t", repo: "r/y", dryRun: false, seq: 1, at: 1000 },
    { type: "run_finished", issueKey: "FAC-Y", outcome: "pr_open", prUrl: "https://github.com/r/y/pull/1",
      costUsd: 0, stages: [], gateStrength: "real", guardedPaths: [], dryRun: false, seq: 2, at: 2000 },
    // merge_decision is emitted AFTER run_finished (loop.ts) — same order here.
    { type: "merge_decision", issueKey: "FAC-Y", repo: "r/y", tier: "auto", wouldMerge: true,
      acted, strength: "real", browser: "not-required", security: "pass", cleanStreak: 3,
      reasons: [], seq: 3, at: 3000 },
  ];

  test("pr_open with an acted merge_decision (failed auto-merge) escalates", () => {
    expect(reconstructRun(prOpen(true)).outcomeClass).toBe("escalated");
  });

  test("pr_open with an unacted merge_decision (shadow/human tier) stays routed", () => {
    expect(reconstructRun(prOpen(false)).outcomeClass).toBe("routed");
  });
});
