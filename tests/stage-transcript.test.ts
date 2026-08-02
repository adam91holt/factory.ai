// Issue #11 (stage_transcript half): full-fidelity per-stage audit transcript.
//
// What is pinned here, and why each pin is load-bearing:
//   1. CAPTURE-PER-KIND. runOneAttempt's message loop is the single choke point
//      every SDK message flows through; one row lands per message — system/init,
//      reasoning, assistant_text (FULL text), tool_use (FULL input — the events
//      stream keeps only a 160-char summary), tool_result (previously not
//      captured AT ALL), result — linked to issue_key + stage + session_id with
//      a monotone per-stage seq.
//   2. REDACTION AT WRITE. A planted secret in tool input/text/results never
//      reaches a stored row (same emit-time discipline as the events table).
//   3. BOUNDS ARE IN-CODE CONSTANTS. Body cap truncates WITH a marker; the
//      per-stage row cap turns the row at the cap into a visible kind:"cap"
//      marker and drops everything past it.
//   4. RETENTION. sweepStageTranscripts deletes ONLY stage_transcript rows
//      older than the window — the summary `events` stream is kept forever.
//   5. ADDITIVE. No issueKey → no rows; closed store → byte-identical stage
//      behaviour (same StageResult, same onEvent stream) with zero rows.
//   6. JSONB DISCIPLINE. Bodies land as native jsonb OBJECTS through the queue
//      (jsonb_typeof pin — issueTranscript's defensive double-parse would mask
//      a string-scalar regression; the real-driver leg of the same pin lives in
//      tests/store-parity-suite.ts).

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { runStage, type StageDeps } from "../src/agents.ts";
import { config } from "../src/config.ts";
import type { AgentStreamEvent } from "../src/events.ts";
import {
  openTestDatabase, closeTestDatabase, flushEvents,
  appendStageTranscript, issueTranscript, sweepStageTranscripts,
  maybeSweepStageTranscripts, testSetTranscriptSweepAt, testTranscriptSweepInFlight,
  testTranscriptQueueStats, MAX_QUEUED_TRANSCRIPT_BYTES,
  insertTestEvent, insertTestTranscriptRow, issueEvents, testTranscriptBodyTypes,
  TRANSCRIPT_BODY_CAP_BYTES, TRANSCRIPT_TRUNCATION_MARKER,
  TRANSCRIPT_MAX_ROWS_PER_STAGE, TRANSCRIPT_RETENTION_DAYS,
} from "../src/db.ts";

beforeEach(async () => { await openTestDatabase(); });
afterEach(async () => { await closeTestDatabase(); });

const SECRET = "sk-ant-plantedsecret0123456789abcdef";
const LONG_COMMAND = `bun test ${"tests/very-long-path-".repeat(20)}spec.ts`; // > 160 chars — past the event summary cap

type StageOptions = Parameters<typeof runStage>[2];
const baseOpts = (overrides: Partial<StageOptions> = {}): StageOptions => ({
  model: "sonnet",
  maxTurns: 10,
  budgetUsd: 5,
  deadlineMs: Date.now() + 5 * 60_000,
  ...overrides,
});

/** Fake SDK stream exercising every captured message kind, with a planted
 *  secret in each free-text surface. Same DI shape as agents-effort.test.ts. */
function fullDeps(): StageDeps {
  return {
    query: () => (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-11", model: "sonnet" };
      yield { type: "assistant", message: { content: [
        { type: "thinking", thinking: `reasoning with ${SECRET} inside` },
        { type: "text", text: `working on it, token ${SECRET}` },
        { type: "tool_use", id: "tu1", name: "Bash", input: { command: LONG_COMMAND, note: SECRET } },
      ] } };
      yield { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: `tool output ${SECRET}` }], is_error: false },
      ] } };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0.02, num_turns: 2 };
    })(),
    sleep: async () => {},
  };
}

