import { describe, expect, test } from "bun:test";
import {
  collectFindings, findingsFiles, renderFindingsForFixer, buildFixerFindingsBlock,
  type GateOutput, type GateFinding, type FindingsLeg,
} from "../src/gate.ts";

// Findings-driven fixer prompts (ticket #7): the fixer/design-fixer prompt is
// built FROM structured findings (grouped by file, most severe first) instead
// of raw review prose — this is a NEW test file (tests/gate.test.ts already
// covers gate resolution and stays untouched; gamed-gate protection blocks
// editing an existing test file).

function finding(over: Partial<GateFinding> = {}): GateFinding {
  return {
    severity: "high", file: "src/x.ts", line: 42,
    summary: "SQL injection", failureScenario: "id=1;DROP TABLE", fix: "parameterize",
    ...over,
  };
}

function gateWith(findings: GateFinding[], over: Partial<GateOutput> = {}): GateOutput {
  return {
    verdict: "fail", findings, evidence: [], recommendedAction: "repair",
    prose: "review prose", source: "structured", dropped: 0,
    ...over,
  };
}

describe("collectFindings — tags each finding with its originating leg", () => {
  test("flattens findings across legs, tagging source", () => {
    const legs = [
      { label: "reviewer-spec", gate: gateWith([finding({ file: "a.ts" })]) },
      { label: "reviewer-repo", gate: gateWith([finding({ file: "b.ts" })]) },
    ];
    const out = collectFindings(legs);
    expect(out).toHaveLength(2);
    expect(out[0]!.source).toBe("reviewer-spec");
    expect(out[1]!.source).toBe("reviewer-repo");
  });

  test("a null gate (unresolved leg) contributes nothing", () => {
    const legs = [{ label: "reviewer-spec", gate: null }, { label: "reviewer-repo", gate: gateWith([finding()]) }];
    expect(collectFindings(legs)).toHaveLength(1);
  });
});

describe("findingsFiles — pure, deduped file list", () => {
  test("dedupes and preserves first-seen order", () => {
    expect(findingsFiles([finding({ file: "a.ts" }), finding({ file: "b.ts" }), finding({ file: "a.ts" })]))
      .toEqual(["a.ts", "b.ts"]);
  });

  test("drops blank file entries", () => {
    expect(findingsFiles([finding({ file: "" }), finding({ file: "  " }), finding({ file: "a.ts" })]))
      .toEqual(["a.ts"]);
  });
});

describe("renderFindingsForFixer — grouped by file, blockers first", () => {
  test("empty findings renders a plain no-findings message", () => {
    expect(renderFindingsForFixer([])).toBe("No findings.");
  });

  test("groups by file, most-severe file first", () => {
    const findings = [
      { ...finding({ file: "minor.ts", severity: "low" }), source: "reviewer-spec" },
      { ...finding({ file: "blocker.ts", severity: "critical" }), source: "reviewer-repo" },
    ];
    const rendered = renderFindingsForFixer(findings);
    expect(rendered.indexOf("### blocker.ts")).toBeLessThan(rendered.indexOf("### minor.ts"));
  });

  test("within one file, most-severe finding sorts first", () => {
    const findings = [
      { ...finding({ file: "x.ts", severity: "low", summary: "cosmetic" }), source: "reviewer-spec" },
      { ...finding({ file: "x.ts", severity: "critical", summary: "sqli" }), source: "reviewer-repo" },
    ];
    const rendered = renderFindingsForFixer(findings);
    expect(rendered.indexOf("sqli")).toBeLessThan(rendered.indexOf("cosmetic"));
  });

  test("findings with no file given are grouped last under one heading", () => {
    const findings = [
      { ...finding({ file: "", severity: "critical" }), source: "reviewer-spec" },
      { ...finding({ file: "x.ts", severity: "low" }), source: "reviewer-repo" },
    ];
    const rendered = renderFindingsForFixer(findings);
    expect(rendered.indexOf("### x.ts")).toBeLessThan(rendered.indexOf("(no file given)"));
  });

  test("renders the exact line format: severity, source, location, summary, scenario, fix", () => {
    const findings = [{ ...finding({ file: "src/x.ts", line: 12, severity: "high", summary: "SQLi",
      failureScenario: "id=1;DROP", fix: "parameterize" }), source: "reviewer-repo" }];
    const rendered = renderFindingsForFixer(findings);
    expect(rendered).toContain("- [high, reviewer-repo]:12 SQLi — fails when: id=1;DROP — fix: parameterize");
  });
});

describe("buildFixerFindingsBlock — merges legs, falls back to raw text when unstructured", () => {
  test("merges two legs' findings into one structured block, no raw duplication", () => {
    const legs: FindingsLeg[] = [
      { label: "reviewer-spec", gate: gateWith([finding({ file: "a.ts" })]), rawText: "spec raw text" },
      { label: "reviewer-repo", gate: gateWith([finding({ file: "b.ts" })]), rawText: "repo raw text" },
    ];
    const block = buildFixerFindingsBlock(legs);
    expect(block).toContain("### a.ts");
    expect(block).toContain("### b.ts");
    expect(block).not.toContain("spec raw text");
    expect(block).not.toContain("repo raw text");
  });

  test("a null-gate leg falls back to its labeled raw text as unresolved", () => {
    const legs: FindingsLeg[] = [
      { label: "reviewer-spec", gate: null, rawText: "spec crashed" },
      { label: "reviewer-repo", gate: gateWith([finding({ file: "b.ts" })]), rawText: "repo raw text" },
    ];
    const block = buildFixerFindingsBlock(legs);
    expect(block).toContain("reviewer-spec (unresolved — raw output below):\nspec crashed");
    expect(block).toContain("### b.ts");
  });

  test("a resolved gate with zero findings falls back to labeled raw text", () => {
    const legs: FindingsLeg[] = [
      { label: "reviewer-spec", gate: gateWith([], { verdict: "fail" }), rawText: "fail but no structured findings" },
    ];
    const block = buildFixerFindingsBlock(legs);
    expect(block).toContain("reviewer-spec (no structured findings — raw output below):\nfail but no structured findings");
  });

  test("all-unresolved-and-empty legs still return a non-empty string", () => {
    const legs: FindingsLeg[] = [{ label: "reviewer-spec", gate: null, rawText: "" }];
    expect(buildFixerFindingsBlock(legs).trim()).not.toBe("");
  });
});
