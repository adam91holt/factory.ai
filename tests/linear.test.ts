import { describe, expect, test } from "bun:test";
import { filterOrphanedIssues } from "../src/linear.ts";
import type { Issue } from "../src/linear.ts";

// B3/B5 audit improvement #5 — the runtime orphan sweep (index.ts) re-runs
// recoverOrphanedClaims periodically, excluding this process's own live
// inFlight claims so a genuinely-running issue is never reset out from under
// itself. filterOrphanedIssues is the pure decision recoverOrphanedClaims
// delegates to; its surrounding fetchByLabel/removeLabel/transition calls are
// network-only and out of scope for a unit test.

const mk = (identifier: string): Issue => ({
  id: `id-${identifier}`, identifier, title: "t", description: "", url: "https://linear.app/x",
  teamKey: "FAC", teamId: "team-1", stateName: "In Progress", stateType: "started",
  labels: ["Factory-Executing"], createdAt: "2026-07-01T00:00:00.000Z",
});

describe("filterOrphanedIssues", () => {
  test("an empty exclude set (startup case) treats every Executing-labeled issue as orphaned", () => {
    const issues = [mk("FAC-1"), mk("FAC-2")];
    expect(filterOrphanedIssues(issues, new Set())).toEqual(issues);
  });

  test("issues tracked in the exclude set (this process's own inFlight) are NOT orphaned", () => {
    const issues = [mk("FAC-1"), mk("FAC-2"), mk("FAC-3")];
    const result = filterOrphanedIssues(issues, new Set(["FAC-2"]));
    expect(result.map((i) => i.identifier)).toEqual(["FAC-1", "FAC-3"]);
  });

  test("every issue excluded → no orphans (a fully-tracked in-flight batch stays untouched)", () => {
    const issues = [mk("FAC-1"), mk("FAC-2")];
    expect(filterOrphanedIssues(issues, new Set(["FAC-1", "FAC-2"]))).toEqual([]);
  });

  test("an exclude entry with no matching issue is simply inert", () => {
    const issues = [mk("FAC-1")];
    expect(filterOrphanedIssues(issues, new Set(["FAC-99"]))).toEqual(issues);
  });
});
