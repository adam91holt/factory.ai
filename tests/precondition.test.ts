import { describe, expect, test } from "bun:test";
import {
  parsePrecondition, parsePreconditions, evaluateOne, decideFreshness, checkFreshness, liftPreconditions,
  decidePendingMerge, checkPendingMerge, applyMergeGate,
  type Precondition, type PreconditionProbes, type PrState, type PerCheck, type MergeGateIssue,
} from "../src/precondition.ts";
import { deriveImplicitDeps, type Schedulable } from "../src/dag.ts";
import { withFactoryMeta } from "../src/meta.ts";

// A fully-injected probe set so every check is pure (no gh, no fs). Each field
// defaults to the "holds" answer; a test overrides only what it exercises.
function probes(over: Partial<PreconditionProbes> = {}): PreconditionProbes {
  return {
    prState: () => "UNKNOWN",
    pathExists: () => false,
    fileContains: () => false,
    ...over,
  };
}

const p = (raw: string): Precondition => {
  const parsed = parsePrecondition(raw);
  if (!parsed) throw new Error(`test fixture failed to parse: ${raw}`);
  return parsed;
};

describe("parsePrecondition", () => {
  test("each known kind with a well-formed arg parses", () => {
    expect(parsePrecondition("undelivered factory/fac-1")).toMatchObject({ kind: "undelivered", arg: "factory/fac-1" });
    expect(parsePrecondition("pr-open acme/w#4")).toMatchObject({ kind: "pr-open", arg: "acme/w#4" });
    expect(parsePrecondition("pr-open #12")).toMatchObject({ kind: "pr-open", arg: "#12" });
    expect(parsePrecondition("pr-open https://github.com/acme/w/pull/4")).toMatchObject({ kind: "pr-open" });
    expect(parsePrecondition("pr-merged acme/w#6")).toMatchObject({ kind: "pr-merged", arg: "acme/w#6" });
    expect(parsePrecondition("pr-merged #6")).toMatchObject({ kind: "pr-merged", arg: "#6" });
    expect(parsePrecondition("pr-merged https://github.com/acme/w/pull/6")).toMatchObject({ kind: "pr-merged" });
    expect(parsePrecondition("path-missing src/x.ts")).toMatchObject({ kind: "path-missing", arg: "src/x.ts" });
    expect(parsePrecondition("path-exists src/x.ts")).toMatchObject({ kind: "path-exists", arg: "src/x.ts" });
    expect(parsePrecondition("text-present src/a.ts::TODO")).toMatchObject({ kind: "text-present", arg: "src/a.ts::TODO" });
    expect(parsePrecondition("text-absent src/a.ts::done")).toMatchObject({ kind: "text-absent", arg: "src/a.ts::done" });
  });

  test("an unknown kind is dropped (null)", () => {
    expect(parsePrecondition("merge-now acme/w#4")).toBeNull();
    expect(parsePrecondition("proceed")).toBeNull();
  });

  test("malformed args are dropped", () => {
    expect(parsePrecondition("pr-open acme/w")).toBeNull();        // no #N, not a url
    expect(parsePrecondition("pr-open")).toBeNull();               // no arg at all
    expect(parsePrecondition("pr-merged acme/w")).toBeNull();      // same arg contract as pr-open
    expect(parsePrecondition("pr-merged")).toBeNull();
    expect(parsePrecondition("text-present src/a.ts")).toBeNull(); // no ::needle
    expect(parsePrecondition("text-present ::needle")).toBeNull(); // empty path
    expect(parsePrecondition("text-absent src/a.ts::")).toBeNull();// empty needle
  });

  test("path args that escape the worktree are dropped (traversal defense)", () => {
    expect(parsePrecondition("path-missing /etc/passwd")).toBeNull();
    expect(parsePrecondition("path-exists ../../secret")).toBeNull();
    expect(parsePrecondition("text-present ../x::y")).toBeNull();
  });

  test("whitespace around the line is tolerated", () => {
    expect(parsePrecondition("   pr-open   acme/w#4   ")).toMatchObject({ kind: "pr-open", arg: "acme/w#4" });
  });
});

