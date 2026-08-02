import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Workflow } from "lucide-react";
import { fetchEpicDag, mockDagContext, type DagContext } from "../../lib/epicdag";
import { isMockMode } from "../../lib/fixtures";
import { useFactory } from "../../lib/store";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { DagCanvas } from "./DagView";

const EPIC_LABEL = "Factory-Epic";
const KEY_RE = /^[A-Z]+-\d+$/;

// The epic DAG: nodes are the epic's child tickets in live scheduling lanes,
// solid edges are declared depends_on, dashed amber links are touches-overlap
// serialisation. Lane/edge classification is derived CLIENT-SIDE from data
// the dashboard serves (ONE /epic-dag read + MissionState) — the daemon's
// scheduler stays the only authority; this view just explains it. The
// refetch is deliberately slow (60s): each refetch is one Linear GraphQL
// request on the daemon's own API key, and child meta rarely changes.

export function EpicDagPanel({ drain }: { drain: { draining: boolean; reason: string | null } }) {
  // Board epics (label-derived) offer a quick pick; any TEAM-123 key works too.
  const boardEpics = useFactory((s) =>
    s.mission.board.filter((i) => i.labels.includes(EPIC_LABEL)).map((i) => ({ identifier: i.identifier, title: i.title })),
  );
  const inFlightKeys = useFactory((s) =>
    Object.values(s.mission.runs).filter((r) => r.status === "active").map((r) => r.issueKey),
  );
  const wipLimit = useFactory((s) => s.mission.daemon?.wipLimit ?? null);

  const mock = isMockMode();
  const [input, setInput] = useState(mock ? "FAC-30" : "");
  const [epicKey, setEpicKey] = useState(mock ? "FAC-30" : "");
  const validKey = KEY_RE.test(epicKey);

  const { data, isPending, isError } = useQuery({
    queryKey: ["epic-dag", epicKey],
    queryFn: () => fetchEpicDag(epicKey),
    enabled: validKey,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });

  const ctx: DagContext = useMemo(
    () => (mock
      ? mockDagContext()
      : {
          inFlightKeys,
          wipLimit,
          activeRunCount: inFlightKeys.length,
          draining: drain.draining,
          drainReason: drain.reason,
        }),
    [mock, inFlightKeys, wipLimit, drain.draining, drain.reason],
  );

  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-1.5">
          <Workflow className="size-3" strokeWidth={1.75} />
          Epic DAG
        </CardTitle>
        <span className="font-mono text-[10px] text-fg-faint">
          child tickets in live scheduling lanes — solid = depends_on, dashed ∩ = serialised by touches overlap
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            className="w-36 rounded-md border border-line bg-bg0 px-2 py-1 font-mono text-[11px] text-fg outline-none transition-colors duration-100 focus:border-live/60"
            placeholder="epic key — FAC-30"
            value={input}
            onChange={(e) => setInput(e.target.value.trim().toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter" && KEY_RE.test(input)) setEpicKey(input); }}
          />
          <button
            type="button"
            disabled={!KEY_RE.test(input)}
            onClick={() => setEpicKey(input)}
            className="rounded-md border border-line px-2 py-1 font-mono text-[10.5px] text-fg-dim transition-colors duration-100 hover:bg-bg2 disabled:opacity-50"
          >
            load
          </button>
          {boardEpics.map((e) => (
            <button
              key={e.identifier}
              type="button"
              onClick={() => { setInput(e.identifier); setEpicKey(e.identifier); }}
              title={e.title}
              className={`rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors duration-100 ${
                e.identifier === epicKey
                  ? "border-live/50 bg-live/10 text-live"
                  : "border-line text-fg-dim hover:bg-bg2"
              }`}
            >
              {e.identifier}
            </button>
          ))}
        </div>

        {drain.draining && (
          <div className="rounded-md border border-parked/35 bg-parked/5 px-2 py-1.5 font-mono text-[10.5px] text-parked">
            drain mode — the daemon is not claiming new work{drain.reason ? ` (${drain.reason})` : ""}; every ready node stays deferred.
          </div>
        )}

        {!validKey ? (
          <div className="rounded-lg border border-dashed border-line px-6 py-8 text-center font-mono text-[11px] text-fg-faint">
            pick an epic above (or type its key) to see its child DAG
          </div>
        ) : isPending ? (
          <div className="flex gap-3">
            <Skeleton className="h-40 w-1/3" />
            <Skeleton className="h-40 w-1/3" />
            <Skeleton className="h-40 w-1/3" />
          </div>
        ) : isError || !data ? (
          <div className="rounded-lg border border-err/30 bg-err/5 p-4 text-center font-mono text-[11px] text-err">
            could not load {epicKey} — the /epic-dag endpoint may be unavailable or the key wrong
          </div>
        ) : (
          <>
            <div className="font-mono text-[11px] text-fg-dim">
              <span className="text-fg">{data.epic.identifier}</span> · {data.epic.title}
            </div>
            <DagCanvas tickets={data.tickets} ctx={ctx} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
