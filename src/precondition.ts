// Freshness / idempotency preconditions (Gap 4) — the RUNTIME complement to
// Gap 1's plan-time depends_on. A precondition is a machine-checkable LIVENESS
// premise: "is this ticket still worth doing?" re-validated against the real
// world at stage start. It generalizes loop.ts's Linear-only stillOurs() (claim
// freshness) into WORLD freshness (PR state, path/text existence) — the fix for
// the FAC-20 incident (grinding on an already-merged/closed PR).
//
// SEMANTICS: falsity of a SELF-CANCEL-kind precondition ALWAYS means "work no
// longer needed" (moot), NEVER "wait" — the wait-for-a-dependency case is
// Gap 1's depends_on, deliberately not modeled by evaluateOne/decideFreshness
// below. So a self-cancel precondition can only ever STOP work (cancel/park),
// never GRANT authority — the same trust rule meta.ts gives the `merge` field
// ("may only withhold"). Preconditions ride the trusted, START-ANCHORED
// factory metadata block (meta.ts), so an injected one in prose is ignored
// (not start-anchored) and a steward-lifted one must pass the
// parsePrecondition allowlist — worst case a low-severity DoS-cancel of one
// reversible ticket, never an escalation.
//
// EXCEPTION (FAC-75): `pr-merged` is the one deliberate WAIT-kind precondition
// — a steward follow-up whose work only makes sense AFTER a specific PR lands
// must not start while it's still open (FAC-74: a "verify main is green after
// PR #6 lands" follow-up raced #6's merge by two hours and faithfully rebuilt
// ~1650 lines of it). It intentionally lives OUTSIDE the self-cancel-only
// contract above: `decidePendingMerge`/`checkPendingMerge` are its own
// combinator, evaluated PRE-CLAIM (index.ts, alongside depends_on) so holding
// costs nothing (no workspace, no label, automatic re-check next tick) —
// never routed through decideFreshness's proceed/cancel/park action space,
// whose "park" would wrongly require a human to clear a plain "not yet".
// evaluateOne still carries a `pr-merged` case for TypeScript exhaustiveness
// and as a defence-in-depth fallback (see its comment) — never the primary
// mechanism.
//
// This module is pure given its injected probes (mirrors steward.ghPr + repos.ts
// git()): the combinator/policy (decideFreshness) is the primary unit-test
// target, and evaluateOne is testable without gh/fs via fake probes.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFactoryMeta } from "./meta.ts";

// A liveness premise: falsity ALWAYS means "work no longer needed" (never "wait").
export type PreconditionKind =
  | "undelivered"   // <branch>  implicit, loop-synthesized: holds if no PR yet OR PR open; moot only if MERGED/CLOSED
  | "pr-open"       // <org/repo#N | #N | url>  holds if OPEN; moot if MERGED/CLOSED
  | "pr-merged"      // <org/repo#N | #N | url>  WAIT-kind (see header EXCEPTION): hold while OPEN/UNKNOWN, run once MERGED, cancel if CLOSED unmerged
  | "path-missing"  // <relpath>  holds if absent; moot if present
  | "path-exists"   // <relpath>  holds if present; moot if absent
  | "text-present"  // <relpath>::<needle>  holds if file has needle; moot if gone (already fixed)
  | "text-absent";  // <relpath>::<needle>  holds if needle absent; moot if present

export interface Precondition { kind: PreconditionKind; arg: string; raw: string; }

const KNOWN_KINDS: readonly PreconditionKind[] = [
  "undelivered", "pr-open", "pr-merged", "path-missing", "path-exists", "text-present", "text-absent",
];

// Cap on how many preconditions a single ticket may carry — injected junk in an
// untrusted description must not bloat the block or the per-tick probe fan-out.
const MAX_PRECONDITIONS = 16;

// A PR reference embeds a number: "org/repo#N", "#N", "N", or a URL.
const PR_FULL = /^[\w.-]+\/[\w.-]+#\d+$/;
const PR_SHORT = /^#?\d+$/;

/** Shared arg validator for the two PR-referencing kinds (`pr-open`, `pr-merged`). */
function isPrRefArg(arg: string): boolean {
  return /^https?:\/\/\S+$/.test(arg) || PR_FULL.test(arg) || PR_SHORT.test(arg);
}

