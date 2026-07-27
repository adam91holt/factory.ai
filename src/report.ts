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
  // #12b (FAC-34): set when park pushed the worktree's committed work
  // best-effort so a human can salvage it instead of it being silently lost.
  parkedBranchUrl?: string;
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
  const gateLines = input.gates.map((g) =>
    `- ${g.name}: ${g.passed === null ? "no-gate (fails on baseline)" : g.passed ? "pass" : "FAIL"}`);
  if (gateLines.length > 0) lines.push("**Gates:**", ...gateLines, "");

  lines.push("```yaml");
  lines.push("meta:");
  lines.push(`  outcome: ${input.outcome}`);
  lines.push(`  reason: ${JSON.stringify(input.reason ?? null)}`);
  lines.push(`  pr: ${input.prUrl ?? "null"}`);
  lines.push(`  gate_strength: ${input.gateStrength}`);
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
