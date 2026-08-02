import { History } from "lucide-react";
import type { ProjectAuditRow } from "../../lib/projects";
import { relTime } from "../../lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

// Config history — project_config_audit rows, newest first. Every write path
// (descriptive save, model row, groundskeeper row, policy transitions) lands
// here in the same statement as the change, so this IS the change log.

export function AuditTrail({ audit, now }: { audit: ProjectAuditRow[]; now: number }) {
  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-1.5">
          <History className="size-3" strokeWidth={1.75} />
          Config history
        </CardTitle>
      </CardHeader>
      <CardContent className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {audit.length === 0 ? (
          <span className="font-mono text-[10.5px] text-fg-faint">no configuration changes recorded yet</span>
        ) : (
          audit.map((row) => (
            <div key={row.id} className="flex items-baseline gap-2 rounded-md px-1 py-1 hover:bg-bg2/60">
              <span className="w-40 shrink-0 truncate font-mono text-[10.5px] text-fg" title={row.field}>
                {row.field}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-dim" title={`${row.oldValue ?? "—"} → ${row.newValue ?? "—"}`}>
                {row.oldValue !== null && <span className="text-fg-faint line-through">{row.oldValue}</span>}
                {row.oldValue !== null && <span className="text-fg-faint"> → </span>}
                {row.newValue ?? "—"}
              </span>
              <span className="shrink-0 font-mono text-[9.5px] text-fg-faint">{row.actor}</span>
              <span className="shrink-0 font-mono text-[9.5px] text-fg-faint">{relTime(row.at, now)}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
