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
  stateDescription: "[factory:working]", labels: ["Factory-Executing"], createdAt: "2026-07-01T00:00:00.000Z",
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

// ---------------------------------------------------------------------------
// Epic DAG payload (GET /epic-dag). Regression for the dashboard N+1: the UI
// previously issued 1 + N /issue reads (N ≤ 40) per 30s refetch on the
// daemon's own Linear API key — ~4,900 requests/hour from one open tab against
// a ~1,500/hour budget, starving the pipeline into rate-limit backoff. The
// daemon now assembles the whole panel from ONE query; buildEpicDagPayload is
// the pure assembly, pinned here without a network.
// ---------------------------------------------------------------------------
import { buildEpicDagPayload, getEpicDag, MAX_EPIC_DAG_CHILDREN, type RawEpicDagIssue } from "../src/linear.ts";
import { readFileSync } from "node:fs";

const rawChild = (identifier: string, description: string | null = null): RawEpicDagIssue["children"]["nodes"][number] => ({
  identifier, title: `title ${identifier}`, description,
  state: { name: "Todo", type: "unstarted" }, labels: { nodes: [{ name: "Factory-Planned" }] },
});

describe("buildEpicDagPayload — one query serves the whole Epic DAG panel", () => {
  test("children carry depends_on/touches parsed by the AUTHORITATIVE meta.ts parser (start-anchored)", () => {
    const payload = buildEpicDagPayload({
      identifier: "FAC-30", title: "Epic",
      children: { nodes: [
        rawChild("FAC-31", "<!-- factory\ndepends_on: FAC-1, FAC-2\ntouches: src/a/**, src/b.ts\n-->\n\nbody"),
        // A meta block buried in prose (injected/pasted) draws NO edges.
        rawChild("FAC-32", "Some prose first.\n<!-- factory\ndepends_on: FAC-1\n-->"),
        rawChild("FAC-33", null),
      ] },
    });
    expect(payload.epic).toEqual({ identifier: "FAC-30", title: "Epic" });
    expect(payload.tickets[0]).toEqual({
      identifier: "FAC-31", title: "title FAC-31", stateType: "unstarted", stateName: "Todo",
      labels: ["Factory-Planned"], dependsOn: ["FAC-1", "FAC-2"], touches: ["src/a/**", "src/b.ts"],
    });
    expect(payload.tickets[1]!.dependsOn).toEqual([]);
    expect(payload.tickets[2]!.dependsOn).toEqual([]);
    expect(payload.tickets[2]!.touches).toEqual([]);
  });

  test("children are capped at MAX_EPIC_DAG_CHILDREN (in-code display cap)", () => {
    const nodes = Array.from({ length: 55 }, (_, i) => rawChild(`FAC-${i + 1}`));
    const payload = buildEpicDagPayload({ identifier: "FAC-30", title: "Epic", children: { nodes } });
    expect(MAX_EPIC_DAG_CHILDREN).toBe(40);
    expect(payload.tickets).toHaveLength(40);
  });

  test("descriptions never reach the wire payload — only parsed meta does", () => {
    const payload = buildEpicDagPayload({
      identifier: "FAC-30", title: "Epic",
      children: { nodes: [rawChild("FAC-31", "<!-- factory\ntouches: src/x.ts\n-->\nSENSITIVE ticket body")] },
    });
    expect(JSON.stringify(payload)).not.toContain("SENSITIVE");
  });

  test("getEpicDag issues exactly ONE GraphQL request (static pin — no per-child fetch loop)", () => {
    // The function body must contain a single gql call and no map/loop that
    // fetches per child; the children arrive inside the one epic query.
    const src = readFileSync(new URL("../src/linear.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export async function getEpicDag"));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    expect((body.match(/gql[<(]/g) ?? []).length).toBe(1);
    expect(typeof getEpicDag).toBe("function");
  });
});
