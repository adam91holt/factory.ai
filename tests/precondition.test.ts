import { describe, expect, test } from "bun:test";
import {
  parsePrecondition, parsePreconditions, evaluateOne, decideFreshness, checkFreshness, liftPreconditions,
  type Precondition, type PreconditionProbes, type PrState, type PerCheck,
} from "../src/precondition.ts";
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
});
