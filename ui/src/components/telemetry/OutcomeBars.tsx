import type { Telemetry } from "../../lib/telemetry";
import { cn } from "../../lib/utils";

type Outcomes = Telemetry["outcomes"];

const ROWS: Array<{ key: keyof Outcomes; label: string; bar: string; text: string }> = [
  { key: "merged", label: "Merged", bar: "bg-ok", text: "text-ok" },
  { key: "pr_open", label: "PR open", bar: "bg-ok/60", text: "text-ok" },
  { key: "planned", label: "Planned", bar: "bg-ok/60", text: "text-ok" },
  { key: "parked", label: "Parked", bar: "bg-parked", text: "text-parked" },
  { key: "needs_human", label: "Needs human", bar: "bg-human", text: "text-human" },
  { key: "aborted", label: "Aborted", bar: "bg-err", text: "text-err" },
];

export function OutcomeBars({ outcomes }: { outcomes: Outcomes }) {
  const total = ROWS.reduce((s, r) => s + outcomes[r.key], 0);
  if (total === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-6 text-center font-mono text-[11px] text-fg-faint">
        no completed runs yet
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-bg2">
        {ROWS.filter((r) => outcomes[r.key] > 0).map((r) => (
          <div
            key={r.key}
            className={cn("h-full", r.bar)}
            style={{ width: `${(outcomes[r.key] / total) * 100}%` }}
            title={`${r.label}: ${outcomes[r.key]}`}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {ROWS.filter((r) => outcomes[r.key] > 0).map((r) => (
          <div key={r.key} className="flex items-center gap-1.5 font-mono text-[10.5px]">
            <span className={cn("size-2 shrink-0 rounded-full", r.bar)} />
            <span className="text-fg-dim">{r.label}</span>
            <span className={cn("ml-auto tabular", r.text)}>{outcomes[r.key]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
