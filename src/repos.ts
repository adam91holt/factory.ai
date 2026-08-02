import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { parseFactoryMeta } from "./meta.ts";
import { redactSecrets } from "./agents.ts";

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

/** True if the branch already has commits ahead of its base — e.g. a resumed
 * run whose prior attempt committed work before failing a later step. Lets the
 * pipeline proceed to review/PR instead of parking "no committable changes"
 * when the work exists from before. */
export function hasCommitsAheadOfBase(ws: Workspace): boolean {
  const r = gitRetry(ws.dir, ["rev-list", "--count", `${ws.baseRef}..HEAD`]);
  return r.ok && parseInt(r.stdout.trim() || "0", 10) > 0;
}

// Factory-owned scratch INSIDE the worktree (issue #17): materialized register
// skills live under <worktree>/.factory/ so workers can Read them on demand.
// That content is prompt material, not repo work — it must NEVER reach a
// commit, a diff, or a PR. Two independent legs enforce it: commitAll's
// pathspec exclusion below (so `git add -A` cannot sweep it in), and the
// classifier exclusion in classifyPaths (so even a leaked path never enters
// guarded-path output). Note .factory/skills/ would otherwise match the
// skills/ guard regex — the exclusion must run FIRST.
//
// ROOT-ANCHORED by design: git pathspecs are rooted, so commitAll's
// ":(exclude).factory" excludes ONLY the top-level .factory/ — a NESTED
// `anything/.factory/…` path commits like any other file. The classifier's
// blind spot must therefore be EXACTLY the set commitAll refuses to stage, and
// nothing more: an any-depth exclusion here would let a committed
// `web/.factory/CLAUDE.md` (or a nested workflow/test) reach the PR while
// staying invisible to guardedPathsTouched — and thus to MergeEvidence.guarded,
// silently bypassing the human review the guard exists to force. Materialization
// only ever writes the root `.factory/`, so root-anchored loses nothing.
export const FACTORY_SCRATCH_RE = /^\.factory\//;

/** True when `file` is factory-owned worktree scratch (top-level .factory/ —
 *  the exact set commitAll's rooted pathspec exclusion keeps out of commits).
 *  A nested `x/.factory/…` path is NOT scratch: it commits, so it must stay
 *  classifiable as guarded. */
export function isFactoryScratchPath(file: string): boolean {
  return FACTORY_SCRATCH_RE.test(file);
}

export function commitAll(ws: Workspace, message: string): boolean {
  // ":(exclude).factory": the worktree-scratch dir (materialized skills) is
  // never committed — see FACTORY_SCRATCH_RE above. The "." pathspec keeps
  // -A's full-tree coverage for everything else.
  git(ws.dir, ["add", "-A", "--", ".", ":(exclude).factory"]);
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

// groundskeepers/ and agents/ are the factory's own spend governors and role
// definitions — a PR that flips `enabled:` or raises `budget:` must never
// auto-merge without a human (machine self-arming). projects/ is the same class
// of self-mod: a project registry card (Gap 5) is factory-controlled routing
// config that decides which repos the factory may build/deploy into AND carries
// TRUSTED deploy/smoke shell commands — a PR that adds or edits one must be
// human-reviewed, so bootstrap REGISTERS via a human-gated PR, never a direct
// commit.
const NON_TEST_GUARDED_RES = [/(^|\/)\.github\//, /(^|\/)CLAUDE\.md$/, /(^|\/)\.claude\//, /(^|\/)skills\//, /(^|\/)groundskeepers\//, /(^|\/)agents\//, /(^|\/)projects\//];
// Split out so guardedPathsTouched can special-case it (#1): a NEWLY-ADDED test
// file is normal, safe engineering practice — every well-built task adds
// tests, so guarding on ANY touch made every task stop for a human. Only
// MODIFYING or DELETING a PRE-EXISTING test stays guarded — that's the real
// gate-gaming threat (neutering or removing a test to force a gate to pass).
const TEST_PATH_RE = /\.test\.|\.spec\.|(^|\/)tests?\//;
const GUARDED_PATH_RES = [...NON_TEST_GUARDED_RES, TEST_PATH_RE];

/** Pure guarded-path classifier: the subset of `files` that any guard regex
 * matches. Extracted from guardedPathsTouched so the policy is unit-testable
 * without shelling out to git — behavior identical. Status-blind (used where
 * add-vs-modify doesn't matter, e.g. testFilesRemoved's own deletion filter);
 * classifyStatusPaths below is the status-aware variant guardedPathsTouched uses. */
export function classifyPaths(files: string[]): string[] {
  return files.filter((f) => !isFactoryScratchPath(f) && GUARDED_PATH_RES.some((g) => g.test(f)));
}

/** One `git diff --name-status` entry. For renames git emits `R100\told\tnew`;
 * `file` is always the current (new) path. */
export interface NameStatusEntry { status: string; file: string }

/** Parse `git diff --name-status` output into (status, file) pairs. Exported
 * so parsing is unit-testable without shelling out to git. */
export function parseNameStatus(out: string): NameStatusEntry[] {
  return out.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return { status: parts[0] ?? "", file: parts[parts.length - 1] ?? "" };
  }).filter((e) => e.file);
}

