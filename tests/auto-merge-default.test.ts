import { describe, expect, test } from "bun:test";
import { effectiveMergeTier, decideMerge, type MergeEvidence } from "../src/merge-ladder.ts";

// Auto-merge-by-default (AUTO_MERGE_DEFAULT). The tier flip changes ONLY the
// default; decideMerge still enforces every SAFETY condition. These tests prove
// both halves: the tier resolution AND that "auto" tier never merges an unsafe task.

describe("effectiveMergeTier — auto-merge default + human-review opt-out", () => {
  test("autoDefault ON, un-enrolled non-self repo → auto", async () => {
    expect(effectiveMergeTier("acme/widgets", null, { autoDefault: true })).toBe("auto");
  });
  test("autoDefault OFF → human (unchanged legacy behavior)", async () => {
    expect(effectiveMergeTier("acme/widgets", null, { autoDefault: false })).toBe("human");
    expect(effectiveMergeTier("acme/widgets", null)).toBe("human");
  });
  test("self-repo is ALWAYS human, even with autoDefault ON", async () => {
    // isSelfRepo matches config.selfRepo OR any '.../factory'
    expect(effectiveMergeTier("acme/factory", null, { autoDefault: true })).toBe("human");
  });
  test("human-review opt-out forces human, even with autoDefault ON", async () => {
    expect(effectiveMergeTier("acme/widgets", null, { autoDefault: true, humanReview: true })).toBe("human");
  });
});

describe("decideMerge — auto tier NEVER merges an unsafe task (safety unchanged)", () => {
  const AUTO = "auto" as const;
  const OPTS = { lowRiskMaxDiff: 40 };
  const clean: MergeEvidence = { green: true, strength: "strong", guarded: false, needsHuman: false, security: "pass", browser: "pass", diffLines: 10 };

  test("a fully clean task at auto tier DOES merge (act=true)", async () => {
    expect(decideMerge(AUTO, clean, OPTS).act).toBe(true);
  });
  test("security FAIL → never acts", async () => {
    expect(decideMerge(AUTO, { ...clean, security: "fail" }, OPTS).act).toBe(false);
  });
  test("guarded paths touched → never acts", async () => {
    expect(decideMerge(AUTO, { ...clean, guarded: true }, OPTS).act).toBe(false);
  });
  test("needsHuman fold (taste/tester/test-deletion) → never acts", async () => {
    expect(decideMerge(AUTO, { ...clean, needsHuman: true }, OPTS).act).toBe(false);
  });
  test("gates not green → never acts", async () => {
    expect(decideMerge(AUTO, { ...clean, green: false }, OPTS).act).toBe(false);
  });
  test("gate strength not strong → never acts", async () => {
    expect(decideMerge(AUTO, { ...clean, strength: "real" }, OPTS).act).toBe(false);
  });
  test("browser evidence failed/missing → never acts", async () => {
    expect(decideMerge(AUTO, { ...clean, browser: "fail" }, OPTS).act).toBe(false);
    expect(decideMerge(AUTO, { ...clean, browser: "missing" }, OPTS).act).toBe(false);
  });
});

// --- merge-integrity pre-flight (stream: merge-integrity) --------------------
// preMergeIntegrity is the last check between "evidence says merge" and the
// irreversible `gh pr merge`: it enforces "a PR is never merged except against
// the exact main its checks last passed on, at the exact head its checks ran
// against". Deps are injected (postmerge.ts's DeployDeps pattern) so every
// branch of the decision sequence is provable without git/gh. TIGHTEN-ONLY
// property under test: there is NO path from any failure to an ok result.
import { preMergeIntegrity, type MergeIntegrityDeps } from "../src/loop.ts";
import type { Workspace } from "../src/repos.ts";

