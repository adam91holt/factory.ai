import type { RunView, StageView } from "../../lib/events";
import { secs, usd } from "../../lib/format";
import { pinLabel } from "../../lib/registers";
import { useNow } from "../../lib/useNow";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";

function isCodex(s: StageView): boolean {
  return s.viaProxy || s.stage === "reviewer-codex";
}

function segmentClass(s: StageView): string {
  if (s.error) return "bg-err/70 border-err";
  if (s.finishedAt === null) return "pulse-live bg-live/80 border-live shadow-[0_0_18px_-6px] shadow-live/40";
  return "bg-ok/55 border-ok/70";
}

export function StageTimeline({ run }: { run: RunView }) {
  const now = useNow(1000);
  if (run.stages.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-4 text-center font-mono text-[11px] text-fg-faint">
        no stages yet — claiming worktree
      </div>
    );
  }
  const t0 = run.startedAt;
  const tEnd = Math.max(
    run.finishedAt ?? now,
    ...run.stages.map((s) => s.finishedAt ?? now),
    t0 + 1000,
  );
  const span = tEnd - t0;
  const pct = (t: number): number => ((t - t0) / span) * 100;

  return (
    <div className="flex flex-col gap-1">
      {run.stages.map((s, i) => {
        const end = s.finishedAt ?? now;
        const left = pct(s.startedAt);
        const width = Math.max(1.2, pct(end) - left);
        const running = s.finishedAt === null;
        return (
          <div key={`${s.stage}-${i}`} className="group grid grid-cols-1 gap-1 sm:grid-cols-[10.5rem_1fr_9rem] sm:items-center sm:gap-3">
            {/* Mobile: name left + meta right on ONE wrapping line; the fixed
                three-column grid left the nowrap meta ~9rem and it plowed into
                the bar (live overlap scan 2026-08-02: "15m 15s" x "$0.4483"). */}
            <div className="flex items-center gap-1.5 sm:justify-end sm:text-right">
              {s.degraded && (
                <Badge variant="parked" className="px-1 text-[9.5px]">DEGRADED</Badge>
              )}
              <span className={cn("font-mono text-[11px]", running ? "text-live" : "text-fg-dim")}>
                {s.stage}
              </span>
              {/* Version pin (issue #16 WP3): which card@version the stage ran
                  with — small, monospace, desktop-only (mobile keeps one line;
                  the ledger below shows it there). Skills pins live in title. */}
              {s.card !== undefined && (
                <span
                  className="hidden font-mono text-[9.5px] text-fg-faint sm:inline"
                  title={s.skills && s.skills.length > 0 ? `skills: ${s.skills.map(pinLabel).join(", ")}` : undefined}
                >
                  {pinLabel(s.card)}
                </span>
              )}
              <span
                className={cn("size-1.5 shrink-0 rounded-full", isCodex(s) ? "bg-codex" : "bg-claude")}
                title={`${s.model}${s.viaProxy ? " · via proxy" : ""}`}
              />
            </div>
            <div className="relative order-3 h-5 rounded-md border border-line/60 bg-bg0 sm:order-none sm:h-7">
              <div
                className={cn("absolute top-1 bottom-1 rounded border", segmentClass(s))}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </div>
            <span className={cn("order-2 -mt-1 font-mono text-[10px] sm:order-none sm:mt-0 sm:whitespace-nowrap sm:text-right", running ? "text-live" : "text-fg-faint")}>
              {secs((end - s.startedAt) / 1000)}
              {s.finishedAt !== null && <> · {s.turns}t · {usd(s.costUsd)}</>}
              {running && s.toolCalls > 0 && <> · {s.toolCalls} tools</>}
            </span>
          </div>
        );
      })}
      <div className="mt-1 grid grid-cols-1 sm:grid-cols-[10.5rem_1fr_9rem] sm:gap-3">
        <span className="hidden sm:block" />
        <div className="flex justify-between font-mono text-[9.5px] text-fg-faint">
          <span>t+0s</span>
          <span>{secs(span / 1000)}</span>
        </div>
        <span className="hidden sm:block" />
      </div>
    </div>
  );
}
