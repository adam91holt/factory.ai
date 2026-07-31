import type { DeployEvent } from "../../lib/reconstruct";
import { Badge } from "../ui/badge";

/** Post-merge deploy / smoke / revert outcomes (Gap-5) — write-only until now. */
export function DeployPanel({ deploys }: { deploys: DeployEvent[] }) {
  return (
    <div className="flex flex-col gap-2 p-3.5 pt-2">
      {deploys.map((d, i) => (
        <div key={i} className="rounded-lg border border-line bg-bg0 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="uppercase">{d.stage}</Badge>
            {d.reverted ? (
              <Badge variant="err">REVERTED</Badge>
            ) : d.ok ? (
              <Badge variant="ok">OK</Badge>
            ) : (
              <Badge variant="err">FAILED</Badge>
            )}
            <span className="ml-auto font-mono text-[10.5px] text-fg-faint">
              {d.repo}
              {d.sha && <span className="text-fg-dim"> @{d.sha.slice(0, 7)}</span>}
            </span>
          </div>
          {d.detail && (
            <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed text-fg-dim">{d.detail}</p>
          )}
        </div>
      ))}
    </div>
  );
}