describe("preMergeIntegrity — stale-main re-gate + head pinning", () => {
  const WS: Workspace = { repo: "acme/kiwi", dir: "/nowhere", branch: "factory/fac-1", baseRef: "refs/remotes/origin/main" };
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const NEW_SHA = "89abcdef0123456789abcdef0123456789abcdef";

  /** Deps for the happy behind-main path; tests override single seams and
   * record which steps ran (a failed step must short-circuit everything after it). */
  function deps(over: Partial<MergeIntegrityDeps> = {}): MergeIntegrityDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fetchBase: () => { calls.push("fetch"); return { ok: true, out: "" }; },
      commitsBehindBase: () => { calls.push("behind"); return 0; },
      mergeBaseIntoBranch: () => { calls.push("update"); return { ok: true, out: "" }; },
      regate: () => { calls.push("regate"); return { green: true, failures: [] }; },
      push: () => { calls.push("push"); },
      headSha: () => { calls.push("headSha"); return NEW_SHA; },
      ...over,
    };
  }

  test("up to date (behind 0) → merge proceeds pinned to the ORIGINAL gated SHA; no update/re-gate/push runs", async () => {
    const d = deps();
    const r = await preMergeIntegrity(WS, SHA, d);
    expect(r).toEqual({ ok: true, pinnedHeadSha: SHA });
    expect(d.calls).toEqual(["fetch", "behind"]); // never touched the branch it didn't need to
  });

  test("no gated SHA recorded → hold (an unpinned auto-merge is refused before any I/O)", async () => {
    const d = deps();
    const r = await preMergeIntegrity(WS, null, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hold).toMatch(/unpinned/);
    expect(d.calls).toEqual([]);
  });

  test("fetch failure → hold (cannot prove the branch is current; ambiguity routes to a human)", async () => {
    const d = deps({ fetchBase: () => ({ ok: false, out: "network unreachable" }) });
    const r = await preMergeIntegrity(WS, SHA, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hold).toMatch(/could not refresh/);
    expect(d.calls).toEqual([]);
  });

  test("unknown behind-count (git failure) → hold, never 'assume current'", async () => {
    const d = deps({ commitsBehindBase: () => null });
    const r = await preMergeIntegrity(WS, SHA, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hold).toMatch(/refusing to merge blind/);
  });

  test("behind + clean update + green re-gate → merge proceeds pinned to the NEW head (never the stale gated SHA)", async () => {
    const d = deps({ commitsBehindBase: () => { d.calls.push("behind"); return 2; } });
    const r = await preMergeIntegrity(WS, SHA, d);
    expect(r).toEqual({ ok: true, pinnedHeadSha: NEW_SHA });
    // full sequence ran, in order: the push lands the re-gated head BEFORE the pin is read
    expect(d.calls).toEqual(["fetch", "behind", "update", "regate", "push", "headSha"]);
  });

  test("behind + conflicting update → hold; the re-gate and push NEVER run", async () => {
    const d = deps({
      commitsBehindBase: () => { d.calls.push("behind"); return 1; },
      mergeBaseIntoBranch: () => { d.calls.push("update"); return { ok: false, out: "CONFLICT (content): shared.txt" }; },
    });
    const r = await preMergeIntegrity(WS, SHA, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hold).toMatch(/behind .* conflicted .* human/);
    expect(d.calls).toEqual(["fetch", "behind", "update"]);
  });

  test("behind + update ok + RED re-gate → hold (the sibling's changes break this branch); push never runs", async () => {
    const d = deps({
      commitsBehindBase: () => { d.calls.push("behind"); return 1; },
      regate: () => { d.calls.push("regate"); return { green: false, failures: [{ name: "test" }, { name: "typecheck" }] }; },
    });
    const r = await preMergeIntegrity(WS, SHA, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hold).toMatch(/gates FAILED against the combined head \(test, typecheck\)/);
    expect(d.calls).toEqual(["fetch", "behind", "update", "regate"]);
  });

  test("behind + green re-gate but push throws → hold (never merge a head GitHub cannot see)", async () => {
    const d = deps({
      commitsBehindBase: () => 1,
      push: () => { throw new Error("push failed: remote hung up"); },
    });
    const r = await preMergeIntegrity(WS, SHA, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hold).toMatch(/could not push/);
  });

  test("behind + green re-gate but the NEW head SHA is unreadable → hold (unpinned re-gated merge refused too)", async () => {
    const d = deps({ commitsBehindBase: () => 1, headSha: () => null });
    const r = await preMergeIntegrity(WS, SHA, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hold).toMatch(/unpinned/);
  });
});