describe("parsePreconditions (reads only the start-anchored meta block)", () => {
  test("collects every precondition line from the block", () => {
    const desc = "<!-- factory\nrepo: acme/w\nprecondition: pr-open acme/w#4\nprecondition: path-missing src/x.ts\n-->\n\nbody";
    expect(parsePreconditions(desc).map((x) => x.kind)).toEqual(["pr-open", "path-missing"]);
  });

  test("a precondition line buried in prose is ignored", () => {
    const desc = "intro prose\nprecondition: pr-open acme/w#4\n\nmore";
    expect(parsePreconditions(desc)).toEqual([]);
  });

  test("a precondition in a SECOND (embedded) block is ignored — only offset 0 is authoritative", () => {
    const desc = "<!-- factory\nrepo: acme/w\n-->\n\nbody\n\n<!-- factory\nprecondition: pr-open acme/w#9\n-->";
    expect(parsePreconditions(desc)).toEqual([]);
  });

  test("no block -> []", () => {
    expect(parsePreconditions("just a plain ticket")).toEqual([]);
  });
});

describe("evaluateOne (pure via fake probes)", () => {
  const ctx = { repo: "acme/w", worktreeDir: "/wt" };

  test("pr-open: OPEN holds, MERGED/CLOSED are moot, UNKNOWN is unknown", () => {
    expect(evaluateOne(p("pr-open acme/w#4"), ctx, probes({ prState: () => "OPEN" })).status).toBe("hold");
    expect(evaluateOne(p("pr-open acme/w#4"), ctx, probes({ prState: () => "MERGED" })).status).toBe("moot");
    expect(evaluateOne(p("pr-open acme/w#4"), ctx, probes({ prState: () => "CLOSED" })).status).toBe("moot");
    expect(evaluateOne(p("pr-open acme/w#4"), ctx, probes({ prState: () => "UNKNOWN" })).status).toBe("unknown");
  });

  test("pr-open carries its own repo when arg is org/repo#N", () => {
    let seenRepo = "";
    const probe = probes({ prState: (_ref: string, repo: string): PrState => { seenRepo = repo; return "OPEN"; } });
    evaluateOne(p("pr-open other/lib#7"), ctx, probe);
    expect(seenRepo).toBe("other/lib");
  });

  test("pr-merged defensive fallback (the primary gate is decidePendingMerge, pre-claim): MERGED holds (proceed), CLOSED is moot (cancel), OPEN/UNKNOWN are unknown (park, never proceed)", () => {
    expect(evaluateOne(p("pr-merged acme/w#6"), ctx, probes({ prState: () => "MERGED" })).status).toBe("hold");
    expect(evaluateOne(p("pr-merged acme/w#6"), ctx, probes({ prState: () => "CLOSED" })).status).toBe("moot");
    expect(evaluateOne(p("pr-merged acme/w#6"), ctx, probes({ prState: () => "OPEN" })).status).toBe("unknown");
    expect(evaluateOne(p("pr-merged acme/w#6"), ctx, probes({ prState: () => "UNKNOWN" })).status).toBe("unknown");
  });

  test("undelivered: OPEN holds, MERGED is moot, no-PR (UNKNOWN) HOLDS (rebuild)", () => {
    expect(evaluateOne(p("undelivered factory/fac-1"), ctx, probes({ prState: () => "OPEN" })).status).toBe("hold");
    expect(evaluateOne(p("undelivered factory/fac-1"), ctx, probes({ prState: () => "MERGED" })).status).toBe("moot");
    expect(evaluateOne(p("undelivered factory/fac-1"), ctx, probes({ prState: () => "UNKNOWN" })).status).toBe("hold");
  });

  test("path-missing: exists -> moot, absent -> hold", () => {
    expect(evaluateOne(p("path-missing src/x.ts"), ctx, probes({ pathExists: () => true })).status).toBe("moot");
    expect(evaluateOne(p("path-missing src/x.ts"), ctx, probes({ pathExists: () => false })).status).toBe("hold");
  });

  test("path-exists: present -> hold, gone -> moot (the inverse)", () => {
    expect(evaluateOne(p("path-exists src/x.ts"), ctx, probes({ pathExists: () => true })).status).toBe("hold");
    expect(evaluateOne(p("path-exists src/x.ts"), ctx, probes({ pathExists: () => false })).status).toBe("moot");
  });

  test("text-present: needle present -> hold, gone -> moot, file missing -> unknown", () => {
    expect(evaluateOne(p("text-present src/a.ts::TODO"), ctx, probes({ fileContains: () => true })).status).toBe("hold");
    expect(evaluateOne(p("text-present src/a.ts::TODO"), ctx, probes({ fileContains: () => false })).status).toBe("moot");
    expect(evaluateOne(p("text-present src/a.ts::TODO"), ctx, probes({ fileContains: () => "UNKNOWN" })).status).toBe("unknown");
  });

  test("text-absent: needle present -> moot, absent -> hold, file missing -> unknown (the inverse)", () => {
    expect(evaluateOne(p("text-absent src/a.ts::done"), ctx, probes({ fileContains: () => true })).status).toBe("moot");
    expect(evaluateOne(p("text-absent src/a.ts::done"), ctx, probes({ fileContains: () => false })).status).toBe("hold");
    expect(evaluateOne(p("text-absent src/a.ts::done"), ctx, probes({ fileContains: () => "UNKNOWN" })).status).toBe("unknown");
  });

  test("path/text checks with no worktree are unknown (nothing to probe)", () => {
    expect(evaluateOne(p("path-missing src/x.ts"), { repo: "acme/w" }, probes()).status).toBe("unknown");
    expect(evaluateOne(p("text-present src/a.ts::x"), { repo: "acme/w" }, probes()).status).toBe("unknown");
  });
});

