import { Link, useNavigate } from "@tanstack/react-router";
import { GitPullRequest } from "lucide-react";
import type { RunView } from "../lib/events";
import { secs, usd } from "../lib/format";
import { useFactory } from "../lib/store";
import { useNow } from "../lib/useNow";
import { BoardLane } from "../components/board/BoardLane";
import { IssueCard } from "../components/board/IssueCard";
import { cn } from "../lib/utils";

function ExecutingCard({ run, now }: { run: RunView; now: number }) {
  const stage = [...run.stages].reverse().find((s) => s.finishedAt === null);
  return (
    <Link
      to="/runs/$issueKey"
      params={{ issueKey: run.issueKey }}
      className="block rounded-xl border border-live/30 bg-bg1 p-3.5 shadow-[0_0_18px_-6px] shadow-live/40 transition-colors duration-100 hover:border-live/50 hover:bg-bg2"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 font-mono text-xs font-medium text-live">
          <span className="pulse-live size-1.5 rounded-full bg-live" />
          {run.issueKey}
        </span>
        <span className="pulse-live font-mono text-[10.5px] text-live">{usd(run.costUsd)}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-fg">{run.title}</div>
      <div className="mt-2 flex items-center justify-between font-mono text-[10.5px] text-fg-faint">
        <span className="truncate text-live/90">{stage ? stage.stage : "claiming"}</span>
        <span>{secs((now - run.startedAt) / 1000)}</span>
      </div>
    </Link>
  );
}

function DeliveredCard({ run }: { run: RunView }) {
  const navigate = useNavigate();
  const open = () => void navigate({ to: "/runs/$issueKey", params: { issueKey: run.issueKey } });
  // Not a <Link>: the PR chip is a real <a>, and anchors must never nest.
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="block cursor-pointer rounded-xl border border-line bg-bg1 p-3.5 transition-colors duration-100 hover:border-ok/40 hover:bg-bg2"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 font-mono text-xs font-medium text-ok">
          {run.issueKey}
          {run.dryRun && (
            <span className="rounded border border-codex/35 bg-codex/10 px-1 font-mono text-[9.5px] leading-4 text-codex">
              DRY
            </span>
          )}
        </span>
        <span className="font-mono text-[10.5px] text-fg-faint">{usd(run.costUsd)}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-fg">{run.title}</div>
      {run.prUrl && (
        <a
          href={run.prUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-2 flex w-fit items-center gap-1.5 rounded-md border border-ok/35 bg-ok/10 px-1.5 py-0.5 font-mono text-[10.5px] text-ok transition-colors duration-100 hover:bg-ok/20"
        >
          <GitPullRequest className="size-3" strokeWidth={1.75} />
          {run.prUrl.split("/").slice(-2).join("/")}
        </a>
      )}
    </div>
  );
}

export function BoardPage() {
  const board = useFactory((s) => s.mission.board);
  const boardAt = useFactory((s) => s.mission.boardAt);
  const watchInterval = useFactory((s) => s.mission.daemon?.watchIntervalSeconds ?? 60);
  const runs = useFactory((s) => Object.values(s.mission.runs));
  const now = useNow(1000);

  const todo = board.filter((i) => i.lane === "todo");
  const needsHuman = board.filter((i) => i.lane === "needs_human");
  const parked = board.filter((i) => i.lane === "parked");
  const executing = runs
    .filter((r) => r.status === "active")
    .sort((a, b) => a.startedAt - b.startedAt);
  const delivered = runs
    .filter((r) => r.status === "pr_open")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const stale = boardAt !== null && now - boardAt > 2 * watchInterval * 1000;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-bold tracking-wide text-fg">Board</h1>
        {stale && (
          <span className="rounded-md border border-line2 bg-bg2 px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-fg-faint">
            snapshot stale
          </span>
        )}
        {boardAt === null && (
          <span className="font-mono text-[11px] text-fg-faint">waiting for first queue snapshot…</span>
        )}
      </div>
      {/* Lanes get a floor width; narrow windows scroll horizontally inside
          this wrapper (body itself is overflow: hidden). */}
      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className={cn("grid h-full min-w-[1080px] grid-cols-5 gap-3", stale && "opacity-90")}>
          <BoardLane title="Todo" accent="bg-fg-faint" count={todo.length}>
            {todo.map((i) => <IssueCard key={i.id} issue={i} now={now} />)}
          </BoardLane>
          <BoardLane title="Needs Human" accent="bg-human" count={needsHuman.length}>
            {needsHuman.map((i) => <IssueCard key={i.id} issue={i} now={now} />)}
          </BoardLane>
          <BoardLane title="Parked" accent="bg-parked" count={parked.length}>
            {parked.map((i) => <IssueCard key={i.id} issue={i} now={now} />)}
          </BoardLane>
          <BoardLane title="Executing" accent="bg-live" count={executing.length}>
            {executing.map((r) => <ExecutingCard key={r.issueKey} run={r} now={now} />)}
          </BoardLane>
          <BoardLane title="Delivered" accent="bg-ok" count={delivered.length}>
            {delivered.map((r) => <DeliveredCard key={r.issueKey} run={r} />)}
          </BoardLane>
        </div>
      </div>
    </div>
  );
}
