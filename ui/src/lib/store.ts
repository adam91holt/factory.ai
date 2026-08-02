import { useRef, useSyncExternalStore } from "react";
import type { FactoryEvent, MissionState, RunView, StageView } from "./events";

// ---------------------------------------------------------------------------
// Factory store — a module singleton holding the MissionState mirror plus the
// per-run activity feeds. Every FactoryEvent (live SSE or mock replay) flows
// through ingest() → applyEvent(), the same pure fold the daemon uses for
// GET /state (§5.3 of docs/ui-architecture.md).
// ---------------------------------------------------------------------------

export type Connection = "connecting" | "live" | "reconnecting";

export interface FeedItem {
  seq: number;
  at: number;
  stage: string;
  kind: "tool" | "text";
  tool?: string;
  body: string;
}

export interface UiState {
  connection: Connection;
  mission: MissionState;
  feeds: Record<string, FeedItem[]>; // keyed by issueKey, ring-capped 500/run
}

const FEED_CAP = 500;

/** Finished runs retained in MissionState (newest by finishedAt); active runs
 *  are never pruned. Bounds long-open-tab memory — identical constant and rule
 *  daemon-side (src/server.ts). */
const MAX_FINISHED_RUNS = 50;

export function emptyMission(): MissionState {
  return { seq: 0, daemon: null, board: [], boardAt: null, runs: {}, needsHuman: [] };
}

function freshRun(issueKey: string, at: number): RunView {
  return {
    issueKey,
    title: "",
    repo: "",
    dryRun: false,
    startedAt: at,
    finishedAt: null,
    status: "active",
    stages: [],
    gates: null,
    costUsd: 0,
    prUrl: null,
  };
}

/** Find index of the last unfinished stage with this label (parallel reviewers overlap). */
function openStageIndex(stages: StageView[], label: string): number {
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i];
    if (s !== undefined && s.stage === label && s.finishedAt === null) return i;
  }
  return -1;
}

function withRun(m: MissionState, issueKey: string, at: number, fn: (run: RunView) => RunView): MissionState {
  const existing = m.runs[issueKey] ?? freshRun(issueKey, at);
  return { ...m, runs: { ...m.runs, [issueKey]: fn(existing) } };
}

function pruneFinishedRuns(runs: Record<string, RunView>): Record<string, RunView> {
  const finished = Object.values(runs).filter((r) => r.status !== "active");
  if (finished.length <= MAX_FINISHED_RUNS) return runs;
  finished.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const drop = new Set(finished.slice(MAX_FINISHED_RUNS).map((r) => r.issueKey));
  const next: Record<string, RunView> = {};
  for (const [key, run] of Object.entries(runs)) {
    if (!drop.has(key)) next[key] = run;
  }
  return next;
}

