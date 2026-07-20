import type { MissionState, RunRecord } from "./events";
import type { Telemetry } from "./telemetry";
import { emptyMission } from "./store";
import { isMockMode, mockRunRecords, mockTelemetry } from "./fixtures";

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

export async function fetchTelemetry(): Promise<Telemetry> {
  if (isMockMode()) return mockTelemetry();
  const res = await fetch("/telemetry");
  if (!res.ok) throw new Error(`GET /telemetry → ${res.status}`);
  return (await res.json()) as Telemetry;
}
