import { describe, expect, test } from "bun:test";
import {
  authorityRows,
  currentAuthorityValue,
  formatPolicyValue,
  groundskeeperToggleState,
  isRosterModel,
  mapProjectsPayload,
  openApprovalsCount,
  pendingPolicies,
  recentParkReasons,
  spend30d,
  AUTHORITY_KEYS,
  type ProjectView,
  type ProjectPolicy,
} from "../ui/src/lib/projects.ts";
import type { RunRecord } from "../ui/src/lib/events.ts";
import type { ApprovalItem } from "../ui/src/lib/approvals.ts";

// The /projects views' pure logic: the wire→view mapping (the UI's copy of the
// GET /projects contract from src/project-config.ts), the list-page
// derivations (30d spend / park reasons / open approvals — all computed
// client-side from endpoints that already exist), and the two-tier display
// rules: authority keys render READ-ONLY with an awaiting-approval diff, and a
// groundskeeper toggle must VISIBLY report inertness when the global
// GROUNDSKEEPERS_ENABLED gate is off (reporting the double-gate, never
// weakening it).

const DAY = 24 * 3_600_000;
const NOW = 1_700_000_000_000;

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    issueKey: "FAC-1", outcome: "pr_open", prUrl: null, costUsd: 1,
    stages: [], gateStrength: "real", guardedPaths: [], finishedAt: NOW - DAY,
    repo: "acme/api",
    ...overrides,
  };
}

function project(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    name: "acme", goal: "", description: "", team: "FAC", status: "active",
    createdAt: 0, updatedAt: 0,
    repos: ["acme/api"],
    ladder: [{ repo: "acme/api", tier: "shadow", cleanStreak: 2 }],
    card: { name: "acme", team: "FAC", repos: ["acme/api"], merge: "review", deployEnabled: false },
    effective: { name: "acme", team: "FAC", repos: ["acme/api"], merge: "review", deployEnabled: false },
    models: [], groundskeepers: [], policies: [], audit: [],
    ...overrides,
  };
}

function policy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    id: 1, key: "merge", value: "shadow", state: "pending",
    approvedBy: null, approvedAt: null, createdAt: NOW,
    ...overrides,
  };
}

describe("mapProjectsPayload — wire tolerance for older backends", () => {
  test("a payload missing every additive field still renders (empty, never undefined)", () => {
    const mapped = mapProjectsPayload({ projects: [{ name: "bare" }] });
    expect(mapped.projects[0]).toMatchObject({
      name: "bare", repos: [], ladder: [], models: [], groundskeepers: [], policies: [], audit: [],
    });
    expect(mapped.roster).toEqual({ roles: [], models: [] });
    expect(mapped.drain).toEqual({ draining: false, reason: null });
  });

  test("groundskeepersEnabled missing degrades to FALSE — toggles read as inert, never silently armed", () => {
    expect(mapProjectsPayload({ projects: [] }).groundskeepersEnabled).toBe(false);
    expect(mapProjectsPayload({ projects: [], groundskeepersEnabled: true }).groundskeepersEnabled).toBe(true);
    expect(mapProjectsPayload({ projects: [], groundskeepersEnabled: "yes" }).groundskeepersEnabled).toBe(false);
  });

  test("null payload maps to an empty view, not a crash", () => {
    expect(mapProjectsPayload(null).projects).toEqual([]);
  });
});

describe("spend30d — durable history filtered to the project's repos", () => {
  const records = [
    record({ costUsd: 3, finishedAt: NOW - 2 * DAY }),
    record({ costUsd: 5, finishedAt: NOW - 29 * DAY }),
    record({ costUsd: 100, finishedAt: NOW - 31 * DAY }),          // outside window
    record({ costUsd: 7, repo: "other/repo" }),                    // other project
    record({ costUsd: 9, repo: undefined }),                       // legacy row, no repo
  ];

  test("sums only in-window rows of the project's repos", () => {
    expect(spend30d(records, ["acme/api"], NOW)).toBe(8);
  });

  test("a legacy row without a repo counts for NO project — never guessed in", () => {
    expect(spend30d(records, ["acme/api", "other/repo"], NOW)).toBe(15);
  });

  test("empty repos → zero", () => {
    expect(spend30d(records, [], NOW)).toBe(0);
  });
});

describe("recentParkReasons — newest first, verbatim, deduped, capped", () => {
  const records = [
    record({ outcome: "parked", reason: "gates still failing after 3 repair rounds", finishedAt: NOW - 3 * DAY }),
    record({ outcome: "parked", reason: "wall-clock cap reached", finishedAt: NOW - DAY }),
    record({ outcome: "parked", reason: "wall-clock cap reached", finishedAt: NOW - 2 * DAY }), // dupe
    record({ outcome: "needs_human", reason: "guarded paths touched: CLAUDE.md", finishedAt: NOW - 4 * DAY }),
    record({ outcome: "pr_open", reason: "should never appear" }),
    record({ outcome: "parked", reason: "other project's reason", repo: "other/repo" }),
    record({ outcome: "parked", finishedAt: NOW }), // parked but no reason recorded
  ];

  test("orders newest-first across parked AND needs_human, deduped", () => {
    expect(recentParkReasons(records, ["acme/api"], 5)).toEqual([
      "wall-clock cap reached",
      "gates still failing after 3 repair rounds",
      "guarded paths touched: CLAUDE.md",
    ]);
  });

  test("cap applies after dedupe", () => {
    expect(recentParkReasons(records, ["acme/api"], 1)).toEqual(["wall-clock cap reached"]);
  });
});

