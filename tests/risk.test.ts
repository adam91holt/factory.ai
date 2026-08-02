import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  RISK_CLASSES, RISK_MODEL_TIERS, RISK_THRESHOLDS, MAX_TIER_ESCALATIONS, MODEL_TIERS,
  deriveRiskClass, diffFilePaths, maxRiskClass, resolveTierModel, escalationModel,
  modelVendor, vendorDiversityViolations, vendorDiversityPolicy, gateTiersDeclared,
  type RiskClass, type RiskSignals, type TierConfig,
} from "../src/risk.ts";
import { config } from "../src/config.ts";

const SRC_DIR = join(import.meta.dir, "..", "src");

/** A signals bundle that classifies LOW; cases override one axis at a time. */
const QUIET: RiskSignals = {
  diffLines: 5, paths: ["src/util.ts"], guardedPaths: [], diffUnavailable: false, testFilesRemoved: false,
};

// ---------------------------------------------------------------------------
// deriveRiskClass — table-driven, pure, evidence-only.
// ---------------------------------------------------------------------------

describe("deriveRiskClass — table-driven classification", () => {
  const CASES: Array<[string, Partial<RiskSignals>, RiskClass]> = [
    ["tiny unguarded diff", {}, "low"],
    ["diff lines exactly at the medium threshold", { diffLines: RISK_THRESHOLDS.mediumDiffLines }, "medium"],
    ["diff lines just below the medium threshold", { diffLines: RISK_THRESHOLDS.mediumDiffLines - 1 }, "low"],
    ["diff lines at the high threshold", { diffLines: RISK_THRESHOLDS.highDiffLines }, "high"],
    ["file count at the medium threshold", { paths: Array.from({ length: RISK_THRESHOLDS.mediumFiles }, (_, i) => `src/f${i}.ts`) }, "medium"],
    ["file count at the high threshold", { paths: Array.from({ length: RISK_THRESHOLDS.highFiles }, (_, i) => `src/f${i}.ts`) }, "high"],
    ["auth path", { paths: ["src/auth/session.ts"] }, "high"],
    ["migration path", { paths: ["db/migrations/0042_add_users.sql"] }, "high"],
    ["secret-handling path", { paths: ["src/lib/secrets.ts"] }, "high"],
    ["dotenv file", { paths: [".env.production"] }, "high"],
    ["docker-compose", { paths: ["docker-compose.yml"] }, "high"],
    ["crypto path", { paths: ["src/crypto/sign.ts"] }, "high"],
    ["payment path", { paths: ["src/billing/invoice.ts"] }, "high"],
    ["guarded path touched", { guardedPaths: ["CLAUDE.md"] }, "critical"],
    ["test files removed", { testFilesRemoved: true }, "critical"],
    ["diff unavailable (fail closed)", { diffUnavailable: true }, "critical"],
    ["sensitive + guarded folds to the max (critical)", { paths: ["src/auth/x.ts"], guardedPaths: [".github/workflows/ci.yml"] }, "critical"],
    ["big diff + sensitive stays high (no false critical)", { diffLines: 1000, paths: ["src/auth/x.ts"] }, "high"],
  ];
  for (const [name, override, expected] of CASES) {
    test(`${name} → ${expected}`, () => {
      const assessment = deriveRiskClass({ ...QUIET, ...override });
      expect(assessment.class).toBe(expected);
      expect(assessment.reasons.length).toBeGreaterThan(0);
    });
  }

  test("word-shape guards: author/oracle/keyboard do not read as sensitive", () => {
    expect(deriveRiskClass({ ...QUIET, paths: ["src/author.ts", "src/oracle.ts", "src/keyboard.ts"] }).class).toBe("low");
  });

  test("reasons name every rule that fired", () => {
    const a = deriveRiskClass({ ...QUIET, diffLines: 500, paths: ["src/auth/x.ts"], testFilesRemoved: true });
    expect(a.class).toBe("critical");
    expect(a.reasons.join(" ")).toMatch(/test files/i);
    expect(a.reasons.join(" ")).toMatch(/auth/i);
    expect(a.reasons.join(" ")).toMatch(/500 changed lines/);
  });

  test("maxRiskClass never lowers", () => {
    expect(maxRiskClass("critical", "low")).toBe("critical");
    expect(maxRiskClass("low", "high")).toBe("high");
    expect(maxRiskClass("medium", "medium")).toBe("medium");
  });
});

