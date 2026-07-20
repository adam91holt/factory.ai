import { useQuery } from "@tanstack/react-query";
import { fetchTelemetry } from "../lib/api";
import { compact, relTime, usd } from "../lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { StatTile } from "../components/telemetry/StatTile";
import { ModelBreakdown } from "../components/telemetry/ModelBreakdown";
import { StageBars } from "../components/telemetry/StageBars";
import { DailySpend } from "../components/telemetry/DailySpend";
import { OutcomeBars } from "../components/telemetry/OutcomeBars";
import { ParkReasons } from "../components/telemetry/ParkReasons";
import { IssueLeaderboard } from "../components/telemetry/IssueLeaderboard";

export function TelemetryPage() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["telemetry"],
    queryFn: fetchTelemetry,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  if (isPending) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <h1 className="text-sm font-bold tracking-wide text-fg">Telemetry</h1>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
        <Skeleton className="h-64 w-full" />
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <h1 className="text-sm font-bold tracking-wide text-fg">Telemetry</h1>
        <div className="rounded-lg border border-err/30 bg-err/5 p-5 text-center font-mono text-[11px] text-err">
          could not load /telemetry — is the daemon running with DASHBOARD_PORT set?
        </div>
      </div>
    );
  }

  const { totals } = data;
  const tokensThrough = totals.tokensIn + totals.tokensOut;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-sm font-bold tracking-wide text-fg">Telemetry</h1>
        <span className="font-mono text-[11px] text-fg-faint">
          {totals.stageRuns} stage runs · {totals.degradedRuns} degraded runs · updated {relTime(data.generatedAt)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Total spend"
          value={usd(totals.costUsd)}
          sub={`${totals.turns} turns · ${totals.stageRuns} stages`}
          accent="live"
        />
        <StatTile
          label="Tokens through"
          value={compact(tokensThrough)}
          sub={`${compact(totals.cacheRead)} cache-read`}
          accent="claude"
        />
        <StatTile
          label="Runs finished"
          value={totals.runs}
          sub={`${totals.prOpen} PRs open`}
          accent="ok"
        />
        <StatTile
          label="Parked"
          value={totals.parked}
          sub={`${totals.needsHuman} need a human`}
          accent="parked"
        />
      </div>

      {/* The star: how many tokens through which model. */}
      <Card>
        <CardHeader>
          <CardTitle>Tokens &amp; cost by model</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <ModelBreakdown models={data.perModel} />
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Spend by stage</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <StageBars stages={data.perStage} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Daily spend · last 7 days</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <DailySpend daily={data.daily} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Outcomes</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <OutcomeBars outcomes={data.outcomes} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top park reasons</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <ParkReasons reasons={data.parkReasons} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cost per issue · top {data.costPerIssue.length}</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <IssueLeaderboard rows={data.costPerIssue} />
        </CardContent>
      </Card>
    </div>
  );
}
