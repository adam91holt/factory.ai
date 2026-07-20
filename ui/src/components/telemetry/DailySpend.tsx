import type { Telemetry } from "../../lib/telemetry";
import { compact, usd } from "../../lib/format";
import { cn } from "../../lib/utils";

type Day = Telemetry["daily"][number];

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parts(date: string): { weekday: string; dom: string; isToday: boolean } {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const now = new Date();
  const isToday = dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth() && dt.getDate() === now.getDate();
  return { weekday: WEEKDAY[dt.getDay()] ?? "", dom: String(dt.getDate()), isToday };
}

export function DailySpend({ daily }: { daily: Day[] }) {
  const maxCost = Math.max(...daily.map((d) => d.costUsd), 0.0001);
  const weekTotal = daily.reduce((s, d) => s + d.costUsd, 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-28 items-end gap-1.5">
        {daily.map((d) => {
          const { weekday, dom, isToday } = parts(d.date);
          const h = Math.max(2, (d.costUsd / maxCost) * 100);
          return (
            <div key={d.date} className="group flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="font-mono text-[9px] text-fg-faint opacity-0 transition-opacity group-hover:opacity-100">
                {d.costUsd > 0 ? usd(d.costUsd) : "—"}
              </span>
              <div className="flex w-full flex-1 items-end">
                <div
                  className={cn(
                    "w-full rounded-t-sm transition-[height] duration-500",
                    isToday ? "bg-live" : d.costUsd > 0 ? "bg-live/50" : "bg-bg2",
                  )}
                  style={{ height: `${h}%` }}
                  title={`${d.date} · ${usd(d.costUsd)} · ${compact(d.tokensIn + d.tokensOut)} tok · ${d.runs} runs`}
                />
              </div>
              <div className={cn("text-center font-mono leading-tight", isToday ? "text-live" : "text-fg-faint")}>
                <div className="text-[9.5px]">{weekday}</div>
                <div className="text-[9px] opacity-70">{dom}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-line pt-1.5 text-right font-mono text-[10px] text-fg-faint">
        7-day spend <span className="text-fg-dim tabular">{usd(weekTotal)}</span>
      </div>
    </div>
  );
}