describe("capture — one row per SDK message, every kind, fully linked", () => {
  test("system/reasoning/assistant_text/tool_use/tool_result/result all land, in order, with issue/stage/session/seq", async () => {
    const r = await runStage("implementer", "do it", baseOpts({ issueKey: "FAC-99" }), fullDeps());
    expect(r.error).toBeUndefined();

    const rows = await issueTranscript("FAC-99");
    expect(rows.map((x) => x.kind)).toEqual(["system", "reasoning", "assistant_text", "tool_use", "tool_result", "result"]);
    expect(rows.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const row of rows) {
      expect(row.issueKey).toBe("FAC-99");
      expect(row.stage).toBe("implementer");
      expect(row.sessionId).toBe("sess-11"); // bound before the init row is recorded
    }

    // FULL fidelity — not the 160-char event summary, not a 500-char snippet.
    const toolUse = rows[3]!;
    const input = toolUse.body.input as Record<string, unknown>;
    expect(input.command).toBe(LONG_COMMAND.replaceAll(SECRET, "[REDACTED-SECRET]"));
    expect((input.command as string).length).toBeGreaterThan(160);
    expect(toolUse.body.tool).toBe("Bash");
    expect(toolUse.body.id).toBe("tu1");

    // Tool RESULTS are captured (previously lost entirely).
    const toolResult = rows[4]!;
    expect(toolResult.body.toolUseId).toBe("tu1");
    const content = toolResult.body.content as Array<Record<string, unknown>>;
    expect(content[0]?.text).toBe("tool output [REDACTED-SECRET]");

    // The result row carries the full SDK result record.
    expect(rows[5]!.body.subtype).toBe("success");
    expect(rows[5]!.body.total_cost_usd).toBe(0.02);

    // Filtering by stage works (the (issue_key, stage, id) index surface).
    expect((await issueTranscript("FAC-99", "implementer")).length).toBe(6);
    expect((await issueTranscript("FAC-99", "reviewer-repo")).length).toBe(0);
  });

  test("bodies are native jsonb OBJECTS through the queue write path (never string scalars)", async () => {
    await runStage("implementer", "do it", baseOpts({ issueKey: "FAC-J" }), fullDeps());
    const types = await testTranscriptBodyTypes("FAC-J");
    expect(types.length).toBe(6);
    expect(types).toEqual(Array(6).fill("object"));
  });

  test("no issueKey → no transcript rows, and the stage is otherwise untouched", async () => {
    const r = await runStage("implementer", "do it", baseOpts(), fullDeps());
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("done");
    await flushEvents();
    expect((await issueTranscript("FAC-99")).length).toBe(0);
  });
});

describe("redaction — a planted secret never reaches a stored row", () => {
  test("every surface (reasoning, text, tool input, tool result) is redacted at write", async () => {
    await runStage("implementer", "do it", baseOpts({ issueKey: "FAC-RED" }), fullDeps());
    const rows = await issueTranscript("FAC-RED");
    expect(rows.length).toBe(6);
    let redactions = 0;
    for (const row of rows) {
      const serialized = JSON.stringify(row.body);
      expect(serialized).not.toContain(SECRET);
      if (serialized.includes("[REDACTED-SECRET]")) redactions += 1;
    }
    expect(redactions).toBeGreaterThanOrEqual(4); // reasoning, text, tool_use, tool_result
  });
});

