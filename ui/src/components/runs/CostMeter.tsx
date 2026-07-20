import { usd } from "../../lib/format";
import { useFactory } from "../../lib/store";
import { cn } from "../../lib/utils";

const FALLBACK_BUDGET_USD = 25; // MAX_BUDGET_USD_PER_ISSUE default, until daemon_started arrives

export function CostMeter({ costUsd, active }: { costUsd: number; active: boolean }) {
  const budgetUsd = useFactory((s) => s.mission.daemon?.budgetUsdPerIssue ?? FALLBACK_BUDGET_USD);
  const frac = Math.min(1, costUsd / budgetUsd);
  const hot = frac > 0.85;
  return (
    <div className="w-44">
      <div className="flex items-baseline justify-between font-mono text-[10.5px]">
        <span className={cn("text-fg-dim", active && "pulse-live text-live", hot && "text-err")}>
          {usd(costUsd)}
        </span>
        <span className="text-fg-faint">/ ${budgetUsd} cap</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg2">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", hot ? "bg-err" : "bg-live")}
          style={{ width: `${Math.max(1.5, frac * 100)}%` }}
        />
      </div>
    </div>
  );
}