// Helper to build a decideFreshness input row.
const row = (raw: string, status: PerCheck) => ({ p: p(raw), status, reason: `${raw}: ${status}` });

describe("decideFreshness precedence", () => {
  test("all hold -> proceed", () => {
    expect(decideFreshness([row("undelivered factory/fac-1", "hold"), row("pr-open acme/w#4", "hold")]).action).toBe("proceed");
  });

  test("every authored premise moot -> cancel", () => {
    expect(decideFreshness([row("pr-open acme/w#4", "moot"), row("path-missing src/x.ts", "moot")]).action).toBe("cancel");
  });

  test("mixed moot + hold -> park (partial staleness)", () => {
    const d = decideFreshness([row("pr-open acme/w#4", "moot"), row("path-missing src/x.ts", "hold")]);
    expect(d.action).toBe("park");
    expect(d.reason).toContain("pr-open acme/w#4");
  });

  test("authored unknown + hold, none moot -> park", () => {
    expect(decideFreshness([row("pr-open acme/w#4", "unknown"), row("path-exists src/x.ts", "hold")]).action).toBe("park");
  });

  test("implicit undelivered unknown ALONE -> proceed (fail-open on gh outage)", () => {
    expect(decideFreshness([row("undelivered factory/fac-1", "unknown")]).action).toBe("proceed");
  });

  test("a MOOT delivery guard cancels regardless of a still-holding authored premise", () => {
    // Branch PR merged (guard moot) even though the world-premise still holds:
    // the ticket's own work is already delivered -> cancel.
    expect(decideFreshness([row("undelivered factory/fac-1", "moot"), row("path-missing src/x.ts", "hold")]).action).toBe("cancel");
  });

  test("a holding guard does NOT downgrade an all-authored-moot ticket to park", () => {
    // The steward follow-up shape: fresh branch has no PR (guard holds) yet the
    // authored pr-open reads moot -> still cancel, not park.
    expect(decideFreshness([row("undelivered factory/fac-99", "hold"), row("pr-open acme/w#4", "moot")]).action).toBe("cancel");
  });

  test("the reason names the flipping check", () => {
    const d = decideFreshness([row("pr-open acme/w#4", "moot")]);
    expect(d.reason).toContain("pr-open acme/w#4");
  });
});

describe("checkPendingMerge (probe wiring)", () => {
  test("reads only the ticket's pr-merged preconditions — a co-declared pr-open is invisible to this gate", async () => {
    const desc = withFactoryMeta("## Goal\nx", { type: "task", repo: "acme/w", preconditions: ["pr-open acme/w#4", "pr-merged acme/w#6"] });
    const queried: string[] = [];
    const probe = probes({ prState: (ref: string): PrState => { queried.push(ref); return ref === "6" ? "MERGED" : "OPEN"; } });
    const d = await checkPendingMerge(desc, { repo: "acme/w" }, probe);
    expect(queried).toEqual(["6"]);
    expect(d.action).toBe("proceed");
  });

  test("a ticket with no pr-merged precondition -> proceed WITHOUT probing gh at all (zero cost for the common case)", async () => {
    let called = false;
    const probe = probes({ prState: (): PrState => { called = true; return "OPEN"; } });
    const d = await checkPendingMerge("## Goal\nplain", { repo: "acme/w" }, probe);
    expect(d.action).toBe("proceed");
    expect(called).toBe(false);
  });
});

