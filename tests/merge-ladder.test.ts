import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  decideMerge, advanceLadder, isSelfRepo, effectiveMergeTier, buildMergeEvidence, isEnrolled,
  type LadderState, type MergeEvidence,
} from "../src/merge-ladder.ts";
import { getLadderState, recordShadowDecision, openTestDatabase, closeTestDatabase } from "../src/db.ts";
import { config } from "../src/config.ts";

// A fully-clean evidence bundle — every gate strong and green, nothing held.
const CLEAN: MergeEvidence = {
  green: true, strength: "strong", guarded: false, needsHuman: false,
  security: "pass", browser: "pass", diffLines: 10,
};
const OPTS = { lowRiskMaxDiff: 40 };

describe("decideMerge — tier gating", () => {
  test("shadow tier: wouldMerge can be true but act is ALWAYS false", () => {
    const d = decideMerge("shadow", CLEAN, OPTS);
    expect(d.wouldMerge).toBe(true);
    expect(d.act).toBe(false);
  });

  test("human tier: act is false even on a clean bundle", () => {
    expect(decideMerge("human", CLEAN, OPTS).act).toBe(false);
  });

  test("auto tier: acts on a clean, strong, unguarded bundle", () => {
    const d = decideMerge("auto", CLEAN, OPTS);
    expect(d.wouldMerge).toBe(true);
    expect(d.act).toBe(true);
  });

  test("auto tier acts only with security != fail and browser in {pass, not-required}", () => {
    expect(decideMerge("auto", { ...CLEAN, security: null }, OPTS).act).toBe(true);
    expect(decideMerge("auto", { ...CLEAN, browser: "not-required" }, OPTS).act).toBe(true);
    expect(decideMerge("auto", { ...CLEAN, security: "fail" }, OPTS).act).toBe(false);
    expect(decideMerge("auto", { ...CLEAN, browser: "partial" }, OPTS).wouldMerge).toBe(true); // partial does not block
  });
});

describe("decideMerge — each blocker sets wouldMerge=false with a matching reason", () => {
  const blocked = (ev: Partial<MergeEvidence>, needle: RegExp) => {
    const d = decideMerge("auto", { ...CLEAN, ...ev }, OPTS);
    expect(d.wouldMerge).toBe(false);
    expect(d.act).toBe(false);
    expect(d.reasons.some((r) => needle.test(r))).toBe(true);
  };

  test("not green", () => blocked({ green: false }, /green/i));
  test("guarded paths", () => blocked({ guarded: true }, /guarded/i));
  test("needs human", () => blocked({ needsHuman: true }, /human/i));
  test("security fail", () => blocked({ security: "fail" }, /security/i));
  test("browser fail", () => blocked({ browser: "fail" }, /browser/i));
  test("browser missing", () => blocked({ browser: "missing" }, /missing/i));
  test("strength real (not strong)", () => blocked({ strength: "real" }, /strength/i));
});

describe("decideMerge — auto-low-risk diff cap", () => {
  test("acts when diffLines <= lowRiskMaxDiff", () => {
    expect(decideMerge("auto-low-risk", { ...CLEAN, diffLines: 40 }, OPTS).act).toBe(true);
  });
  test("blocks when diffLines > lowRiskMaxDiff (wouldMerge stays true)", () => {
    const d = decideMerge("auto-low-risk", { ...CLEAN, diffLines: 41 }, OPTS);
    expect(d.wouldMerge).toBe(true);
    expect(d.act).toBe(false);
    expect(d.reasons.some((r) => /low-risk cap/i.test(r))).toBe(true);
  });
});

describe("decideMerge — construction: no ticket/description input", () => {
  test("the signature is (tier, evidence, opts) — untrusted text cannot reach it", () => {
    // decideMerge takes exactly three params; none is a ticket/description. This
    // is a compile-anchored guarantee — if a description arg were ever added the
    // arity check here would need editing, forcing a review of that decision.
    expect(decideMerge.length).toBe(3);
  });
});

