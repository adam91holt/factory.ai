import { Link } from "@tanstack/react-router";
import { GitPullRequest } from "lucide-react";
import type { RunView, StageView } from "../../lib/events";
import { secs, usd } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { OutcomeBadge } from "../OutcomeBadge";
import { cn } from "../../lib/utils";

function segClass(s: StageView): string {
  if (s.error) return "bg-err/70";
  if (s.finishedAt === null) return "pulse-live bg-live";
  return "bg-ok/60";
}

export function RunCard({ run }: { run: RunView }) {
  const now = useNow(1000);
  const active = run.status === "active";
  const elapsed = ((run.finishedAt ?? now) - run.startedAt) / 1000;
  const openStage = [...run.stages].reverse().find((s) => s.finishedAt === null);

  return (
    <Link
      to="/runs/$issueKey"
      params={{ issueKey: run.issueKey }}
      className={cn(
        "block rounded-xl border bg-bg1 p-3.5 transition-colors duration-100 hover:bg-bg2",
        active
          ? "border-live/30 shadow-[0_0_18px_-6px] shadow-live/40 hover:border-live/50"
          : "border-line hover:border-line2",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[13px] font-medium text-fg">{run.issueKey}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-dim">{run.title}</span>
        <OutcomeBadge status={run.status} />
      </div>

      <div className="mt-2.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {run.stages.length === 0 ? (
          <span className="flex-1 rounded-full bg-bg2" />
        ) : (
          run.stages.map((s, i) => (
            <span
              key={`${s.stage}-${i}`}
              title={s.stage}
              className={cn("rounded-sm", segClass(s))}
              style={{ flexGrow: Math.max(1, ((s.finishedAt ?? now) - s.startedAt) / 1000) }}
            />
          ))
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-3 font-mono text-[11px] text-fg-faint">
        <span className="text-fg-dim">{run.repo}</span>
        {run.dryRun && <span className="text-codex">dry-run</span>}
        <span>{secs(elapsed)}</span>
        <span className={cn(active && "pulse-live text-live")}>{usd(run.costUsd)}</span>
        {active && openStage && (
          <span className="min-w-0 flex-1 truncate text-right">
            <span className="text-live">{openStage.stage}</span>
            {openStage.lastActivity && <> · {openStage.lastActivity}</>}
          </span>
        )}
        {run.prUrl && (
          <span className="ml-auto flex items-center gap-1 text-ok">
            <GitPullRequest className="size-3" strokeWidth={1.75} />
            PR
          </span>
        )}
        {!active && !run.prUrl && run.reason && (
          <span className="ml-auto min-w-0 max-w-[50%] truncate">{run.reason}</span>
        )}
      </div>
    </Link>
  );
}