describe("FAC-20 regression (the exact incident)", () => {
  test("a ticket carrying `precondition: pr-open acme/w#4` with the PR MERGED -> cancel", async () => {
    const desc = withFactoryMeta("## Goal\nmake PR #4 mergeable", { type: "task", repo: "acme/w", preconditions: ["pr-open acme/w#4"] });
    // The PR is merged; the fresh follow-up branch has no PR of its own (UNKNOWN).
    const probe = probes({
      prState: (ref: string): PrState => (ref === "4" ? "MERGED" : "UNKNOWN"),
    });
    const d = await checkFreshness("FAC-99", desc, { repo: "acme/w", worktreeDir: "/wt" }, probe);
    expect(d.action).toBe("cancel");
    expect(d.reason).toContain("MERGED");
  });

  test("the same ticket while PR #4 is still OPEN -> proceed", async () => {
    const desc = withFactoryMeta("## Goal\nmake PR #4 mergeable", { type: "task", repo: "acme/w", preconditions: ["pr-open acme/w#4"] });
    const probe = probes({ prState: (ref: string): PrState => (ref === "4" ? "OPEN" : "UNKNOWN") });
    expect((await checkFreshness("FAC-99", desc, { repo: "acme/w", worktreeDir: "/wt" }, probe)).action).toBe("proceed");
  });
});

describe("decidePendingMerge precedence (pure combinator)", () => {
  test("no pr-merged gate declared -> proceed", () => {
    expect(decidePendingMerge([{ p: p("path-missing src/x.ts"), state: "OPEN" }]).action).toBe("proceed");
    expect(decidePendingMerge([]).action).toBe("proceed");
  });

  test("PR OPEN -> hold", () => {
    expect(decidePendingMerge([{ p: p("pr-merged acme/w#6"), state: "OPEN" }]).action).toBe("hold");
  });

  test("PR state UNKNOWN -> hold (fail-safe: unreadable never reads as merged)", () => {
    expect(decidePendingMerge([{ p: p("pr-merged acme/w#6"), state: "UNKNOWN" }]).action).toBe("hold");
  });

  test("PR MERGED -> proceed", () => {
    expect(decidePendingMerge([{ p: p("pr-merged acme/w#6"), state: "MERGED" }]).action).toBe("proceed");
  });

  test("PR CLOSED without merging -> cancel", () => {
    const d = decidePendingMerge([{ p: p("pr-merged acme/w#6"), state: "CLOSED" }]);
    expect(d.action).toBe("cancel");
    expect(d.reason).toContain("acme/w#6");
  });

  test("multiple gates: any CLOSED cancels even if another is still OPEN", () => {
    expect(decidePendingMerge([
      { p: p("pr-merged acme/w#5"), state: "OPEN" },
      { p: p("pr-merged acme/w#6"), state: "CLOSED" },
    ]).action).toBe("cancel");
  });

  test("multiple gates: all MERGED -> proceed; one still OPEN -> hold", () => {
    expect(decidePendingMerge([
      { p: p("pr-merged acme/w#5"), state: "MERGED" },
      { p: p("pr-merged acme/w#6"), state: "MERGED" },
    ]).action).toBe("proceed");
    expect(decidePendingMerge([
      { p: p("pr-merged acme/w#5"), state: "MERGED" },
      { p: p("pr-merged acme/w#6"), state: "OPEN" },
    ]).action).toBe("hold");
  });
});

