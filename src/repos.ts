import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { parseFactoryMeta } from "./meta.ts";

// Worktree manager. Never touches ~/RapidoCoding (Adam's live checkouts) —
// everything lives under FACTORY_WORK_ROOT. Hardened per code-review verdict
// 2026-07-20: tracking-ref fetches (C1), split git() results (C2), https+gh
// auth (C3), stdout-only PR URL (C14), per-repo mutex (C15), slow-command
// timeouts (C22), --no-verify commits (M2).

interface GitResult { ok: boolean; stdout: string; stderr: string; out: string }

function git(cwd: string, args: string[], timeoutMs = 120_000): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { ok: r.status === 0, stdout, stderr, out: stdout + stderr };
}

const SLOW = 600_000; // clone/fetch of large repos (C22)

export interface Workspace {
  repo: string;    // org/name
  dir: string;     // worktree path
  branch: string;  // factory/<issue-key>
  baseRef: string; // refs/remotes/origin/<default>
}

/** Parse the "## Repo" section of the ticket contract (loosened per C24). */
export function repoFromTicket(description: string): string | null {
  // Extract the "## Repo" section (up to the next heading), then find the first
  // org/name anywhere in it — tolerant of "## Repo (org/name)", a bare line,
  // backticks, or a link. (Decomposers format this inconsistently: parens on
  // the header line vs the repo on the next line.)
  // Primary: the atomic, typed factory metadata block. Fallback: the ## Repo
  // section (hardened, for tickets/humans that don't use the block yet).
  const metaRepo = parseFactoryMeta(description).repo;
  if (metaRepo) return metaRepo;
  const section = description.match(/##\s*Repo\b([\s\S]*?)(?:\n##\s|$)/);
  const repo = section?.[1]?.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/)?.[1];
  return repo ?? null;
}

// Per-repo mutex: concurrent same-repo issues serialize workspace setup (C15).
const repoLocks = new Map<string, Promise<unknown>>();

export async function ensureWorkspace(repo: string, issueKey: string): Promise<Workspace> {
  const previous = repoLocks.get(repo) ?? Promise.resolve();
  let releaseLock!: () => void;
  repoLocks.set(repo, new Promise<void>((resolve) => { releaseLock = resolve; }));
  try {
    await previous.catch(() => {});
    return buildWorkspace(repo, issueKey);
  } finally {
    releaseLock();
  }
}

