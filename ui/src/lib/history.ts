import type { RunOutcome, RunRecord } from "./events";

// ---------------------------------------------------------------------------
// Pure helpers for the history view — kept out of the components so the
// summary math and filtering are unit-testable without a DOM.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Routed-vs-escalated outcomes ledger.
//
// "Every human handoff = NEEDS HUMAN" buries the signal: a run that touched a
// guarded path and correctly stopped is the system WORKING, while a run that
// blew its budget or failed the security gate is genuine friction. The split:
//
//   ROUTED    — by-design handoff. Guarded paths (C17), the self-repo /
//               merge:review human-merge tier (every pr_open), the categorical
//               test-deletion review, intake awaiting a human answer.
//   ESCALATED — friction. Gate failures, security/taste/tester FAILs,
//               errored or never-completed stages, budget/wall-clock expiry,
//               drain, external moves, and anything unrecognized.
//
// Derivation, not new state: classification is reconstructed from the reason
// strings loop.ts already records (the marker-reconstruction approach), so
// rows written before this ledger existed classify identically — no event or
// RunRecord field was added. The trade-off is a soft contract on phrasing:
// reword a loop.ts hold/park reason and its runs fall back to ESCALATED
// (fail-noisy — a routed run shows up as friction, never the reverse) until
// the marker lists below learn the new phrasing.
//
// TIGHTEN-ONLY invariant: ambiguity resolves toward ESCALATED. Escalated
// markers are checked FIRST so a mixed holdReason ("guarded paths touched: …;
// security review returned a FAIL verdict") reads as friction, and anything
// matching no marker at all defaults to escalated. Never default to routed.
// ---------------------------------------------------------------------------

export type OutcomeClass = "routed" | "escalated";

/** Substrings (lowercased) of reasons that mean the handoff was BY DESIGN. */
const ROUTED_MARKERS = [
  "guarded paths touched",     // C17 hold — guarded files always get a human
  "deletes test files",        // park: "change DELETES test files (…) — categorical human review"
  "categorical human review",
];

/** Substrings (lowercased) of reasons that mean GENUINE friction. Checked
 *  before ROUTED_MARKERS so mixed holdReasons escalate. Most friction reasons
 *  (stage errors like "implementer: …", "workspace: …", unparseable tickets)
 *  need no marker — they escalate via the default — so this list only has to
 *  name reasons that can share a holdReason with a routed marker, plus the
 *  common terminal causes we want robust against future reason-joining. */
const ESCALATED_MARKERS = [
  // repos.ts guardedPathsTouched could not compute the diff (git failure) and
  // returned the DIFF_FAILED sentinel; loop.ts records it inside the guarded
  // hold ("guarded paths touched: <diff-failed>"). That is an errored stage
  // wearing the routed marker's clothing — friction, not a by-design C17 stop —
  // so it must be listed HERE (escalated wins over routed) or it would misfile.
  "<diff-failed>",
  "auto-merge failed",                 // mergePr ran and failed (loop.ts B16 path)
  "security review returned a fail",   // security FAIL verdict
  "security review did not complete",  // warranted-but-absent security pass
  "design taste gate failed",
  "design review did not complete",
  "explicit fail verdict",             // tester VERDICT: fail
  "gates still failing",
  "wall-clock cap reached",            // budgetExpiredReason variants (loop.ts)
  "issue budget exhausted",
  "factory is draining",
  "moved externally",
];

/** Classify a terminal run outcome as a by-design handoff ("routed"), genuine
 *  friction ("escalated"), or neither (null — the run needed no human at all).
 *  Pure; total over unknown outcome strings and absent reasons (old rows and
 *  future outcomes both classify — default escalated, never routed). */
export function classifyOutcome(outcome: RunOutcome, reason?: string): OutcomeClass | null {
  const r = (reason ?? "").toLowerCase();
  const escalatedMarker = ESCALATED_MARKERS.some((m) => r.includes(m));
  switch (outcome) {
    // No human handoff: the change landed autonomously, planning produced
    // children, bootstrap/authoring completed, or the premise was already
    // satisfied (stale resolves to Done by itself — nothing for a human).
    case "merged":
    case "planned":
    case "bootstrapped":
    case "authored":
    case "stale":
      return null;
    // "A human merges the PR" IS the design of the human/shadow tiers and the
    // merge:review / self-repo caps — routed by definition, not by default.
    // The reason scan catches the exception: a run the daemon TRIED and FAILED
    // to auto-merge (loop.ts records "auto-merge failed: …" on that pr_open
    // row) is friction, not the human-merge tier working. Rows written before
    // that reason existed carry no reason and stay routed here; the run-detail
    // reconstruction (reconstruct.ts) recovers them from merge_decision events.
    case "pr_open":
      return escalatedMarker ? "escalated" : "routed";
    // Intake posted clarifying questions and requeued for the human's answer —
    // the Gap-5 bookend working exactly as intended.
    case "awaiting_answer":
      return "routed";
    // External move detected mid-run — the world changed under us.
    case "aborted":
      return "escalated";
    // needs_human / parked (and any outcome this union doesn't know yet):
    // derive from the recorded reason; escalated wins over routed; no match
    // at all — including a missing reason — is escalated.
    default:
      return !escalatedMarker && ROUTED_MARKERS.some((m) => r.includes(m))
        ? "routed"
        : "escalated";
  }
}

export interface HistorySummary {
  total: number;
  totalCost: number;
  costPerRun: number;
  byOutcome: Record<RunOutcome, number>;
  /** Routed-vs-escalated ledger over the same rows; routed + escalated ≤ total
   *  (merged/planned/… classify as neither). */
  routed: number;
  escalated: number;
}

const OUTCOME_KEYS: RunOutcome[] = [
  "pr_open", "merged", "planned", "parked", "needs_human",
  "aborted", "stale", "bootstrapped", "authored", "awaiting_answer",
];

export function summarizeRuns(records: RunRecord[]): HistorySummary {
  const byOutcome = Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0])) as Record<RunOutcome, number>;
  let totalCost = 0;
  let routed = 0;
  let escalated = 0;
  for (const r of records) {
    totalCost += r.costUsd;
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    const cls = classifyOutcome(r.outcome, r.reason);
    if (cls === "routed") routed += 1;
    else if (cls === "escalated") escalated += 1;
  }
  const total = records.length;
  return { total, totalCost, costPerRun: total > 0 ? totalCost / total : 0, byOutcome, routed, escalated };
}

/** Distinct repos across the loaded runs, sorted — for the repo filter. Runs
 *  written before repo enrichment simply contribute nothing here. */
export function distinctRepos(records: RunRecord[]): string[] {
  const set = new Set<string>();
  for (const r of records) {
    if (r.repo) set.add(r.repo);
  }
  return [...set].sort();
}