/** Pure fold of one FactoryEvent into MissionState — identical semantics daemon-side. */
export function applyEvent(mission: MissionState, e: FactoryEvent): MissionState {
  let m = mission;
  switch (e.type) {
    case "daemon_started":
      m = {
        ...m,
        daemon: {
          mode: e.mode, teamKeys: e.teamKeys, workRoot: e.workRoot, wipLimit: e.wipLimit,
          watchIntervalSeconds: e.watchIntervalSeconds, budgetUsdPerIssue: e.budgetUsdPerIssue,
          startedAt: e.at, lastTick: null, backoffSeconds: 0,
        },
      };
      break;
    case "daemon_stopped":
      break;
    case "tick_started":
      break;
    case "tick_finished":
      if (m.daemon) {
        m = {
          ...m,
          daemon: {
            ...m.daemon,
            lastTick: {
              at: e.at, queued: e.queued, eligible: e.eligible,
              markedNeedsHuman: e.markedNeedsHuman, processed: e.processed,
              ...(e.error ? { error: e.error } : {}),
            },
            backoffSeconds: e.error ? m.daemon.backoffSeconds : 0,
          },
        };
      }
      break;
    case "linear_backoff":
      if (m.daemon) m = { ...m, daemon: { ...m.daemon, backoffSeconds: e.seconds } };
      break;
    case "queue_snapshot":
      m = { ...m, board: e.issues, boardAt: e.at };
      break;
    case "issue_needs_human":
      m = {
        ...m,
        needsHuman: [
          ...m.needsHuman.filter((n) => n.issueKey !== e.issueKey),
          { issueKey: e.issueKey, reason: e.reason, at: e.at },
        ],
      };
      break;
    case "run_started":
      m = {
        ...m,
        runs: {
          ...m.runs,
          [e.issueKey]: {
            ...freshRun(e.issueKey, e.at),
            title: e.title,
            repo: e.repo,
            dryRun: e.dryRun,
          },
        },
      };
      break;
    case "run_stage_started":
      m = withRun(m, e.issueKey, e.at, (run) => ({
        ...run,
        stages: [
          ...run.stages,
          {
            stage: e.stage, model: e.model, viaProxy: e.viaProxy, startedAt: e.at,
            // Version pins (issue #16 WP3) — kept in lockstep with the daemon
            // reducer in src/server.ts (spread-conditional: old events fold
            // byte-identically).
            ...(e.card !== undefined ? { card: e.card } : {}),
            ...(e.skills !== undefined ? { skills: e.skills } : {}),
            finishedAt: null, costUsd: 0, turns: 0, toolCalls: 0, lastActivity: "",
            resultText: "",
          },
        ],
      }));
      break;
    case "run_tool_use":
      m = withRun(m, e.issueKey, e.at, (run) => {
        const i = openStageIndex(run.stages, e.stage);
        if (i < 0) return run;
        const stages = run.stages.slice();
        const s = stages[i] as StageView;
        stages[i] = {
          ...s,
          toolCalls: s.toolCalls + 1,
          lastActivity: e.detail ? `${e.tool} · ${e.detail}` : e.tool,
        };
        return { ...run, stages };
      });
      break;
    case "run_assistant_text":
      m = withRun(m, e.issueKey, e.at, (run) => {
        const i = openStageIndex(run.stages, e.stage);
        if (i < 0) return run;
        const stages = run.stages.slice();
        const s = stages[i] as StageView;
        stages[i] = { ...s, lastActivity: e.text.slice(0, 120) };
        return { ...run, stages };
      });
      break;
    case "run_stage_finished":
      m = withRun(m, e.issueKey, e.at, (run) => {
        const i = openStageIndex(run.stages, e.stage);
        if (i < 0) return { ...run, costUsd: run.costUsd + e.costUsd };
        const stages = run.stages.slice();
        const s = stages[i] as StageView;
        stages[i] = {
          ...s,
          finishedAt: e.at,
          costUsd: e.costUsd,
          turns: e.turns,
          resultText: e.resultText,
          ...(e.error ? { error: e.error } : {}),
          ...(e.degraded ? { degraded: true } : {}),
        };
        return { ...run, stages, costUsd: run.costUsd + e.costUsd };
      });
      break;
    case "run_gates":
      m = withRun(m, e.issueKey, e.at, (run) => ({
        ...run,
        gates: { round: e.round, green: e.green, strength: e.strength, gates: e.gates },
      }));
      break;
    case "run_finished":
      m = withRun(m, e.issueKey, e.at, (run) => {
        const degradedLabels = new Set(e.stages.filter((s) => s.degraded).map((s) => s.label));
        return {
          ...run,
          status: e.outcome,
          finishedAt: e.at,
          prUrl: e.prUrl,
          costUsd: e.costUsd,
          ...(e.reason ? { reason: e.reason } : {}),
          stages: run.stages.map((s) =>
            degradedLabels.has(s.stage) ? { ...s, degraded: true } : s,
          ),
        };
      });
      m = { ...m, runs: pruneFinishedRuns(m.runs) };
      break;
  }
  return { ...m, seq: e.seq };
}

// ------------------------------------------------------------------ singleton

let state: UiState = { connection: "connecting", mission: emptyMission(), feeds: {} };
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function getState(): UiState {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setConnection(connection: Connection): void {
  if (state.connection === connection) return;
  state = { ...state, connection };
  notify();
}

/** Seed / hard-reset the mission mirror (boot fetchState, daemon restart). */
export function resetMission(mission: MissionState, opts?: { keepFeeds?: boolean }): void {
  state = { ...state, mission, feeds: opts?.keepFeeds ? state.feeds : {} };
  notify();
}

/** Fold one event: mission reducer + per-run activity feed. */
export function ingest(e: FactoryEvent): void {
  const mission = applyEvent(state.mission, e);
  let feeds = state.feeds;
  if (e.type === "run_tool_use" || e.type === "run_assistant_text") {
    const item: FeedItem =
      e.type === "run_tool_use"
        ? { seq: e.seq, at: e.at, stage: e.stage, kind: "tool", tool: e.tool, body: e.detail }
        : { seq: e.seq, at: e.at, stage: e.stage, kind: "text", body: e.text };
    const prev = feeds[e.issueKey] ?? [];
    const next = prev.length >= FEED_CAP ? [...prev.slice(prev.length - FEED_CAP + 1), item] : [...prev, item];
    feeds = { ...feeds, [e.issueKey]: next };
  }
  if (e.type === "run_finished") {
    // Drop feeds for runs the reducer pruned (MAX_FINISHED_RUNS cap).
    const kept: Record<string, FeedItem[]> = {};
    for (const [key, items] of Object.entries(feeds)) {
      if (mission.runs[key]) kept[key] = items;
    }
    feeds = kept;
  }
  state = { ...state, mission, feeds };
  notify();
}

// ---------------------------------------------------------------------- hook

/** Select from the store with per-state memoization (stable across re-renders). */
export function useFactory<T>(selector: (s: UiState) => T): T {
  const cache = useRef<{ state: UiState; selector: (s: UiState) => T; value: T } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    const s = getState();
    if (!cache.current || cache.current.state !== s || cache.current.selector !== selector) {
      cache.current = { state: s, selector, value: selector(s) };
    }
    return cache.current.value;
  });
}
