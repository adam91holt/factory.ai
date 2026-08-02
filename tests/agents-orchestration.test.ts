import { describe, expect, test } from "bun:test";
import { runStage, type StageDeps } from "../src/agents.ts";
import { IMPLEMENTER_TOOLS, REVIEWER_TOOLS, ROLE_CEILINGS, ORCHESTRATION_TOOLS } from "../src/routing.ts";

// Subagent orchestration enablement (owner decision 2026-08-02). The plumbing
// under test is runOneAttempt's derivation: a stage orchestrates iff its
// allowlist grants Task/Agent, in which case the SDK call must carry
//   - agents.worker with model:"inherit"  (the 502-storm fix: SDK default
//     subagents request a Claude model by name, which a proxied Qwen/DeepSeek
//     stage cannot serve — measured as a retry storm vs zero errors + ~half
//     the cost with inherit), and
//   - disallowedTools = side-channels ONLY (Task/Agent usable),
// while a non-orchestrating stage keeps the full historical deny.
// SDK faked via the injectable StageDeps — same DI as agents-retry.test.ts.

interface Captured { options: Record<string, unknown> }

function capturingDeps(captured: Captured[]): StageDeps {
  return {
    query: (params) => {
      captured.push({ options: params.options as Record<string, unknown> });
      return (async function* (): AsyncGenerator<unknown> {
        yield { type: "system", subtype: "init", session_id: "s" };
        yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, num_turns: 1 };
      })();
    },
    sleep: async () => {},
  };
}

const baseOpts = { model: "sonnet", maxTurns: 5, budgetUsd: 1, deadlineMs: Date.now() + 60_000 };

describe("orchestration derivation from the allowlist", () => {
  test("an allowlist granting Task/Agent gets the worker subagent with model:'inherit'", async () => {
    const captured: Captured[] = [];
    await runStage("implementer", "p", { ...baseOpts, allowedTools: [...IMPLEMENTER_TOOLS] }, capturingDeps(captured));
    const options = captured[0]!.options;
    const agents = options.agents as Record<string, { model?: string; maxTurns?: number; disallowedTools?: string[] }>;
    expect(agents).toBeDefined();
    expect(agents.worker!.model).toBe("inherit");
    // In-code turn cap: parent maxTurns does not bound subagent loops.
    expect(typeof agents.worker!.maxTurns).toBe("number");
    expect(agents.worker!.maxTurns!).toBeGreaterThan(0);
    // Depth 1: the worker may never spawn workers, and side-channels stay shut.
    expect(agents.worker!.disallowedTools).toEqual(expect.arrayContaining(["Task", "Agent", "CronCreate", "SendMessage"]));
    // Session denies keep ONLY the side-channels — Task/Agent must be usable.
    const denied = options.disallowedTools as string[];
    expect(denied).not.toContain("Task");
    expect(denied).not.toContain("Agent");
    expect(denied).toEqual(expect.arrayContaining(["CronCreate", "SendMessage", "Workflow", "ScheduleWakeup"]));
  });

  test("a non-orchestrating allowlist (reviewer) keeps the FULL deny and gets no agents map", async () => {
    const captured: Captured[] = [];
    await runStage("reviewer-repo", "p", { ...baseOpts, allowedTools: [...REVIEWER_TOOLS] }, capturingDeps(captured));
    const options = captured[0]!.options;
    expect(options.agents).toBeUndefined();
    const denied = options.disallowedTools as string[];
    expect(denied).toEqual(expect.arrayContaining(["Task", "Agent", "CronCreate", "SendMessage"]));
  });

  test("an empty allowlist (tool-less security reviewer) never orchestrates", async () => {
    const captured: Captured[] = [];
    await runStage("security-reviewer", "p", { ...baseOpts, allowedTools: [] }, capturingDeps(captured));
    expect(captured[0]!.options.agents).toBeUndefined();
    expect(captured[0]!.options.disallowedTools as string[]).toContain("Task");
  });
});

describe("which roles may orchestrate — the ceiling split is the policy", () => {
  const may = (role: string): boolean =>
    (ROLE_CEILINGS[role] ?? []).some((t) => ORCHESTRATION_TOOLS.includes(t));

  test("work-heavy roles may fan out", () => {
    for (const role of ["implementer", "fixer", "tester", "scout"]) expect({ role, may: may(role) }).toEqual({ role, may: true });
  });

  test("judges, planners and the steward may NOT — the 42%-of-spend incident was a reviewer", () => {
    for (const role of ["reviewer-repo", "reviewer-spec", "design-reviewer", "security-reviewer", "steward", "decomposer", "intake-author", "scaffolder"]) {
      expect({ role, may: may(role) }).toEqual({ role, may: false });
    }
  });
});
