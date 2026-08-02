import { describe, expect, test } from "bun:test";
import {
  attachEqual, parsePin, parseProjectsInput, pinLabel, toggleEntry,
  type NormalizedAttach,
} from "../ui/src/lib/registers.ts";
import { applyEvent as uiApplyEvent, emptyMission } from "../ui/src/lib/store.ts";
import type { FactoryEvent as UiFactoryEvent } from "../ui/src/lib/events.ts";
import { applyEvent as daemonApplyEvent } from "../src/server.ts";
import type { FactoryEvent } from "../src/events.ts";

// The register UI's pure logic (issue #16 WP3): the pin display grammar the
// stage ledger renders, the attach-editor state helpers, and — the lockstep-
// critical piece — BOTH reducers (daemon src/server.ts and ui store) folding
// run_stage_started's card/skills version pins into the StageView identically,
// including the additive guarantee that pre-pinning events fold with the
// fields absent (old history replays byte-identically).

describe("parsePin / pinLabel — the name@version grammar", () => {
  test("parses well-formed pins; version 0 is the file fallback", () => {
    expect(parsePin("implementer@3")).toEqual({ name: "implementer", version: 3 });
    expect(parsePin("implementer@0")).toEqual({ name: "implementer", version: 0 });
    expect(parsePin("has@at@2")).toEqual({ name: "has@at", version: 2 });
  });

  test("rejects malformed pins instead of guessing", () => {
    for (const bad of ["", "noversion", "@3", "name@", "name@x", "name@-1", "name@1.5"]) {
      expect(parsePin(bad)).toBeNull();
    }
  });

  test("pinLabel renders v0 as ·file so a 0 never reads like a register version", () => {
    expect(pinLabel("implementer@0")).toBe("implementer·file");
    expect(pinLabel("implementer@4")).toBe("implementer@v4");
    expect(pinLabel("garbage")).toBe("garbage"); // defensive passthrough
  });
});

describe("attach editor state helpers", () => {
  test("toggleEntry adds when absent, removes when present, never mutates", () => {
    const base = ["implementer"];
    expect(toggleEntry(base, "fixer")).toEqual(["implementer", "fixer"]);
    expect(toggleEntry(base, "implementer")).toEqual([]);
    expect(base).toEqual(["implementer"]);
  });

  test("parseProjectsInput splits on commas/whitespace, trims, dedupes, keeps order", () => {
    expect(parseProjectsInput("acme/kiwi, other-repo acme/kiwi\n third")).toEqual(["acme/kiwi", "other-repo", "third"]);
    expect(parseProjectsInput("   ")).toEqual([]);
  });

  test("attachEqual is order-insensitive per key and keys are independent", () => {
    const a: NormalizedAttach = { roles: ["a", "b"], projects: [], match: ["ui"] };
    expect(attachEqual(a, { roles: ["b", "a"], projects: [], match: ["ui"] })).toBe(true);
    expect(attachEqual(a, { roles: ["a"], projects: [], match: ["ui"] })).toBe(false);
    expect(attachEqual(a, { roles: ["a", "b"], projects: ["p"], match: ["ui"] })).toBe(false);
  });
});

describe("run_stage_started version pins fold into StageView — both reducers, in lockstep", () => {
  const started = (extra: Record<string, unknown>): { seq: number; at: number; type: "run_stage_started"; issueKey: string; stage: string; model: string; viaProxy: boolean } & Record<string, unknown> => ({
    seq: 1, at: 1000, type: "run_stage_started", issueKey: "FAC-9", stage: "implementer",
    model: "claude", viaProxy: false, ...extra,
  });

  test("card + skills land on the stage; both reducers agree field-for-field", () => {
    const e = started({ card: "implementer@3", skills: ["factory-design@2"] });
    const ui = uiApplyEvent(emptyMission(), e as UiFactoryEvent);
    const daemon = daemonApplyEvent(
      { seq: 0, daemon: null, board: [], boardAt: null, runs: {}, needsHuman: [] },
      e as FactoryEvent,
    );
    const uiStage = ui.runs["FAC-9"]?.stages[0];
    const daemonStage = daemon.runs["FAC-9"]?.stages[0];
    expect(uiStage?.card).toBe("implementer@3");
    expect(uiStage?.skills).toEqual(["factory-design@2"]);
    expect(daemonStage).toEqual(uiStage);
  });

  test("a pre-pinning event (no card/skills) folds with the fields ABSENT — old history replays unchanged", () => {
    const e = started({});
    const ui = uiApplyEvent(emptyMission(), e as UiFactoryEvent);
    const stage = ui.runs["FAC-9"]?.stages[0];
    expect(stage).toBeDefined();
    expect(Object.keys(stage ?? {})).not.toContain("card");
    expect(Object.keys(stage ?? {})).not.toContain("skills");
  });
});
