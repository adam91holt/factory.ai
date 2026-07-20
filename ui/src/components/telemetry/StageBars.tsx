import type { Telemetry } from "../../lib/telemetry";
import { compact, usd } from "../../lib/format";
import { cn } from "../../lib/utils";

type Stage = Telemetry["perStage"][number];

/** Same stage → hue mapping as the History sparkbars, for cross-page recognition. */
function stageBar(label: string): string {
  if (label === "reviewer-codex") return "bg-codex/70";
  if (label.startsWith("reviewer")) return "bg-claude/70";
  if (label.startsWith("design")) return "bg-human/70";
  if (label === "fixer" || label.startsWith("verify-repair")) return "bg-parked/70";
  if (label === "tester") return "bg-ok/70";
  return "bg-live/70"; // implementer
}

export function StageBars({ stages }: { stages: Stage[] }) {
  if (stages.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-6 text-center font-mono text-[11px] text-fg-faint">
        no stage spend recorded yet
      </div>
    );
  }
  const maxCost = Math.max(...stages.map((s) => s.costUsd), 0.0001);

  return (
    <div className="flex flex-col gap-2">
      {stages.map((s) => (
        <div key={s.stage} className="grid grid-cols-[8.5rem_1fr_auto] items-center gap-2.5">
          <span className="truncate text-right font-mono text-[11px] text-fg-dim" title={s.stage}>
            {s.stage}
          </span>
          <div className="h-4 w-full overflow-hidden rounded bg-bg2">
            <div
              className={cn("h-full rounded transition-[width] duration-500", stageBar(s.stage))}
              style={{ width: `${Math.max(1.5, (s.costUsd / maxCost) * 100)}%` }}
            />
          </div>
          <span className="whitespace-nowrap text-right font-mono text-[10.5px] text-fg-faint">
            <span className="text-fg tabular">{usd(s.costUsd)}</span> · {s.calls}× · {compact(s.tokensIn + s.tokensOut)} tok
          </span>
        </div>
      ))}
    </div>
  );
}
