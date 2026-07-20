import { Link } from "@tanstack/react-router";
import type { RunView } from "../../lib/events";
import { usd } from "../../lib/format";

function currentStage(run: RunView): string {
  for (let i = run.stages.length - 1; i >= 0; i--) {
    const s = run.stages[i];
    if (s && s.finishedAt === null) return s.stage;
  }
  return run.stages.length === 0 ? "claiming" : "finishing";
}

export function LiveRunPill({ run }: { run: RunView }) {
  return (
    <Link
      to="/runs/$issueKey"
      params={{ issueKey: run.issueKey }}
      className="group flex items-center gap-2 rounded-lg border border-live/25 bg-live/[0.06] px-2.5 py-2 shadow-[0_0_18px_-6px] shadow-live/40 transition-colors duration-100 hover:border-live/50"
    >
      <span className="pulse-live size-1.5 shrink-0 rounded-full bg-live" />
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-xs text-fg">{run.issueKey}</span>
        <span className="block truncate font-mono text-[10.5px] text-fg-faint">
          {currentStage(run)}
        </span>
      </span>
      <span className="pulse-live font-mono text-[10.5px] text-live">{usd(run.costUsd)}</span>
    </Link>
  );
}
