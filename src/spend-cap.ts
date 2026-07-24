import { config } from "./config.ts";
import { bus, type FactoryEvent } from "./events.ts";
import { enterDrain } from "./control.ts";

// Prerequisite-0 rolling spend cap (T5, docs/planning/autonomy.md "Build
// order" item 0). config.caps.budgetUsdPerIssue bounds ONE issue; this bounds
// the whole factory's trailing-24h spend across every issue/stage combined —
// the gap the audit flagged ("budget is per-issue only"). Maintained in-memory
// straight off the bus (every run_stage_finished the SAME way db.ts's durable
// log does), so it needs no db.ts dependency and works even with the event
// store closed. Exceeding the cap enters drain mode via control.ts: index.ts
// stops claiming new work next tick, in-flight issues finish normally.

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Rolling ledger of stage spend, oldest first — pruned to the trailing 24h on
 *  every insert, so its size tracks stage THROUGHPUT in the window, not the
 *  factory's entire history. */
let ledger: Array<{ at: number; costUsd: number }> = [];

function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < ledger.length && (ledger[i]?.at ?? 0) < cutoff) i += 1;
  if (i > 0) ledger = ledger.slice(i);
}

/** Sum of run_stage_finished costUsd in the trailing 24h from `now`. Exported
 *  for tests and any future /state surfacing — the daemon itself only needs
 *  the side effect in onSpendEvent below. */
export function rollingSpendUsd(now: number = Date.now()): number {
  prune(now);
  return ledger.reduce((sum, e) => sum + e.costUsd, 0);
}

function onEvent(e: FactoryEvent): void {
  if (e.type !== "run_stage_finished") return;
  ledger.push({ at: e.at, costUsd: e.costUsd });
  const total = rollingSpendUsd(e.at);
  if (total > config.caps.budgetUsdPerDay) {
    enterDrain(
      `rolling 24h spend $${total.toFixed(2)} exceeded MAX_BUDGET_USD_PER_DAY $${config.caps.budgetUsdPerDay.toFixed(2)}`,
      "budget_cap",
    );
  }
}

/** Wire the rolling spend cap onto the bus. Call once at daemon startup
 *  (index.ts main(), alongside startAlerts()). Returns the unsubscribe fn. */
export function startSpendCap(): () => void {
  return bus.subscribe(onEvent);
}

/** Test-only reset — same seam pattern as control.ts's resetDrainForTest(). */
export function resetSpendCapForTest(): void {
  ledger = [];
}