describe("openApprovalsCount — pending review-queue items for this project's repos", () => {
  const item = (over: Partial<ApprovalItem>): ApprovalItem => ({
    id: "1", issueKey: "FAC-1", title: "t", repo: "acme/api", parkedAt: 0,
    holdReasons: [], prUrl: null, costUsd: null, turns: null, gates: null,
    securityVerdict: "pass", tasteVerdict: "not-required", findings: null,
    diffStat: null, gatedHeadSha: null, regateFailed: false, status: "pending",
    staleReason: null, handledAt: null, ...over,
  });

  test("counts pending items in the project's repos only", () => {
    const items = [
      item({}),
      item({ id: "2", status: "approved" }),
      item({ id: "3", repo: "other/repo" }),
    ];
    expect(openApprovalsCount(items, ["acme/api"])).toBe(1);
  });
});

describe("two-tier display — authority is read-only with a pending diff", () => {
  test("authorityRows covers every AUTHORITY key exactly once", () => {
    const rows = authorityRows(project());
    expect(rows.map((r) => r.key)).toEqual([...AUTHORITY_KEYS]);
  });

  test("the effective (approved-overlay) value wins over the raw card", () => {
    const p = project({
      effective: { name: "acme", team: "FAC", repos: ["acme/api"], merge: "shadow", deployEnabled: false },
    });
    expect(currentAuthorityValue(p, "merge")).toBe("shadow");
  });

  test("a pending revision renders as an awaiting-approval diff on its key only", () => {
    const p = project({ policies: [policy({ id: 7, key: "merge", value: "shadow" })] });
    const rows = authorityRows(p);
    const merge = rows.find((r) => r.key === "merge")!;
    expect(merge.pending).toEqual({ policyId: 7, proposed: "shadow", createdAt: NOW });
    expect(merge.current).toBe("review");
    for (const r of rows.filter((r) => r.key !== "merge")) expect(r.pending).toBeNull();
  });

  test("only PENDING revisions show — active/rejected/superseded never render a diff", () => {
    const p = project({
      policies: [
        policy({ id: 1, state: "active" }),
        policy({ id: 2, state: "rejected" }),
        policy({ id: 3, state: "superseded" }),
      ],
    });
    expect(authorityRows(p).every((r) => r.pending === null)).toBe(true);
  });

  test("with several pending revisions of one key, the NEWEST is the diff shown", () => {
    const p = project({
      policies: [
        policy({ id: 1, value: "shadow", createdAt: NOW - DAY }),
        policy({ id: 2, value: "auto", createdAt: NOW }),
      ],
    });
    expect(authorityRows(p).find((r) => r.key === "merge")!.pending!.policyId).toBe(2);
    expect(pendingPolicies(p.policies).map((x) => x.id)).toEqual([2, 1]);
  });

  test("value formatting: repos arrays join, booleans render bare, null renders —", () => {
    expect(formatPolicyValue(["a/b", "c/d"])).toBe("a/b, c/d");
    expect(formatPolicyValue([])).toBe("(none)");
    expect(formatPolicyValue(true)).toBe("true");
    expect(formatPolicyValue(false)).toBe("false");
    expect(formatPolicyValue(null)).toBe("—");
    expect(currentAuthorityValue(project({ card: null, effective: null }), "merge")).toBe("—");
  });
});

describe("groundskeeperToggleState — the double-gate made visible", () => {
  test("enabled + global gate on → armed", () => {
    expect(groundskeeperToggleState(true, true)).toBe("armed");
  });

  test("enabled but GROUNDSKEEPERS_ENABLED=0 → INERT (visibly, never silently armed)", () => {
    expect(groundskeeperToggleState(true, false)).toBe("inert");
  });

  test("disabled is off regardless of the global gate", () => {
    expect(groundskeeperToggleState(false, true)).toBe("off");
    expect(groundskeeperToggleState(false, false)).toBe("off");
  });
});

describe("isRosterModel — the dropdown allowlist", () => {
  test("only roster models pass; free text never does", () => {
    const roster = { roles: ["fixer"], models: ["sonnet", "opus"] };
    expect(isRosterModel(roster, "sonnet")).toBe(true);
    expect(isRosterModel(roster, "gpt-9-turbo-max")).toBe(false);
    expect(isRosterModel(roster, "")).toBe(false);
  });
});