describe("FAC-74 regression (the exact incident, wait-until-merged shape)", () => {
  // A steward follow-up filed against a still-open PR, mirroring FAC-74's
  // "verify main is green after PR #6 lands" ticket. Pins the full life cycle
  // the ticket demands: NOT claimed while open, runs after merge, self-cancels
  // if the PR is closed without merging.
  const desc = withFactoryMeta("## Goal\nverify main is green after PR #6 lands", { type: "task", repo: "acme/w", preconditions: ["pr-merged acme/w#6"] });

  test("PR still OPEN -> hold (NOT claimed) — the FAC-74 race this ticket fixes", async () => {
    const probe = probes({ prState: (ref: string): PrState => (ref === "6" ? "OPEN" : "UNKNOWN") });
    const d = await checkPendingMerge(desc, { repo: "acme/w" }, probe);
    expect(d.action).toBe("hold");
  });

  test("gh unreadable (UNKNOWN) -> hold, never proceeds and never cancels", async () => {
    const probe = probes({ prState: () => "UNKNOWN" });
    const d = await checkPendingMerge(desc, { repo: "acme/w" }, probe);
    expect(d.action).toBe("hold");
  });

  test("PR MERGED -> proceed (runs, now safe against a main that has the content)", async () => {
    const probe = probes({ prState: (ref: string): PrState => (ref === "6" ? "MERGED" : "UNKNOWN") });
    const d = await checkPendingMerge(desc, { repo: "acme/w" }, probe);
    expect(d.action).toBe("proceed");
  });

  test("PR CLOSED without merging -> cancel (self-cancels; the premise can never be satisfied)", async () => {
    const probe = probes({ prState: (ref: string): PrState => (ref === "6" ? "CLOSED" : "UNKNOWN") });
    const d = await checkPendingMerge(desc, { repo: "acme/w" }, probe);
    expect(d.action).toBe("cancel");
  });

  test("a bare pr-open (the OLD, backwards-for-post-merge kind) would have cancelled on merge — pr-merged does not", async () => {
    // Documents the exact bug this ticket fixes: decideFreshness treats a
    // MERGED pr-open as moot -> cancel, which is backwards for a post-merge
    // follow-up. decidePendingMerge (pr-merged) reads the SAME merged state as
    // the green light to proceed.
    const oldStyleDesc = withFactoryMeta("## Goal\nverify main is green after PR #6 lands", { type: "task", repo: "acme/w", preconditions: ["pr-open acme/w#6"] });
    const probe = probes({ prState: (ref: string): PrState => (ref === "6" ? "MERGED" : "UNKNOWN") });
    const oldVerdict = await checkFreshness("FAC-75", oldStyleDesc, { repo: "acme/w", worktreeDir: "/wt" }, probe);
    expect(oldVerdict.action).toBe("cancel"); // the FAC-74 bug, preserved on purpose for the OLD kind
    const newVerdict = await checkPendingMerge(desc, { repo: "acme/w" }, probe);
    expect(newVerdict.action).toBe("proceed"); // the fix
  });
});

describe("checkFreshness excludes pr-merged (repair, FAC-75 review round 1, medium)", () => {
  // Outcome #2's fail-safe direction ("an unreadable/unknown PR state defers —
  // stays queued — never park") must hold post-claim too, not just at the
  // pre-claim gate. Before the repair, evaluateOne's pr-merged case mapped
  // OPEN/UNKNOWN to "unknown", which decideFreshness turns into `park` — a
  // human-blocking state — the moment ANY other check makes the ticket reach
  // this post-claim freshness gate (e.g. a claimed ticket whose gh read
  // blips between the pre-claim probe and this check). checkFreshness now
  // drops `pr-merged` from the authored set entirely (it's the pre-claim
  // gate's business, per the module header EXCEPTION), so it can never park
  // a ticket over it.
  const desc = withFactoryMeta("## Goal\nverify main is green after PR #6 lands", { type: "task", repo: "acme/w", preconditions: ["pr-merged acme/w#6"] });

  test("PR still OPEN post-claim -> proceed (NOT park) — pr-merged is invisible to decideFreshness", async () => {
    const probe = probes({ prState: (ref: string): PrState => (ref === "6" ? "OPEN" : "UNKNOWN") });
    const d = await checkFreshness("FAC-90", desc, { repo: "acme/w", worktreeDir: "/wt" }, probe);
    expect(d.action).toBe("proceed");
  });

  test("gh UNKNOWN post-claim (transient blip) -> proceed (NOT park) — the exact repair scenario", async () => {
    const probe = probes({ prState: () => "UNKNOWN" });
    const d = await checkFreshness("FAC-90", desc, { repo: "acme/w", worktreeDir: "/wt" }, probe);
    expect(d.action).toBe("proceed");
  });

  test("PR MERGED post-claim -> proceed (unchanged)", async () => {
    const probe = probes({ prState: (ref: string): PrState => (ref === "6" ? "MERGED" : "UNKNOWN") });
    const d = await checkFreshness("FAC-90", desc, { repo: "acme/w", worktreeDir: "/wt" }, probe);
    expect(d.action).toBe("proceed");
  });

  test("a co-declared self-cancel precondition (pr-open) is still evaluated normally alongside an ignored pr-merged", async () => {
    const mixed = withFactoryMeta("## Goal\nx", { type: "task", repo: "acme/w", preconditions: ["pr-open acme/w#4", "pr-merged acme/w#6"] });
    const probe = probes({ prState: (ref: string): PrState => (ref === "4" ? "MERGED" : "OPEN") });
    // pr-open acme/w#4 is MERGED -> moot -> cancel, regardless of pr-merged's OPEN/unknown state.
    const d = await checkFreshness("FAC-90", mixed, { repo: "acme/w", worktreeDir: "/wt" }, probe);
    expect(d.action).toBe("cancel");
  });
});