describe("bounds — in-code constants, truncate with marker", () => {
  test("an oversized body is truncated to a marker object that itself fits the cap", async () => {
    const big = JSON.stringify({ kind: "blob", data: "x".repeat(TRANSCRIPT_BODY_CAP_BYTES + 40_000) });
    appendStageTranscript({ issueKey: "FAC-BIG", stage: "implementer", sessionId: null, seq: 1, kind: "tool_result", bodyJson: big });
    const rows = await issueTranscript("FAC-BIG");
    expect(rows.length).toBe(1);
    expect(rows[0]!.body.truncated).toBe(TRANSCRIPT_TRUNCATION_MARKER);
    expect(rows[0]!.body.originalBytes).toBe(Buffer.byteLength(big, "utf8"));
    expect(typeof rows[0]!.body.head).toBe("string");
    expect((rows[0]!.body.head as string).length).toBeGreaterThan(0); // a truncation keeps a head, not nothing
    expect(Buffer.byteLength(JSON.stringify(rows[0]!.body), "utf8")).toBeLessThanOrEqual(TRANSCRIPT_BODY_CAP_BYTES);
    // Still a queryable jsonb object, not a scalar.
    expect(await testTranscriptBodyTypes("FAC-BIG")).toEqual(["object"]);
  });

  test("a body at/under the cap is stored verbatim (no marker)", async () => {
    appendStageTranscript({ issueKey: "FAC-OK", stage: "implementer", sessionId: null, seq: 1, kind: "assistant_text", bodyJson: JSON.stringify({ text: "small" }) });
    const rows = await issueTranscript("FAC-OK");
    expect(rows[0]!.body).toEqual({ text: "small" });
  });

  test("per-stage row cap: the row AT the cap becomes a kind:'cap' marker; rows past it are dropped", async () => {
    for (let seq = 1; seq <= TRANSCRIPT_MAX_ROWS_PER_STAGE + 5; seq++) {
      appendStageTranscript({ issueKey: "FAC-CAP", stage: "implementer", sessionId: null, seq, kind: "assistant_text", bodyJson: JSON.stringify({ n: seq }) });
    }
    const rows = await issueTranscript("FAC-CAP", undefined, TRANSCRIPT_MAX_ROWS_PER_STAGE + 10);
    expect(rows.length).toBe(TRANSCRIPT_MAX_ROWS_PER_STAGE);
    expect(rows[rows.length - 2]!.kind).toBe("assistant_text"); // last real row
    const capRow = rows[rows.length - 1]!;
    expect(capRow.seq).toBe(TRANSCRIPT_MAX_ROWS_PER_STAGE);
    expect(capRow.kind).toBe("cap");
    expect(capRow.body.truncated).toBe(TRANSCRIPT_TRUNCATION_MARKER);
  });
});

describe("retention sweep — deletes ONLY old transcript rows, events stay forever", () => {
  test("rows older than the window go; recent transcript rows and ALL events survive", async () => {
    const oldAt = Date.now() - (TRANSCRIPT_RETENTION_DAYS + 10) * 86_400_000;
    await insertTestTranscriptRow("FAC-OLD", "implementer", "tool_use", { tool: "Bash" }, oldAt);
    await insertTestTranscriptRow("FAC-OLD", "implementer", "result", { ok: true }); // now — inside the window
    await insertTestEvent("run_finished", { issueKey: "FAC-OLD", outcome: "pr_open" }, oldAt);

    const deleted = await sweepStageTranscripts();
    expect(deleted).toBe(1);

    const rows = await issueTranscript("FAC-OLD");
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("result");
    // The summary events stream is untouched — even rows older than the window.
    expect((await issueEvents("FAC-OLD")).length).toBe(1);
    // Idempotent: nothing left to sweep.
    expect(await sweepStageTranscripts()).toBe(0);
  });
});

describe("additive — closed store changes NOTHING except that no rows land", () => {
  test("append on a closed store is a quiet no-op (never throws, never queues)", async () => {
    await closeTestDatabase();
    expect(() => appendStageTranscript({ issueKey: "FAC-X", stage: "s", sessionId: null, seq: 1, kind: "system", bodyJson: "{}" })).not.toThrow();
    await openTestDatabase(); // truncates; also proves nothing was queued to leak in
    await flushEvents();
    expect((await issueTranscript("FAC-X")).length).toBe(0);
  });

  test("runStage on a closed store: byte-identical StageResult and onEvent stream vs an open store", async () => {
    const run = async (): Promise<{ result: unknown; events: AgentStreamEvent[] }> => {
      const events: AgentStreamEvent[] = [];
      const result = await runStage("implementer", "do it",
        baseOpts({ issueKey: "FAC-SAME", onEvent: (e) => events.push(e) }), fullDeps());
      return { result: { ...result, wallSeconds: 0 }, events };
    };
    const open = await run();
    expect((await issueTranscript("FAC-SAME")).length).toBe(6); // capture happened on the open store
    await closeTestDatabase();
    const closed = await run(); // same stage, store closed — must not throw, must not differ
    expect(closed.result).toEqual(open.result);
    expect(closed.events).toEqual(open.events);
    await openTestDatabase();
  });
});

