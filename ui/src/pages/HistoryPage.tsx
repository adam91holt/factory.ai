import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunOutcome } from "../lib/events";
import { fetchRuns } from "../lib/api";
import { usd } from "../lib/format";
import { HistoryTable } from "../components/history/HistoryTable";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";

type Filter = "all" | RunOutcome;

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "all" },
  { key: "pr_open", label: "pr open" },
  { key: "merged", label: "merged" },
  { key: "parked", label: "parked" },
  { key: "needs_human", label: "needs human" },
  { key: "aborted", label: "aborted" },
];

export function HistoryPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const { data, isPending, isError } = useQuery({
    queryKey: ["runs"],
    queryFn: fetchRuns,
    staleTime: 30_000,
  });

  const records = (data ?? []).filter((r) => filter === "all" || r.outcome === filter);
  const totalCost = (data ?? []).reduce((s, r) => s + r.costUsd, 0);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-bold tracking-wide text-fg">History</h1>
        {data && (
          <span className="font-mono text-[11px] text-fg-faint">
            {data.length} runs · {usd(totalCost)} total
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-md border px-2 py-0.5 font-mono text-[10.5px] transition-colors duration-100",
                filter === f.key
                  ? "border-line2 bg-bg2 text-fg"
                  : "border-transparent text-fg-faint hover:border-line hover:text-fg-dim",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {isPending ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-err/30 bg-err/5 p-5 text-center font-mono text-[11px] text-err">
          could not load /runs — is the daemon running with DASHBOARD_PORT set?
        </div>
      ) : (
        <HistoryTable records={records} />
      )}
    </div>
  );
}
