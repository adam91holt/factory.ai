import type { RunOutcome, RunRecord } from "./events";

// ---------------------------------------------------------------------------
// Pure helpers for the history view — kept out of the components so the
// summary math and filtering are unit-testable without a DOM.
// ---------------------------------------------------------------------------

export interface HistorySummary {
  total: number;
  totalCost: number;
  costPerRun: number;
  byOutcome: Record<RunOutcome, number>;
}

const OUTCOME_KEYS: RunOutcome[] = [
  "pr_open", "merged", "planned", "parked", "needs_human",
  "aborted", "stale", "bootstrapped", "authored", "awaiting_answer",
];

export function summarizeRuns(records: RunRecord[]): HistorySummary {
  const byOutcome = Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0])) as Record<RunOutcome, number>;
  let totalCost = 0;
  for (const r of records) {
    totalCost += r.costUsd;
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  }
  const total = records.length;
  return { total, totalCost, costPerRun: total > 0 ? totalCost / total : 0, byOutcome };
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
