import { describe, expect, test } from "bun:test";
import { abortIssueStages, isTransientStageError, runStage, CLAIM_LOST, type StageDeps } from "../src/agents.ts";
import { claimLossSweep, type LiveClaimView } from "../src/reconcile.ts";

// Mid-stage claim re-verification (fix-list #6). Live repro 2026-08-02: FAC-64
// was moved to Done mid-implementer and the stage kept burning until its next
// mutating-step stillOurs check. These tests pin the three pieces of the fix:
// the pure debounced sweep decision, the per-issue abort surface, and the
// never-retry classification of the resulting stage error.

const EXEC = "Factory-Executing";
const view = (labels: string[], stateType = "started"): LiveClaimView => ({ labels, stateType });

describe("claimLossSweep — debounced over two consecutive passes", () => {
  test("healthy in-flight issues are never warned or aborted", () => {
    const pending = new Set<string>();
    const r = claimLossSweep(new Set(["FAC-1"]), new Map([["FAC-1", view([EXEC])]]), pending);
    expect(r).toEqual({ abort: [], warn: [] });
    expect(pending.size).toBe(0);
  });

  test("first suspicious pass WARNS only — a stale Linear read must not kill a paid run", () => {
    const pending = new Set<string>();
    const r = claimLossSweep(new Set(["FAC-1"]), new Map(), pending); // absent from started fetch
    expect(r.warn).toEqual(["FAC-1"]);
    expect(r.abort).toEqual([]);
    expect(pending.has("FAC-1")).toBe(true);
  });

  test("second consecutive suspicious pass ABORTS (the FAC-64 repro: moved to Done mid-stage)", () => {
    const pending = new Set<string>(["FAC-1"]);
    const r = claimLossSweep(new Set(["FAC-1"]), new Map(), pending);
    expect(r.abort).toEqual(["FAC-1"]);
    expect(pending.has("FAC-1")).toBe(false); // consumed — a re-loss starts a fresh debounce
  });

  test("recovery between passes clears the debounce — no abort on a transient blip", () => {
    const pending = new Set<string>(["FAC-1"]);
    const r = claimLossSweep(new Set(["FAC-1"]), new Map([["FAC-1", view([EXEC])]]), pending);
    expect(r).toEqual({ abort: [], warn: [] });
    expect(pending.size).toBe(0);
  });

  test("a stripped executing label counts as loss even while the state is still started", () => {
    const pending = new Set<string>();
    const r = claimLossSweep(new Set(["FAC-1"]), new Map([["FAC-1", view([])]]), pending);
    expect(r.warn).toEqual(["FAC-1"]);
  });

  test("a non-started state counts as loss even with the label intact", () => {
    const pending = new Set<string>();
    const r = claimLossSweep(new Set(["FAC-1"]), new Map([["FAC-1", view([EXEC], "completed")]]), pending);
    expect(r.warn).toEqual(["FAC-1"]);
  });

  test("keys that left the in-flight set are purged from the debounce memory", () => {
    const pending = new Set<string>(["FAC-GONE"]);
    claimLossSweep(new Set(["FAC-2"]), new Map([["FAC-2", view([EXEC])]]), pending);
    expect(pending.has("FAC-GONE")).toBe(false);
  });
});

describe("abortIssueStages — aborts exactly one issue's stages", () => {
  // A fake SDK whose stage hangs until its AbortController fires — the shape
  // of a long implementer mid-flight.
  function hangingDeps(): StageDeps {
    return {
      query: (params) => {
        const abort = (params.options as { abortController: AbortController }).abortController;
        return (async function* (): AsyncGenerator<unknown> {
          yield { type: "system", subtype: "init", session_id: "s" };
          await new Promise((_, reject) => {
            abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
          });
        })();
      },
      sleep: async () => {},
    };
  }

  const opts = { model: "sonnet", maxTurns: 5, budgetUsd: 1, deadlineMs: Date.now() + 60_000 };

  test("the matching issue's stage fails with the CLAIM_LOST prefix; other issues are untouched", async () => {
    const victim = runStage("implementer", "p", { ...opts, issueKey: "FAC-7" }, hangingDeps());
    const bystander = runStage("implementer", "p", { ...opts, issueKey: "FAC-8" }, hangingDeps());
    await new Promise((r) => setTimeout(r, 20)); // let both stages register
    const aborted = abortIssueStages("FAC-7", "test: human moved the ticket");
    expect(aborted).toEqual(["implementer"]);
    const result = await victim;
    expect(result.error ?? "").toContain(CLAIM_LOST);
    // The bystander is still in flight — release it via its own abort.
    expect(abortIssueStages("FAC-8", "cleanup")).toEqual(["implementer"]);
    await bystander;
  });

  test("an issue with nothing in flight aborts nothing", () => {
    expect(abortIssueStages("FAC-NONE", "noop")).toEqual([]);
  });
});

describe("claim-lost is never transient — a lost claim must not retry or fail over", () => {
  test("the exact error shape runStage produces", () => {
    expect(isTransientStageError(`${CLAIM_LOST}: issue left In Progress (confirmed across two reconcile passes)`)).toBe(false);
  });
});
