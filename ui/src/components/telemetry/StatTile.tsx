import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** Headline metric tile — big tabular value over a tracked label, with an
 *  optional sub-line and left accent rule keyed to the metric's meaning. */
export function StatTile({
  label,
  value,
  sub,
  accent = "live",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: "live" | "ok" | "parked" | "human" | "claude";
}) {
  const rule = {
    live: "before:bg-live",
    ok: "before:bg-ok",
    parked: "before:bg-parked",
    human: "before:bg-human",
    claude: "before:bg-claude",
  }[accent];
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-line bg-bg1 px-3.5 py-3",
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
        rule,
      )}
    >
      <div className="section-label">{label}</div>
      <div className="mt-1.5 font-mono text-xl leading-none tracking-tight text-fg tabular">{value}</div>
      {sub !== undefined && (
        <div className="mt-1.5 font-mono text-[10.5px] text-fg-faint">{sub}</div>
      )}
    </div>
  );
}