// ---------------------------------------------------------------------------
// Review-fix pins (issue #11 close-out).
// ---------------------------------------------------------------------------

const rowFor = (issueKey: string, seq: number, kind: string, bodyJson: string) =>
  ({ issueKey, stage: "implementer", sessionId: null, seq, kind, bodyJson });

describe("jsonb safety - a lone UTF-16 surrogate can never poison an INSERT batch", () => {
  test("a body with a lone surrogate lands as a CLEANED row and its neighbors always persist", async () => {
    // Lone surrogates arise organically: a tool result truncated mid-emoji.
    // JSON.stringify escapes the unpaired unit to \udXXX, which Postgres
    // jsonb REJECTS - before the scrub, this row poisoned its whole batch.
    appendStageTranscript(rowFor("FAC-SUR", 1, "assistant_text", JSON.stringify({ text: "before" })));
    appendStageTranscript(rowFor("FAC-SUR", 2, "tool_result",
      JSON.stringify({ text: "emoji cut mid-pair: \uD83D", ["k\uDC00ey"]: "v" })));
    appendStageTranscript(rowFor("FAC-SUR", 3, "result", JSON.stringify({ text: "after" })));

    const rows = await issueTranscript("FAC-SUR");
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]); // nobody dropped
    expect(rows[1]!.body.text).toBe("emoji cut mid-pair: "); // surrogate stripped, value kept
    expect(rows[1]!.body.key).toBe("v"); // keys are scrubbed too (jsonb rejects them anywhere)
    expect(await testTranscriptBodyTypes("FAC-SUR")).toEqual(["object", "object", "object"]);
  });

  test("defense in depth: a row the engine still rejects drops ALONE - batch neighbors persist", async () => {
    await closeTestDatabase();
    await openTestDatabase({ failTranscriptRowContaining: "POISON-MARKER" });
    // Row 1 flushes solo (first drain pass); rows 2+3 land in ONE batch where
    // row 2 is rejected by the engine every time - batch, retry, AND per-row.
    appendStageTranscript(rowFor("FAC-PB", 1, "assistant_text", JSON.stringify({ text: "good one" })));
    appendStageTranscript(rowFor("FAC-PB", 2, "tool_result", JSON.stringify({ text: "POISON-MARKER" })));
    appendStageTranscript(rowFor("FAC-PB", 3, "result", JSON.stringify({ text: "good two" })));

    const rows = await issueTranscript("FAC-PB");
    expect(rows.map((r) => r.seq)).toEqual([1, 3]); // only the poisoned row is lost
  });
});

describe("retention sweep is WIRED - a daily watermark, checked where writes already flow", () => {
  test("stale watermark + one append => the sweep runs; inside the interval it never re-runs", async () => {
    const oldAt = Date.now() - (TRANSCRIPT_RETENTION_DAYS + 10) * 86_400_000;
    await insertTestTranscriptRow("FAC-WIRE", "implementer", "tool_use", { tool: "Bash" }, oldAt);
    testSetTranscriptSweepAt(Date.now() - 86_400_000 - 1); // > TRANSCRIPT_SWEEP_INTERVAL_MS ago
    appendStageTranscript(rowFor("FAC-WIRE", 1, "result", JSON.stringify({ ok: true })));

    expect(await testTranscriptSweepInFlight()).toBe(1); // the old row, nothing else
    // The watermark advanced BEFORE the async work - inside the interval the
    // trigger is a no-op, so appends can never stack daily sweeps.
    expect(maybeSweepStageTranscripts()).toBeNull();

    const rows = await issueTranscript("FAC-WIRE");
    expect(rows.length).toBe(1); // the fresh append survived the sweep
    expect(rows[0]!.body.ok).toBe(true);
  });

  test("wiring pin: startEventStore and appendStageTranscript both check the watermark", () => {
    // TRANSCRIPT_RETENTION_DAYS is only a bound if something enforces it: the
    // daemon has no dedicated scheduler, so the sweep trigger must live on the
    // paths that always run - store open (restart/idle) and the append hot
    // path (working daemon). An unwired sweep is dead code and this regresses.
    const src = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
    const between = (from: string, to: string): string => {
      const a = src.indexOf(from), b = src.indexOf(to);
      expect(a).toBeGreaterThan(-1);
      expect(b).toBeGreaterThan(a);
      return src.slice(a, b);
    };
    expect(between("export async function startEventStore", "export function eventStoreOpen"))
      .toContain("maybeSweepStageTranscripts()");
    expect(between("export function appendStageTranscript", "export interface TranscriptRow"))
      .toContain("maybeSweepStageTranscripts()");
  });
});

