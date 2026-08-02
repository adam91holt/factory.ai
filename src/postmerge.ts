import { spawnSync } from "node:child_process";
import { config } from "./config.ts";
import { effectiveProjects, type ProjectCard } from "./registry.ts";
import { claimDeploy, recordDeploy } from "./db.ts";
import { ensureWorkspace, revertMerge as realRevertMerge, createRevertPr as realCreateRevertPr, type Workspace } from "./repos.ts";
import { redactSecrets } from "./agents.ts";
import { bus } from "./events.ts";

// POST-MERGE watch (Gap 5): the last bookend — "finish" includes the finish.
// For a project whose registry card has an ENABLED deploy (and the global
// DEPLOY_ENABLED kill-switch is on), a newly-merged SHA on main is deployed,
// smoke-tested, and AUTO-REVERTED on smoke failure.
//
// SAFETY ENVELOPE (non-negotiable):
//   - DOUBLE-GATED OFF: global config.deployEnabled AND the card's own
//     deployEnabled must both hold (the groundskeeper double-gate). Ships OFF.
//   - TRUSTED COMMANDS ONLY: deploy/smoke come from the human-gated registry
//     card (registry.ts), NEVER from ticket text (safety envelope d).
//   - EXACTLY-ONCE: claimDeploy()'s atomic INSERT guards against a second tick (or a
//     reconcile racing the merge→Done transition) re-deploying the same SHA.
//   - FRESHNESS (Gap-4 interaction): deployAndVerify re-validates the SHA is
//     still main's head before acting — a human who already reverted must not be
//     re-deployed-over. A stale SHA is SKIPPED, never reverted.
//   - POLICY-SCOPED REVERT (Gap-3 interaction): auto-merge repos get a direct
//     revert-of-merge; review repos get a revert PR + human escalation. A direct
//     revert that CONFLICTS (a human built on top) escalates to a PR rather than
//     force-reverting.

const DEPLOY_TIMEOUT_MS = 600_000;
const SMOKE_TIMEOUT_MS = 300_000;

export interface DeployOutcome {
  ok: boolean;
  stage: "skipped" | "deploy" | "smoke";
  detail: string;
  reverted: boolean;
}

/** Run a TRUSTED shell command (from a registry card) in `dir`. Exit 0 → ok;
 * non-zero → fail with captured output (last 3000 chars). `sh -c` so a card can
 * use a normal command line. Unit-testable against real exit codes. */
export function runShellGate(dir: string, cmd: string, timeoutMs = DEPLOY_TIMEOUT_MS): { ok: boolean; out: string } {
  const r = spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8", timeout: timeoutMs });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).slice(-3000) };
}

/** Current head SHA of `branch` on the repo's origin, or null on any failure
 * (network/auth) — a null head SKIPS the deploy (fail-safe), never deploys blind. */
