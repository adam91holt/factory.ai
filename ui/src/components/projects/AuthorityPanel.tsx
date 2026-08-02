import { Lock } from "lucide-react";
import { authorityRows, type ProjectView } from "../../lib/projects";
import { relTime } from "../../lib/format";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { TierBadge } from "./TierBadge";

// AUTHORITY tier: repos / merge / deploy / smoke / deployEnabled are
// READ-ONLY here by design — the two-tier model (src/project-config.ts). A
// pending revision renders as an awaiting-approval diff (current → proposed)
// with the approve/reject claim buttons; nothing on this panel edits a value
// in force directly.

export function AuthorityPanel({
  project,
  now,
  deciding,
  onDecide,
  decisionError,
}: {
  project: ProjectView;
  now: number;
  deciding: number | null;
  onDecide: (policyId: number, action: "approve" | "reject") => void;
  decisionError: string | null;
}) {
  const rows = authorityRows(project);
  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-1.5">
          <Lock className="size-3" strokeWidth={1.75} />
          Authority — approval required
        </CardTitle>
        <span className="font-mono text-[10px] text-fg-faint">
          in-force values are read-only; a proposed change lands as a pending revision and applies only when you approve it
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-bg0/40 p-2">
          <span className="section-label">merge ladder (evidence-earned, display-only)</span>
          <div className="flex flex-col gap-1">
            {project.ladder.map((l) => (
              <div key={l.repo} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-dim">{l.repo}</span>
                <TierBadge tier={l.tier} cleanStreak={l.cleanStreak} />
              </div>
            ))}
            {project.ladder.length === 0 && (
              <span className="font-mono text-[10.5px] text-fg-faint">no repos declared</span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <div key={row.key} className={`flex flex-col gap-1 rounded-lg border p-2 ${row.pending ? "border-live/40 bg-live/5" : "border-line"}`}>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-faint">{row.key}</span>
                {row.pending && <Badge variant="live">awaiting approval</Badge>}
              </div>
              <div className="break-words font-mono text-[11.5px] text-fg">{row.current}</div>
              {row.pending && (
                <div className="flex flex-col gap-1.5 border-t border-live/20 pt-1.5">
                  <div className="flex items-baseline gap-1.5 font-mono text-[11px]">
                    <span className="text-fg-faint line-through decoration-err/60">{row.current}</span>
                    <span className="text-fg-faint">→</span>
                    <span className="text-live">{row.pending.proposed}</span>
                    <span className="ml-auto text-[10px] text-fg-faint">proposed {relTime(row.pending.createdAt, now)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={deciding === row.pending.policyId}
                      onClick={() => onDecide(row.pending!.policyId, "approve")}
                      className="rounded-md border border-ok/40 bg-ok/10 px-2 py-0.5 font-mono text-[10.5px] text-ok transition-colors duration-100 hover:bg-ok/20 disabled:opacity-50"
                    >
                      approve
                    </button>
                    <button
                      type="button"
                      disabled={deciding === row.pending.policyId}
                      onClick={() => onDecide(row.pending!.policyId, "reject")}
                      className="rounded-md border border-err/40 bg-err/10 px-2 py-0.5 font-mono text-[10.5px] text-err transition-colors duration-100 hover:bg-err/20 disabled:opacity-50"
                    >
                      reject
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {decisionError && (
          <div className="rounded-md border border-err/30 bg-err/5 px-2 py-1.5 font-mono text-[10.5px] text-err">
            {decisionError}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
