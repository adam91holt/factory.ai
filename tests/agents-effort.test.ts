import { describe, expect, test } from "bun:test";
import { runStage, type StageDeps } from "../src/agents.ts";

// execution-profiles: effort was DEAD (StageOptions had no effort field, so
// cards' `effort: high` frontmatter was documentation only — every stage ran
// at the SDK default regardless). This proves runStage now actually forwards
// opts.effort into the SDK query() call's options, and — the back-compat half
// — that a caller who omits it (any pre-existing call site this change didn't
// touch) still gets a call with NO `effort` key at all, not an undefined one
// that could shadow the SDK's own default.

type StageOptions = Parameters<typeof runStage>[2];

const baseOpts = (overrides: Partial<StageOptions> = {}): StageOptions => ({
  model: "sonnet",
  maxTurns: 10,
  budgetUsd: 5,
  deadlineMs: Date.now() + 5 * 60_000,
  ...overrides,
});

/** Records the full `options` object the SDK query() was invoked with, for
 *  each call — same DI shape as agents-retry.test.ts's fakeDeps, but capturing
 *  the whole options bag (not just model) so effort presence/absence is
 *  directly assertable. */
function fakeDeps(): StageDeps & { optionsCalls: Array<Record<string, unknown>> } {
  const optionsCalls: Array<Record<string, unknown>> = [];
  return {
    optionsCalls,
    query: (params) => {
      optionsCalls.push(params.options as Record<string, unknown>);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" };
        yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, num_turns: 1 };
      })();
    },
    sleep: async () => {},
  };
}

describe("runStage — effort wiring (execution-profiles)", () => {
  test("opts.effort is forwarded verbatim into the SDK query() options", async () => {
    const deps = fakeDeps();
    await runStage("implementer", "do the thing", baseOpts({ effort: "high" }), deps);
    expect(deps.optionsCalls).toHaveLength(1);
    expect(deps.optionsCalls[0]!.effort).toBe("high");
  });

  test("each of the five SDK levels passes through unchanged", async () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      const deps = fakeDeps();
      await runStage("implementer", "do the thing", baseOpts({ effort: level }), deps);
      expect(deps.optionsCalls[0]!.effort).toBe(level);
    }
  });

  test("back-compat: a caller that omits effort gets a query() call with NO effort key at all", async () => {
    const deps = fakeDeps();
    await runStage("implementer", "do the thing", baseOpts(), deps);
    expect(deps.optionsCalls).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(deps.optionsCalls[0]!, "effort")).toBe(false);
  });
});
