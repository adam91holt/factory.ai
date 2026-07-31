import { describe, expect, test } from "bun:test";
import { forbiddenToolViolations, runStage, isTransientStageError, type StageDeps } from "../src/agents.ts";
import { WRITER_BASH, REVIEWER_TOOLS } from "../src/loop.ts";
import { STEWARD_TOOLS } from "../src/steward.ts";

// Worker tool-allowlist audit (tighten-only hardening): "remove any tool whose
// matcher cannot pin the target". The daemon performs every remote mutation
// itself (repos.ts pushBranch / createPr), so NO worker allowlist may carry
// git push (except the exact wildcard-free pinned forms), gh write verbs
// (merge/api/issue/label/...), unpinned Bash/git, or shell-escape runners.
// These tests pin BOTH the predicate (forbiddenToolViolations) and the actual
// production allowlists (WRITER_BASH / REVIEWER_TOOLS / STEWARD_TOOLS), so a
// future edit cannot silently loosen either without a red test.

describe("forbiddenToolViolations — predicate", () => {
  test("flags unpinned Bash in every spelling", () => {
    for (const tool of ["Bash", "Bash(*)", "Bash(:*)"]) {
      expect(forbiddenToolViolations([tool])).toHaveLength(1);
    }
  });

  test("flags unpinned git (any subcommand incl. push --force)", () => {
    expect(forbiddenToolViolations(["Bash(git:*)"])).toHaveLength(1);
  });

  test("flags every non-pinned git push form", () => {
    const bad = [
      "Bash(git push:*)",                      // wildcard: matches --force too
      "Bash(git push origin HEAD:*)",          // wildcarded pinned form: matches HEAD:main suffix args
      "Bash(git push -u origin HEAD:*)",
      "Bash(git push --force origin HEAD)",    // exact but force
      "Bash(git push origin HEAD:main)",       // exact but explicit refspec
      "Bash(git push origin main)",
    ];
    for (const tool of bad) {
      expect(forbiddenToolViolations([tool])).toHaveLength(1);
    }
  });

  test("accepts ONLY the exact wildcard-free pinned push forms", () => {
    expect(forbiddenToolViolations(["Bash(git push -u origin HEAD)"])).toEqual([]);
    expect(forbiddenToolViolations(["Bash(git push origin HEAD)"])).toEqual([]);
  });

  test("flags daemon-only git subcommands (remote/config rewrite, arbitrary remote fetch)", () => {
    for (const tool of ["Bash(git remote:*)", "Bash(git config:*)", "Bash(git fetch:*)", "Bash(git pull:*)", "Bash(git remote set-url origin evil)"]) {
      expect(forbiddenToolViolations([tool])).toHaveLength(1);
    }
  });

  test("flags every gh grant beyond the read-only investigation verbs", () => {
    const bad = [
      "Bash(gh:*)", "Bash(gh api:*)", "Bash(gh pr merge:*)", "Bash(gh pr close:*)",
      "Bash(gh pr comment:*)", "Bash(gh pr create:*)", "Bash(gh issue edit:*)",
      "Bash(gh issue create:*)", "Bash(gh label create:*)", "Bash(gh repo delete:*)",
      "Bash(gh pr merge --admin)", // exact-form mutation is still mutation
    ];
    for (const tool of bad) {
      expect(forbiddenToolViolations([tool])).toHaveLength(1);
    }
  });

  test("accepts the read-only gh investigation verbs (the steward's surface)", () => {
    expect(forbiddenToolViolations([
      "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh pr checks:*)",
      "Bash(gh pr list:*)", "Bash(gh pr status:*)",
    ])).toEqual([]);
  });

  test("gh prefix match is word-bounded — 'gh pr listX' style smuggling is not a read-only verb", () => {
    // A matcher whose command merely STARTS WITH the read-only characters but
    // continues the word is a different command, not a pinned read-only verb.
    expect(forbiddenToolViolations(["Bash(gh pr viewer:*)"])).toHaveLength(1);
  });

  test("flags shell-escape runners that defeat command pinning", () => {
    for (const tool of ["Bash(sh:*)", "Bash(bash -c:*)", "Bash(env:*)", "Bash(xargs:*)"]) {
      expect(forbiddenToolViolations([tool])).toHaveLength(1);
    }
  });

  test("flags hard-denied orchestration tools appearing in an allowlist (confused config)", () => {
    for (const tool of ["Task", "SendMessage", "CronCreate", "Skill"]) {
      expect(forbiddenToolViolations([tool])).toHaveLength(1);
    }
  });

  test("reports one violation per offending entry, none for clean ones", () => {
    const v = forbiddenToolViolations(["Read", "Bash(gh api:*)", "Grep", "Bash(git push:*)"]);
    expect(v).toHaveLength(2);
    expect(v[0]).toContain("gh");
    expect(v[1]).toContain("git push");
  });

  test("accepts the pipeline's actual non-Bash tool grants", () => {
    // scout / planner / groundskeeper-style lists (plan.ts, intake.ts, groundskeepers.ts)
    expect(forbiddenToolViolations(["Read", "Glob", "Grep", "WebSearch", "WebFetch"])).toEqual([]);
    expect(forbiddenToolViolations(["Write", "Read"])).toEqual([]);
    expect(forbiddenToolViolations(["Read", "Glob", "Grep", "Write(/work/gk/out/**)"])).toEqual([]);
  });
});