/** A safe RELATIVE worktree path: not absolute, no `..` traversal, non-empty. A
 * malformed/escaping path is DROPPED (returns false) so an injected precondition
 * can never read outside the fresh base worktree. */
function isSafeRelPath(p: string): boolean {
  if (!p || p.startsWith("/")) return false;
  return !p.split(/[\\/]/).includes("..");
}

/** Canonical DSL serialization ("<kind> <arg>") so a parsed precondition
 * round-trips byte-stable through the meta block and lift path. */
function serialize(p: Precondition): string {
  return `${p.kind} ${p.arg}`;
}

/** Parse ONE DSL line ("pr-open acme/w#4") into a Precondition; null on unknown
 * kind or malformed arg (same drop-don't-throw defense as meta.ts isKnownModel).
 * Reused both to read the trusted meta block AND to validate steward-declared
 * preconditions before lifting. */
export function parsePrecondition(raw: string): Precondition | null {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) return null;
  const kind = m[1]! as PreconditionKind;
  const arg = m[2]!.trim();
  if (!KNOWN_KINDS.includes(kind) || arg === "") return null;
  switch (kind) {
    case "undelivered":
      // Any non-empty branch name; the implicit loop-synthesized form is
      // "undelivered factory/<key>".
      return { kind, arg, raw: trimmed };
    case "pr-open":
    case "pr-merged":
      return isPrRefArg(arg) ? { kind, arg, raw: trimmed } : null;
    case "path-missing":
    case "path-exists":
      return isSafeRelPath(arg) ? { kind, arg, raw: trimmed } : null;
    case "text-present":
    case "text-absent": {
      // "<relpath>::<needle>" — both halves non-empty, path confined.
      const idx = arg.indexOf("::");
      if (idx <= 0) return null;
      const rel = arg.slice(0, idx);
      const needle = arg.slice(idx + 2);
      if (!isSafeRelPath(rel) || needle === "") return null;
      return { kind, arg, raw: trimmed };
    }
  }
}

/** All preconditions carried by a ticket = the START-ANCHORED meta block's
 * `precondition:` lines (a line buried in prose or in an embedded block is
 * ignored — same trust boundary as every other meta key). */
export function parsePreconditions(description: string): Precondition[] {
  const raws = parseFactoryMeta(description).preconditions ?? [];
  const out: Precondition[] = [];
  for (const r of raws) {
    const p = parsePrecondition(r);
    if (p) out.push(p);
  }
  return out;
}

// Injected probes so the checker is unit-testable without gh/fs (mirrors steward
// ghPr + repos.ts git()). Default impls: spawnSync gh (view --json state) + node:fs.
export type PrState = "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";
export interface PreconditionProbes {
  prState(ref: string, repo: string): PrState;                       // gh pr view <ref> --json state
  pathExists(dir: string, rel: string): boolean;
  fileContains(dir: string, rel: string, needle: string): boolean | "UNKNOWN"; // UNKNOWN = file missing
}

