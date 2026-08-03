import { config } from "./config.ts";
import type { MergeTier, BrowserEvidence } from "./events.ts";

// Gap-2: the evidence-gated merge ladder — the single source of truth for
// "should this PR merge unattended, and is this repo allowed to yet." PURE and
// I/O-free: it decides from VERIFICATION EVIDENCE only. Ticket text is NEVER an
// input (untrusted description must not confer merge authority — see decideMerge
// signature). db.ts persists the earning transitions; loop.ts (and, later, the
// steward) consume decideMerge/effectiveMergeTier so the loop and the steward can
// never disagree on what is mergeable.

export type { MergeTier, BrowserEvidence };

export interface MergeEvidence {
  green: boolean;                          // all runnable gates passed
  strength: "none" | "weak" | "real" | "strong";
  guarded: boolean;                        // guardedPathsTouched non-empty OR DIFF_FAILED
  needsHuman: boolean;                     // taste fail / tester fail / test deletion
  security: "pass" | "fail" | null;        // null = not run
  browser: BrowserEvidence;
  diffLines: number;                       // for low-risk classification
}

export interface MergeDecision {
  wouldMerge: boolean;   // would this PR merge if the repo were at full "auto"?
  act: boolean;          // does the CURRENT tier actually merge it now?
  tier: MergeTier;
  reasons: string[];     // blockers (wouldMerge=false) or the gating note (act=false)
}

export interface LadderState {
  repo: string;
  tier: MergeTier;       // the EARNED tier (shadow | auto-low-risk); ceiling caps apply elsewhere
  cleanStreak: number;   // consecutive clean shadow decisions since the last dirty one / promotion
  totalShadow: number;   // lifetime shadow decisions recorded (audit)
}

// human < shadow < auto-low-risk < auto — ordered from most to least restrictive.
const TIER_ORDER: MergeTier[] = ["human", "shadow", "auto-low-risk", "auto"];
function tierRank(t: MergeTier): number {
  const i = TIER_ORDER.indexOf(t);
  return i < 0 ? 0 : i; // an unknown/legacy tier is treated as the safest (human)
}
/** The more restrictive of two tiers (hard rules always win). */
function minTier(a: MergeTier, b: MergeTier): MergeTier {
  return tierRank(a) <= tierRank(b) ? a : b;
}

/** Build merge evidence from gate summary + external signals. The ONLY place a
 * passing external browser check upgrades "real" → "strong" (the substitute for
 * a repo that drives its app via Playwright but has no `test:e2e` script). */
export function buildMergeEvidence(x: {
  summary: { green: boolean; strength: "none" | "weak" | "real" | "strong" };
  guarded: string[];
  needsHuman: boolean;
  security: "pass" | "fail" | null;
  browser: BrowserEvidence;
  diffLines: number;
}): MergeEvidence {
  const strength = x.summary.strength === "real" && x.browser === "pass" ? "strong" : x.summary.strength;
  return {
    green: x.summary.green,
    strength,
    guarded: x.guarded.length > 0,
    needsHuman: x.needsHuman,
    security: x.security,
    browser: x.browser,
    diffLines: x.diffLines,
  };
}

/** Pure merge decision from evidence alone. NOTE the signature: no ticket / no
 * description parameter — untrusted text physically cannot reach this policy.
 * `minStrength` (default "strong") is the evidence floor: the AUTO_MERGE_ALL
 * override passes "real" so repos without an e2e gate can still merge on green
 * unit tests — every OTHER safety condition below is non-negotiable either way. */
export function decideMerge(tier: MergeTier, ev: MergeEvidence, opts: { lowRiskMaxDiff: number; minStrength?: "real" | "strong"; allowGuarded?: boolean }): MergeDecision {
  const minStrength = opts.minStrength ?? "strong";
  const strengthOk = ev.strength === "strong" || (minStrength === "real" && ev.strength === "real");
  // allowGuarded (operator override — AUTO_MERGE_ALL or a per-project
  // mergeGuarded grant) lets guarded-path touches auto-merge. It relaxes ONLY
  // the guarded-path classification; every other block below (needs-human
  // folds, security, browser, green, strength) is untouched. The caller only
  // ever sets it alongside an explicit auto grant on a non-self repo.
  const guardedBlocks = ev.guarded && !opts.allowGuarded;
  const reasons: string[] = [];
  if (!ev.green) reasons.push("gates not green");
  if (!strengthOk) reasons.push(`gate strength ${ev.strength} (need ${minStrength})`);
  if (guardedBlocks) reasons.push("guarded paths touched");
  else if (ev.guarded) reasons.push("guarded paths touched — auto-merged under operator override");
  if (ev.needsHuman) reasons.push("needs human (taste/tester/test-deletion)");
  if (ev.security === "fail") reasons.push("security review failed");
  if (ev.browser === "fail") reasons.push("browser evidence failed");
  if (ev.browser === "missing") reasons.push("required browser evidence missing");

  const wouldMerge = ev.green && !guardedBlocks && !ev.needsHuman && strengthOk
    && ev.security !== "fail" && ev.browser !== "fail" && ev.browser !== "missing";

  let act = false;
  if (wouldMerge) {
    if (tier === "auto") act = true;
    else if (tier === "auto-low-risk") {
      act = ev.diffLines <= opts.lowRiskMaxDiff && !guardedBlocks;
      if (!act) reasons.push(`diff ${ev.diffLines} lines > low-risk cap ${opts.lowRiskMaxDiff}`);
    } else {
      // shadow | human: compute-only — record the would-merge, never act.
      reasons.push(tier === "shadow" ? "shadow tier: recording only (earning auto-merge)" : "human-merge tier");
    }
  }
  return { wouldMerge, act, tier, reasons };
}

