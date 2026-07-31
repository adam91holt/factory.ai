// Typed event bus + seq-stamped ring buffer for the mission-control UI.
// Contract: docs/ui-architecture.md §2 (shared block is duplicated verbatim in
// ui/src/lib/events.ts by design). This file imports NOTHING from other src
// files — it is cycle-free; agents.ts / loop.ts / linear.ts / index.ts /
// server.ts all import from it.

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
  // Test-count ratchet evidence ("tests: 631 -> 640" on the dashboard): parsed
  // passing-test counts, null = unknown / not a test gate. Optional so events
  // persisted before the ratchet existed replay unchanged.
  baselineTestCount?: number | null;
  testCount?: number | null;
}

// Gap-5 bookend outcomes: "authored" = intake turned a rough idea into a full
// epic contract and requeued it; "awaiting_answer" = intake posted clarifying
// questions and is waiting on the human; "bootstrapped" = a new project repo was
// created + green-gate-scaffolded + registered.
// B16: "merged" = the merge ladder didn't just open the PR — mergePr actually
// succeeded and the change landed with ZERO human intervention. Distinct from
// "pr_open" (which now means "a human still has to merge it") so the "≤1 human
// intervention" milestone is measurable straight from run_finished/telemetry
// instead of only being visible as a follow-up Linear comment.
export type RunOutcome = "pr_open" | "merged" | "planned" | "parked" | "needs_human" | "aborted" | "stale"
  | "bootstrapped" | "authored" | "awaiting_answer";
// Gap-2: "strong" = a repo whose real app was driven (a passing e2e gate or
// external browser evidence on top of unit tests) — the tier auto-merge requires.
export type GateStrength = "none" | "weak" | "real" | "strong";
export type DaemonMode = "watch" | "once" | "dry";

// Gap-2 evidence-gated merge ladder. Canonical here (events.ts imports nothing,
// so it is the cycle-free home for shared unions); merge-ladder.ts re-exports
// these as its public API.
export type MergeTier = "human" | "shadow" | "auto-low-risk" | "auto";
export type BrowserEvidence = "pass" | "partial" | "fail" | "missing" | "not-required";

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
      error?: string; degraded?: boolean;
      // per-model token/cost usage (short keys: in/out/cacheRead/cacheWrite/costUsd)
      modelUsage?: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number; costUsd: number }> }
  | { type: "run_gates"; issueKey: string; round: number;      // 0 = pre-repair verify
      green: boolean; strength: GateStrength; gates: GateMeta[] }
  | { type: "run_finished"; issueKey: string; outcome: RunOutcome; reason?: string;
      prUrl: string | null; costUsd: number; stages: StageMeta[];
      gateStrength: GateStrength; guardedPaths: string[]; dryRun: boolean;
      // Gap-2 verification-depth signals for the digest; optional so the many
      // early-exit emitters (park / abort / stale) stay unchanged.
      securityVerdict?: "pass" | "fail" | null; browser?: BrowserEvidence }
  // ---- Gap-2 evidence-gated merge ladder (shadow → auto-low-risk → auto) ----
  | { type: "merge_decision"; issueKey: string; repo: string; tier: MergeTier;
      wouldMerge: boolean; acted: boolean; strength: string; browser: BrowserEvidence;
      security: "pass" | "fail" | null; cleanStreak: number; reasons: string[] }
  // ---- Gap-5 post-merge deploy/smoke/revert (postmerge.ts) ----
  | { type: "deploy_started"; repo: string; sha: string; issueKey?: string }
  | { type: "deploy_finished"; repo: string; sha: string; ok: boolean;
      stage: "skipped" | "deploy" | "smoke"; reverted: boolean; detail: string }
  // ---- Gap-5 project bootstrap (bootstrap.ts) ----
  | { type: "bootstrap_finished"; issueKey: string; repo: string | null; ok: boolean; reason: string }
  // ---- Prerequisite-0 (docs/planning/autonomy.md "Build order" item 0): kill
  // switch (B6, control.ts) + rolling daily spend cap (T5, spend-cap.ts). Both
  // funnel through control.ts's enterDrain — this is the ONE event a human (or
  // the spend cap) entering drain mode ever emits, so alerts.ts has a single
  // trigger to watch. `reason` is already bounded/plain text (never raw input).
  | { type: "drain_entered"; trigger: "kill_switch" | "budget_cap"; reason: string }
  // B3: park's own Linear mutations (Parked label / queue transition / Executing-
  // label release) exhausted their bounded retries during processIssue's park()
  // — the ticket may now be STRANDED (still Executing-labeled and/or missing its
  // Parked label) until a human notices or a later orphan sweep recovers it
  // (recoverOrphanedClaims). Daemon-only addition, like drain_entered before it —
  // not mirrored to the UI's copy of this union; it's an operability signal for
  // logs/alerts, not something the dashboard renders today.
  | { type: "park_mutation_failed"; issueKey: string; failures: string[] }
  // #14/#11 resilience: agents.ts's runStage emits this once a stage's primary
  // model has exhausted its bounded transient-error retries (429 / "cooling
  // down" / network drop). `toModel` is the fallback model it failed over to,
  // or null when no fallback was configured/usable — the exact "one 429 took
  // the whole factory down" scenario this exists to surface. Daemon-only, like
  // park_mutation_failed above — not mirrored to the UI's copy of this union.
  | { type: "provider_failover"; stage: string; fromModel: string; toModel: string | null; reason: string };

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
  // `reason` is not just display text: the dashboard's routed-vs-escalated
  // outcomes ledger (ui/src/lib/history.ts classifyOutcome) DERIVES its
  // classification from these recorded strings — zero new event state, so rows
  // written before the ledger existed classify too. That makes the hold/park
  // phrasings in loop.ts a soft contract: reword one and its runs fall back to
  // ESCALATED (fail-noisy, never fail-quiet) until the marker lists catch up.
  reason?: string;
  prUrl: string | null;
  costUsd: number;
  stages: StageMeta[];
  gateStrength: GateStrength;
  guardedPaths: string[];
  finishedAt: number;      // epoch ms
  // Additive history-view enrichment (optional — rows written before this
  // existed simply lack them and the UI degrades gracefully). Populated at
  // write time from the just-folded MissionState run, which already carries
  // repo/title/startedAt and the per-stage models.
  repo?: string;
  title?: string;
  startedAt?: number;      // epoch ms — run wall clock = finishedAt - startedAt
  models?: string[];       // distinct models across the run's stages
}