describe("production allowlist shape", () => {
  test("WRITER_BASH (implementer/fixer/tester) is clean and carries no push and no gh at all", () => {
    expect(forbiddenToolViolations(WRITER_BASH)).toEqual([]);
    expect(forbiddenToolViolations(["Read", "Glob", "Grep", "Write", "Edit", ...WRITER_BASH])).toEqual([]);
    for (const tool of WRITER_BASH) {
      expect(tool).not.toMatch(/push/i);
      expect(tool).not.toMatch(/\bgh\b/);
    }
  });

  test("REVIEWER_TOOLS is read-only: no Write/Edit, no push, no gh, only pinned read git", () => {
    expect(forbiddenToolViolations(REVIEWER_TOOLS)).toEqual([]);
    expect(REVIEWER_TOOLS).not.toContain("Write");
    expect(REVIEWER_TOOLS).not.toContain("Edit");
    for (const tool of REVIEWER_TOOLS) {
      expect(tool).not.toMatch(/push/i);
      expect(tool).not.toMatch(/\bgh\b/);
      if (tool.startsWith("Bash(")) expect(tool).toMatch(/^Bash\(git (diff|log|status|show):\*\)$/);
    }
  });

  test("STEWARD_TOOLS gh surface is exactly the read-only investigation verbs", () => {
    expect(forbiddenToolViolations(STEWARD_TOOLS)).toEqual([]);
    const gh = STEWARD_TOOLS.filter((t) => t.includes("gh"));
    expect(gh.length).toBeGreaterThan(0); // the steward DOES investigate via gh
    for (const tool of gh) {
      expect(tool).toMatch(/^Bash\(gh pr (view|diff|checks|list|status):\*\)$/);
    }
    // The mutations that must never appear, spelled out for the next editor.
    const joined = STEWARD_TOOLS.join(" ");
    expect(joined).not.toMatch(/merge|close|comment|api|issue|label|push/i);
  });
});

describe("runStage enforcement — the guard runs before any SDK spawn", () => {
  function recordingDeps(): StageDeps & { calls: number } {
    const deps = {
      calls: 0,
      query: (): AsyncIterable<unknown> => {
        deps.calls += 1;
        return (async function* (): AsyncGenerator<unknown> {
          yield { type: "result", subtype: "success", result: "should never run", total_cost_usd: 1, num_turns: 1 };
        })();
      },
      sleep: async (): Promise<void> => {},
    };
    return deps;
  }

  test("a forbidden grant fails the stage with zero spend and no SDK call", async () => {
    const deps = recordingDeps();
    const events: string[] = [];
    const r = await runStage("implementer", "prompt", {
      model: "sonnet", maxTurns: 5, budgetUsd: 5, deadlineMs: Date.now() + 60_000,
      allowedTools: ["Read", "Bash(gh api:*)"],
      onEvent: (e) => events.push(e.kind),
    }, deps);
    expect(r.error).toContain("forbidden tool grant");
    expect(r.error).toContain("Bash(gh api:*)");
    expect(r.costUsd).toBe(0);
    expect(r.turns).toBe(0);
    expect(deps.calls).toBe(0);                 // no money spent arming the worker
    expect(events).toEqual(["stage_finished"]); // surfaced to the UI like any stage error
    // Deterministic config error: must never be retried/failed-over.
    expect(isTransientStageError(r.error!)).toBe(false);
  });

  test("a wildcard git push grant is refused even alongside an otherwise-clean list", async () => {
    const deps = recordingDeps();
    const r = await runStage("fixer", "prompt", {
      model: "sonnet", maxTurns: 5, budgetUsd: 5, deadlineMs: Date.now() + 60_000,
      allowedTools: [...WRITER_BASH, "Bash(git push:*)"],
    }, deps);
    expect(r.error).toContain("git push");
    expect(deps.calls).toBe(0);
  });

  test("clean production allowlists still run", async () => {
    const deps = recordingDeps();
    const r = await runStage("implementer", "prompt", {
      model: "sonnet", maxTurns: 5, budgetUsd: 5, deadlineMs: Date.now() + 60_000,
      allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", ...WRITER_BASH],
    }, deps);
    expect(r.error).toBeUndefined();
    expect(deps.calls).toBe(1);
  });
});