function buildWorkspace(repo: string, issueKey: string): Workspace {
  mkdirSync(join(config.workRoot, ".bare"), { recursive: true });
  const bare = join(config.workRoot, ".bare", repo.replace("/", "__"));
  const url = `https://github.com/${repo}.git`; // https + gh credential helper (C3)

  if (!existsSync(bare)) {
    const clone = git(config.workRoot, ["clone", "--bare", url, bare], SLOW);
    if (!clone.ok) throw new Error(`clone failed for ${repo}: ${clone.out.slice(0, 400)}`);
    // Bare clones default to mirroring heads; use tracking refs so fetch --prune
    // can never delete in-flight factory/* branches (C1).
    git(bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  }
  const fetch = git(bare, ["fetch", "origin", "--prune"], SLOW);
  if (!fetch.ok) throw new Error(`fetch failed for ${repo}: ${fetch.out.slice(0, 400)}`);

  const headRes = git(bare, ["symbolic-ref", "--short", "HEAD"]);
  const head = headRes.ok ? headRes.stdout.trim() : "main";
  const baseRef = `refs/remotes/origin/${head}`;
  const branch = `factory/${issueKey.toLowerCase()}`;
  const dir = join(config.workRoot, issueKey);

  // Foreign same-issue branch on origin → park, don't fight (C9-family).
  const remote = git(bare, ["show-ref", `refs/remotes/origin/${branch}`]);
  if (remote.ok && !existsSync(dir)) {
    throw new Error(`branch ${branch} already exists on origin for ${repo} — parking (existing work found)`);
  }

  if (!existsSync(dir)) {
    const wt = git(bare, ["worktree", "add", "-b", branch, dir, baseRef]);
    if (!wt.ok) throw new Error(`worktree add failed: ${wt.out.slice(0, 400)}`);
  }
  return { repo, dir, branch, baseRef };
}

/** Hard-reset a REUSED throwaway worktree to origin's current default head.
 * buildWorkspace already fetched the bare repo, so baseRef is fresh; without
 * this a long-lived worktree (the groundskeeper's `<name>-gk`) reviews the
 * frozen snapshot it was created from forever. Never used on issue worktrees —
 * those carry real branch work that must not be discarded. */
export function resetWorkspaceToBase(ws: Workspace): void {
  const reset = git(ws.dir, ["reset", "--hard", ws.baseRef]);
  if (!reset.ok) throw new Error(`reset to ${ws.baseRef} failed: ${reset.out.slice(0, 300)}`);
  git(ws.dir, ["clean", "-fd"]); // stale untracked files from prior runs; best-effort
}

export function commitAll(ws: Workspace, message: string): boolean {
  git(ws.dir, ["add", "-A"]);
  // --no-verify: repo-committed hooks are repo-controlled code execution in the
  // worker, and a failing hook masquerades as "no changes" (M2).
  return git(ws.dir, ["commit", "--no-verify", "-m", message]).ok;
}

function gitRetry(cwd: string, args: string[], attempts = 3): GitResult {
  let last = git(cwd, args);
  for (let i = 1; i < attempts && !last.ok; i++) {
    // Busy-wait a beat: concurrent worktrees of one repo share the object store,
    // so a sibling's fetch/commit can transiently lock refs. Contention clears fast.
    const until = Date.now() + 400;
    while (Date.now() < until) { /* spin */ }
    last = git(cwd, args);
  }
  return last;
}

function mergeBase(ws: Workspace): string {
  const mb = gitRetry(ws.dir, ["merge-base", "HEAD", ws.baseRef]);
  if (!mb.ok) throw new Error(`cannot locate base ${ws.baseRef}: ${mb.stderr.slice(0, 200)}`);
  return mb.stdout.trim();
}

export function diffAgainstBase(ws: Workspace): string {
  const diff = gitRetry(ws.dir, ["diff", mergeBase(ws), "HEAD"]);
  if (!diff.ok) throw new Error(`diff failed: ${diff.stderr.slice(0, 200)}`);
  return diff.stdout;
}

export const DIFF_FAILED = "<diff-failed>";

/** Guarded paths force human attention; on any git failure return a sentinel
 * that forces review rather than silently passing (C2/C17). */
export function guardedPathsTouched(ws: Workspace): string[] {
  let base: string;
  try {
    base = mergeBase(ws);
  } catch {
    return [DIFF_FAILED];
  }
  const diff = git(ws.dir, ["diff", "--name-only", base, "HEAD"]);
  if (!diff.ok) return [DIFF_FAILED];
  const files = diff.stdout.split("\n").filter(Boolean);
  // groundskeepers/ and agents/ are the factory's own spend governors and role
  // definitions — a PR that flips `enabled:` or raises `budget:` must never
  // auto-merge without a human (machine self-arming).
  const guards = [/(^|\/)\.github\//, /(^|\/)CLAUDE\.md$/, /(^|\/)\.claude\//, /(^|\/)skills\//, /(^|\/)groundskeepers\//, /(^|\/)agents\//, /\.test\.|\.spec\.|(^|\/)tests?\//];
  return files.filter((f) => guards.some((g) => g.test(f)));
}

/** UI files changed by this diff — the taste-gate heuristic (name-only, same
 * shape as guardedPathsTouched). Empty on any git failure (gate simply skips). */
export function uiFilesTouched(ws: Workspace): string[] {
  let base: string;
  try {
    base = mergeBase(ws);
  } catch {
    return [];
  }
  const diff = git(ws.dir, ["diff", "--name-only", base, "HEAD"]);
  if (!diff.ok) return [];
  return diff.stdout.split("\n").filter(Boolean).filter((f) => /\.(tsx|jsx|css|scss|html)$/.test(f));
}

/** Test files deleted by the change → categorical park (C17). */
export function testFilesRemoved(ws: Workspace): string[] {
  let base: string;
  try {
    base = mergeBase(ws);
  } catch {
    return [];
  }
  const diff = git(ws.dir, ["diff", "--name-status", base, "HEAD"]);
  if (!diff.ok) return [];
  return diff.stdout.split("\n")
    .filter((line) => line.startsWith("D\t"))
    .map((line) => line.slice(2))
    .filter((f) => /\.test\.|\.spec\.|(^|\/)tests?\//.test(f));
}

export function pushBranch(ws: Workspace): void {
  const r = git(ws.dir, ["push", "origin", `HEAD:${ws.branch}`], SLOW);
  if (!r.ok) throw new Error(`push failed: ${r.out.slice(0, 400)}`);
}

export function mergePr(repo: string, prUrl: string): { ok: boolean; out: string } {
  const r = spawnSync("gh", ["pr", "merge", prUrl, "--repo", repo, "--squash", "--delete-branch"],
    { encoding: "utf8", timeout: 60_000 });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 300) };
}

export function createPr(ws: Workspace, title: string, body: string): string {
  const r = spawnSync("gh", ["pr", "create", "--repo", ws.repo, "--head", ws.branch, "--title", title, "--body", body],
    { cwd: ws.dir, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) {
    // Idempotency: PR may already exist for this branch.
    const existing = spawnSync("gh", ["pr", "view", ws.branch, "--repo", ws.repo, "--json", "url", "-q", ".url"],
      { encoding: "utf8", timeout: 30_000 });
    if (existing.status === 0 && existing.stdout.trim()) return existing.stdout.trim();
    throw new Error(`gh pr create failed: ${((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 400)}`);
  }
  // URL is on stdout; stderr carries progress/notices (C14).
  const url = (r.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => /^https?:\/\//.test(line)).pop();
  return url ?? "";
}
