import { abortAllStages } from "./agents.ts";
import { bus } from "./events.ts";

// Prerequisite-0 (docs/planning/autonomy.md "Build order" item 0): kill switch
// (B6) + the drain flag both the kill switch and the rolling spend cap
// (spend-cap.ts, T5) flip. Single source of truth so index.ts's tick loop and
// server.ts's /stop endpoint agree on "should new work be claimed right now?"
// without a cyclic import — this file imports agents.ts/events.ts only, never
// index.ts or server.ts, so both of those can import IT freely.

let drainRequested = false;
let drainReason: string | null = null;
let drainTrigger: "kill_switch" | "budget_cap" | null = null;

/** True once drain mode has been entered (kill switch or budget cap) — checked
 *  by index.ts's tick() before claiming any new work. Never resets itself; a
 *  human restarts the daemon once the cause is addressed. */
export function isDraining(): boolean {
  return drainRequested;
}

/** Current drain state for observability (e.g. a future /state field). */
export function drainInfo(): { draining: boolean; reason: string | null } {
  return { draining: drainRequested, reason: drainReason };
}

/** Enter drain mode: index.ts stops claiming new work starting next tick;
 *  work already in flight finishes (or was separately aborted). Idempotent —
 *  the FIRST reason wins and only the first call emits drain_entered, so a
 *  human triggering /stop right after the spend cap trips doesn't spam alerts.
 *  Emits on the bus so alerts.ts (T5) and the durable event log (db.ts) both
 *  see it — `reason` must already be plain, bounded text, never raw input. */
export function enterDrain(reason: string, trigger: "kill_switch" | "budget_cap"): void {
  if (drainRequested) return;
  drainRequested = true;
  drainReason = reason;
  drainTrigger = trigger;
  console.error(`[control] entering drain mode (${trigger}): ${reason}`);
  bus.emit({ type: "drain_entered", trigger, reason });
}

/** /resume (fix-list ②, live-found: /stop had no undo short of a restart).
 *  Clears a KILL-SWITCH drain so the next tick claims work again. A
 *  BUDGET-CAP drain is REFUSED by design: the spend cap is an in-code safety
 *  cap (CLAUDE.md), and a one-click resume would make it a soft suggestion —
 *  the operator addresses the spend (or restarts with an explicit decision)
 *  instead. Idempotent: resuming while not draining is a no-op "resumed". */
export function resumeFromDrain(): { resumed: boolean; refused?: string } {
  if (!drainRequested) return { resumed: true };
  if (drainTrigger === "budget_cap") {
    return { resumed: false, refused: `drain was entered by the BUDGET CAP (${drainReason ?? "?"}) — /resume cannot override a spend cap; restart the daemon after addressing the spend` };
  }
  const was = drainReason;
  drainRequested = false;
  drainReason = null;
  drainTrigger = null;
  console.error(`[control] drain RESUMED by operator (was: ${was})`);
  bus.emit({ type: "drain_resumed", previousReason: was ?? "" });
  return { resumed: true };
}

/** Kill switch (B6): abort every in-flight stage's AbortController AND enter
 *  drain mode. Returns the stage labels that were aborted — server.ts's /stop
 *  handler turns this straight into the JSON response. */
export function killSwitch(reason: string): { abortedStages: string[] } {
  const abortedStages = abortAllStages();
  enterDrain(reason, "kill_switch");
  return { abortedStages };
}

/** Test-only reset — mirrors db.ts's closeTestDatabase() seam pattern. Module-
 *  level state must not leak drain mode across unrelated test files. */
export function resetDrainForTest(): void {
  drainRequested = false;
  drainReason = null;
  drainTrigger = null;
}
