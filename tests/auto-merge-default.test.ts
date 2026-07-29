import { describe, expect, test } from "bun:test";
import { effectiveMergeTier, decideMerge, type MergeEvidence } from "../src/merge-ladder.ts";

// Auto-merge-by-default (AUTO_MERGE_DEFAULT). The tier flip changes ONLY the
// default; decideMerge still enforces every SAFETY condition. These tests prove
// both halves: the tier resolution AND that "auto" tier never merges an unsafe task.

describe("effectiveMergeTier — auto-merge default + human-review opt-out", () => {
  test("autoDefault ON, un-enrolled non-self repo → auto", () => {
    expect(effectiveMergeTier("acme/widgets", null, { autoDefault: true })).toBe("auto");
  });
  test("autoDefault OFF → human (unchanged legacy behavior)", () => {
    expect(effectiveMergeTier("acme/widgets", null, { autoDefault: false })).toBe("human");
    expect(effectiveMergeTier("acme/widgets", null)).toBe("human");
  });
  test("self-repo is ALWAYS human, even with autoDefault ON", () => {
    // isSelfRepo matches config.selfRepo OR any '.../factory'
    expect(effectiveMergeTier("acme/factory", null, { autoDefault: true })).toBe("human");
  });
  test("human-review opt-out forces human, even with autoDefault ON", () => {
    expect(effectiveMergeTier("acme/widgets", null, { autoDefault: true, humanReview: true })).toBe("human");
  });
});

describe("decideMerge — auto tier NEVER merges an unsafe task (safety unchanged)", () => {
  const AUTO = "auto" as const;
  const OPTS = { lowRiskMaxDiff: 40 };
  const clean: MergeEvidence = { green: true, strength: "strong", guarded: false, needsHuman: false, security: "pass", browser: "pass", diffLines: 10 };

  test("a fully clean task at auto tier DOES merge (act=true)", () => {
    expect(decideMerge(AUTO, clean, OPTS).act).toBe(true);
  });
  test("security FAIL → never acts", () => {
    expect(decideMerge(AUTO, { ...clean, security: "fail" }, OPTS).act).toBe(false);
  });
  test("guarded paths touched → never acts", () => {
    expect(decideMerge(AUTO, { ...clean, guarded: true }, OPTS).act).toBe(false);
  });
  test("needsHuman fold (taste/tester/test-deletion) → never acts", () => {
    expect(decideMerge(AUTO, { ...clean, needsHuman: true }, OPTS).act).toBe(false);
  });
  test("gates not green → never acts", () => {
    expect(decideMerge(AUTO, { ...clean, green: false }, OPTS).act).toBe(false);
  });
  test("gate strength not strong → never acts", () => {
    expect(decideMerge(AUTO, { ...clean, strength: "real" }, OPTS).act).toBe(false);
  });
  test("browser evidence failed/missing → never acts", () => {
    expect(decideMerge(AUTO, { ...clean, browser: "fail" }, OPTS).act).toBe(false);
    expect(decideMerge(AUTO, { ...clean, browser: "missing" }, OPTS).act).toBe(false);
  });
});
