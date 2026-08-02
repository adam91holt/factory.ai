import { SENTINEL, PARKED_LABEL } from "./linear.ts";
import type { StageResult } from "./agents.ts";
import type { GateResult } from "./verify.ts";

// Factory report: dual-audience — human prose + fenced YAML meta (the
// triage-agent's parseMeta pattern). This IS the telemetry store: metrics are
// a Linear query over these blocks. Verdict C23: reason is always queryable.

export interface ReportInput {
  issueKey: string;
  prUrl: string | null;
  // B16: "merged" = mergePr actually succeeded (zero human intervention),
  // distinct from "pr_open" (a human still has to merge it) — see events.ts.
  outcome: "pr_open" | "merged" | "parked" | "needs_human" | "blocked" | "aborted";
  reason?: string;
  stages: StageResult[];
  gates: GateResult[];
  gateStrength: "none" | "weak" | "real" | "strong";
  guardedPaths: string[];
  reviewFindingsSummary?: string;
  designReview?: string;   // taste-gate findings when TASTE: fail persisted
  verification?: string;   // tester verification report, when it ran
  // Test-count ratchet (verify.ts): baseline-vs-post passing-test counts, when
  // a test gate ran. Rendered so "tests: 631 -> 640" evidence is queryable in
  // the report and a DECREASED/unknown verdict is visible even when it did not
  // park anything (withhold-only / non-blocking respectively).
  testRatchet?: { verdict: "ok" | "decreased" | "unknown"; evidence: string };
  // #12b (FAC-34): set when park pushed the worktree's committed work
  // best-effort so a human can salvage it instead of it being silently lost.
  parkedBranchUrl?: string;
  // Agent routing (routing.ts): the NOTABLE routing decisions for this run —
  // a specialist card selected on repo facts, a card that narrowed its own
  // allowlist below the code ceiling, or an unknown tool selector that was
  // dropped. Omitted (and rendered as nothing at all) when every stage took
  // its default card with the full ceiling, so an unrouted run's report is
  // byte-identical to what it was before routing existed.
  routing?: RoutingEntry[];
  // Structured gate outputs (issue #6 Part 1): how each gate stage's verdict
  // was recovered — schema-validated structured output, a fenced json block,
  // the legacy in-band token, or not at all ("unresolved", which the loop
  // routes fail-closed). `action` is the stage's recommendedAction: ADVISORY
  // ONLY, surfaced here for humans/telemetry — it is never an input to
  // merge-ladder.ts. Omitted entirely on runs where no gate stage ran.
  gateVerdicts?: GateVerdictEntry[];
}

export interface GateVerdictEntry {
  stage: string;
  verdict: "pass" | "fail" | "uncertain" | "unresolved";
  source: "structured" | "fenced-json" | "token" | "none";
  findings: number;
  action: "continue" | "repair" | "escalate" | "none";
}

export interface RoutingEntry {
  stage: string;
  card: string;
  specialist: boolean;
  /** Repo-fact terms that selected the specialist ([] for a default card). */
  matched: string[];
  toolCount: number;
  narrowed: boolean;
  unknownTools: string[];
}

