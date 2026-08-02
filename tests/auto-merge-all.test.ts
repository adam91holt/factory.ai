import { describe, expect, test } from "bun:test";
import { effectiveMergeTier, decideMerge, type MergeEvidence } from "../src/merge-ladder.ts";

// AUTO_MERGE_ALL — the operator's blanket override. Two effects, both pinned
// here: (1) tier resolves to "auto" for every non-self repo, INCLUDING
// ladder-enrolled ones held at shadow; (2) the decideMerge evidence floor drops
// to "real" (unit tests, no e2e requirement). Every OTHER safety condition is
// proven unchanged — the override widens WHO may merge and the strength floor,
// never what counts as safe.

describe("effectiveMergeTier — AUTO_MERGE_ALL override", () => {
  test("un-enrolled non-self repo → auto", () => {
    expect(effectiveMergeTier("acme/widgets", null, { overrideAll: true })).toBe("auto");
  });
  test("beats ladder enrollment: an enrolled repo still earning at shadow → auto", () => {
    const earned = { repo: "acme/widgets", tier: "shadow" as const, cleanStreak: 3, totalShadow: 3 };
    expect(effectiveMergeTier("acme/widgets", earned, { overrideAll: true })).toBe("auto");
  });
  test("self-repo is ALWAYS human — the override cannot touch it", () => {
    expect(effectiveMergeTier("acme/factory", null, { overrideAll: true })).toBe("human");
  });
  test("an epic's merge:review withhold still wins over the override", () => {
    expect(effectiveMergeTier("acme/widgets", null, { overrideAll: true, humanReview: true })).toBe("human");
  });
  test("override OFF → behavior unchanged (human default)", () => {
    expect(effectiveMergeTier("acme/widgets", null, { overrideAll: false })).toBe("human");
  });
});

describe("decideMerge — minStrength 'real' floor (the AUTO_MERGE_ALL leg)", () => {
  const AUTO = "auto" as const;
  const RELAXED = { lowRiskMaxDiff: 40, minStrength: "real" as const };
  const clean: MergeEvidence = { green: true, strength: "real", guarded: false, needsHuman: false, security: "pass", browser: "not-required", diffLines: 10 };

  test("green + strength 'real' now merges (the strong requirement was the only blocker)", () => {
    const d = decideMerge(AUTO, clean, RELAXED);
    expect(d.wouldMerge).toBe(true);
    expect(d.act).toBe(true);
  });
  test("'strong' evidence still merges under the relaxed floor", () => {
    expect(decideMerge(AUTO, { ...clean, strength: "strong" }, RELAXED).act).toBe(true);
  });
  test("'weak'/'none' still refused — the floor is real, not gone", () => {
    expect(decideMerge(AUTO, { ...clean, strength: "weak" }, RELAXED).act).toBe(false);
    expect(decideMerge(AUTO, { ...clean, strength: "none" }, RELAXED).act).toBe(false);
  });
  test("default floor is unchanged 'strong' when minStrength is omitted", () => {
    expect(decideMerge(AUTO, clean, { lowRiskMaxDiff: 40 }).act).toBe(false);
    expect(decideMerge(AUTO, clean, { lowRiskMaxDiff: 40 }).reasons).toContain("gate strength real (need strong)");
  });

  test("every other safety condition survives the relaxed floor", () => {
    expect(decideMerge(AUTO, { ...clean, green: false }, RELAXED).act).toBe(false);
    expect(decideMerge(AUTO, { ...clean, guarded: true }, RELAXED).act).toBe(false);
    expect(decideMerge(AUTO, { ...clean, needsHuman: true }, RELAXED).act).toBe(false);
    expect(decideMerge(AUTO, { ...clean, security: "fail" }, RELAXED).act).toBe(false);
    expect(decideMerge(AUTO, { ...clean, browser: "fail" }, RELAXED).act).toBe(false);
    expect(decideMerge(AUTO, { ...clean, browser: "missing" }, RELAXED).act).toBe(false);
  });
  test("shadow tier with the relaxed floor still only RECORDS (tier gating unchanged)", () => {
    const d = decideMerge("shadow", clean, RELAXED);
    expect(d.wouldMerge).toBe(true);
    expect(d.act).toBe(false);
  });
});
