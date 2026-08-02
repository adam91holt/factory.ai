// fetchQueue's server-side hold-label exclusion (issue #8 F1).
//
// WP3 moved Blocked / Needs Human into unstarted-TYPE states, which put held
// issues inside the SAME server-truncated `first: 50` unstarted page fetchQueue
// reads — label filtering only happened client-side, AFTER truncation, so a
// backlog of blocked/needs-human issues could crowd fresh Todo tickets out of
// the page entirely (the daemon would see an "empty" queue). The fix sends the
// exclusion to the SERVER (`labels: { every: { name: { nin: HOLD_LABELS } } }` —
// Linear's IssueLabelCollectionFilter has NO `none` field; live 400, 2026-08-02)
// and fetches the held complement as a second aliased page in the same request
// so the dashboard's queue_snapshot keeps rendering parked/needs-human cards
// (the WP3 promise). These tests pin, via the injectable transport deps:
//   1. the request itself — held labels excluded server-side, both pages asked
//      for in ONE round-trip (the failure mode was in the QUERY, so the query
//      is what gets pinned);
//   2. the client-side skip-set survives as belt-and-braces — a held issue the
//      server hands back anyway (filter regression) still never becomes eligible;
//   3. the snapshot union — held issues render with their lanes, but are never
//      returned as claimable.

import { describe, expect, test } from "bun:test";
import { bus } from "../src/events.ts";
import {
  ConnectionHealth, fetchQueue, HOLD_LABELS,
  EXECUTING_LABEL, PARKED_LABEL, NEEDS_HUMAN_LABEL, PLANNED_LABEL, STALE_LABEL, AWAITING_ANSWER_LABEL,
} from "../src/linear.ts";
import type { LinearTransportDeps } from "../src/linear.ts";

interface RawNode {
  id: string; identifier: string; title: string; description: string | null; url: string;
  createdAt: string;
  team: { id: string; key: string };
  state: { name: string; type: string; description?: string | null };
  labels: { nodes: Array<{ name: string }> };
}

function node(identifier: string, opts: { labels?: string[]; createdAt?: string; stateDesc?: string } = {}): RawNode {
  return {
    id: `id-${identifier}`, identifier, title: `t-${identifier}`, description: "", url: `https://linear.app/${identifier}`,
    createdAt: opts.createdAt ?? "2026-07-01T00:00:00.000Z",
    team: { id: "team-1", key: "FAC" },
    state: { name: "Todo", type: "unstarted", description: opts.stateDesc ?? "[factory:queue]" },
    labels: { nodes: (opts.labels ?? []).map((name) => ({ name })) },
  };
}

/** Fake transport that records every request body and returns the given pages. */
function queueDeps(queue: RawNode[], held: RawNode[]): { deps: LinearTransportDeps; bodies: Array<{ query: string; variables: Record<string, unknown> }> } {
  const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const deps: LinearTransportDeps = {
    health: new ConnectionHealth(() => {}),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> });
      return new Response(JSON.stringify({ data: { queue: { nodes: queue }, held: { nodes: held } } }), { status: 200 });
    },
  };
  return { deps, bodies };
}

describe("fetchQueue — server-side hold-label exclusion", () => {
  test("HOLD_LABELS is exactly the historical skip-set (one list, two enforcement points)", () => {
    expect([...HOLD_LABELS].sort()).toEqual([
      EXECUTING_LABEL, PARKED_LABEL, NEEDS_HUMAN_LABEL, PLANNED_LABEL, STALE_LABEL, AWAITING_ANSWER_LABEL,
    ].sort());
  });

  test("ONE request carries BOTH server-side filters: every-nin for the queue page, some-in for the held page", async () => {
    const { deps, bodies } = queueDeps([node("FAC-1")], []);
    await fetchQueue(deps);
    expect(bodies.length).toBe(1); // aliased pages, not a second round-trip
    const { query, variables } = bodies[0]!;
    // The queue page excludes hold labels ON THE SERVER — this filter existing
    // in the request is the whole fix: held backlog can no longer crowd the
    // server-truncated page before any client code runs.
    expect(query.replace(/\s+/g, " ")).toContain("labels: { every: { name: { nin: $hold } } }");
    // The held complement is fetched only for the dashboard snapshot.
    expect(query.replace(/\s+/g, " ")).toContain("labels: { some: { name: { in: $hold } } }");
    // And the variable really carries every hold label.
    expect((variables.hold as string[]).sort()).toEqual([...HOLD_LABELS].sort());
    expect(query).toContain('state: { type: { eq: "unstarted" } }');
  });

  test("belt-and-braces: a held issue the server returns in the queue page anyway is STILL skipped", async () => {
    // Simulates a server-side filter regression (API change, silently ignored
    // filter): the parked issue arrives inside the queue page. The client-side
    // skip-set must still keep it out of the claimable result.
    const { deps } = queueDeps(
      [node("FAC-2", { createdAt: "2026-07-02T00:00:00.000Z" }),
       node("FAC-3", { labels: [PARKED_LABEL] }),
       node("FAC-1", { createdAt: "2026-07-01T00:00:00.000Z" })],
      [],
    );
    const eligible = await fetchQueue(deps);
    expect(eligible.map((i) => i.identifier)).toEqual(["FAC-1", "FAC-2"]); // FIFO, parked skipped
  });

  test("held-page issues are NEVER claimable but DO reach the queue_snapshot with their lanes", async () => {
    const { deps } = queueDeps(
      [node("FAC-10")],
      [node("FAC-11", { labels: [NEEDS_HUMAN_LABEL] }),
       node("FAC-12", { labels: [PARKED_LABEL] }),
       node("FAC-13", { labels: [EXECUTING_LABEL] })],
    );
    const snapshots: Array<{ identifier: string; lane: string }> = [];
    const unsubscribe = bus.subscribe((e) => {
      if (e.type === "queue_snapshot") {
        snapshots.push(...e.issues.map((i) => ({ identifier: i.identifier, lane: i.lane })));
      }
    });
    try {
      const eligible = await fetchQueue(deps);
      // Claimable: only the label-free queue-page issue.
      expect(eligible.map((i) => i.identifier)).toEqual(["FAC-10"]);
      // The dashboard board still sees the held issues — the WP3 promise that
      // blocked/needs-human cards keep rendering instead of vanishing.
      expect(snapshots).toEqual([
        { identifier: "FAC-10", lane: "todo" },
        { identifier: "FAC-11", lane: "needs_human" },
        { identifier: "FAC-12", lane: "parked" },
        { identifier: "FAC-13", lane: "claimed" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  test("a hand-dragged Blocked card (state tag, NO label) stays out of the claimable queue via its lane source", async () => {
    // No factory label ⇒ every.nin is vacuously TRUE (load-bearing: fresh unlabeled tickets stay eligible), and
    // the client skip-set won't either — it lands in the queue page. That is
    // today's (pre-existing) claim behaviour, pinned here so a change to it is
    // a decision, not an accident; its LANE must still render as parked.
    const { deps } = queueDeps([node("FAC-20", { stateDesc: "[factory:blocked]" })], []);
    const lanes: string[] = [];
    const unsubscribe = bus.subscribe((e) => {
      if (e.type === "queue_snapshot") lanes.push(...e.issues.map((i) => i.lane));
    });
    try {
      await fetchQueue(deps);
      expect(lanes).toEqual(["parked"]);
    } finally {
      unsubscribe();
    }
  });
});
