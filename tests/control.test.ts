import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bus, type FactoryEvent } from "../src/events.ts";
import { abortAllStages, activeStageCount } from "../src/agents.ts";
import { drainInfo, enterDrain, isDraining, killSwitch, resetDrainForTest } from "../src/control.ts";

// Prerequisite-0 (docs/planning/autonomy.md "Build order" item 0): the kill
// switch (B6) + the shared drain flag both it and the rolling spend cap
// (spend-cap.ts) flip. resetDrainForTest() mirrors db.ts's closeTestDatabase()
// seam — module-level drain state must not leak across test files.

beforeEach(() => resetDrainForTest());
afterEach(() => resetDrainForTest());

type DrainEntered = Extract<FactoryEvent, { type: "drain_entered" }>;

/** Collect drain_entered events emitted during the wrapped block, without
 *  disturbing any other subscriber on the shared bus singleton. */
function collectDrainEvents(): { events: DrainEntered[]; unsubscribe: () => void } {
  const events: DrainEntered[] = [];
  const unsubscribe = bus.subscribe((e) => { if (e.type === "drain_entered") events.push(e); });
  return { events, unsubscribe };
}

describe("isDraining / drainInfo", () => {
  test("starts false with no reason", () => {
    expect(isDraining()).toBe(false);
    expect(drainInfo()).toEqual({ draining: false, reason: null });
  });
});

describe("enterDrain", () => {
  test("flips isDraining and records the reason", () => {
    enterDrain("rolling spend exceeded cap", "budget_cap");
    expect(isDraining()).toBe(true);
    expect(drainInfo()).toEqual({ draining: true, reason: "rolling spend exceeded cap" });
  });

  test("is idempotent — the FIRST reason wins and only the first call emits drain_entered", () => {
    const { events, unsubscribe } = collectDrainEvents();
    try {
      enterDrain("first reason", "kill_switch");
      enterDrain("second reason", "budget_cap");
      expect(isDraining()).toBe(true);
      expect(drainInfo().reason).toBe("first reason");
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({ type: "drain_entered", trigger: "kill_switch", reason: "first reason" });
    } finally {
      unsubscribe();
    }
  });
});

describe("killSwitch (B6)", () => {
  test("with nothing in flight: aborts nothing but still enters drain", () => {
    expect(activeStageCount()).toBe(0);
    const { abortedStages } = killSwitch("manual /stop");
    expect(abortedStages).toEqual([]);
    expect(isDraining()).toBe(true);
    expect(drainInfo().reason).toBe("manual /stop");
  });

  test("emits drain_entered with trigger kill_switch (the alert path alerts.ts watches)", () => {
    const { events, unsubscribe } = collectDrainEvents();
    try {
      killSwitch("panic button pressed");
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({ type: "drain_entered", trigger: "kill_switch", reason: "panic button pressed" });
    } finally {
      unsubscribe();
    }
  });

  test("a second /stop after drain is already entered aborts nothing new and does not re-emit", () => {
    killSwitch("first stop");
    const { events, unsubscribe } = collectDrainEvents();
    try {
      const { abortedStages } = killSwitch("second stop — should be a no-op reason-wise");
      expect(abortedStages).toEqual([]); // agents.ts's registry, independent of drain state
      expect(drainInfo().reason).toBe("first stop"); // enterDrain's idempotency held
      expect(events.length).toBe(0); // no second drain_entered
    } finally {
      unsubscribe();
    }
  });
});

describe("abortAllStages / activeStageCount (agents.ts registry)", () => {
  test("baseline: no stages ever registered outside a live runStage call", () => {
    expect(activeStageCount()).toBe(0);
    expect(abortAllStages()).toEqual([]);
  });
});
