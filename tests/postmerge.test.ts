import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { openTestDatabase, closeTestDatabase, claimDeploy, deployAttempted, recordDeploy } from "../src/db.ts";
import { deployAndVerify, runShellGate, type DeployDeps } from "../src/postmerge.ts";
import type { ProjectCard } from "../src/registry.ts";
import type { Workspace } from "../src/repos.ts";

const SHA = "a".repeat(40);
const card = (over: Partial<ProjectCard> = {}): ProjectCard => ({
  name: "kiwi", team: "FAC", repos: ["acme/kiwi"], merge: "review",
  deploy: "deploy-cmd", smoke: "smoke-cmd", deployEnabled: true, ...over,
});
const ws: Workspace = { repo: "acme/kiwi", dir: "/tmp/x", branch: "main", baseRef: "refs/remotes/origin/main" };

interface Calls { deploy: number; smoke: number; revertMerge: number; createRevertPr: number; escalate: number }

// A deps builder whose default legs pass; individual tests override + spy.
function mkDeps(over: Partial<DeployDeps> = {}): DeployDeps & { calls: Calls } {
  const calls: Calls = { deploy: 0, smoke: 0, revertMerge: 0, createRevertPr: 0, escalate: 0 };
  const base: DeployDeps = {
    currentHead: () => SHA,
    workspace: async () => ws,
    shell: (_dir, cmd) => { if (cmd === "deploy-cmd") calls.deploy++; if (cmd === "smoke-cmd") calls.smoke++; return { ok: true, out: "" }; },
    isAutoRepo: () => false,
    revertMerge: () => { calls.revertMerge++; return { ok: true, out: "" }; },
    createRevertPr: () => { calls.createRevertPr++; return "https://github.com/acme/kiwi/pull/9"; },
    escalate: async () => { calls.escalate++; },
  };
  return { ...base, ...over, calls };
}

const originalDeployEnabled = config.deployEnabled;
beforeEach(() => { config.deployEnabled = true; });
afterEach(() => { config.deployEnabled = originalDeployEnabled; });

describe("deployAttempted — exactly-once idempotency guard", () => {
  beforeEach(async () => { await openTestDatabase(); });
  afterEach(async () => { await closeTestDatabase(); });

  test("false before, true after recordDeploy (a second tick short-circuits)", async () => {
    expect(await deployAttempted("acme/kiwi", SHA)).toBe(false);
    await recordDeploy("acme/kiwi", SHA, "started");
    expect(await deployAttempted("acme/kiwi", SHA)).toBe(true);
    // A different sha is independent.
    expect(await deployAttempted("acme/kiwi", "b".repeat(40))).toBe(false);
  });

  test("closed store → false (deploy is OFF there anyway; never double-deploys blind)", async () => {
    await closeTestDatabase();
    expect(await deployAttempted("acme/kiwi", SHA)).toBe(false);
  });
});

describe("claimDeploy — the atomic claim postMergeTick now runs on", () => {
  beforeEach(async () => { await openTestDatabase(); });
  afterEach(async () => { await closeTestDatabase(); });

  test("exactly one winner: first claim true, every subsequent claim false", async () => {
    expect(await claimDeploy("acme/kiwi", SHA)).toBe(true);
    expect(await claimDeploy("acme/kiwi", SHA)).toBe(false);   // second tick
    expect(await deployAttempted("acme/kiwi", SHA)).toBe(true); // and the row is the guard
    expect(await claimDeploy("acme/kiwi", "b".repeat(40))).toBe(true); // other SHA independent
  });

  test("CONCURRENT claims for the same (repo, sha) yield exactly one true", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => claimDeploy("acme/kiwi", SHA)));
    expect(results.filter(Boolean).length).toBe(1);
  });

  test("recordDeploy still upserts the outcome over a claim's 'started'", async () => {
    await claimDeploy("acme/kiwi", SHA);
    await recordDeploy("acme/kiwi", SHA, "ok"); // outcome update, not a re-claim
    expect(await claimDeploy("acme/kiwi", SHA)).toBe(false); // still claimed
  });

  test("closed store → false: an unclaimable SHA is never deployed (fail closed)", async () => {
    await closeTestDatabase();
    expect(await claimDeploy("acme/kiwi", SHA)).toBe(false);
  });
});

