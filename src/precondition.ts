// Freshness / idempotency preconditions (Gap 4) — the RUNTIME complement to
// Gap 1's plan-time depends_on. A precondition is a machine-checkable LIVENESS
// premise: "is this ticket still worth doing?" re-validated against the real
// world at stage start. It generalizes loop.ts's Linear-only stillOurs() (claim
// freshness) into WORLD freshness (PR state, path/text existence) — the fix for
// the FAC-20 incident (grinding on an already-merged/closed PR).
//
// SEMANTICS: falsity of a precondition ALWAYS means "work no longer needed"
// (moot), NEVER "wait" — the wait-for-a-dependency case is Gap 1's depends_on,
// deliberately NOT modeled here. So a precondition can only ever STOP work
// (cancel/park), never GRANT authority — the same trust rule meta.ts gives the
// `merge` field ("may only withhold"). Preconditions ride the trusted, START-
// ANCHORED factory metadata block (meta.ts), so an injected one in prose is
// ignored (not start-anchored) and a steward-lifted one must pass the
// parsePrecondition allowlist — worst case a low-severity DoS-cancel of one
// reversible ticket, never an escalation.
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
  | "path-missing"  // <relpath>  holds if absent; moot if present
  | "path-exists"   // <relpath>  holds if present; moot if absent
  | "text-present"  // <relpath>::<needle>  holds if file has needle; moot if gone (already fixed)
  | "text-absent";  // <relpath>::<needle>  holds if needle absent; moot if present

export interface Precondition { kind: PreconditionKind; arg: string; raw: string; }

const KNOWN_KINDS: readonly PreconditionKind[] = [
  "undelivered", "pr-open", "path-missing", "path-exists", "text-present", "text-absent",
];

// Cap on how many preconditions a single ticket may carry — injected junk in an
// untrusted description must not bloat the block or the per-tick probe fan-out.
const MAX_PRECONDITIONS = 16;

// A PR reference embeds a number: "org/repo#N", "#N", "N", or a URL.
const PR_FULL = /^[\w.-]+\/[\w.-]+#\d+$/;
const PR_SHORT = /^#?\d+$/;

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
      if (/^https?:\/\/\S+$/.test(arg) || PR_FULL.test(arg) || PR_SHORT.test(arg)) return { kind, arg, raw: trimmed };
      return null;
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
  const all = [implicit, ...parsePreconditions(description)];
  const evaluated = all.map((p) => ({ p, ...evaluateOne(p, ctx, probes) }));
  return decideFreshness(evaluated);
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
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
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
