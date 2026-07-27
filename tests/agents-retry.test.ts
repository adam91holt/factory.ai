import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../src/config.ts";
import { bus, type FactoryEvent } from "../src/events.ts";
import { isTransientStageError, runStage, type StageDeps } from "../src/agents.ts";

// #14/#11: model failover + stage retry on transient errors. Before this fix,
// a single 429 ("all credentials for model X are cooling down") hard-failed
// the stage outright — with the whole roster sharing one model, that took the
// entire factory down. These tests exercise runStage's retry/failover logic
// with the SDK faked out via the injectable StageDeps (same DI pattern as
// alerts.test.ts's AlertDeps / postmerge.test.ts's DeployDeps) — no network,
// no real SDK process, and instant (mocked) backoff so the suite stays fast.

type StageOptions = Parameters<typeof runStage>[2];

const baseOpts = (overrides: Partial<StageOptions> = {}): StageOptions => ({
  model: "sonnet",
  maxTurns: 10,
  budgetUsd: 5,
  deadlineMs: Date.now() + 5 * 60_000, // generous — never the thing under test here
  ...overrides,
});

/** Records the `model` each scripted call was made with; sleep is a no-op
 *  recorder so backoff never actually slows the suite down. */
function fakeDeps(scripts: Array<() => AsyncIterable<unknown>>): StageDeps & { calls: string[]; sleeps: number[] } {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let i = 0;
  return {
    calls,
    sleeps,
    query: (params) => {
      calls.push(String((params.options as Record<string, unknown>).model));
      const script = scripts[Math.min(i, scripts.length - 1)]!;
      i += 1;
      return script();
    },
    sleep: async (ms) => { sleeps.push(ms); },
  };
}

async function* success(text = "ok"): AsyncGenerator<unknown> {
  yield { type: "system", subtype: "init", session_id: "s" };
  yield { type: "result", subtype: "success", result: text, total_cost_usd: 0.02, num_turns: 3 };
}

async function* transient429(): AsyncGenerator<unknown> {
  yield { type: "system", subtype: "init", session_id: "s" };
  yield { type: "result", subtype: "error_during_execution",
    errors: ["429 · all credentials for model X are cooling down"] };
}

async function* realError(): AsyncGenerator<unknown> {
  yield { type: "system", subtype: "init", session_id: "s" };
  yield { type: "result", subtype: "error_max_turns" };
}

/** Collect provider_failover events emitted during `fn`, without touching the
 *  shared bus's other subscribers (same subscribe/unsubscribe pattern
 *  alerts.test.ts uses). */
async function withFailoverEvents<T>(fn: () => Promise<T>): Promise<{ result: T; events: FactoryEvent[] }> {
  const events: FactoryEvent[] = [];
  const unsubscribe = bus.subscribe((e) => { if (e.type === "provider_failover") events.push(e); });
  try {
    const result = await fn();
    return { result, events };
  } finally {
    unsubscribe();
  }
}

const originalFallback = config.fallbackModel;
afterEach(() => { config.fallbackModel = originalFallback; });

describe("isTransientStageError", () => {
  test("provider/network signals are transient", () => {
    expect(isTransientStageError("429 · all credentials for model X are cooling down")).toBe(true);
    expect(isTransientStageError("error_during_execution: rate limited, try again")).toBe(true);
    expect(isTransientStageError("fetch failed: ECONNRESET")).toBe(true);
    expect(isTransientStageError("upstream overloaded, please retry")).toBe(true);
    expect(isTransientStageError("503 service unavailable")).toBe(true);
  });

  test("our own abort reasons are never transient — must fail immediately", () => {
    expect(isTransientStageError("stage deadline reached")).toBe(false);
    expect(isTransientStageError("kill switch: /stop invoked")).toBe(false);
  });

  test("real exhaustion (turns/budget) is never transient", () => {
    expect(isTransientStageError("error_max_turns")).toBe(false);
    expect(isTransientStageError("error_max_budget_usd")).toBe(false);
  });

  test("a genuine tool/logic error is never transient", () => {
    expect(isTransientStageError("TypeError: cannot read property 'x' of undefined")).toBe(false);
    expect(isTransientStageError("permission denied: Write to /etc/passwd")).toBe(false);
  });
});

