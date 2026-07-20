// ============================================================================
// FactoryEvent schema v1 — VERBATIM SHARED BLOCK
// Lives in: src/events.ts (daemon)  AND  ui/src/lib/events.ts (copy).
// ============================================================================

/** Lane derived from Linear labels on unstarted issues (see §4 linear.ts diff). */
export type Lane = "todo" | "claimed" | "parked" | "needs_human";

export interface QueueIssue {
  id: string;
  identifier: string;   // e.g. "FAC-12"
  title: string;
  url: string;
  teamKey: string;
  stateName: string;
  stateType: string;    // Linear state type ("unstarted")
  labels: string[];
  createdAt: string;    // ISO
  lane: Lane;
}
// NOTE: issue descriptions are deliberately NOT included in any event.

export interface StageMeta {
  label: string;        // "implementer" | "reviewer-claude" | "reviewer-codex"
                        // | "reviewer-fallback" | "fixer" | "verify-repair-N"
  costUsd: number;
  turns: number;
  wallSeconds: number;
  error?: string;
  degraded?: boolean;
}

export interface GateMeta {
  name: string;               // package.json script name, e.g. "typecheck", "test"
  baselinePassed: boolean;
  passed: boolean | null;     // null = no-gate (fails on clean baseline)
  outputTail: string;         // last ≤400 chars of failure output, redacted; "" on pass
}

export type RunOutcome = "pr_open" | "parked" | "needs_human" | "aborted";
export type GateStrength = "none" | "weak" | "real";
export type DaemonMode = "watch" | "once" | "dry";

/** Event bodies as emitted by daemon code (bus stamps seq + at). */
export type FactoryEventBody =
  // ---- daemon lifecycle ----
  | { type: "daemon_started"; mode: DaemonMode; teamKeys: string[]; workRoot: string;
      wipLimit: number; watchIntervalSeconds: number; budgetUsdPerIssue: number }
  | { type: "daemon_stopped"; reason: "drained" | "one_shot" | "error" }
  // ---- tick loop ----
  | { type: "tick_started" }
  | { type: "tick_finished"; queued: number; eligible: number;
      markedNeedsHuman: number; processed: number; error?: string }
  | { type: "linear_backoff"; seconds: number }
  // ---- queue / board ----
  | { type: "queue_snapshot"; issues: QueueIssue[] }
  | { type: "issue_needs_human"; issueKey: string; reason: string }
  // ---- per-issue run lifecycle ----
  | { type: "run_started"; issueKey: string; title: string; repo: string; dryRun: boolean }
  | { type: "run_stage_started"; issueKey: string; stage: string; model: string;
      viaProxy: boolean }
  | { type: "run_tool_use"; issueKey: string; stage: string; tool: string;
      detail: string }                                 // detail: redacted, ≤160 chars
  | { type: "run_assistant_text"; issueKey: string; stage: string;
      text: string }                                   // redacted, ≤500 chars
  | { type: "run_stage_finished"; issueKey: string; stage: string; costUsd: number;
      turns: number; wallSeconds: number; resultText: string;   // redacted, ≤4000 chars
      error?: string; degraded?: boolean }
  | { type: "run_gates"; issueKey: string; round: number;      // 0 = pre-repair verify
      green: boolean; strength: GateStrength; gates: GateMeta[] }
  | { type: "run_finished"; issueKey: string; outcome: RunOutcome; reason?: string;
      prUrl: string | null; costUsd: number; stages: StageMeta[];
      gateStrength: GateStrength; guardedPaths: string[]; dryRun: boolean };

/** Wire type: what SSE frames and the ring buffer contain. */
export type FactoryEvent = FactoryEventBody & { seq: number; at: number };

// ---------------------------------------------------------------------------
// MissionState — shape of GET /state; the UI store mirrors this exactly and
// keeps it current by folding FactoryEvents into it (same reducer semantics
// on both sides, see §3 and §5).
// ---------------------------------------------------------------------------

export interface StageView {
  stage: string;
  model: string;
  viaProxy: boolean;
  startedAt: number;
  finishedAt: number | null;
  costUsd: number;          // 0 until finished
  turns: number;
  toolCalls: number;        // count of run_tool_use seen
  lastActivity: string;     // "<tool> · <detail>" of the latest tool_use
  resultText: string;       // from run_stage_finished
  error?: string;
  degraded?: boolean;
}

export interface RunView {
  issueKey: string;
  title: string;
  repo: string;
  dryRun: boolean;
  startedAt: number;
  finishedAt: number | null;
  status: "active" | RunOutcome;
  stages: StageView[];                 // in start order; parallel reviewers overlap
  gates: { round: number; green: boolean; strength: GateStrength;
           gates: GateMeta[] } | null; // latest run_gates
  costUsd: number;                     // sum of finished stage costs
  prUrl: string | null;
  reason?: string;
}

export interface MissionState {
  seq: number;                         // last event seq folded in
  daemon: {
    mode: DaemonMode; teamKeys: string[]; workRoot: string; wipLimit: number;
    watchIntervalSeconds: number; budgetUsdPerIssue: number; startedAt: number;
    lastTick: { at: number; queued: number; eligible: number;
                markedNeedsHuman: number; processed: number; error?: string } | null;
    backoffSeconds: number;            // 0 unless linear_backoff seen last tick
  } | null;                            // null until daemon_started observed
  board: QueueIssue[];                 // latest queue_snapshot
  boardAt: number | null;
  runs: Record<string, RunView>;       // keyed by issueKey; this-process runs
  needsHuman: Array<{ issueKey: string; reason: string; at: number }>; // session log
}

// ---------------------------------------------------------------------------
// RunRecord — one row of GET /runs (durable history, JSONL mirror of the
// factory-report YAML meta; see §3 /runs).
// ---------------------------------------------------------------------------

export interface RunRecord {
  issueKey: string;
  outcome: RunOutcome;
  reason?: string;
  prUrl: string | null;
  costUsd: number;
  stages: StageMeta[];
  gateStrength: GateStrength;
  guardedPaths: string[];
  finishedAt: number;      // epoch ms
}

// ============================================================================
// END VERBATIM SHARED BLOCK
// ============================================================================