// ============================================================================
// END VERBATIM SHARED BLOCK
// ============================================================================

// ---------------------------------------------------------------------------
// Daemon-only additions (§2.1 — NOT copied to the UI).
// ---------------------------------------------------------------------------

/** Stream callback payloads runStage forwards to loop.ts (see §4 agents.ts). */
export type AgentStreamEvent =
  | { kind: "stage_started"; stage: string; model: string; viaProxy: boolean }
  | { kind: "tool_use"; stage: string; tool: string; detail: string }
  | { kind: "assistant_text"; stage: string; text: string }
  | { kind: "stage_finished"; stage: string; costUsd: number; turns: number;
      wallSeconds: number; resultText: string; error?: string; degraded?: boolean;
      modelUsage?: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number; costUsd: number }> };

const SUMMARY_KEYS = ["command", "file_path", "pattern", "query", "url", "prompt", "description"] as const;

/** Allowlist-field summary of a tool_use input — codexProxyTest pattern.
 *  Never JSON.stringify the whole input (raw inputs can carry file contents /
 *  ticket text). */
export function summarizeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.replace(/\s+/g, " ").trim().slice(0, 160);
    }
  }
  return "";
}

/** StageResult (structural) → StageMeta: drops `text`, omits absent flags.
 *  Typed structurally so events.ts never imports agents.ts (cycle-free rule). */
export function toStageMeta(s: { label: string; costUsd: number; turns: number;
  wallSeconds: number; error?: string; degraded?: boolean }): StageMeta {
  return {
    label: s.label, costUsd: s.costUsd, turns: s.turns, wallSeconds: s.wallSeconds,
    ...(s.error !== undefined ? { error: s.error } : {}),
    ...(s.degraded !== undefined ? { degraded: s.degraded } : {}),
  };
}

const RING_CAP = 5000;
const ring: FactoryEvent[] = [];
const subscribers = new Set<(e: FactoryEvent) => void>();
let lastSeq = 0;

export const bus: {
  /** Stamps seq (monotonic from 1) + at (Date.now()), stores in the ring
   *  buffer, fans out to subscribers. Synchronous, never throws: a subscriber
   *  exception is caught and console.error'd. */
  emit(body: FactoryEventBody): void;
  /** Events with seq > sinceSeq, oldest first. */
  history(sinceSeq?: number): FactoryEvent[];
  subscribe(fn: (e: FactoryEvent) => void): () => void;
} = {
  emit(body: FactoryEventBody): void {
    // queue_snapshot dedupe: only the latest snapshot matters for replay.
    if (body.type === "queue_snapshot") {
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i]?.type === "queue_snapshot") ring.splice(i, 1);
      }
    }
    lastSeq += 1;
    const event: FactoryEvent = { ...body, seq: lastSeq, at: Date.now() };
    ring.push(event);
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch (error) {
        console.error(`[events] subscriber failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  },
  history(sinceSeq = 0): FactoryEvent[] {
    return ring.filter((e) => e.seq > sinceSeq);
  },
  subscribe(fn: (e: FactoryEvent) => void): () => void {
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  },
};