export function buildReport(input: ReportInput): string {
  const totalCost = input.stages.reduce((sum, s) => sum + s.costUsd, 0);
  const degraded = input.stages.some((s) => s.degraded);
  const lines: string[] = [SENTINEL, ""];

  if (input.outcome === "pr_open" && input.prUrl) {
    lines.push(`PR ready for review: ${input.prUrl}`, "");
  } else if (input.outcome === "merged" && input.prUrl) {
    // The tier-specific "**Auto-merged** (merge ladder · tier X)" comment
    // (loop.ts, posted right after this report) carries the full detail —
    // keep this line short so the two comments don't read as duplicates.
    lines.push(`PR merged: ${input.prUrl}`, "");
  } else {
    lines.push(`**Outcome:** ${input.outcome}${input.reason ? ` — ${input.reason}` : ""}`, "");
  }

  if (input.outcome === "parked") {
    // #13: a parked ticket stays in Todo — only the label keeps it out of the
    // queue (fetchQueue's skip-set) — so requeue is a single reversible edit.
    lines.push(`Remove the \`${PARKED_LABEL}\` label to requeue.`, "");
  }
  if (input.parkedBranchUrl) {
    // #12b: committed work was pushed best-effort so it is never silently
    // lost even though the pipeline parked and no PR was opened.
    lines.push(`🔗 **Work pushed — branch available for salvage:** ${input.parkedBranchUrl}`, "");
  }
  if (input.gateStrength === "none") {
    lines.push("⚠️ **No usable verify gate in this repo** (nothing runnable, or gates fail on clean baseline). Review accordingly.", "");
  }
  if (input.guardedPaths.length > 0) {
    lines.push(`🛑 **Touches guarded paths — human must advance this issue manually:** ${input.guardedPaths.join(", ")}`, "");
  }
  if (degraded) lines.push("⚠️ Codex reviewer leg was down — Claude fallback reviewed (degraded).", "");
  if (input.reviewFindingsSummary) {
    lines.push("**Adversarial review:**", input.reviewFindingsSummary, "");
  }
  if (input.designReview) {
    lines.push("🎨 **Design taste gate — FAILED (human review required):**", input.designReview, "");
  }
  if (input.verification) {
    lines.push("**Verification (tester):**", input.verification, "");
  }
  const routing = input.routing ?? [];
  if (routing.length > 0) {
    lines.push("**Agent routing** (selected on repo facts — never on ticket text):");
    for (const r of routing) {
      const bits = [`\`${r.card}\``];
      if (r.specialist) bits.push(`specialist · matched ${r.matched.join(" + ") || "(none)"}`);
      if (r.narrowed) bits.push(`allowlist narrowed by the card to ${r.toolCount} tool(s)`);
      if (r.unknownTools.length > 0) bits.push(`⚠️ unknown tool selector(s) dropped: ${r.unknownTools.join(", ")}`);
      lines.push(`- ${r.stage}: ${bits.join(" · ")}`);
    }
    lines.push("");
  }
  const gateVerdicts = input.gateVerdicts ?? [];
  if (gateVerdicts.length > 0) {
    lines.push(`**Gate verdicts:** ${gateVerdicts.map((g) =>
      `${g.stage} ${g.verdict === "unresolved" ? "UNRESOLVED" : g.verdict} (${g.source}${g.findings > 0 ? `, ${g.findings} finding${g.findings === 1 ? "" : "s"}` : ""})`).join(" · ")}`, "");
  }
  const gateLines = input.gates.map((g) =>
    `- ${g.name}: ${g.passed === null ? "no-gate (fails on baseline)" : g.passed ? "pass" : "FAIL"}`);
  if (gateLines.length > 0) lines.push("**Gates:**", ...gateLines, "");
  if (input.testRatchet) {
    const note = input.testRatchet.verdict === "decreased" ? " — ⚠️ DECREASED vs baseline (human adjudication; auto-merge withheld)"
      : input.testRatchet.verdict === "unknown" ? " — count unparseable on one side (not blocking; diff classifier still guards)"
      : "";
    lines.push(`**Test count:** ${input.testRatchet.evidence}${note}`, "");
  }

  lines.push("```yaml");
  lines.push("meta:");
  lines.push(`  outcome: ${input.outcome}`);
  lines.push(`  reason: ${JSON.stringify(input.reason ?? null)}`);
  lines.push(`  pr: ${input.prUrl ?? "null"}`);
  lines.push(`  gate_strength: ${input.gateStrength}`);
  if (input.testRatchet) {
    lines.push(`  test_ratchet: ${input.testRatchet.verdict}`);
    lines.push(`  test_counts: ${JSON.stringify(input.testRatchet.evidence)}`);
  }
  if (routing.length > 0) {
    lines.push("  routing:");
    for (const r of routing) {
      lines.push(`    - stage: ${r.stage}`);
      lines.push(`      card: ${r.card}`);
      lines.push(`      specialist: ${r.specialist}`);
      if (r.matched.length > 0) lines.push(`      matched: ${JSON.stringify(r.matched.join(" "))}`);
      lines.push(`      tools: ${r.toolCount}`);
      if (r.narrowed) lines.push("      narrowed: true");
      if (r.unknownTools.length > 0) lines.push(`      unknown_tools: ${JSON.stringify(r.unknownTools.join(" "))}`);
    }
  }
  if (gateVerdicts.length > 0) {
    lines.push("  gate_verdicts:");
    for (const g of gateVerdicts) {
      lines.push(`    - stage: ${g.stage}`);
      lines.push(`      verdict: ${g.verdict}`);
      lines.push(`      source: ${g.source}`);
      lines.push(`      findings: ${g.findings}`);
      lines.push(`      action: ${g.action}`);
    }
  }
  lines.push(`  guarded_paths: ${input.guardedPaths.length}`);
  lines.push(`  parked_branch: ${JSON.stringify(input.parkedBranchUrl ?? null)}`);
  lines.push(`  degraded: ${degraded}`);
  lines.push(`  cost_usd: ${totalCost.toFixed(4)}`);
  lines.push("  stages:");
  for (const s of input.stages) {
    lines.push(`    - name: ${s.label}`);
    lines.push(`      turns: ${s.turns}`);
    lines.push(`      wall_s: ${s.wallSeconds}`);
    lines.push(`      cost_usd: ${s.costUsd.toFixed(4)}`);
    if (s.error) lines.push(`      error: ${JSON.stringify(s.error.slice(0, 200))}`);
    if (s.degraded) lines.push("      degraded: true");
  }
  lines.push("```");
  return lines.join("\n");
}
