import { describe, expect, test } from "bun:test";
import { MAP } from "../ui/src/components/OutcomeBadge.tsx";
import type { RunOutcome } from "../src/events.ts";

// Guards the widening trap: RunOutcome lives in both src/events.ts and
// ui/src/lib/events.ts, but OutcomeBadge's MAP is a hand-written
// Record<"active" | RunOutcome, …>. When a new outcome ("stale") is added to
// the union, TS only catches the missing MAP entry in the *ui* tsconfig — the
// root typecheck stays green — so a stale run would hit MAP[undefined] and
// crash the history/run views at runtime. This list mirrors src/events.ts and
// fails loudly the next time the union grows without MAP keeping up.
const OUTCOMES: RunOutcome[] = [
  "pr_open",
  "merged",
  "planned",
  "parked",
  "needs_human",
  "aborted",
  "stale",
  "bootstrapped",
  "authored",
  "awaiting_answer",
];

describe("OutcomeBadge MAP — every RunOutcome is renderable", () => {
  test("active is always present", () => {
    expect(MAP.active).toBeDefined();
    expect(typeof MAP.active.label).toBe("string");
  });

  for (const outcome of OUTCOMES) {
    test(`${outcome} maps to a label + variant`, () => {
      const m = MAP[outcome];
      expect(m).toBeDefined();
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.variant).toBeTruthy();
    });
  }

  test("stale specifically resolves (regression for the widening gap)", () => {
    expect(MAP.stale).toEqual({ label: "STALE", variant: "parked" });
  });
});
