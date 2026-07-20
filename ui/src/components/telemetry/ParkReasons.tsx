import type { Telemetry } from "../../lib/telemetry";
import { cn } from "../../lib/utils";

type Reason = Telemetry["parkReasons"][number];

export function ParkReasons({ reasons }: { reasons: Reason[] }) {
  if (reasons.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-6 text-center font-mono text-[11px] text-fg-faint">
        nothing parked — clean run
      </div>
    );
  }
  const max = Math.max(...reasons.map((r) => r.count), 1);
  return (
    <div className="flex flex-col gap-2">
      {reasons.map((r) => (
        <div key={r.reason} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-fg-dim" title={r.reason}>
              {r.reason}
            </span>
            <span className="font-mono text-[10.5px] text-parked tabular">×{r.count}</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-bg2">
            <div className={cn("h-full rounded-full bg-parked/70")} style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