export const defaultProbes: PreconditionProbes = {
  prState(ref: string, repo: string): PrState {
    const args = ["pr", "view", ref, "--json", "state"];
    // A URL already identifies the repo; --repo alongside it is redundant/erroring.
    if (repo && !/^https?:\/\//.test(ref)) args.push("--repo", repo);
    const r = spawnSync("gh", args, { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) return "UNKNOWN"; // no PR yet, or gh unavailable
    try {
      const state = (JSON.parse(r.stdout) as { state?: string }).state?.toUpperCase();
      if (state === "OPEN" || state === "MERGED" || state === "CLOSED") return state;
      return "UNKNOWN";
    } catch {
      return "UNKNOWN";
    }
  },
  pathExists(dir: string, rel: string): boolean {
    return existsSync(join(dir, rel));
  },
  fileContains(dir: string, rel: string, needle: string): boolean | "UNKNOWN" {
    try {
      return readFileSync(join(dir, rel), "utf8").includes(needle);
    } catch {
      return "UNKNOWN"; // file missing / unreadable
    }
  },
};

export interface PreconditionContext { repo: string; worktreeDir?: string; }
export type PerCheck = "hold" | "moot" | "unknown";

/** Resolve a pr-open arg into a (gh ref, repo) pair. "org/repo#N" carries its own
 * repo; "#N"/"N"/url fall back to the ticket's repo. */
function prTarget(arg: string, ctxRepo: string): { ref: string; repo: string } {
  if (/^https?:\/\//.test(arg)) return { ref: arg, repo: ctxRepo };
  const full = arg.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (full) return { ref: full[2]!, repo: full[1]! };
  const short = arg.match(/^#?(\d+)$/);
  if (short) return { ref: short[1]!, repo: ctxRepo };
  return { ref: arg, repo: ctxRepo };
}

/** Evaluate one precondition to hold/moot/unknown (pure given probes). */
export function evaluateOne(
  p: Precondition, ctx: PreconditionContext, probes: PreconditionProbes = defaultProbes,
): { status: PerCheck; reason: string } {
  const tag = `${p.kind} ${p.arg}`;
  switch (p.kind) {
    case "undelivered": {
      // Implicit delivery check: holds while no PR exists yet (UNKNOWN via
      // not-found) OR the PR is still OPEN; moot only once MERGED/CLOSED.
      const state = probes.prState(p.arg, ctx.repo);
      if (state === "MERGED" || state === "CLOSED") return { status: "moot", reason: `${tag}: branch PR is ${state} — already delivered` };
      if (state === "OPEN") return { status: "hold", reason: `${tag}: branch PR still OPEN` };
      return { status: "hold", reason: `${tag}: no PR yet (or gh unavailable) — rebuild` };
    }
    case "pr-open": {
      const { ref, repo } = prTarget(p.arg, ctx.repo);
      const state = probes.prState(ref, repo);
      if (state === "OPEN") return { status: "hold", reason: `${tag}: PR is OPEN` };
      if (state === "MERGED" || state === "CLOSED") return { status: "moot", reason: `${tag}: PR is ${state}` };
      return { status: "unknown", reason: `${tag}: PR state UNKNOWN (gh unavailable / not found)` };
    }
    case "pr-merged": {
      // Defence-in-depth only — the PRIMARY gate for this kind is
      // decidePendingMerge/checkPendingMerge below, evaluated PRE-CLAIM
      // (index.ts) so a ticket never even reaches this post-claim self-cancel
      // check while its PR is still open. If it somehow does anyway (a race
      // the pre-claim gate should make unreachable in practice), fail toward
      // the safe "unknown" -> park path rather than ever proceeding on a
      // stale premise or silently cancelling live work.
      const { ref, repo } = prTarget(p.arg, ctx.repo);
      const state = probes.prState(ref, repo);
      if (state === "MERGED") return { status: "hold", reason: `${tag}: PR is MERGED — safe to proceed` };
      if (state === "CLOSED") return { status: "moot", reason: `${tag}: PR CLOSED without merging — premise no longer holds` };
      return { status: "unknown", reason: `${tag}: PR still ${state} — should have been held pre-claim` };
    }
    case "path-missing": {
      if (!ctx.worktreeDir) return { status: "unknown", reason: `${tag}: no worktree to check` };
      const present = probes.pathExists(ctx.worktreeDir, p.arg);
      return present ? { status: "moot", reason: `${tag}: path now EXISTS` } : { status: "hold", reason: `${tag}: path still missing` };
    }
    case "path-exists": {
      if (!ctx.worktreeDir) return { status: "unknown", reason: `${tag}: no worktree to check` };
      const present = probes.pathExists(ctx.worktreeDir, p.arg);
      return present ? { status: "hold", reason: `${tag}: path present` } : { status: "moot", reason: `${tag}: path is GONE` };
    }
    case "text-present":
    case "text-absent": {
      if (!ctx.worktreeDir) return { status: "unknown", reason: `${tag}: no worktree to check` };
      const idx = p.arg.indexOf("::");
      const rel = p.arg.slice(0, idx);
      const needle = p.arg.slice(idx + 2);
      const has = probes.fileContains(ctx.worktreeDir, rel, needle);
      if (has === "UNKNOWN") return { status: "unknown", reason: `${tag}: file missing/unreadable` };
      if (p.kind === "text-present") {
        return has ? { status: "hold", reason: `${tag}: needle present` } : { status: "moot", reason: `${tag}: needle GONE — already fixed` };
      }
      return has ? { status: "moot", reason: `${tag}: needle now PRESENT` } : { status: "hold", reason: `${tag}: needle still absent` };
    }
  }
}

// Combinator + policy (PURE, the primary unit-test target).
export type FreshnessAction = "proceed" | "cancel" | "park";

function describe(items: Array<{ reason: string }>): string {
  return items.map((e) => e.reason).join("; ");
}

/** Combine per-check verdicts into ONE decision.
 *
 * The `undelivered` check(s) are the DELIVERY GUARD (the implicit, loop-
 * synthesized `undelivered factory/<key>`), handled apart from the authored
 * world-premises:
 *   - guard MOOT (this ticket's own branch PR merged/closed) -> cancel: the work
 *     is already delivered (FAC-20 at the ticket level).
 *   - guard FAILS OPEN: its unknown is coerced to hold, so a gh outage rebuilds
 *     rather than wrongly cancelling or stalling the whole factory. A holding
 *     guard is the NORMAL not-yet-delivered case and must NOT, on its own, turn
 *     an otherwise-all-moot follow-up into a park.
 *
 * With the guard holding, the decision is over the AUTHORED preconditions alone:
 *   every hold (or none authored)  -> proceed
 *   every authored moot            -> cancel (premise fully satisfied -> Done);
 *                                     this is the steward follow-up self-cancel —
 *                                     a fresh follow-up branch has no PR yet, so
 *                                     the guard holds, yet its `pr-open <that PR>`
 *                                     reads moot once the PR merged -> cancel.
 *   some authored moot (partial)   -> park (human decides)
 *   some authored unknown, no moot -> park */
export function decideFreshness(
  evaluated: Array<{ p: Precondition; status: PerCheck; reason: string }>,
): { action: FreshnessAction; reason: string } {
  const guards = evaluated
    .filter((e) => e.p.kind === "undelivered")
    .map((e) => (e.status === "unknown" ? { ...e, status: "hold" as PerCheck } : e));
  const authored = evaluated.filter((e) => e.p.kind !== "undelivered");

  const guardMoot = guards.find((e) => e.status === "moot");
  if (guardMoot) return { action: "cancel", reason: guardMoot.reason };

  if (authored.length === 0) return { action: "proceed", reason: "not yet delivered; no world-premises to check" };
  const moot = authored.filter((e) => e.status === "moot");
  const unknown = authored.filter((e) => e.status === "unknown");
  if (moot.length === authored.length) return { action: "cancel", reason: describe(moot) };
  if (moot.length > 0) return { action: "park", reason: `partial staleness — ${describe(moot)} (other premises still hold)` };
  if (unknown.length > 0) return { action: "park", reason: `cannot confirm freshness — ${describe(unknown)}` };
  return { action: "proceed", reason: "all preconditions hold" };
}

/** Convenience the loop calls: builds the implicit `undelivered factory/<key>`,
 * prepends it to any authored preconditions, evaluates each, and returns the
 * decision. Async (probes may go to gh) so it slots into the loop's await chain. */
export async function checkFreshness(
  issueKey: string, description: string, ctx: PreconditionContext, probes: PreconditionProbes = defaultProbes,
): Promise<{ action: FreshnessAction; reason: string }> {
  const implicit = parsePrecondition(`undelivered factory/${issueKey.toLowerCase()}`)!;
  // `pr-merged` is EXCLUDED here on purpose (repair, FAC-75 review round 1): the
  // header EXCEPTION says this kind never routes through decideFreshness's
  // proceed/cancel/park space, because its "park" would turn a plain "not yet"
  // (PR still OPEN, or a transient gh UNKNOWN between the pre-claim gate and
  // this check) into a human-blocking state — exactly the fail-safe direction
  // Outcome #2 forbids. The pre-claim gate (decidePendingMerge/checkPendingMerge,
  // index.ts) is the ONLY place `pr-merged` can hold/cancel; once a ticket has
  // passed it, MERGED is a terminal PR state (a PR cannot un-merge back to
  // CLOSED), so there is no legitimate post-claim cancellation left to detect —
  // dropping it here costs nothing and removes the unreachable-in-theory,
  // reachable-in-practice park path a gh hiccup could trigger.
  const authored = parsePreconditions(description).filter((p) => p.kind !== "pr-merged");
  const all = [implicit, ...authored];
  const evaluated = all.map((p) => ({ p, ...evaluateOne(p, ctx, probes) }));
  return decideFreshness(evaluated);
}

// ---------------------------------------------------------------------------
// `pr-merged` scheduling gate (FAC-75) — the WAIT-kind exception documented in
// the header comment. A SEPARATE combinator from decideFreshness on purpose:
// its action space (proceed / hold / cancel) has no "park", because "hold"
// here means "not yet — stay queued, re-check next tick" and must never
// require a human to clear it (unlike decideFreshness's park). Called
// PRE-CLAIM, before a workspace is ever built, so holding is free.
// ---------------------------------------------------------------------------

export type MergeGateAction = "proceed" | "hold" | "cancel";

/** Pure combinator (the primary unit-test target, mirrors decideFreshness).
 * Only `pr-merged` preconditions participate; every other kind is ignored
 * here (it is decideFreshness's business, not this gate's).
 *
 *   any referenced PR CLOSED (unmerged) -> cancel: the premise this follow-up
 *     was filed under can never be satisfied now — reuses the same terminal
 *     self-cancel path (resolveStale) every other precondition kind uses.
 *   else any PR OPEN, or its state UNKNOWN            -> hold: fail-safe in
 *     the same direction — an unreadable PR state must never be read as
 *     "merged, go ahead" any more than an OPEN one should be.
 *   else (no `pr-merged` declared, or every one MERGED) -> proceed. */
export function decidePendingMerge(
  evaluated: Array<{ p: Precondition; state: PrState }>,
): { action: MergeGateAction; reason: string } {
  const gates = evaluated.filter((e) => e.p.kind === "pr-merged");
  if (gates.length === 0) return { action: "proceed", reason: "no pr-merged gate declared" };
  const closed = gates.find((e) => e.state === "CLOSED");
  if (closed) return { action: "cancel", reason: `pr-merged ${closed.p.arg}: PR CLOSED without merging — premise no longer holds` };
  const notMerged = gates.find((e) => e.state !== "MERGED");
  if (notMerged) {
    return { action: "hold", reason: `pr-merged ${notMerged.p.arg}: PR ${notMerged.state === "OPEN" ? "still OPEN" : "state UNKNOWN"} — waiting for merge` };
  }
  return { action: "proceed", reason: "every pr-merged gate is satisfied (PR(s) MERGED)" };
}

/** Convenience the tick loop calls PRE-CLAIM (index.ts, alongside depends_on):
 * reads only the ticket's `pr-merged` preconditions (every other kind is
 * untouched — decideFreshness still owns those, post-claim, unchanged) and
 * resolves each against `gh`. Async so it slots in beside the existing
 * depends_on Linear-state fetch. */
export async function checkPendingMerge(
  description: string, ctx: PreconditionContext, probes: PreconditionProbes = defaultProbes,
): Promise<{ action: MergeGateAction; reason: string }> {
  const gates = parsePreconditions(description).filter((p) => p.kind === "pr-merged");
  const evaluated = gates.map((p) => {
    const { ref, repo } = prTarget(p.arg, ctx.repo);
    return { p, state: probes.prState(ref, repo) };
  });
  return decidePendingMerge(evaluated);
}

/** Minimal shape the scheduling wiring (index.ts) needs from a queue issue —
 * kept narrow so this stays testable with plain fixture objects, no linear.ts
 * Issue import here. */
export interface MergeGateIssue { identifier: string; description: string; }

/** Result of applying the pre-claim `pr-merged` gate to a batch of candidates.
 *  `schedulable` is EVERY candidate minus the cancelled ones — including held
 *  ones — so DAG derivation and the file mutex (dag.ts, index.ts) still see a
 *  held ticket's `touches`/position and order/serialize real siblings around
 *  it correctly; the caller is responsible for excluding `heldIds` from the
 *  final CLAIM batch (after selectRunnable), not from scheduling itself.
 *  Repair (FAC-75 review round 1, high #1 dag.ts/index.ts): dropping a held
 *  candidate out of the schedulable set entirely — the pre-repair behavior —
 *  made it invisible to deriveImplicitDeps, so a later sibling with
 *  overlapping `touches` could jump ahead of it with no ordering edge. */
export interface MergeGatePartition<T extends MergeGateIssue> {
  schedulable: T[];
  heldIds: Set<string>;
  cancelled: Array<{ issue: T; reason: string }>;
}

/** Apply the `pr-merged` pre-claim gate to a batch of already-eligible,
 * NOT-in-flight candidates (the caller MUST exclude in-flight issues before
 * calling this — an issue whose run is currently executing must never be
 * re-probed or resolved here; see index.ts's FAC-75 repair note). Extracted
 * from index.ts's tick() so the scheduling wiring itself — not just the pure
 * decidePendingMerge combinator — is unit-testable without mocking Linear/gh
 * (repair, FAC-75 review round 1, medium #3: the pre-repair gate loop had
 * zero coverage at this level, which is exactly where the in-flight defect
 * lived). Pure given injected `probes`; async because checkPendingMerge is. */
export async function applyMergeGate<T extends MergeGateIssue>(
  issues: T[],
  repoOf: (issue: T) => string,
  probes: PreconditionProbes = defaultProbes,
): Promise<MergeGatePartition<T>> {
  const schedulable: T[] = [];
  const heldIds = new Set<string>();
  const cancelled: Array<{ issue: T; reason: string }> = [];
  for (const issue of issues) {
    const gate = await checkPendingMerge(issue.description, { repo: repoOf(issue) }, probes).catch((error) => ({
      action: "hold" as const,
      reason: `pr-merged gate check errored — holding (fail-safe): ${error instanceof Error ? error.message : error}`,
    }));
    if (gate.action === "cancel") { cancelled.push({ issue, reason: gate.reason }); continue; }
    schedulable.push(issue);
    if (gate.action === "hold") heldIds.add(issue.identifier);
  }
  return { schedulable, heldIds, cancelled };
}

/** Lift model-authored preconditions (a "## Precondition" section, or inline
 * "Precondition:" lines the steward wrote in prose) into validated DSL strings,
 * dropping any that don't parse — the same trust boundary plan.ts uses stamping
 * repo/type into the meta block. Deduped and capped. */
export function liftPreconditions(followupBody: string): string[] {
  const candidates: string[] = [];
  const lines = followupBody.split("\n");
  let inSection = false;
  for (const line of lines) {
    const header = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (header) {
      // A "## Precondition(s)" header opens the section; any other header closes it.
      inSection = /^precondition/i.test(header[1]!.trim());
      continue;
    }
    const inline = line.match(/^\s*precondition\s*:\s*(.+?)\s*$/i);
    if (inline) { candidates.push(inline[1]!); continue; }
    if (inSection) {
      const body = line.replace(/^\s*[-*]\s+/, "").trim();
      if (body) candidates.push(body);
    }
  }
  // A model echoing this module's own vocabulary docs (agents/steward.md
  // wraps every DSL example in a code span, e.g. `pr-merged acme/w#6`) is a
  // very plausible steward output shape. Left unstripped, the leading/
  // trailing backtick makes the KIND token unrecognizable ("`pr-merged" is
  // not a known kind), so parsePrecondition silently drops the WHOLE line —
  // for a self-cancel kind that's a minor missed DoS-immunity (module header),
  // but for `pr-merged` it defeats the very gate this ticket adds: the
  // follow-up is stamped with NO precondition at all and proceeds immediately,
  // recreating the FAC-74 race (repair, FAC-75 review round 1, high). Strip
  // ONE matched pair of surrounding backticks (a single code span around the
  // whole line) before parsing; anything else malformed still drops, same as
  // before.
  const stripCodeSpan = (s: string): string => {
    const m = s.match(/^`([^`]+)`$/);
    return m ? m[1]!.trim() : s;
  };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const c = stripCodeSpan(raw);
    const p = parsePrecondition(c);
    if (!p) continue;
    const dsl = serialize(p);
    if (seen.has(dsl)) continue;
    seen.add(dsl);
    out.push(dsl);
    if (out.length >= MAX_PRECONDITIONS) break;
  }
  return out;
}