describe("advanceLadder — earning transition", () => {
  const shadow: LadderState = { repo: "acme/w", tier: "shadow", cleanStreak: 0, totalShadow: 0 };
  const PROMOTE = { promoteAfter: 3, ceiling: "auto" as const };

  test("clean streak increments on a would-merge decision", () => {
    const s = advanceLadder(shadow, true, PROMOTE);
    expect(s.cleanStreak).toBe(1);
    expect(s.totalShadow).toBe(1);
    expect(s.tier).toBe("shadow");
  });

  test("a dirty decision resets the streak to 0 (but still counts as shadow)", () => {
    const s = advanceLadder({ ...shadow, cleanStreak: 2 }, false, PROMOTE);
    expect(s.cleanStreak).toBe(0);
    expect(s.totalShadow).toBe(1);
    expect(s.tier).toBe("shadow");
  });

  test("promotes shadow → auto-low-risk exactly at promoteAfter, resetting the streak", () => {
    const s = advanceLadder({ ...shadow, cleanStreak: 2 }, true, PROMOTE); // 2 + 1 === 3
    expect(s.tier).toBe("auto-low-risk");
    expect(s.cleanStreak).toBe(0);
  });

  test("does not promote one shy of promoteAfter", () => {
    const s = advanceLadder({ ...shadow, cleanStreak: 1 }, true, PROMOTE);
    expect(s.tier).toBe("shadow");
    expect(s.cleanStreak).toBe(2);
  });

  test("never promotes past a ceiling below auto-low-risk", () => {
    const s = advanceLadder({ ...shadow, cleanStreak: 2 }, true, { promoteAfter: 3, ceiling: "shadow" });
    expect(s.tier).toBe("shadow");
  });

  test("NEVER auto-promotes auto-low-risk → auto (human raises the ceiling)", () => {
    const alr: LadderState = { repo: "acme/w", tier: "auto-low-risk", cleanStreak: 99, totalShadow: 99 };
    const s = advanceLadder(alr, true, PROMOTE);
    expect(s.tier).toBe("auto-low-risk");
  });
});

describe("isSelfRepo + effectiveMergeTier — the unconditional human gate", () => {
  test("any */factory repo is the self-repo", () => {
    expect(isSelfRepo("adam/factory")).toBe(true);
    expect(isSelfRepo("acme/widgets")).toBe(false);
  });

  test("effectiveMergeTier(*/factory) is human even with an earned auto state + would-be ceiling", () => {
    const earnedAuto: LadderState = { repo: "adam/factory", tier: "auto", cleanStreak: 999, totalShadow: 999 };
    expect(effectiveMergeTier("adam/factory", earnedAuto)).toBe("human");
  });

  test("a repo not enrolled anywhere resolves to human", () => {
    expect(effectiveMergeTier("acme/widgets", null)).toBe("human");
  });
});

describe("buildMergeEvidence — external browser evidence lifts real → strong", () => {
  test("real gate summary + browser pass ⇒ strong", () => {
    const ev = buildMergeEvidence({ summary: { green: true, strength: "real" }, guarded: [], needsHuman: false, security: "pass", browser: "pass", diffLines: 5 });
    expect(ev.strength).toBe("strong");
  });
  test("real gate summary + browser not-required stays real (no unearned lift)", () => {
    const ev = buildMergeEvidence({ summary: { green: true, strength: "real" }, guarded: [], needsHuman: false, security: null, browser: "not-required", diffLines: 5 });
    expect(ev.strength).toBe("real");
  });
  test("guarded paths array folds to a boolean", () => {
    const ev = buildMergeEvidence({ summary: { green: true, strength: "strong" }, guarded: ["src/x"], needsHuman: false, security: null, browser: "pass", diffLines: 5 });
    expect(ev.guarded).toBe(true);
  });
});