describe("deployAndVerify — double-gate skips", () => {
  test("card deployEnabled:false → skipped, nothing runs", async () => {
    const deps = mkDeps();
    const out = await deployAndVerify("acme/kiwi", card({ deployEnabled: false }), SHA, "main", deps);
    expect(out.stage).toBe("skipped");
    expect(deps.calls.deploy).toBe(0);
    expect(deps.calls.smoke).toBe(0);
  });

  test("global kill-switch off → skipped even for an armed card", async () => {
    config.deployEnabled = false;
    const deps = mkDeps();
    const out = await deployAndVerify("acme/kiwi", card(), SHA, "main", deps);
    expect(out.stage).toBe("skipped");
    expect(deps.calls.deploy).toBe(0);
  });
});

describe("deployAndVerify — freshness guard (Gap-4)", () => {
  test("a merge SHA no longer at head is SKIPPED, not reverted", async () => {
    const deps = mkDeps({ currentHead: () => "c".repeat(40) }); // head moved on
    const out = await deployAndVerify("acme/kiwi", card(), SHA, "main", deps);
    expect(out.stage).toBe("skipped");
    expect(out.reverted).toBe(false);
    expect(deps.calls.deploy).toBe(0);
    expect(deps.calls.revertMerge).toBe(0);
    expect(deps.calls.createRevertPr).toBe(0);
  });
});

describe("deployAndVerify — deploy + smoke green", () => {
  test("both green → ok, not reverted", async () => {
    const deps = mkDeps();
    const out = await deployAndVerify("acme/kiwi", card(), SHA, "main", deps);
    expect(out).toMatchObject({ ok: true, stage: "smoke", reverted: false });
    expect(deps.calls.deploy).toBe(1);
    expect(deps.calls.smoke).toBe(1);
  });
});

describe("deployAndVerify — smoke fail → AUTO-REVERT (policy-scoped, Gap-3)", () => {
  // shell: deploy passes, smoke fails — the trigger for auto-revert.
  const failSmokeShell: DeployDeps["shell"] = (_d, cmd) => ({ ok: cmd !== "smoke-cmd", out: cmd === "smoke-cmd" ? "boom" : "" });

  test("auto-repo → direct revertMerge invoked, reverted:true", async () => {
    const deps = mkDeps({ shell: failSmokeShell, isAutoRepo: () => true });
    const out = await deployAndVerify("acme/kiwi", card(), SHA, "main", deps);
    expect(out.reverted).toBe(true);
    expect(out.stage).toBe("smoke");
    expect(deps.calls.revertMerge).toBe(1);
    expect(deps.calls.createRevertPr).toBe(0);
  });

  test("review-repo → createRevertPr + escalate, reverted:true, main untouched", async () => {
    const deps = mkDeps({ shell: failSmokeShell, isAutoRepo: () => false });
    const out = await deployAndVerify("acme/kiwi", card(), SHA, "main", deps);
    expect(out.reverted).toBe(true);
    expect(deps.calls.createRevertPr).toBe(1);
    expect(deps.calls.escalate).toBe(1);
    expect(deps.calls.revertMerge).toBe(0); // never force-touch main on a review repo
  });

  test("auto-repo whose direct revert CONFLICTS → escalates to a revert PR", async () => {
    const deps = mkDeps({ shell: failSmokeShell, isAutoRepo: () => true, revertMerge: () => ({ ok: false, out: "conflict" }) });
    const out = await deployAndVerify("acme/kiwi", card(), SHA, "main", deps);
    expect(out.reverted).toBe(true);
    expect(deps.calls.createRevertPr).toBe(1);
    expect(deps.calls.escalate).toBe(1);
  });
});

describe("deployAndVerify — deploy itself fails", () => {
  test("deploy non-zero → stage 'deploy', not reverted (nothing went live), escalated", async () => {
    const deps = mkDeps({ shell: () => ({ ok: false, out: "deploy blew up" }) });
    const out = await deployAndVerify("acme/kiwi", card(), SHA, "main", deps);
    expect(out.stage).toBe("deploy");
    expect(out.ok).toBe(false);
    expect(out.reverted).toBe(false);
    expect(deps.calls.escalate).toBe(1);
    expect(deps.calls.revertMerge).toBe(0);
  });
});

describe("runShellGate — real exit-code mapping", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "factory-shell-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("exit 0 → ok", () => {
    expect(runShellGate(dir, "exit 0").ok).toBe(true);
  });

  test("non-zero → fail, with captured output", () => {
    const r = runShellGate(dir, "echo captured-output; exit 3");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("captured-output");
  });
});
