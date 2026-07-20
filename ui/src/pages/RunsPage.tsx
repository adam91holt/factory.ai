import { useFactory } from "../lib/store";
import { RunCard } from "../components/runs/RunCard";

export function RunsPage() {
  const runs = useFactory((s) =>
    Object.values(s.mission.runs).sort((a, b) => {
      const aActive = a.status === "active" ? 0 : 1;
      const bActive = b.status === "active" ? 0 : 1;
      return aActive - bActive || b.startedAt - a.startedAt;
    }),
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <h1 className="text-sm font-bold tracking-wide text-fg">
        Runs <span className="font-mono text-[11px] font-normal text-fg-faint">this session</span>
      </h1>
      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-8 text-center font-mono text-[11px] text-fg-faint">
          no pipeline runs this session — the daemon claims eligible FAC issues on its next tick
        </div>
      ) : (
        runs.map((run) => <RunCard key={run.issueKey} run={run} />)
      )}
    </div>
  );
}
