import { describe, expect, test } from "bun:test";
import { runStage, type StageDeps } from "../src/agents.ts";
import { GATE_OUTPUT_SCHEMA } from "../src/gate.ts";

// Structured gate outputs (issue #6 Part 1) — the agents.ts transport half:
// runStage passes a caller's json_schema outputFormat through to the SDK query
// options, and surfaces the result message's `structured_output` verbatim on
// StageResult.structured (validation is gate.ts's job, not the runner's).
// Same injectable-StageDeps harness as tests/agents-retry.test.ts.

type StageOptions = Parameters<typeof runStage>[2];

const baseOpts = (overrides: Partial<StageOptions> = {}): StageOptions => ({
  model: "sonnet",
  maxTurns: 10,
  budgetUsd: 5,
  deadlineMs: Date.now() + 5 * 60_000,
  ...overrides,
});

function fakeDeps(script: () => AsyncIterable<unknown>): StageDeps & { optionsSeen: Record<string, unknown>[] } {
  const optionsSeen: Record<string, unknown>[] = [];
  return {
    optionsSeen,
    query: (params) => { optionsSeen.push(params.options); return script(); },
    sleep: async () => {},
  };
}

const STRUCTURED = { verdict: "fail", findings: [], evidence: [], recommendedAction: "escalate", prose: "p" };

async function* successWithStructured(): AsyncGenerator<unknown> {
  yield { type: "system", subtype: "init", session_id: "s" };
  yield { type: "result", subtype: "success", result: "prose", total_cost_usd: 0.01, num_turns: 2, structured_output: STRUCTURED };
}
async function* successPlain(): AsyncGenerator<unknown> {
  yield { type: "system", subtype: "init", session_id: "s" };
  yield { type: "result", subtype: "success", result: "prose", total_cost_usd: 0.01, num_turns: 2 };
}
async function* structuredRetriesExhausted(): AsyncGenerator<unknown> {
  yield { type: "system", subtype: "init", session_id: "s" };
  yield { type: "result", subtype: "error_max_structured_output_retries", errors: ["could not satisfy schema"] };
}

describe("runStage structured-output transport", () => {
  const outputFormat = { type: "json_schema", schema: GATE_OUTPUT_SCHEMA } as const;

  test("outputFormat is passed through to the SDK options exactly as given", async () => {
    const deps = fakeDeps(successWithStructured);
    await runStage("security-reviewer", "p", baseOpts({ outputFormat }), deps);
    expect(deps.optionsSeen[0]!.outputFormat).toEqual(outputFormat);
  });

  test("a stage WITHOUT outputFormat sends none (pre-existing call sites unchanged) and gets no structured field", async () => {
    const deps = fakeDeps(successPlain);
    const r = await runStage("implementer", "p", baseOpts(), deps);
    expect("outputFormat" in deps.optionsSeen[0]!).toBe(false);
    expect("structured" in r).toBe(false);
  });

  test("the result's structured_output surfaces verbatim on StageResult.structured (validation is gate.ts's job)", async () => {
    const deps = fakeDeps(successWithStructured);
    const r = await runStage("security-reviewer", "p", baseOpts({ outputFormat }), deps);
    expect(r.structured).toEqual(STRUCTURED);
    expect(r.text).toBe("prose");
    expect(r.error).toBeUndefined();
  });

  test("error_max_structured_output_retries surfaces as a stage ERROR (C7) — the gate callers route it fail-closed", async () => {
    const deps = fakeDeps(structuredRetriesExhausted);
    const r = await runStage("security-reviewer", "p", baseOpts({ outputFormat }), deps);
    expect(r.error).toContain("error_max_structured_output_retries");
    expect(r.structured).toBeUndefined();
  });
});
