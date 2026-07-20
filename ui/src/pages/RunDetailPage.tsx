import { Link } from "@tanstack/react-router";
import { ArrowLeft, GitPullRequest } from "lucide-react";
import { useFactory } from "../lib/store";
import { secs } from "../lib/format";
import { useNow } from "../lib/useNow";
import { OutcomeBadge } from "../components/OutcomeBadge";
import { CostMeter } from "../components/runs/CostMeter";
import { StageTimeline } from "../components/runs/StageTimeline";
import { ToolFeed } from "../components/runs/ToolFeed";
import { FindingsPanel } from "../components/runs/FindingsPanel";
import { GatePanel } from "../components/runs/GatePanel";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

export function RunDetailPage({ issueKey }: { issueKey: string }) {
  const run = useFactory((s) => s.mission.runs[issueKey]);
  const now = useNow(1000);

  if (!run) {
    return (
      <div className="mx-auto max-w-xl pt-16 text-center">
        <div className="font-mono text-sm text-fg-dim">{issueKey}</div>
        <p className="mt-2 font-mono text-[11px] text-fg-faint">
          no run for this issue in the current daemon session — completed runs from earlier
          sessions live in{" "}
          <Link to="/history" className="text-live underline underline-offset-2">History</Link>.
        </p>
        <Link
          to="/runs"
          className="mt-4 inline-flex items-center gap-1.5 font-mono text-[11px] text-fg-dim hover:text-fg"
        >
          <ArrowLeft className="size-3" /> all runs
        </Link>
      </div>
    );
  }

  const degraded = run.stages.some((s) => s.degraded);
  const active = run.status === "active";
  const elapsed = ((run.finishedAt ?? now) - run.startedAt) / 1000;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* header */}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <Link to="/runs" className="text-fg-faint transition-colors duration-100 hover:text-fg">
              <ArrowLeft className="size-3.5" strokeWidth={1.75} />
            </Link>
            <span className="font-mono text-base font-medium text-fg">{run.issueKey}</span>
            <OutcomeBadge status={run.status} />
            {degraded && <Badge variant="parked">DEGRADED</Badge>}
            {run.dryRun && <Badge variant="codex">DRY RUN</Badge>}
          </div>
          <div className="mt-1 truncate pl-6 text-[13px] text-fg-dim">{run.title}</div>
          <div className="mt-1 flex items-center gap-3 pl-6 font-mono text-[11px] text-fg-faint">
            <span>{run.repo}</span>
            <span>{secs(elapsed)}</span>
            {run.reason && <span className="truncate text-parked">{run.reason}</span>}
            {run.prUrl && (
              <a
                href={run.prUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-ok transition-colors duration-100 hover:text-fg"
              >
                <GitPullRequest className="size-3" strokeWidth={1.75} />
                {run.prUrl.replace("https://github.com/", "")}
              </a>
            )}
          </div>
        </div>
        <CostMeter costUsd={run.costUsd} active={active} />
      </div>

      {/* body */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-3">
        <div className="flex min-h-0 flex-col gap-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>Stage timeline</CardTitle>
            </CardHeader>
            <div className="px-3.5 pb-3.5">
              <StageTimeline run={run} />
            </div>
          </Card>
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="pb-1.5">
              <CardTitle>Agent activity</CardTitle>
            </CardHeader>
            <ToolFeed issueKey={run.issueKey} />
          </Card>
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <Card>
            <CardHeader className="pb-1.5">
              <CardTitle>Review findings</CardTitle>
            </CardHeader>
            <FindingsPanel run={run} />
          </Card>
          <Card>
            <CardHeader className="pb-1.5">
              <CardTitle>Gates</CardTitle>
            </CardHeader>
            <GatePanel run={run} />
          </Card>
        </div>
      </div>
    </div>
  );
}
