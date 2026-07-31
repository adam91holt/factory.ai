import type {
  BrowserEvidence,
  FactoryEvent,
  GateMeta,
  GateStrength,
  MergeTier,
  RunView,
} from "./events";
import { applyEvent, emptyMission, type FeedItem } from "./store";

// ---------------------------------------------------------------------------
// reconstructRun — fold a run's full durable event stream (GET /run-events)
// into everything the drill-down needs. The RunView comes from the SAME pure
// reducer the daemon and live SSE path use (applyEvent), so a run replayed from
// history renders identically to one watched live. On top of that we surface
// the events the shared MissionState deliberately drops: per-stage token usage
// (modelUsage), EVERY gate round (the reducer keeps only the latest), and the
// write-only merge_decision / deploy / bootstrap events.
// ---------------------------------------------------------------------------

export interface GateRound {
  round: number;
  green: boolean;
  strength: GateStrength;
  gates: GateMeta[];
}

/** Per-model token/cost usage aggregated for one stage. */
export interface StageUsage {
  models: string[];
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface MergeDecision {
  repo: string;
  tier: MergeTier;
  wouldMerge: boolean;
  acted: boolean;
  strength: string;
  browser: BrowserEvidence;
  security: "pass" | "fail" | null;
  cleanStreak: number;
  reasons: string[];
  at: number;
}

export interface DeployEvent {
  repo: string;
  sha: string;
  ok: boolean;
  stage: "skipped" | "deploy" | "smoke";
  reverted: boolean;
  detail: string;
  at: number;
}

export interface Bootstrap {
  repo: string | null;
  ok: boolean;
  reason: string;
  at: number;
}

export interface Reconstruction {
  run: RunView | null;
  feed: FeedItem[];
  gateRounds: GateRound[];
  /** keyed by stage label; last occurrence wins for repeated labels. */
  usageByStage: Record<string, StageUsage>;
  mergeDecisions: MergeDecision[];
  deploys: DeployEvent[];
  bootstrap: Bootstrap | null;
}

const FEED_CAP = 500;

export function reconstructRun(events: FactoryEvent[]): Reconstruction {
  let mission = emptyMission();
  const feed: FeedItem[] = [];
  const gateRounds: GateRound[] = [];
  const usageByStage: Record<string, StageUsage> = {};
  const mergeDecisions: MergeDecision[] = [];
  const deploys: DeployEvent[] = [];
  let bootstrap: Bootstrap | null = null;

  for (const e of events) {
    // Fold into the mission mirror via the shared reducer (unknown event types
    // pass through untouched, exactly as they do daemon-side).
    mission = applyEvent(mission, e);

    switch (e.type) {
      case "run_tool_use":
        feed.push({ seq: e.seq, at: e.at, stage: e.stage, kind: "tool", tool: e.tool, body: e.detail });
        break;
      case "run_assistant_text":
        feed.push({ seq: e.seq, at: e.at, stage: e.stage, kind: "text", body: e.text });
        break;
      case "run_gates":
        gateRounds.push({ round: e.round, green: e.green, strength: e.strength, gates: e.gates });
        break;
      case "run_stage_finished": {
        if (!e.modelUsage) break;
        const u: StageUsage = usageByStage[e.stage] ?? {
          models: [], tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0,
        };
        // A finished stage supersedes any earlier same-label reading.
        const fresh: StageUsage = { models: [], tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
        for (const [model, mu] of Object.entries(e.modelUsage)) {
          if (!fresh.models.includes(model)) fresh.models.push(model);
          fresh.tokensIn += mu.in;
          fresh.tokensOut += mu.out;
          fresh.cacheRead += mu.cacheRead;
          fresh.cacheWrite += mu.cacheWrite;
          fresh.costUsd += mu.costUsd;
        }
        usageByStage[e.stage] = fresh.models.length ? fresh : u;
        break;
      }
      case "merge_decision":
        mergeDecisions.push({
          repo: e.repo, tier: e.tier, wouldMerge: e.wouldMerge, acted: e.acted,
          strength: e.strength, browser: e.browser, security: e.security,
          cleanStreak: e.cleanStreak, reasons: e.reasons, at: e.at,
        });
        break;
      case "deploy_finished":
        deploys.push({
          repo: e.repo, sha: e.sha, ok: e.ok, stage: e.stage,
          reverted: e.reverted, detail: e.detail, at: e.at,
        });
        break;
      case "bootstrap_finished":
        bootstrap = { repo: e.repo, ok: e.ok, reason: e.reason, at: e.at };
        break;
    }
  }

  // Ring-cap the feed the same way the live store does.
  const cappedFeed = feed.length > FEED_CAP ? feed.slice(feed.length - FEED_CAP) : feed;

  const runs = Object.values(mission.runs);
  return {
    run: runs[0] ?? null,
    feed: cappedFeed,
    gateRounds,
    usageByStage,
    mergeDecisions,
    deploys,
    bootstrap,
  };
}