describe("deriveRiskClass — purity: ticket text is structurally unreachable", () => {
  test("risk.ts imports NOTHING and mentions no ticket machinery", () => {
    const src = readFileSync(join(SRC_DIR, "risk.ts"), "utf8");
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/^\s*import\s/m);        // pure, I/O-free, cycle-free
    expect(code).not.toMatch(/description|FactoryMeta|parseFactoryMeta|untrusted/);
  });

  test("RiskSignals carries no string field a description could ride in on (loop.ts builds every input from git/worktree calls)", () => {
    const loop = readFileSync(join(SRC_DIR, "loop.ts"), "utf8");
    const at = loop.indexOf("deriveRiskClass({");
    expect(at).toBeGreaterThan(-1);
    const call = loop.slice(at, loop.indexOf("});", at)); // the argument object only
    expect(call).not.toMatch(/issue\.|description|spec|meta\./);
    expect(call).toMatch(/countDiffLines\(diff\)/);
    expect(call).toMatch(/guardedPathsTouched|guardedForRisk/);
  });

  test("risk is NOT a merge input: merge-ladder.ts never touches risk.ts, and the evidence build near decideMerge reads no risk value", () => {
    const ladder = readFileSync(join(SRC_DIR, "merge-ladder.ts"), "utf8");
    expect(ladder).not.toContain("risk.ts");
    expect(ladder).not.toContain("RiskClass");
    expect(ladder).not.toContain("deriveRiskClass");
    const loop = readFileSync(join(SRC_DIR, "loop.ts"), "utf8");
    const evAt = loop.indexOf("buildMergeEvidence(");
    const ev = loop.slice(evAt, loop.indexOf(");", evAt)); // the evidence argument only
    // (lowRiskMaxDiff nearby is the ladder's own diff-size knob, not this
    // module's risk class — assert on the risk-class tokens specifically.)
    expect(ev).not.toMatch(/risk\.class|RiskClass|deriveRiskClass|\brisk\b/);
  });
});

