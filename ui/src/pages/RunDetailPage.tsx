import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, GitPullRequest } from "lucide-react";
import { useFactory } from "../lib/store";
import { fetchRunEvents } from "../lib/api";
import { dateTime, secs } from "../lib/format";
import { reconstructRun } from "../lib/reconstruct";
import { classifyOutcome } from "../lib/history";
import { useNow } from "../lib/useNow";
import { OutcomeBadge } from "../components/OutcomeBadge";
import { OutcomeClassBadge } from "../components/OutcomeClassBadge";
import { CostMeter } from "../components/runs/CostMeter";
import { StageTimeline } from "../components/runs/StageTimeline";
import { StageDetail } from "../components/runs/StageDetail";
import { ToolFeed } from "../components/runs/ToolFeed";
import { FindingsPanel } from "../components/runs/FindingsPanel";
import { GatePanel } from "../components/runs/GatePanel";
import { GateRounds } from "../components/runs/GateRounds";
import { MergeDecisionPanel } from "../components/runs/MergeDecisionPanel";
import { DeployPanel } from "../components/runs/DeployPanel";
import { TicketPanel } from "../components/runs/TicketPanel";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Tooltip } from "../components/ui/tooltip";

export function RunDetailPage({ issueKey }: { issueKey: string }) {
  const liveRun = useFactory((s) => s.mission.runs[issueKey]);
  const now = useNow(1000);

  // Always pull the durable event stream: it carries the write-only merge /
  // deploy / bootstrap events and per-stage token usage the live MissionState
  // drops, and it lets us reconstruct runs from earlier sessions (not in the
  // in-process store) with the exact same reducer.
  const { data: events, isPending: eventsPending } = useQuery({
    queryKey: ["run-events", issueKey],
    queryFn: () => fetchRunEvents(issueKey),
    staleTime: 60_000,
  });
  const recon = useMemo(() => (events ? reconstructRun(events) : null), [events]);

  // Prefer the live store while a run is active this session (SSE keeps its
  // timeline + feed current); otherwise render from the reconstructed history.
  const useLive = !!liveRun && liveRun.status === "active";
  const run = useLive ? liveRun : (recon?.run ?? liveRun ?? null);

  if (!run) {
    if (eventsPending) {
      return (
        <div className="mx-auto max-w-2xl pt-8 text-center font-mono text-[11px] text-fg-faint">
          loading {issueKey}…
        </div>
      );
    }
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 pt-8">
        <div className="text-center">
          <div className="font-mono text-sm text-fg-dim">{issueKey}</div>
          <p className="mt-2 font-mono text-[11px] text-fg-faint">
            no events recorded for this issue — completed runs live in{" "}
            <Link to="/history" className="text-live underline underline-offset-2">History</Link>.
          </p>
          <Link
            to="/runs"
            className="mt-4 inline-flex items-center gap-1.5 font-mono text-[11px] text-fg-dim hover:text-fg"
          >
            <ArrowLeft className="size-3" /> all runs
          </Link>
        </div>
        <TicketPanel issueKey={issueKey} />
      </div>
    );
  }

  const degraded = run.stages.some((s) => s.degraded);
  const active = run.status === "active";
  // Routed-vs-escalated ledger class: prefer the reconstruction (derived from
  // the durable run_finished event) and fall back to classifying the live
  // store's terminal status — a run that just finished this session renders
  // its class before the run-events query lands.
  const outcomeClass = run.status === "active"
    ? null
    : (recon?.outcomeClass ?? classifyOutcome(run.status, run.reason));
  const elapsed = ((run.finishedAt ?? now) - run.startedAt) / 1000;
  const models = [...new Set(run.stages.map((s) => s.model).filter(Boolean))];

  const gateRounds = recon?.gateRounds ?? [];
  const usageByStage = recon?.usageByStage ?? {};
  const mergeDecisions = recon?.mergeDecisions ?? [];
  const deploys = recon?.deploys ?? [];
  const bootstrap = recon?.bootstrap ?? null;

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
            {outcomeClass && (
              <Tooltip
                content={
                  run.reason
                    ? `${outcomeClass}: ${run.reason}`
                    : outcomeClass === "routed"
                      ? "by-design human handoff — the system worked as intended"
                      : "escalated — no recorded reason, classified as friction by default"
                }
              >
                <span><OutcomeClassBadge cls={outcomeClass} /></span>
              </Tooltip>
            )}
            {degraded && <Badge variant="parked">DEGRADED</Badge>}
            {run.dryRun && <Badge variant="codex">DRY RUN</Badge>}
          </div>
          <div className="mt-1 truncate pl-6 text-[13px] text-fg-dim">{run.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 font-mono text-[11px] text-fg-faint">
            {run.repo && <span className="text-fg-dim">{run.repo}</span>}
            <Tooltip content={dateTime(run.startedAt)}>
              <span>{secs(elapsed)} wall</span>
            </Tooltip>
            {run.finishedAt !== null && (
              <Tooltip content={dateTime(run.finishedAt)}>
                <span>finished {dateTime(run.finishedAt)}</span>
              </Tooltip>
            )}
            {models.length > 0 && <span>{models.join(" · ")}</span>}
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
      {/* Mobile/tablet: single column — the 7/5 split at 390px gave each column
    ~180px and wrapped model names letter-by-letter (live review 2026-08-02). */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="flex min-h-0 flex-col gap-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>Stage timeline</CardTitle>
            </CardHeader>
            <div className="px-3.5 pb-3.5">
              <StageTimeline run={run} />
            </div>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>Stage ledger — tokens & tools</CardTitle>
            </CardHeader>
            <div className="px-3.5 pb-3.5">
              <StageDetail run={run} usageByStage={usageByStage} />
            </div>
          </Card>
          <Card className="flex min-h-64 flex-1 flex-col">
            <CardHeader className="pb-1.5">
              <CardTitle>Agent activity</CardTitle>
            </CardHeader>
            <ToolFeed issueKey={run.issueKey} items={useLive ? undefined : recon?.feed} />
          </Card>
        </div>
        <div className="flex min-h-0 flex-col gap-3">
          <Card>
            <CardHeader className="pb-1.5">
              <CardTitle>Review findings</CardTitle>
            </CardHeader>
            <FindingsPanel run={run} />
          </Card>
          <Card>
            <CardHeader className="pb-1.5">
              <CardTitle>Gates {gateRounds.length > 1 && <span className="text-fg-faint">· {gateRounds.length} rounds</span>}</CardTitle>
            </CardHeader>
            {gateRounds.length > 0 ? <GateRounds rounds={gateRounds} /> : <GatePanel run={run} />}
          </Card>
          {mergeDecisions.length > 0 && (
            <Card>
              <CardHeader className="pb-1.5">
                <CardTitle>Merge decision</CardTitle>
              </CardHeader>
              <MergeDecisionPanel decisions={mergeDecisions} />
            </Card>
          )}
          {deploys.length > 0 && (
            <Card>
              <CardHeader className="pb-1.5">
                <CardTitle>Deploy</CardTitle>
              </CardHeader>
              <DeployPanel deploys={deploys} />
            </Card>
          )}
          {bootstrap && (
            <Card>
              <CardHeader className="pb-1.5">
                <CardTitle>Bootstrap</CardTitle>
              </CardHeader>
              <div className="flex items-center gap-2 p-3.5 pt-2">
                <Badge variant={bootstrap.ok ? "ok" : "err"}>{bootstrap.ok ? "OK" : "FAILED"}</Badge>
                <span className="font-mono text-[11px] text-fg-dim">{bootstrap.reason}</span>
              </div>
            </Card>
          )}
          <TicketPanel issueKey={run.issueKey} />
        </div>
      </div>
    </div>
  );
}