describe("checkFreshness default path (no authored preconditions)", () => {
  test("a normal ticket whose branch has no PR yet -> proceed (identical to today)", async () => {
    const d = await checkFreshness("FAC-1", "## Goal\nplain", { repo: "acme/w", worktreeDir: "/wt" }, probes({ prState: () => "UNKNOWN" }));
    expect(d.action).toBe("proceed");
  });

  test("a ticket whose OWN branch PR already merged -> cancel (FAC-20 at ticket level)", async () => {
    const d = await checkFreshness("FAC-1", "## Goal\nplain", { repo: "acme/w", worktreeDir: "/wt" }, probes({ prState: () => "MERGED" }));
    expect(d.action).toBe("cancel");
  });
});

describe("liftPreconditions", () => {
  test("extracts valid entries from a '## Precondition' section, drops non-DSL prose", () => {
    const body = [
      "## Goal", "fix it", "",
      "## Precondition",
      "- pr-open acme/w#4",
      "- this line is just prose, not DSL",
      "- path-missing src/x.ts", "",
      "## Repo", "acme/w",
    ].join("\n");
    expect(liftPreconditions(body)).toEqual(["pr-open acme/w#4", "path-missing src/x.ts"]);
  });

  test("extracts inline 'Precondition:' lines anywhere", () => {
    expect(liftPreconditions("blah\nPrecondition: pr-open acme/w#4\nmore")).toEqual(["pr-open acme/w#4"]);
  });

  test("a follow-up with no precondition section -> []", () => {
    expect(liftPreconditions("## Goal\ndo it\n## Repo\nacme/w")).toEqual([]);
  });

  test("the section closes at the next header (a later bullet is not swept in)", () => {
    const body = "## Precondition\n- pr-open acme/w#4\n## Outcomes\n- path-missing not-a-precondition-here.ts";
    expect(liftPreconditions(body)).toEqual(["pr-open acme/w#4"]);
  });

  test("lifted strings survive a withFactoryMeta round-trip", () => {
    const lifted = liftPreconditions("## Precondition\n- pr-open acme/w#4\n- path-missing src/x.ts");
    const stamped = withFactoryMeta("## Goal\ndo it", { type: "task", repo: "acme/w", preconditions: lifted });
    expect(parsePreconditions(stamped).map((x) => x.arg)).toEqual(["acme/w#4", "src/x.ts"]);
  });

  // Repair (FAC-75 review round 1, high): agents/steward.md's OWN vocabulary
  // docs wrap every DSL example in a code span (`` `pr-merged <ref>` ``), so a
  // steward echoing that formatting into the ticket body is a very plausible
  // output shape, not an edge case. Before the repair this silently dropped
  // the WHOLE line (the leading backtick makes "`pr-merged" an unknown kind),
  // stamping the follow-up with NO precondition at all — for the new
  // wait-kind gate that recreates the exact FAC-74 race this ticket exists to
  // close, not just a missed self-cancel.
  test("a single-backtick code span around a pr-merged line still lifts", () => {
    const body = "## Precondition\n- `pr-merged acme/w#6`";
    expect(liftPreconditions(body)).toEqual(["pr-merged acme/w#6"]);
  });

  test("a code-spanned inline 'Precondition:' line still lifts", () => {
    expect(liftPreconditions("blah\nPrecondition: `pr-merged acme/w#6`\nmore")).toEqual(["pr-merged acme/w#6"]);
  });

  test("a code span still round-trips into a real gate (not silently ungated)", () => {
    const lifted = liftPreconditions("## Precondition\n- `pr-merged acme/w#6`");
    const stamped = withFactoryMeta("## Goal\nverify after #6 lands", { type: "task", repo: "acme/w", preconditions: lifted });
    expect(parsePreconditions(stamped).map((x) => x.kind)).toEqual(["pr-merged"]);
  });

  test("an unmatched/partial backtick is NOT stripped — still drops if otherwise malformed", () => {
    expect(liftPreconditions("## Precondition\n- `pr-merged acme/w#6")).toEqual([]); // no closing backtick
    expect(liftPreconditions("## Precondition\n- pr-merged acme/w#6`")).toEqual([]); // no opening backtick
  });
});

