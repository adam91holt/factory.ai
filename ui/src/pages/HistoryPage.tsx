import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunOutcome } from "../lib/events";
import { fetchRuns } from "../lib/api";
import { usd } from "../lib/format";
import { distinctRepos, summarizeRuns } from "../lib/history";
import { HistoryTable } from "../components/history/HistoryTable";
import { OutcomeBadge } from "../components/OutcomeBadge";
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

/** Compact outcome tally shown in the summary strip. */
const SUMMARY_OUTCOMES: RunOutcome[] = ["merged", "pr_open", "parked", "needs_human"];

export function HistoryPage() {
  const [outcome, setOutcome] = useState<Filter>("all");
  const [repo, setRepo] = useState<string>("all");
  const { data, isPending, isError } = useQuery({
    queryKey: ["runs"],
    queryFn: fetchRuns,
    staleTime: 30_000,
  });

  const all = useMemo(() => data ?? [], [data]);
  const repos = useMemo(() => distinctRepos(all), [all]);
  const summary = useMemo(() => summarizeRuns(all), [all]);
  const records = all.filter(
    (r) => (outcome === "all" || r.outcome === outcome) && (repo === "all" || r.repo === repo),
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-sm font-bold tracking-wide text-fg">History</h1>
        {repos.length > 0 && (
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="rounded-md border border-line bg-bg1 px-2 py-0.5 font-mono text-[10.5px] text-fg-dim outline-none hover:border-line2 focus:border-line2"
          >
            <option value="all">all repos</option>
            {repos.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setOutcome(f.key)}
              className={cn(
                "rounded-md border px-2 py-0.5 font-mono text-[10.5px] transition-colors duration-100",
                outcome === f.key
                  ? "border-line2 bg-bg2 text-fg"
                  : "border-transparent text-fg-faint hover:border-line hover:text-fg-dim",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* summary strip — computed from all loaded runs */}
      {data && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line bg-bg1 px-3.5 py-2 font-mono text-[11px]">
          <span className="text-fg-dim">
            <span className="text-fg">{summary.total}</span> runs
          </span>
          <span className="flex items-center gap-2">
            {SUMMARY_OUTCOMES.map((o) => (
              <span key={o} className="flex items-center gap-1">
                <OutcomeBadge status={o} />
                <span className="text-fg-dim">{summary.byOutcome[o] ?? 0}</span>
              </span>
            ))}
          </span>
          <span className="ml-auto flex items-center gap-x-5">
            <span className="text-fg-faint">
              spend <span className="text-fg">{usd(summary.totalCost)}</span>
            </span>
            <span className="text-fg-faint">
              per run <span className="text-fg-dim">{usd(summary.costPerRun)}</span>
            </span>
          </span>
        </div>
      )}

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