describe("diffFilePaths", () => {
  test("extracts the b/ side of each diff --git header", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts", "index 123..456", "--- a/src/a.ts", "+++ b/src/a.ts", "+x",
      "diff --git a/old/name.ts b/new/name.ts", "+y",
    ].join("\n");
    expect(diffFilePaths(diff)).toEqual(["src/a.ts", "new/name.ts"]);
  });
  test("ignores prose that merely mentions diff --git mid-line, and empty diffs", () => {
    expect(diffFilePaths("")).toEqual([]);
    expect(diffFilePaths("see the diff --git a/x b/y marker")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tier table + resolution.
// ---------------------------------------------------------------------------

describe("RISK_MODEL_TIERS invariants", () => {
  test("EVERY gate-verdict-producing stage never maps BELOW standard (risk may strengthen a safety gate, never weaken it)", () => {
    // Any stage whose output reaches buildMergeEvidence or a hold reason
    // belongs here: the three cross-vendor legs, PLUS the tester (sole source
    // of the real→strong browser-evidence upgrade) and the design reviewer
    // (sole source of the taste hold). Only the fixer — which produces no
    // gate verdict — may run cheap.
    for (const risk of RISK_CLASSES) {
      for (const stage of ["reviewerClaude", "reviewerCodex", "securityReviewer", "designReviewer", "tester"] as const) {
        expect({ risk, stage, tier: RISK_MODEL_TIERS[risk][stage] }).not.toEqual({ risk, stage, tier: "cheap" });
      }
    }
  });
  test("LOW risk — the auto-merge-eligible class — floors tester and designReviewer at standard (regression: they were cheap)", () => {
    // RISK_THRESHOLDS.mediumDiffLines is deliberately aligned with the merge
    // ladder's lowRiskMaxDiff, so "low risk" = "auto-low-risk mergeable".
    // The merge-evidence producers must not run the weakest roster model on
    // exactly the runs that merge with zero human touch.
    expect(RISK_MODEL_TIERS.low.tester).toBe("standard");
    expect(RISK_MODEL_TIERS.low.designReviewer).toBe("standard");
    expect(RISK_MODEL_TIERS.low.fixer).toBe("cheap"); // fixer produces no verdict — cheap stays fine
  });
  test("critical maps every stage to strong", () => {
    for (const tier of Object.values(RISK_MODEL_TIERS.critical)) expect(tier).toBe("strong");
  });
  test("medium is all-standard — the exact pre-feature behavior", () => {
    for (const tier of Object.values(RISK_MODEL_TIERS.medium)) expect(tier).toBe("standard");
  });
  test("every cell is a real tier", () => {
    for (const risk of RISK_CLASSES) {
      for (const tier of Object.values(RISK_MODEL_TIERS[risk])) {
        expect(MODEL_TIERS).toContain(tier);
      }
    }
  });
});

describe("resolveTierModel — additive by construction", () => {
  const TIERS: TierConfig = { fixer: { cheap: "mini-model", strong: "big-model" } };

  test("an EMPTY tier config returns the base model at every risk class for every stage", () => {
    for (const risk of RISK_CLASSES) {
      expect(resolveTierModel("fixer", risk, {}, "base")).toBe("base");
      expect(resolveTierModel("securityReviewer", risk, {}, "sec-base")).toBe("sec-base");
    }
  });
  test("standard tier is ALWAYS the base model, even when cheap/strong exist", () => {
    expect(resolveTierModel("fixer", "medium", TIERS, "base")).toBe("base");
  });
  test("cheap and strong resolve to the configured tier models", () => {
    expect(resolveTierModel("fixer", "low", TIERS, "base")).toBe("mini-model");
    expect(resolveTierModel("fixer", "critical", TIERS, "base")).toBe("big-model");
  });
  test("a declared-for-another-stage tier never leaks", () => {
    expect(resolveTierModel("tester", "low", TIERS, "t-base")).toBe("t-base");
  });
});

// ---------------------------------------------------------------------------
// Escalation.
// ---------------------------------------------------------------------------

describe("escalationModel — one bounded retry on the next tier up", () => {
  const TIERS: TierConfig = { fixer: { cheap: "mini", strong: "big" } };

  test("MAX_TIER_ESCALATIONS is the in-code bound and it is 1", () => {
    expect(MAX_TIER_ESCALATIONS).toBe(1);
  });
  test("no tier config → null (nothing to escalate to; block is a no-op)", () => {
    expect(escalationModel("fixer", "medium", {}, "base", "base")).toBe(null);
  });
  test("standard tier with a strong model configured → the strong model", () => {
    expect(escalationModel("fixer", "medium", TIERS, "base", "base")).toBe("big");
  });
  test("cheap tier (low risk) escalates to the STANDARD model first", () => {
    expect(escalationModel("fixer", "low", TIERS, "base", "mini")).toBe("base");
  });
  test("already at strong (critical) → null even with tiers configured", () => {
    expect(escalationModel("fixer", "critical", TIERS, "base", "big")).toBe(null);
  });
  test("a strong model identical to the current one is NOT an escalation", () => {
    expect(escalationModel("fixer", "medium", { fixer: { strong: "base" } }, "base", "base")).toBe(null);
  });
  test("loop.ts wires the bound and the escalated retry runs BEFORE the repair rounds", () => {
    const loop = readFileSync(join(SRC_DIR, "loop.ts"), "utf8");
    expect(loop).toMatch(/for \(let e = 0; e < MAX_TIER_ESCALATIONS/);
    expect(loop.indexOf("MAX_TIER_ESCALATIONS")).toBeGreaterThan(-1);
    // escalation loop textually precedes the verify-repair loop inside processIssue
    expect(loop.indexOf("verify-escalation")).toBeLessThan(loop.indexOf("verify-repair-"));
  });
});

// ---------------------------------------------------------------------------
// Vendor diversity.
// ---------------------------------------------------------------------------

describe("modelVendor", () => {
  const CASES: Array<[string, string]> = [
    ["opus", "anthropic"], ["sonnet", "anthropic"], ["claude-fable-5", "anthropic"],
    ["gpt-5.6-sol", "openai"], ["codex-mini", "openai"],
    ["qwen3.8-max-preview", "qwen"], ["deepseek-v4-flash-0731", "deepseek"],
    ["glm-5.2", "zhipu"], ["gemini-3-pro", "google"], ["kimi-k3", "moonshot"],
  ];
  for (const [id, vendor] of CASES) test(`${id} → ${vendor}`, () => expect(modelVendor(id)).toBe(vendor));

  test("unrecognized ids collide only with THEMSELVES", () => {
    expect(modelVendor("mystery-model-a")).toBe("unknown:mystery-model-a");
    expect(modelVendor("mystery-model-a")).toBe(modelVendor("mystery-model-a"));
    expect(modelVendor("mystery-model-a")).not.toBe(modelVendor("mystery-model-b"));
  });
});

describe("vendorDiversityViolations — high/critical must keep code review and security review vendor-independent", () => {
  const DIVERSE = { reviewerClaude: "opus", reviewerCodex: "qwen3.8-max-preview", securityReviewer: "deepseek-v4-flash-0731" };

  test("a diverse bench has no violations", () => {
    expect(vendorDiversityViolations(DIVERSE, {})).toEqual([]);
  });
  test("shipped-default shape (security shares a vendor with ONE leg, the other differs) is allowed", () => {
    expect(vendorDiversityViolations({ reviewerClaude: "opus", reviewerCodex: "gpt-5.6-sol", securityReviewer: "gpt-5.6-sol" }, {})).toEqual([]);
  });
  test("total collapse — one vendor holds both code-review legs AND the security judgment — is a violation at high AND critical", () => {
    const v = vendorDiversityViolations({ reviewerClaude: "deepseek-v4-flash-0731", reviewerCodex: "deepseek-v4-flash-0731", securityReviewer: "deepseek-v4-flash-0731" }, {});
    expect(v.length).toBe(2);
    expect(v[0]).toMatch(/high/);
    expect(v[1]).toMatch(/critical/);
    expect(v[0]).toMatch(/deepseek/);
  });
  test("a collapse introduced ONLY via strong-tier overrides is caught (the assertion runs on what high/critical actually resolve)", () => {
    const tiers: TierConfig = {
      reviewerClaude: { strong: "deepseek-v4" },
      reviewerCodex: { strong: "deepseek-v4-flash-0731" },
      securityReviewer: { strong: "deepseek-r2" },
    };
    const v = vendorDiversityViolations(DIVERSE, tiers);
    expect(v.length).toBe(2);
  });
  test("a strong tier that RESTORES diversity clears the violation", () => {
    const collapsed = { reviewerClaude: "deepseek-a", reviewerCodex: "deepseek-b", securityReviewer: "deepseek-c" };
    expect(vendorDiversityViolations(collapsed, { securityReviewer: { strong: "qwen3.7-max" } })).toEqual([]);
  });
  test("identical UNKNOWN ids collide; distinct unknown ids do not", () => {
    expect(vendorDiversityViolations({ reviewerClaude: "mystery-x", reviewerCodex: "mystery-x", securityReviewer: "mystery-x" }, {}).length).toBe(2);
    expect(vendorDiversityViolations({ reviewerClaude: "mystery-a", reviewerCodex: "mystery-x", securityReviewer: "mystery-x" }, {})).toEqual([]);
  });
});

describe("vendorDiversityPolicy — fail loudly at config load, additive for pre-tier configs", () => {
  test("no violations → ok, regardless of adoption", () => {
    expect(vendorDiversityPolicy([], false)).toBe("ok");
    expect(vendorDiversityPolicy([], true)).toBe("ok");
  });
  test("violations + gate tiers declared (feature adopted) → throw", () => {
    expect(vendorDiversityPolicy(["v"], true)).toBe("throw");
  });
  test("violations + NO gate tiers declared (pre-tier config) → warn, so existing configs keep booting", () => {
    expect(vendorDiversityPolicy(["v"], false)).toBe("warn");
  });
  test("gateTiersDeclared: only the three gate legs count as adoption", () => {
    expect(gateTiersDeclared({})).toBe(false);
    expect(gateTiersDeclared({ fixer: { strong: "big" }, tester: { cheap: "mini" } })).toBe(false);
    expect(gateTiersDeclared({ securityReviewer: { strong: "big" } })).toBe(true);
    expect(gateTiersDeclared({ reviewerClaude: { cheap: "mini" } })).toBe(true);
    expect(gateTiersDeclared({ reviewerCodex: { strong: "big" } })).toBe(true);
  });
  test("config.ts actually enforces the policy at load (and the running suite's own config passed it)", () => {
    const src = readFileSync(join(SRC_DIR, "config.ts"), "utf8");
    expect(src).toContain("vendorDiversityViolations(");
    expect(src).toContain("vendorDiversityPolicy(");
    expect(src).toMatch(/policy === "throw"[\s\S]{0,200}throw new Error/);
    // The suite imported config at the top of this file — had the live env
    // been a throw-level violation, every test in this process would have died.
    expect(config.modelTiers).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Config surface.
// ---------------------------------------------------------------------------

describe("config.modelTiers", () => {
  test("declares exactly the risk-routed stages (implementer deliberately absent — risk needs its diff)", () => {
    expect(Object.keys(config.modelTiers).sort()).toEqual(
      ["designReviewer", "fixer", "reviewerClaude", "reviewerCodex", "securityReviewer", "tester"].sort(),
    );
  });
  test("every declared tier model has the plain-identifier shape (garbage env values were dropped)", () => {
    for (const pair of Object.values(config.modelTiers)) {
      for (const model of [pair?.cheap, pair?.strong]) {
        if (model !== undefined) expect(model).toMatch(/^[A-Za-z0-9._-]{1,80}$/);
      }
    }
  });
});