// ---------------------------------------------------------------------------
// applyMergeGate — the tick() SCHEDULING WIRING itself (repair, FAC-75 review
// round 1, medium #3). index.ts's tick() cannot be unit-tested directly
// (importing it runs the daemon's main()), so the gate loop was extracted
// into this pure(-given-probes) function precisely so the WIRING — not just
// decidePendingMerge's pure combinator — has coverage. This is exactly the
// layer where the round-1 high-severity defect lived (the gate touching
// in-flight issues; a held issue vanishing from DAG scheduling), so these
// tests pin the fixed shape of that wiring.
// ---------------------------------------------------------------------------

interface FakeIssue extends MergeGateIssue { touches?: string[]; dependsOn?: string[]; }

function fakeIssue(identifier: string, preconditions: string[], opts: { touches?: string[]; dependsOn?: string[] } = {}): FakeIssue {
  const description = withFactoryMeta(`## Goal\n${identifier}`, {
    type: "task", repo: "acme/w", preconditions,
    ...(opts.touches ? { touches: opts.touches } : {}),
    ...(opts.dependsOn ? { depends_on: opts.dependsOn } : {}),
  });
  return { identifier, description, touches: opts.touches, dependsOn: opts.dependsOn };
}

const repoOf = () => "acme/w";

describe("applyMergeGate (the tick() wiring, extracted for testability)", () => {
  test("no pr-merged precondition -> schedulable, not held, no gh probe", async () => {
    const a = fakeIssue("FAC-1", []);
    let probed = false;
    const { schedulable, heldIds, cancelled } = await applyMergeGate([a], repoOf, {
      prState: (): PrState => { probed = true; return "OPEN"; },
      pathExists: () => false, fileContains: () => false,
    });
    expect(schedulable.map((i) => i.identifier)).toEqual(["FAC-1"]);
    expect(heldIds.size).toBe(0);
    expect(cancelled).toEqual([]);
    expect(probed).toBe(false);
  });

  test("PR OPEN -> held: schedulable (visible to DAG) but flagged in heldIds — the FAC-74 race this ticket fixes", async () => {
    const a = fakeIssue("FAC-90", ["pr-merged acme/w#6"]);
    const { schedulable, heldIds, cancelled } = await applyMergeGate([a], repoOf, {
      prState: (): PrState => "OPEN", pathExists: () => false, fileContains: () => false,
    });
    expect(schedulable.map((i) => i.identifier)).toEqual(["FAC-90"]);
    expect(heldIds.has("FAC-90")).toBe(true);
    expect(cancelled).toEqual([]);
  });

  test("PR state UNKNOWN (gh unreadable) -> held too, never proceed and never cancel (fail-safe direction)", async () => {
    const a = fakeIssue("FAC-90", ["pr-merged acme/w#6"]);
    const { heldIds, cancelled, schedulable } = await applyMergeGate([a], repoOf, {
      prState: (): PrState => "UNKNOWN", pathExists: () => false, fileContains: () => false,
    });
    expect(heldIds.has("FAC-90")).toBe(true);
    expect(cancelled).toEqual([]);
    expect(schedulable.map((i) => i.identifier)).toEqual(["FAC-90"]);
  });

  test("PR MERGED -> schedulable and NOT held (claimable this tick)", async () => {
    const a = fakeIssue("FAC-90", ["pr-merged acme/w#6"]);
    const { schedulable, heldIds } = await applyMergeGate([a], repoOf, {
      prState: (): PrState => "MERGED", pathExists: () => false, fileContains: () => false,
    });
    expect(schedulable.map((i) => i.identifier)).toEqual(["FAC-90"]);
    expect(heldIds.size).toBe(0);
  });

  test("PR CLOSED unmerged -> cancelled, dropped from schedulable entirely (index.ts resolveStales it)", async () => {
    const a = fakeIssue("FAC-90", ["pr-merged acme/w#6"]);
    const { schedulable, heldIds, cancelled } = await applyMergeGate([a], repoOf, {
      prState: (): PrState => "CLOSED", pathExists: () => false, fileContains: () => false,
    });
    expect(schedulable).toEqual([]);
    expect(heldIds.size).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.issue.identifier).toBe("FAC-90");
    expect(cancelled[0]!.reason).toContain("CLOSED");
  });

  test("a probe throwing (gh crash) fails toward hold, not toward proceed or cancel", async () => {
    const a = fakeIssue("FAC-90", ["pr-merged acme/w#6"]);
    const { schedulable, heldIds, cancelled } = await applyMergeGate([a], repoOf, {
      prState: (): PrState => { throw new Error("gh ENOENT"); },
      pathExists: () => false, fileContains: () => false,
    });
    expect(schedulable.map((i) => i.identifier)).toEqual(["FAC-90"]);
    expect(heldIds.has("FAC-90")).toBe(true);
    expect(cancelled).toEqual([]);
  });

  test("mixed batch: each candidate resolved independently by its own gate state", async () => {
    const held = fakeIssue("FAC-1", ["pr-merged acme/w#5"]);
    const ready = fakeIssue("FAC-2", ["pr-merged acme/w#6"]);
    const cancel = fakeIssue("FAC-3", ["pr-merged acme/w#7"]);
    const plain = fakeIssue("FAC-4", []);
    const state: Record<string, PrState> = { "5": "OPEN", "6": "MERGED", "7": "CLOSED" };
    const { schedulable, heldIds, cancelled } = await applyMergeGate([held, ready, cancel, plain], repoOf, {
      prState: (ref: string): PrState => state[ref] ?? "UNKNOWN", pathExists: () => false, fileContains: () => false,
    });
    expect(schedulable.map((i) => i.identifier)).toEqual(["FAC-1", "FAC-2", "FAC-4"]);
    expect(heldIds).toEqual(new Set(["FAC-1"]));
    expect(cancelled.map((c) => c.issue.identifier)).toEqual(["FAC-3"]);
  });
});