describe("runStage — transient retry", () => {
  test("a transient 429 retries then succeeds — no failover needed", async () => {
    config.fallbackModel = ""; // must not matter: retry alone should recover
    const deps = fakeDeps([transient429, success]);
    const { result, events } = await withFailoverEvents(() => runStage("implementer", "do the thing", baseOpts(), deps));
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("ok");
    expect(result.degraded).toBeUndefined();
    expect(deps.calls).toEqual(["sonnet", "sonnet"]); // one retry, same model both times
    expect(deps.sleeps.length).toBe(1); // exactly one backoff wait before the retry
    expect(events).toEqual([]); // recovered on the primary model — nothing to alert on
  });

  test("a genuine tool/logic error never retries", async () => {
    const deps = fakeDeps([realError]);
    const result = await runStage("implementer", "do the thing", baseOpts(), deps);
    expect(result.error).toBe("error_max_turns");
    expect(deps.calls).toEqual(["sonnet"]); // exactly one attempt — no retry burned on a real failure
    expect(deps.sleeps.length).toBe(0);
  });
});

describe("runStage — retries exhausted + fallback", () => {
  test("fallback configured → runs on the fallback model after retries exhaust", async () => {
    config.fallbackModel = "opus";
    // 3 transient attempts on the primary model, then success on the fallback.
    const deps = fakeDeps([transient429, transient429, transient429, success]);
    const { result, events } = await withFailoverEvents(() => runStage("implementer", "do the thing", baseOpts(), deps));
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("ok");
    expect(result.degraded).toBe(true); // ran on a non-primary model — surfaced like reviewer-fallback
    expect(deps.calls).toEqual(["sonnet", "sonnet", "sonnet", "opus"]);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: "provider_failover", stage: "implementer", fromModel: "sonnet", toModel: "opus" });
  });

  test("a per-call fallbackModel overrides the global config default", async () => {
    config.fallbackModel = "opus"; // must be ignored — opts.fallbackModel wins
    const deps = fakeDeps([transient429, transient429, transient429, success]);
    const { result } = await withFailoverEvents(() =>
      runStage("implementer", "do the thing", baseOpts({ fallbackModel: "haiku" }), deps));
    expect(result.error).toBeUndefined();
    expect(deps.calls).toEqual(["sonnet", "sonnet", "sonnet", "haiku"]);
  });

  test("no fallback configured → errors with a clear reason after retries exhaust", async () => {
    config.fallbackModel = "";
    const deps = fakeDeps([transient429, transient429, transient429]);
    const { result, events } = await withFailoverEvents(() => runStage("implementer", "do the thing", baseOpts(), deps));
    expect(result.error).toBe("error_during_execution: 429 · all credentials for model X are cooling down");
    expect(result.degraded).toBeUndefined();
    expect(deps.calls).toEqual(["sonnet", "sonnet", "sonnet"]); // primary only — no fallback to try
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: "provider_failover", stage: "implementer", fromModel: "sonnet", toModel: null,
      reason: "error_during_execution: 429 · all credentials for model X are cooling down" });
  });

  test("a fallback identical to the primary model is never used (would just be a silent 4th retry)", async () => {
    config.fallbackModel = "sonnet";
    const deps = fakeDeps([transient429, transient429, transient429]);
    const { result, events } = await withFailoverEvents(() => runStage("implementer", "do the thing", baseOpts(), deps));
    expect(result.error).toBe("error_during_execution: 429 · all credentials for model X are cooling down");
    expect(deps.calls).toEqual(["sonnet", "sonnet", "sonnet"]);
    expect(events[0]).toMatchObject({ type: "provider_failover", fromModel: "sonnet", toModel: null });
  });
});