describe("queue OOM guard - bounded by BYTES, not just rows", () => {
  test("past the byte budget, rows DROP instead of ballooning the heap during an outage", () => {
    // One shared 60KB body string: the queue stores references, so this test
    // is fast - but the accounting sees ~60KB per row, exactly like a real
    // outage with large tool results streaming in.
    const body = JSON.stringify({ data: "x".repeat(60_000) });
    const perRow = Buffer.byteLength(body, "utf8");
    const appended = Math.ceil(MAX_QUEUED_TRANSCRIPT_BYTES / perRow) + 20;
    for (let seq = 1; seq <= appended; seq++) {
      appendStageTranscript(rowFor("FAC-BYTES", seq, "tool_result", body));
    }
    const stats = testTranscriptQueueStats();
    expect(stats.bytes).toBeLessThanOrEqual(MAX_QUEUED_TRANSCRIPT_BYTES); // the budget HELD
    expect(stats.dropped).toBeGreaterThan(0); // overflow dropped (loudly), not queued
    expect(stats.rows).toBeLessThan(appended);
    expect(stats.rows).toBeGreaterThan(0); // ...but the budget admits real work first
  });
});

describe("redaction covers object KEYS, not just values", () => {
  test("a secret used as a property NAME (and a NUL in a key) never reaches the stored row", async () => {
    const deps: StageDeps = {
      query: () => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-k", model: "sonnet" };
        yield { type: "assistant", message: { content: [
          { type: "tool_use", id: "tk1", name: "Bash", input: { [SECRET]: "v", ["nul\u0000key"]: "w" } },
        ] } };
        yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01, num_turns: 1 };
      })(),
      sleep: async () => {},
    };
    const r = await runStage("implementer", "do it", baseOpts({ issueKey: "FAC-KEY" }), deps);
    expect(r.error).toBeUndefined();

    const rows = await issueTranscript("FAC-KEY");
    const toolUse = rows.find((x) => x.kind === "tool_use");
    expect(toolUse).toBeDefined();
    const serialized = JSON.stringify(toolUse!.body);
    expect(serialized).not.toContain(SECRET);
    const input = toolUse!.body.input as Record<string, unknown>;
    expect(input["[REDACTED-SECRET]"]).toBe("v"); // key redacted, entry kept
    expect(input.nulkey).toBe("w"); // NUL stripped from the key (jsonb rejects it anywhere)
  });
});

describe("kill switch - FACTORY_TRANSCRIPT=0 disables capture without touching the stage", () => {
  test("flag off => zero rows and a byte-identical StageResult + onEvent stream", async () => {
    const run = async (issueKey: string): Promise<{ result: unknown; events: AgentStreamEvent[] }> => {
      const events: AgentStreamEvent[] = [];
      const result = await runStage("implementer", "do it",
        baseOpts({ issueKey, onEvent: (e) => events.push(e) }), fullDeps());
      return { result: { ...result, wallSeconds: 0 }, events };
    };
    const on = await run("FAC-FLAG-ON");
    expect((await issueTranscript("FAC-FLAG-ON")).length).toBe(6); // capture works when enabled
    config.transcriptEnabled = false;
    try {
      const off = await run("FAC-FLAG-OFF");
      expect((await issueTranscript("FAC-FLAG-OFF")).length).toBe(0); // zero rows
      expect(off.result).toEqual(on.result); // additive-off: stage untouched
      expect(off.events).toEqual(on.events);
    } finally {
      config.transcriptEnabled = true;
    }
  });
});