/** Status-aware guarded-path classifier (#1): same guard set as classifyPaths,
 * but a file matched ONLY via the test-path regex is excluded when its status
 * is `A` (newly added — nothing pre-existing to neuter). Non-test guarded
 * paths (.github/, CLAUDE.md, .claude/, skills/, groundskeepers/, agents/,
 * projects/) stay guarded on ANY status, added included — those directories are
 * never "just adding tests" and always warrant a human look. Extracted so the
 * add-vs-modify policy is unit-testable without shelling out to git. */
export function classifyStatusPaths(entries: NameStatusEntry[]): string[] {
  return entries
    .filter(({ file }) => classifyPaths([file]).length > 0)
    .filter(({ status, file }) => !(status.startsWith("A") && TEST_PATH_RE.test(file) && !NON_TEST_GUARDED_RES.some((re) => re.test(file))))
    .map(({ file }) => file);
}

// --- MODIFIED-test-file add-vs-weaken classifier -----------------------------
// classifyStatusPaths (above) exempts a NEWLY-ADDED (status A) test file, but a
// MODIFIED (status M) pre-existing test still forces needs_human even when the
// diff is a legitimate extension (+15 assertions / -3 as the state shape
// grows). That's the common case for a good task, so a human ends up
// hand-checking "extended, safe" vs "weakened" on nearly every ticket. This
// classifies the git diff of a MODIFIED test-only file (never a non-test
// guarded path — those stay guarded on content grounds alone) as an additive
// extension or a weakening, purely from diff content — never from
// issue.description (safety envelope: the GRANT side of auto-merge is
// evidence-only, per repos.ts's guarded-path invariant).

/** True when `file` is guarded ONLY via the test-path regex — i.e. it is not
 * also inside a non-test guarded directory (.github/, CLAUDE.md, .claude/,
 * skills/, groundskeepers/, agents/, projects/). Those always stay guarded
 * regardless of diff content; only a pure test file is eligible for the
 * add-vs-weaken diff classifier below. */
function isTestOnlyGuardedPath(file: string): boolean {
  return TEST_PATH_RE.test(file) && !NON_TEST_GUARDED_RES.some((re) => re.test(file));
}