/** Pure earning transition — the DB just persists the result. A clean (would-
 * merge) decision extends the streak; any dirty decision resets it to 0. A repo
 * at "shadow" that reaches `promoteAfter` consecutive clean decisions (and whose
 * ceiling allows it) auto-promotes to "auto-low-risk", resetting the streak.
 * auto-low-risk → auto is NEVER automatic — a human raises the ceiling. */
export function advanceLadder(prev: LadderState, wouldMerge: boolean, opts: { promoteAfter: number; ceiling: MergeTier }): LadderState {
  const cleanStreak = wouldMerge ? prev.cleanStreak + 1 : 0;
  const totalShadow = prev.totalShadow + 1;
  if (prev.tier === "shadow" && cleanStreak >= opts.promoteAfter && tierRank(opts.ceiling) >= tierRank("auto-low-risk")) {
    return { repo: prev.repo, tier: "auto-low-risk", cleanStreak: 0, totalShadow };
  }
  return { repo: prev.repo, tier: prev.tier, cleanStreak, totalShadow };
}

/** The factory's own repo is ALWAYS human-merge — this supersedes enrollment,
 * ceiling, and any earned state, and cannot be overridden by env. Checked FIRST
 * in effectiveMergeTier so "factory.ai stays human-merge regardless" holds by
 * construction. Matches the configured self-repo slug OR any `.../factory`. */
export function isSelfRepo(repo: string): boolean {
  return (config.selfRepo !== "" && repo === config.selfRepo) || repo.endsWith("/factory");
}

/** Is a repo enrolled in the ladder at all? MERGE_LADDER_REPOS ∪ the retained
 * MERGE_AUTO_REPOS (which now enroll at ceiling "auto" but still start shadow).
 * Exported (B9) so db.ts can gate the earning WRITE path on it too — not just
 * effectiveMergeTier's READ path — so a repo cannot accrue a clean streak
 * before a human opts it in. */
export function isEnrolled(repo: string): boolean {
  return config.mergeLadder.enrolled.includes(repo) || config.autoMergeRepos.includes(repo);
}

/** The per-repo ceiling: an explicit MERGE_LADDER_CEILING pair wins; else a
 * MERGE_AUTO_REPOS repo defaults to "auto", any other enrolled repo to
 * "auto-low-risk". Ticket text never influences this. */
function ceilingFor(repo: string): MergeTier {
  const explicit = config.mergeLadder.ceiling[repo];
  if (explicit) return explicit as MergeTier;
  return config.autoMergeRepos.includes(repo) ? "auto" : "auto-low-risk";
}

/** Resolve the tier actually in force: hard rules > policy withholds >
 * operator override > policy grant > DB-earned > config ceiling. self-repo and
 * un-enrolled repos are human-merge; otherwise the earned tier (defaulting to
 * shadow before any row exists) capped by the ceiling.
 *
 * `policyMerge` is the repo's ACTIVE human-approved per-project merge policy
 * (db.ts activeMergePolicyForRepo — the propose→approve authority lane, so it
 * carries the same "a human granted this" weight as an env flag). Its withhold
 * values (review/shadow) beat every grant including AUTO_MERGE_ALL — the
 * tighten-only direction — while its "auto" grant beats enrollment's earning
 * hold (that is its purpose: force one project auto without a blanket flag). */
export function effectiveMergeTier(
  repo: string,
  earned: LadderState | null,
  opts?: { autoDefault?: boolean; humanReview?: boolean; overrideAll?: boolean; policyMerge?: "auto" | "shadow" | "review" | null },
): MergeTier {
  if (isSelfRepo(repo)) return "human";              // self-repo ALWAYS human (backstop, cannot be overridden)
  if (opts?.humanReview) return "human";             // epic opted INTO human review (merge:review — withhold-only)
  if (opts?.policyMerge === "review") return "human";  // project-scoped withhold: beats every grant below
  if (opts?.policyMerge === "shadow") return "shadow"; // project-scoped record-only hold: ditto
  if (opts?.overrideAll) return "auto";              // AUTO_MERGE_ALL: blanket operator override — beats enrollment/earned/ceiling (but never the rules above)
  if (opts?.policyMerge === "auto") return "auto";   // human-approved per-project grant — beats enrollment's earning hold
  if (isEnrolled(repo)) return minTier(earned?.tier ?? "shadow", ceilingFor(repo)); // explicit ladder enrollment wins
  if (opts?.autoDefault) return "auto";              // auto-merge-by-default (operator AUTO_MERGE_DEFAULT flag)
  return "human";                                    // default: human-merge (unchanged when the flag is off)
}

/** The seed a repo starts at before it has a persisted row: enrolled repos begin
 * EARNING at shadow (they must accumulate clean decisions), never at their ceiling. */
export function seedLadderState(repo: string): LadderState {
  return { repo, tier: "shadow", cleanStreak: 0, totalShadow: 0 };
}

/** The ceiling used when advancing a repo's earned tier — exported so db.ts
 * persists exactly the ceiling policy this module owns. */
export function ceilingForRepo(repo: string): MergeTier {
  return ceilingFor(repo);
}
