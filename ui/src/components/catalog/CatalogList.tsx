import { AlertCircle } from "lucide-react";
import { usd } from "../../lib/format";
import type { UsageStat } from "../../lib/catalog";
import { cn } from "../../lib/utils";

export interface ListRow {
  name: string;
  subtitle: string;
  usage: UsageStat | null;
  enabled?: boolean;
  invalid?: boolean;
}

export function CatalogList({
  rows,
  selected,
  dirtyName,
  onSelect,
  emptyText,
}: {
  rows: ListRow[];
  selected: string | null;
  dirtyName: string | null;
  onSelect: (name: string) => void;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-5 text-center font-mono text-[11px] text-fg-faint">
        {emptyText}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {rows.map((row) => {
        const active = row.name === selected;
        return (
          <button
            key={row.name}
            type="button"
            onClick={() => onSelect(row.name)}
            className={cn(
              "flex flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors duration-100",
              active
                ? "border-line2 bg-bg2"
                : "border-line bg-bg1 hover:border-line2 hover:bg-bg2",
            )}
          >
            <div className="flex items-center gap-2">
              <span className={cn("font-mono text-[12.5px]", active ? "text-fg" : "text-fg-dim")}>
                {row.name}
              </span>
              {row.enabled !== undefined && (
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    row.enabled ? "bg-ok" : "bg-fg-faint/50",
                  )}
                  title={row.enabled ? "enabled" : "disabled"}
                />
              )}
              {row.invalid && (
                <AlertCircle className="size-3 text-err" strokeWidth={2} />
              )}
              {dirtyName === row.name && (
                <span className="size-1.5 rounded-full bg-live pulse-live" title="unsaved changes" />
              )}
            </div>
            {row.subtitle && (
              <span className="truncate text-[11px] leading-tight text-fg-faint">
                {row.subtitle}
              </span>
            )}
            <div className="flex items-center gap-2 font-mono text-[10px] text-fg-faint">
              {row.usage ? (
                <>
                  <span>{row.usage.runs} runs</span>
                  <span className="text-line2">·</span>
                  <span>{usd(row.usage.costUsd)}</span>
                  <span className="text-line2">·</span>
                  <span>{row.usage.avgTurns.toFixed(1)} avg turns</span>
                </>
              ) : (
                <span className="opacity-70">no runs yet</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