const BLOCK_OPENER_RE = /\b(?:it|test|describe)\s*\(/g;
const ASSERTION_RE = /\b(?:expect|assert)\s*(?:\.\w+)?\s*\(/g;
// Known no-op / tautological assertion shapes — the "gut a real assertion into
// a rubber stamp" pattern (e.g. `expect(x).toBe(y)` → `expect(true).toBe(true)`).
const TRIVIAL_ASSERTION_RE = /expect\(\s*true\s*\)\.(?:toBe\(\s*true\s*\)|toBeTruthy\(\))|expect\(\s*1\s*\)\.toBe\(\s*1\s*\)|assert\(\s*true\s*\)|assert\.ok\(\s*true\s*\)/g;
function countMatches(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

/** Split a unified diff (as produced by `git diff <base> <head> -- <file>`)
 * into the bodies of added (`+`) and removed (`-`) lines, dropping the
 * `+++`/`---` file-header lines and the leading marker itself. */
function splitDiffLines(diffText: string): { added: string; removed: string } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added: added.join("\n"), removed: removed.join("\n") };
}

/** Pure classifier: does a MODIFIED test file's diff read as a PURELY-ADDITIVE
 * EXTENSION (safe to exempt from the guard) rather than a WEAKENING (stays
 * guarded)? Extracted so the add-vs-weaken policy is unit-testable without
 * shelling out to git (same rationale as classifyPaths/parseNameStatus).
 *
 * A unified diff renders ANY rewritten line — a value edit, a loosened
 * matcher, an added `.not`, a swapped-out it()-block body — as a removed `-`
 * line paired with an added `+` line. A syntactic counter that only looks at
 * net counts (e.g. "assertions added minus removed <= tolerance") is
 * defeated by exactly that rewrite shape: `expect(order.total).toBe(42)` →
 * `expect(order.total).toBe(order.total)` nets to zero and reads as
 * "additive". So this classifier does not permit ANY existing
 * assertion/block line to be removed or rewritten at all — only a diff that
 * strictly ADDS new assertions/blocks without touching a single pre-existing
 * one is exempted. That closes value-edit, matcher-loosening, `.not`
 * inversion, block-swap, and net-zero critical-assertion-for-fluff
 * vectors in one rule: a genuine extension only adds lines.
 *
 * NOT an extension (stays guarded) when any of:
 *   - any pre-existing it()/test()/describe() block line was removed/rewritten
 *     (blocksRemoved > 0);
 *   - any pre-existing assertion line was removed/rewritten
 *     (assertionsRemoved > 0), regardless of how many were added back —
 *     there is no tolerance for a 1:1 "removed one, added one" edit;
 *   - a trivial/tautological assertion was introduced (e.g.
 *     `expect(true).toBe(true)`), even if nothing else was removed;
 *   - the diff adds no assertions/blocks at all (comment/formatting-only
 *     changes are ambiguous, not evidence of an extension).
 * Conservative by construction: every branch that isn't a clear
 * strictly-additive signal returns false (stays guarded). */
export function isAdditiveTestExtension(diffText: string): boolean {
  const { added, removed } = splitDiffLines(diffText);

  const blocksAdded = countMatches(BLOCK_OPENER_RE, added);
  const blocksRemoved = countMatches(BLOCK_OPENER_RE, removed);
  if (blocksRemoved > 0) return false; // any existing test block removed or rewritten

  const trivialAdded = countMatches(TRIVIAL_ASSERTION_RE, added);
  if (trivialAdded > 0) return false; // a tautological/no-op assertion was introduced

  const assertionsAdded = countMatches(ASSERTION_RE, added);
  const assertionsRemoved = countMatches(ASSERTION_RE, removed);
  if (assertionsRemoved > 0) return false; // any existing assertion removed or rewritten — no tolerance

  if (assertionsAdded === 0 && blocksAdded === 0) return false; // nothing added — ambiguous, not evidence of extension

  return true;
}

/** Guarded paths force human attention; on any git failure return a sentinel
 * that forces review rather than silently passing (C2/C17). A MODIFIED
 * test-only file is further exempted when its own diff classifies as an
 * additive extension (isAdditiveTestExtension) — evidence read from git diff
 * content only, never issue.description. */
export function guardedPathsTouched(ws: Workspace): string[] {
  let base: string;
  try {
    base = mergeBase(ws);
  } catch {
    return [DIFF_FAILED];
  }
  const diff = git(ws.dir, ["diff", "--name-status", base, "HEAD"]);
  if (!diff.ok) return [DIFF_FAILED];
  const entries = parseNameStatus(diff.stdout);
  const guarded = classifyStatusPaths(entries);
  return guarded.filter((file) => {
    const entry = entries.find((e) => e.file === file);
    if (!entry || entry.status !== "M" || !isTestOnlyGuardedPath(file)) return true; // stays guarded
    const fileDiff = git(ws.dir, ["diff", base, "HEAD", "--", file]);
    if (!fileDiff.ok) return true; // conservative: git failure keeps it guarded
    return !isAdditiveTestExtension(fileDiff.stdout);
  });
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

// --- merge-integrity primitives ---------------------------------------------
// Two invariants the auto-merge action site (loop.ts preMergeIntegrity) builds
// from these: (a) a PR is only ever merged AT the exact commit its gates ran
// against (--match-head-commit pins the merge; GitHub refuses atomically if the
// branch moved), and (b) a PR is never merged while BEHIND origin's default
// branch — its gates passed against an older main, so a sibling merge could
// land untested-against. All helpers return null / ok:false on any git failure
// so the caller resolves toward the human path, never toward merging blind.

/** The worktree's current HEAD SHA — recorded at gate time so the eventual
 * merge can be pinned to the exact commit the gates actually ran against.
 * null on any git failure (the caller must refuse an unpinned auto-merge). */
export function headSha(ws: Workspace): string | null {
  const r = gitRetry(ws.dir, ["rev-parse", "HEAD"]);
  const sha = r.stdout.trim();
  return r.ok && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/** Refresh origin's refs so "behind" is judged against the REAL current main,
 * not the snapshot buildWorkspace fetched when the run started (sibling PRs
 * merge while a run is in flight). Runs in the worktree — worktrees share the
 * bare repo's config, so the tracking-ref refspec (C1) applies here too. */
export function fetchBase(ws: Workspace): { ok: boolean; out: string } {
  const r = git(ws.dir, ["fetch", "origin", "--prune"], SLOW);
  return { ok: r.ok, out: r.out.slice(0, 400) };
}

/** How many commits origin's default branch has that HEAD does not — i.e. how
 * far BEHIND current main this branch is. 0 = up to date (gates ran against
 * the main it would merge into). null on any git failure — the caller must
 * treat "can't tell" as "not proven current" and route to a human. */
export function commitsBehindBase(ws: Workspace): number | null {
  const r = gitRetry(ws.dir, ["rev-list", "--count", `HEAD..${ws.baseRef}`]);
  if (!r.ok) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Merge origin's default branch INTO the run's branch so the gates can be
 * re-run against the combined result. On conflict: abort so the worktree is
 * left clean (a human resolves via the PR; a half-merged worktree would poison
 * every later git call), and return ok:false — the caller must NEVER merge a
 * behind-main branch whose update failed. */
export function mergeBaseIntoBranch(ws: Workspace): { ok: boolean; out: string } {
  const m = git(ws.dir, ["merge", "--no-edit", ws.baseRef]);
  if (!m.ok) git(ws.dir, ["merge", "--abort"]); // best-effort; leaves worktree usable
  return { ok: m.ok, out: m.out.slice(0, 400) };
}

/** Current head commit of a PR as GITHUB sees it (`gh pr view --json
 * headRefOid`) — the approvals inbox's freshness pre-check: an approve action
 * compares this against the item's gated SHA BEFORE merging, so a branch that
 * moved since gating is refused up front (and --match-head-commit still
 * enforces the same pin atomically server-side as the backstop). null on any
 * gh failure or a malformed SHA — the caller must treat "can't read the head"
 * as "not proven fresh" and refuse, never merge blind. */
export function prHeadSha(repo: string, prUrl: string): string | null {
  const r = spawnSync("gh", ["pr", "view", prUrl, "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"],
    { encoding: "utf8", timeout: 30_000 });
  const sha = (r.stdout ?? "").trim();
  return r.status === 0 && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/** Build the `gh pr merge` argv. PINNED-BY-CONSTRUCTION (same pattern as
 * ghRepoCreateArgs): --match-head-commit is always present and the SHA is
 * validated, so no code path can produce an UNPINNED merge argv — merging
 * whatever the branch happens to point at (code the gates never saw) is
 * unrepresentable. Throws on a malformed SHA rather than degrading. */
export function mergePrArgs(repo: string, prUrl: string, matchHeadSha: string): string[] {
  if (!/^[0-9a-f]{7,40}$/i.test(matchHeadSha)) {
    throw new Error(`mergePr refuses an unpinned merge for ${prUrl} — no valid gated head SHA (got "${matchHeadSha.slice(0, 40)}")`);
  }
  return ["pr", "merge", prUrl, "--repo", repo, "--squash", "--delete-branch", "--match-head-commit", matchHeadSha];
}

/** Did the merge fail BECAUSE the PR head no longer matches the pinned SHA?
 * GitHub's refusal reads "Head branch was modified. Review and try the merge
 * again." (gh surfaces it verbatim, sometimes GraphQL-wrapped); the expected-
 * head/match-head phrasings cover gh's own client-side variants. Pure and
 * exported so the classification is unit-testable without gh. A match means
 * "branch moved since gates passed" — the caller must route to a human, never
 * retry against the new (ungated) head. */
export function mergeRefusedBecauseHeadMoved(out: string): boolean {
  return /head branch (?:was|has been) modified|expected head|match[- ]head/i.test(out);
}

/** Squash-merge a PR, PINNED to the head SHA the gates ran against. GitHub
 * enforces the pin atomically server-side: if anything (steward follow-up,
 * sibling task, a human) pushed to the branch after gate time, the merge is
 * refused and `headMoved` is true — the caller folds that into needs-human
 * rather than retrying (the new head's code was never gated). A malformed SHA
 * never spawns gh at all (mergePrArgs throws; mapped to ok:false so the
 * existing merge-failed → human-review fallback handles it). */
export function mergePr(repo: string, prUrl: string, matchHeadSha: string): { ok: boolean; out: string; headMoved: boolean } {
  let args: string[];
  try {
    args = mergePrArgs(repo, prUrl, matchHeadSha);
  } catch (e) {
    return { ok: false, out: (e instanceof Error ? e.message : String(e)).slice(0, 300), headMoved: false };
  }
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: 60_000 });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 300);
  return { ok: r.status === 0, out, headMoved: r.status !== 0 && mergeRefusedBecauseHeadMoved(out) };
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

// ---------------------------------------------------------------------------
// Gap-5 bookends: project bootstrap (idea→repo) and post-merge revert.
// ---------------------------------------------------------------------------

/** Build the `gh repo create` argv. PRIVATE-BY-DEFAULT is enforced HERE, in code
 * guarded by a type + a test — NOT by prompt discipline: a regression that
 * leaked source is a categorical safety failure (safety envelope (a)). The type
 * makes `{ private: false }` unrepresentable at call sites, and this function
 * throws if it is ever passed at runtime (defence in depth). The argv NEVER
 * contains "--public" — there is no code path that emits it. */
export function ghRepoCreateArgs(fullName: string, opts: { private: true }): string[] {
  if (opts.private !== true) {
    throw new Error(`ghRepoCreate refuses a non-private repo (${fullName}) — private-by-default is non-negotiable (safety envelope a)`);
  }
  // --private explicit; no --source so gh creates an EMPTY remote (bootstrap
  // seeds and pushes the first commit itself).
  return ["repo", "create", fullName, "--private"];
}

/** Create a PRIVATE GitHub repo via `gh repo create`. Throws (never spawns) when
 * asked for anything but private. Returns the created repo URL on success. */
export function ghRepoCreate(fullName: string, opts: { private: true }): { ok: boolean; url: string; out: string } {
  const args = ghRepoCreateArgs(fullName, opts); // throws on non-private before any spawn
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: 60_000 });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 400);
  const url = (r.stdout ?? "").split(/\s+/).map((t) => t.trim()).filter((t) => /^https?:\/\/github\.com\//.test(t)).pop()
    ?? `https://github.com/${fullName}`;
  return { ok: r.status === 0, url, out };
}

/** Clone a freshly-created (empty) repo and prepare a worktree on the default
 * branch so the scaffolder can seed it. An empty repo has no commits yet, so we
 * clone into the work root and ensure a `main` branch exists to commit onto. The
 * returned Workspace pushes with `HEAD:main` like any other. Never touches
 * ~/RapidoCoding — everything under FACTORY_WORK_ROOT. */
export function initScaffoldRepo(repo: string): Workspace {
  const url = `https://github.com/${repo}.git`;
  const dir = join(config.workRoot, `bootstrap-${repo.replace("/", "__")}`);
  mkdirSync(config.workRoot, { recursive: true });
  // Fresh each bootstrap attempt — a stale half-scaffold must not leak in. This
  // is a factory-owned path under FACTORY_WORK_ROOT (same as the plan/gk scratch
  // dirs), never a checkout of a live repo.
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const clone = git(config.workRoot, ["clone", url, dir], SLOW);
  if (!clone.ok) throw new Error(`clone of empty repo ${repo} failed: ${clone.out.slice(0, 300)}`);
  // A brand-new gh repo is empty → unborn branch. Ensure we are on `main`.
  git(dir, ["checkout", "-B", "main"]);
  return { repo, dir, branch: "main", baseRef: "refs/remotes/origin/main" };
}

/** Auto-revert a merge commit on an auto-repo: `git revert -m 1 <sha>` (first-
 * parent, i.e. undo the merged change while keeping main's history) then push.
 * ok:false on a conflicting revert (a human built on top of the merge) — the
 * caller escalates to a revert PR + Needs-Human rather than force-reverting
 * (operational note: an auto-revert that conflicts must not clobber human work). */
export function revertMerge(repo: string, dir: string, mergeSha: string): { ok: boolean; out: string } {
  const rev = git(dir, ["revert", "-m", "1", "--no-edit", mergeSha]);
  if (!rev.ok) {
    git(dir, ["revert", "--abort"]); // leave the worktree clean for the PR fallback
    return { ok: false, out: rev.out.slice(0, 400) };
  }
  const push = git(dir, ["push", "origin", "HEAD:main"], SLOW);
  return { ok: push.ok, out: (rev.out + push.out).slice(0, 400) };
}

/** Open a revert PR for a review-repo (or an auto-repo whose direct revert
 * conflicted): branch, revert, push, `gh pr create`. Returns the PR URL. The
 * revert runs on a NEW branch so main is never force-touched. */
export function createRevertPr(ws: Workspace, mergeSha: string, why: string): string {
  const branch = `factory/revert-${mergeSha.slice(0, 12)}`;
  git(ws.dir, ["checkout", "-B", branch]);
  const rev = git(ws.dir, ["revert", "-m", "1", "--no-edit", mergeSha]);
  if (!rev.ok) { git(ws.dir, ["revert", "--abort"]); throw new Error(`revert of ${mergeSha} failed on branch ${branch}: ${rev.out.slice(0, 200)}`); }
  const push = git(ws.dir, ["push", "origin", `HEAD:${branch}`], SLOW);
  if (!push.ok) throw new Error(`push of revert branch failed: ${push.out.slice(0, 200)}`);
  const body = redactRevertWhy(why);
  const r = spawnSync("gh", ["pr", "create", "--repo", ws.repo, "--head", branch, "--title", `Revert ${mergeSha.slice(0, 12)} — smoke failed`, "--body", body],
    { cwd: ws.dir, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) {
    const existing = spawnSync("gh", ["pr", "view", branch, "--repo", ws.repo, "--json", "url", "-q", ".url"], { encoding: "utf8", timeout: 30_000 });
    if (existing.status === 0 && existing.stdout.trim()) return existing.stdout.trim();
    throw new Error(`gh pr create (revert) failed: ${((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 300)}`);
  }
  return (r.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).pop() ?? "";
}

/** why-text for a revert PR body is raw smoke output — scrub secrets AND cap it.
 * Smoke commands run via runShellGate with an UNSCRUBBED env, so their stdout/
 * stderr routinely echo credentials (e.g. a failing `curl -H "Authorization:
 * Bearer $TOKEN"` dumping its argv). This is an outbound seam into a durable
 * GitHub PR body, so it MUST pass redactSecrets like every other seam (loop.ts
 * PR bodies, gate-output comments) — the redactSecrets-at-every-outbound-seam
 * invariant. Redact BEFORE the slice so a token split across the 1500-char cut
 * still gets scrubbed. Exported so the scrub is unit-testable without shelling
 * out to gh (same rationale as classifyPaths) — this IS the body createRevertPr
 * hands to `gh pr create --body`. */
export function redactRevertWhy(why: string): string {
  const clean = redactSecrets(why).clean.slice(0, 1500);
  return `Automated revert: the post-merge smoke check failed.\n\n${clean}\n\n🤖 Post-merge auto-revert (factory Gap 5). A human reviews before this lands.`;
}
