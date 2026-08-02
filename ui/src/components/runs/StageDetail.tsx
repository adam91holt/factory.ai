import type { RunView, StageView } from "../../lib/events";
import type { StageUsage } from "../../lib/reconstruct";
import { compact, secs, usd } from "../../lib/format";
import { Tooltip } from "../ui/tooltip";
import { cn } from "../../lib/utils";

function isCodex(s: StageView): boolean {
  return s.viaProxy || s.stage === "reviewer-codex";
}

/** Per-stage ledger: model, turns, wall, cost, tool-uses and token usage —
 *  the modelUsage the live MissionState drops, surfaced from /run-events. */
export function StageDetail({
  run,
  usageByStage,
}: {
  run: RunView;
  usageByStage: Record<string, StageUsage>;
}) {
  if (run.stages.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-4 text-center font-mono text-[11px] text-fg-faint">
        no stages recorded
      </div>
    );
  }
  return (
    <>
    {/* Mobile: the 9-column ledger cannot compress below ~600px — token cells
        rendered ON TOP of model names at 390px (live overlap scan 2026-08-02).
        Card per stage instead; the dense table stays for md+. */}
    <div className="flex flex-col gap-2 md:hidden">
      {run.stages.map((s, i) => {
        const u = usageByStage[s.stage];
        const wall = s.finishedAt !== null ? (s.finishedAt - s.startedAt) / 1000 : null;
        return (
          <div key={`m-${s.stage}-${i}`} className="rounded-lg border border-line bg-bg0/60 p-2.5">
            <div className="flex items-center gap-1.5">
              <span className={cn("size-1.5 shrink-0 rounded-full", isCodex(s) ? "bg-codex" : "bg-claude")} />
              <span className="font-mono text-[11.5px] text-fg">{s.stage}</span>
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-fg-faint">{s.model}</span>
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-x-2 gap-y-1 font-mono text-[10.5px] text-fg-dim">
              <span>{s.turns}t</span>
              <span>{wall !== null ? secs(wall) : "…"}</span>
              <span className="text-right">{usd(s.costUsd)}</span>
              <span className="text-fg-faint">tools {s.toolCalls}</span>
              <span className="text-fg-faint">in {u ? compact(u.tokensIn) : "—"}</span>
              <span className="text-right text-fg-faint">out {u ? compact(u.tokensOut) : "—"}</span>
            </div>
          </div>
        );
      })}
    </div>
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="[&>th]:section-label [&>th]:h-6 [&>th]:px-2 [&>th]:font-medium [&>th]:first:pl-0">
            <th>Stage</th>
            <th>Model</th>
            <th className="text-right">Turns</th>
            <th className="text-right">Wall</th>
            <th className="text-right">Cost</th>
            <th className="text-right">Tools</th>
            <th className="text-right">Tok in</th>
            <th className="text-right">Tok out</th>
            <th className="text-right">Cache r/w</th>
          </tr>
        </thead>
        <tbody className="font-mono text-[11px] text-fg-dim">
          {run.stages.map((s, i) => {
            const u = usageByStage[s.stage];
            const wall = s.finishedAt !== null ? (s.finishedAt - s.startedAt) / 1000 : null;
            return (
              <tr key={`${s.stage}-${i}`} className="border-b border-line/50 last:border-0">
                <td className="px-2 py-1 first:pl-0">
                  <span className="flex items-center gap-1.5">
                    <span className={cn("size-1.5 shrink-0 rounded-full", isCodex(s) ? "bg-codex" : "bg-claude")} />
                    <span className={s.error ? "text-err" : s.finishedAt === null ? "text-live" : "text-fg"}>
                      {s.stage}
                    </span>
                    {s.degraded && <span className="text-[9.5px] text-parked">deg</span>}
                  </span>
                </td>
                <td className="px-2 py-1 text-fg-faint">
                  {s.model || "—"}
                  {s.viaProxy && <span className="text-codex"> ·proxy</span>}
                </td>
                <td className="px-2 py-1 text-right">{s.finishedAt === null ? "—" : s.turns}</td>
                <td className="px-2 py-1 text-right">{wall === null ? "—" : secs(wall)}</td>
                <td className="px-2 py-1 text-right text-fg">{s.finishedAt === null ? "—" : usd(s.costUsd)}</td>
                <td className="px-2 py-1 text-right">{s.toolCalls || "—"}</td>
                <td className="px-2 py-1 text-right">{u ? compact(u.tokensIn) : "—"}</td>
                <td className="px-2 py-1 text-right">{u ? compact(u.tokensOut) : "—"}</td>
                <td className="px-2 py-1 text-right text-fg-faint">
                  {u ? (
                    <Tooltip
                      content={`${u.models.join(", ")}\ncache read ${compact(u.cacheRead)} · write ${compact(u.cacheWrite)}`}
                    >
                      <span>{compact(u.cacheRead)}/{compact(u.cacheWrite)}</span>
                    </Tooltip>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}