describe("recordShadowDecision — persistence + earning (in-memory sqlite)", () => {
  afterEach(() => closeTestDatabase());

  const cleanDecision = decideMerge("shadow", CLEAN, OPTS);
  const dirtyDecision = decideMerge("shadow", { ...CLEAN, green: false }, OPTS);

  // These tests exercise the pure earning-transition WIRING (advanceLadder +
  // persistence), not the B9 enrollment gate below — so the repos they use are
  // enrolled up front, exactly as a human would opt a repo in before any of
  // this could run for real.
  const ENROLLED_TEST_REPOS = ["acme/ladder-a", "acme/ladder-b", "acme/closed"];
  beforeAll(() => { config.mergeLadder.enrolled.push(...ENROLLED_TEST_REPOS); });
  afterAll(() => {
    config.mergeLadder.enrolled = config.mergeLadder.enrolled.filter((r) => !ENROLLED_TEST_REPOS.includes(r));
  });

  test("N clean decisions promote the persisted tier shadow → auto-low-risk", () => {
    openTestDatabase();
    const repo = "acme/ladder-a";
    const N = config.mergeLadder.promoteAfter;
    let state: LadderState | null = null;
    for (let i = 0; i < N; i++) state = recordShadowDecision(repo, `FAC-${i}`, cleanDecision, CLEAN);
    expect(state?.tier).toBe("auto-low-risk");
    expect(getLadderState(repo)?.tier).toBe("auto-low-risk");
  });

  test("one dirty decision resets the streak", () => {
    openTestDatabase();
    const repo = "acme/ladder-b";
    recordShadowDecision(repo, "FAC-1", cleanDecision, CLEAN);
    recordShadowDecision(repo, "FAC-2", cleanDecision, CLEAN);
    expect(getLadderState(repo)?.cleanStreak).toBe(2);
    const after = recordShadowDecision(repo, "FAC-3", dirtyDecision, { ...CLEAN, green: false });
    expect(after.cleanStreak).toBe(0);
    expect(getLadderState(repo)?.cleanStreak).toBe(0);
  });

  test("a self-repo never leaves human, however many clean decisions it earns", () => {
    openTestDatabase();
    const repo = "adam/factory";
    const N = config.mergeLadder.promoteAfter;
    for (let i = 0; i < N + 2; i++) recordShadowDecision(repo, `FAC-${i}`, cleanDecision, CLEAN);
    // The persisted earned tier may have climbed, but the EFFECTIVE tier the loop
    // uses is pinned to human by isSelfRepo — enrollment/ceiling/earning cannot override it.
    expect(effectiveMergeTier(repo, getLadderState(repo))).toBe("human");
  });

  test("returns the pure transition even when the store is closed (no throw)", () => {
    // no openTestDatabase() — store is closed
    const s = recordShadowDecision("acme/closed", "FAC-1", cleanDecision, CLEAN);
    expect(s.cleanStreak).toBe(1);
    expect(getLadderState("acme/closed")).toBeNull();
  });
});

describe("recordShadowDecision — B9: earning is gated on isEnrolled (earn only after opt-in)", () => {
  afterEach(() => closeTestDatabase());

  const cleanDecision = decideMerge("shadow", CLEAN, OPTS);

  test("isEnrolled is false for a repo in neither MERGE_LADDER_REPOS nor MERGE_AUTO_REPOS", () => {
    expect(isEnrolled("acme/never-enrolled")).toBe(false);
  });

  test("decisions on an UN-enrolled repo never advance (or even seed) the persisted ladder", () => {
    openTestDatabase();
    const repo = "acme/not-enrolled";
    expect(config.mergeLadder.enrolled.includes(repo)).toBe(false);
    expect(config.autoMergeRepos.includes(repo)).toBe(false);
    const N = config.mergeLadder.promoteAfter;
    // Many clean decisions in a row — before this fix these would silently
    // build a streak (and even promote to auto-low-risk) underneath an
    // un-enrolled repo, only surfacing the moment a human later enrolled it.
    let last: LadderState | null = null;
    for (let i = 0; i < N + 2; i++) last = recordShadowDecision(repo, `FAC-${i}`, cleanDecision, CLEAN);
    expect(getLadderState(repo)).toBeNull();          // nothing was ever persisted
    expect(last?.tier).toBe("shadow");                // and the returned state never advanced either
    expect(last?.cleanStreak).toBe(0);
    expect(effectiveMergeTier(repo, getLadderState(repo))).toBe("human");
  });

  test("enrolling AFTER accruing pre-enrollment decisions does not retroactively grant a streak", () => {
    openTestDatabase();
    const repo = "acme/late-enroll";
    const N = config.mergeLadder.promoteAfter;
    // Pre-enrollment: N-1 clean decisions — a no-op on the persisted ladder.
    for (let i = 0; i < N - 1; i++) recordShadowDecision(repo, `FAC-pre-${i}`, cleanDecision, CLEAN);
    expect(getLadderState(repo)).toBeNull();

    // A human now opts the repo in.
    config.mergeLadder.enrolled.push(repo);
    try {
      // If the pre-enrollment decisions HAD counted, this single post-
      // enrollment clean decision would already hit promoteAfter and promote.
      // It must not — earning starts counting from enrollment, at streak 0.
      const first = recordShadowDecision(repo, "FAC-post-0", cleanDecision, CLEAN);
      expect(first.cleanStreak).toBe(1);
      expect(first.tier).toBe("shadow");
      let state: LadderState | null = null;
      for (let i = 1; i < N; i++) state = recordShadowDecision(repo, `FAC-post-${i}`, cleanDecision, CLEAN);
      expect(state?.tier).toBe("auto-low-risk");
    } finally {
      config.mergeLadder.enrolled = config.mergeLadder.enrolled.filter((r) => r !== repo);
    }
  });
});