function remoteHead(repo: string, branch: string): string | null {
  const r = spawnSync("git", ["ls-remote", `https://github.com/${repo}.git`, branch], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) return null;
  const sha = (r.stdout ?? "").split(/\s+/)[0]?.trim();
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

// Injectable seam so the deploy→smoke→revert decision is testable without gh/git.
export interface DeployDeps {
  currentHead: (repo: string, branch: string) => string | null;
  workspace: (repo: string) => Promise<Workspace>;
  shell: (dir: string, cmd: string, timeoutMs?: number) => { ok: boolean; out: string };
  isAutoRepo: (repo: string) => boolean;
  revertMerge: (repo: string, dir: string, sha: string) => { ok: boolean; out: string };
  createRevertPr: (ws: Workspace, sha: string, why: string) => string;
  escalate: (repo: string, sha: string, reason: string) => Promise<void>;
}

const defaultDeps: DeployDeps = {
  currentHead: remoteHead,
  workspace: (repo) => ensureWorkspace(repo, `${repo.replace("/", "__")}-deploy`),
  shell: runShellGate,
  isAutoRepo: (repo) => config.autoMergeRepos.includes(repo),
  revertMerge: realRevertMerge,
  createRevertPr: realCreateRevertPr,
  escalate: async (repo, sha, reason) => {
    // No ticket to label here (deploy is repo-scoped, post-merge); the revert
    // PR IS the human-visible artifact. Log loudly + redacted.
    console.error(`[postmerge] ${repo}@${sha.slice(0, 12)} ESCALATED: ${redactSecrets(reason).clean.slice(0, 300)}`);
  },
};

/** Deploy a newly-merged SHA, smoke-test it, and auto-revert on smoke failure.
 * Returns a typed outcome. `deps` is injectable for testing; production uses real
 * git/gh/shell. Re-validates the double-gate AND freshness before acting. */
export async function deployAndVerify(
  repo: string,
  card: ProjectCard,
  mergeSha: string,
  branch: string,
  deps: DeployDeps = defaultDeps,
): Promise<DeployOutcome> {
  // Double-gate: global kill-switch AND the card's own arm AND a deploy command.
  if (!config.deployEnabled || !card.deployEnabled || !card.deploy) {
    return { ok: false, stage: "skipped", detail: "deploy disabled (global kill-switch or card deployEnabled/deploy unset)", reverted: false };
  }
  // Freshness (Gap-4): the SHA must still be main's head. A human who already
  // reverted (or a newer merge landed) means the premise moved — SKIP, don't act.
  const head = deps.currentHead(repo, branch);
  if (!head || head !== mergeSha) {
    return { ok: false, stage: "skipped", detail: `merge ${mergeSha.slice(0, 12)} is no longer ${branch} head (now ${head ? head.slice(0, 12) : "unknown"}) — world moved on`, reverted: false };
  }

  const ws = await deps.workspace(repo);
  bus.emit({ type: "deploy_started", repo, sha: mergeSha });

  const deploy = deps.shell(ws.dir, card.deploy, DEPLOY_TIMEOUT_MS);
  if (!deploy.ok) {
    // Deploy itself failed — nothing new went live, so there is nothing to
    // revert. Escalate (human decides); the merge stays on main.
    await deps.escalate(repo, mergeSha, `deploy command failed: ${deploy.out.slice(-400)}`);
    return { ok: false, stage: "deploy", detail: deploy.out.slice(-400), reverted: false };
  }

  if (!card.smoke) {
    return { ok: true, stage: "deploy", detail: "deployed (no smoke command configured)", reverted: false };
  }

  const smoke = deps.shell(ws.dir, card.smoke, SMOKE_TIMEOUT_MS);
  if (smoke.ok) {
    return { ok: true, stage: "smoke", detail: "deploy + smoke green", reverted: false };
  }

  // Smoke failed → AUTO-REVERT, policy-scoped (Gap-3).
  const why = `Post-merge smoke failed for ${mergeSha.slice(0, 12)}:\n${smoke.out.slice(-800)}`;
  if (deps.isAutoRepo(repo)) {
    const rev = deps.revertMerge(repo, ws.dir, mergeSha);
    if (rev.ok) {
      return { ok: false, stage: "smoke", detail: `smoke failed → auto-reverted merge on ${repo}`, reverted: true };
    }
    // A direct revert conflicted (a human built on top of the merge): do NOT
    // force it — open a revert PR and escalate.
    const pr = deps.createRevertPr(ws, mergeSha, why);
    await deps.escalate(repo, mergeSha, `smoke failed and direct revert conflicted — opened revert PR ${pr}`);
    return { ok: false, stage: "smoke", detail: `smoke failed; direct revert conflicted → revert PR ${pr}`, reverted: true };
  }
  // Review repo: never touch main directly — open a revert PR + escalate.
  const pr = deps.createRevertPr(ws, mergeSha, why);
  await deps.escalate(repo, mergeSha, `smoke failed after deploy — opened revert PR ${pr}`);
  return { ok: false, stage: "smoke", detail: `smoke failed → revert PR ${pr}`, reverted: true };
}

/** One post-merge pass per tick, next to reconcileTick. Returns immediately at
 * ZERO cost when the global kill-switch is off. For each deploy-enabled card's
 * repos, deploys the newest un-attempted main SHA (exactly-once), then stops
 * after the first real deploy (one heavy op per tick, like groundskeeperTick). */
export async function postMergeTick(): Promise<void> {
  if (!config.deployEnabled) return; // global kill-switch — no git, no shell, no spend
  // effectiveProjects (issue #7): PG-approved authority overrides layered over
  // the cards — deployEnabled can be governed from the approved policy rows,
  // but the deploy/smoke COMMANDS still come only from the card file (see
  // registry.ts applyPolicyOverlay), and no rows ⇒ cards exactly as before.
  const cards = (await effectiveProjects()).filter((c) => c.deployEnabled && c.deploy);
  if (cards.length === 0) return;

  for (const card of cards) {
    for (const repo of card.repos) {
      const sha = remoteHead(repo, "main");
      if (!sha) continue;
      // Atomic claim: the INSERT either lands (ours to deploy) or conflicts
      // (already attempted — by a prior tick or a crash mid-deploy, which must
      // never re-fire the same SHA). One statement, so there is no
      // check-then-act window for a future concurrent caller to slip through.
      if (!(await claimDeploy(repo, sha))) continue;
      const outcome = await deployAndVerify(repo, card, sha, "main").catch((error): DeployOutcome => ({
        ok: false, stage: "deploy", detail: error instanceof Error ? error.message : String(error), reverted: false,
      }));
      await recordDeploy(repo, sha, outcome.stage === "skipped" ? "skipped" : outcome.ok ? "ok" : outcome.reverted ? "reverted" : "failed");
      bus.emit({ type: "deploy_finished", repo, sha, ok: outcome.ok, stage: outcome.stage, reverted: outcome.reverted, detail: redactSecrets(outcome.detail).clean.slice(0, 300) });
      if (outcome.stage !== "skipped") {
        console.log(`[postmerge] ${repo}@${sha.slice(0, 12)} → ${outcome.ok ? "ok" : outcome.reverted ? "reverted" : "failed"} (${outcome.stage})`);
        return; // one heavy op per tick
      }
    }
  }
}
