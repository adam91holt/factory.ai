import { History, RotateCcw } from "lucide-react";
import type { RegisterVersionInfo } from "../../lib/registers";
import { relTime } from "../../lib/format";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";

// Version history for one register entry (issue #16 WP3): who/when per
// version, newest first, with one-tap rollback ("re-enable version N") on
// every inactive row. Buttons keep a 44px touch target under md.

export function VersionHistory({
  versions,
  rollingBack,
  onRollback,
}: {
  versions: RegisterVersionInfo[];
  /** The version currently being rolled back (spinner state), or null. */
  rollingBack: number | null;
  onRollback: (version: number) => void;
}) {
  if (versions.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="section-label flex items-center gap-1.5">
        <History className="size-3" strokeWidth={1.75} />
        Version history · register
      </span>
      <div className="flex flex-col divide-y divide-line/50 rounded-lg border border-line bg-bg0/60">
        {versions.map((v) => (
          <div key={v.version} className="flex min-h-11 items-center gap-2.5 px-2.5 py-1.5 md:min-h-0">
            <span className={cn("font-mono text-[11.5px]", v.active ? "text-fg" : "text-fg-dim")}>
              v{v.version}
            </span>
            {v.active && <Badge variant="ok" className="px-1 text-[9.5px]">active</Badge>}
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-faint">
              {v.createdBy} · {relTime(v.createdAt)}
            </span>
            {!v.active && (
              <button
                type="button"
                onClick={() => onRollback(v.version)}
                disabled={rollingBack !== null}
                className="flex min-h-9 items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[10.5px] text-fg-dim transition-colors duration-100 hover:border-line2 hover:text-fg disabled:opacity-40 md:min-h-0"
              >
                <RotateCcw className="size-3" strokeWidth={1.75} />
                {rollingBack === v.version ? "Activating…" : "Activate"}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