describe("held candidates stay visible to DAG ordering (repair, FAC-75 review round 1, high)", () => {
  // The exact shape review round 1 flagged: FAC-100 is merge-gated and its PR
  // is still open; FAC-101, queued later, touches the same file with no
  // explicit depends_on. Before the repair, index.ts built the DAG candidate
  // list from ONLY the gate-passed issues, so FAC-100 (held) vanished from
  // deriveImplicitDeps entirely and FAC-101 could jump ahead of it — the
  // ordering the implicit-dep mechanism exists to guarantee was silently lost
  // for any ticket sitting behind this gate.
  test("a later sibling overlapping a held ticket's touches still gets the implicit depends_on edge", async () => {
    const held = fakeIssue("FAC-100", ["pr-merged acme/w#6"], { touches: ["src/shared.ts"] });
    const later = fakeIssue("FAC-101", [], { touches: ["src/shared.ts"] });
    const { schedulable, heldIds } = await applyMergeGate([held, later], repoOf, {
      prState: (): PrState => "OPEN", pathExists: () => false, fileContains: () => false,
    });
    // Held ticket is STILL a DAG candidate (not dropped) — only excluded from
    // the eventual claim batch via heldIds, exactly like index.ts does.
    expect(schedulable.map((i) => i.identifier)).toEqual(["FAC-100", "FAC-101"]);
    expect(heldIds).toEqual(new Set(["FAC-100"]));

    const candidates: Schedulable[] = schedulable.map((i) => ({
      identifier: i.identifier, dependsOn: i.dependsOn ?? [], touches: i.touches ?? [],
    }));
    const { augmented, added } = deriveImplicitDeps(candidates);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ identifier: "FAC-101", dependsOn: "FAC-100" });
    const fac101 = augmented.find((c) => c.identifier === "FAC-101")!;
    expect(fac101.dependsOn).toContain("FAC-100");
  });
});
