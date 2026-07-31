import type { FactoryEvent, MissionState, RunRecord } from "./events";
import type { Telemetry } from "./telemetry";
import { emptyMission } from "./store";
import { isMockMode, mockRunEvents, mockRunRecords, mockTelemetry } from "./fixtures";

export async function fetchState(): Promise<MissionState> {
  if (isMockMode()) return emptyMission(); // fixtures replay through the event path
  const res = await fetch("/state");
  if (!res.ok) throw new Error(`GET /state → ${res.status}`);
  return (await res.json()) as MissionState;
}

export async function fetchRuns(): Promise<RunRecord[]> {
  if (isMockMode()) return mockRunRecords();
  const res = await fetch("/runs");
  if (!res.ok) throw new Error(`GET /runs → ${res.status}`);
  return (await res.json()) as RunRecord[];
}

/** Full durable event stream for one run (all sessions) — the reducer in
 *  reconstruct.ts folds these into a RunView plus the write-only merge/deploy
 *  events the live MissionState drops. GET + loopback, read-only. */
export async function fetchRunEvents(issueKey: string): Promise<FactoryEvent[]> {
  if (isMockMode()) return mockRunEvents(issueKey);
  const res = await fetch(`/run-events?key=${encodeURIComponent(issueKey)}`);
  if (!res.ok) throw new Error(`GET /run-events → ${res.status}`);
  return (await res.json()) as FactoryEvent[];
}

export async function fetchTelemetry(): Promise<Telemetry> {
  if (isMockMode()) return mockTelemetry();
  const res = await fetch("/telemetry");
  if (!res.ok) throw new Error(`GET /telemetry → ${res.status}`);
  return (await res.json()) as Telemetry;
}
