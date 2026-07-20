import { GitPullRequest } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { RunRecord, StageMeta } from "../../lib/events";
import { dateTime, usd } from "../../lib/format";
import { OutcomeBadge } from "../OutcomeBadge";
import { Tooltip } from "../ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { cn } from "../../lib/utils";

function stageColor(label: string): string {
  if (label === "reviewer-codex") return "bg-codex/70";
  if (label.startsWith("reviewer")) return "bg-claude/70";
  if (label === "fixer" || label.startsWith("verify-repair")) return "bg-parked/70";
  return "bg-live/70"; // implementer
}

/** Tiny stacked per-stage cost bar. */
function CostSparkbar({ stages }: { stages: StageMeta[] }) {
  const total = stages.reduce((s, x) => s + x.costUsd, 0);
  if (total <= 0) return <div className="h-1.5 w-24 rounded-full bg-bg2" />;
  return (
    <div className="flex h-1.5 w-24 gap-px overflow-hidden rounded-full bg-bg2">
      {stages.map((s, i) => (
        <span
          key={`${s.label}-${i}`}
          title={`${s.label} ${usd(s.costUsd)}`}
          className={cn("h-full", stageColor(s.label))}
          style={{ flexGrow: Math.max(0.02, s.costUsd / total) }}
        />
      ))}
    </div>
  );
}

export function HistoryTable({ records }: { records: RunRecord[] }) {
  const navigate = useNavigate();
  if (records.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-6 text-center font-mono text-[11px] text-fg-faint">
        no completed runs recorded yet
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-28">Finished</TableHead>
          <TableHead className="w-20">Issue</TableHead>
          <TableHead className="w-32">Outcome</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead className="w-16">Gates</TableHead>
          <TableHead className="w-20 text-right">Cost</TableHead>
          <TableHead className="w-16 text-right">Turns</TableHead>
          <TableHead className="w-28">Stage cost</TableHead>
          <TableHead className="w-12">PR</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((r) => {
          const turns = r.stages.reduce((s, x) => s + x.turns, 0);
          const degraded = r.stages.some((s) => s.degraded);
          return (
            <TableRow
              key={`${r.issueKey}-${r.finishedAt}`}
              className="h-9 cursor-pointer hover:bg-bg2"
              onClick={() => void navigate({ to: "/runs/$issueKey", params: { issueKey: r.issueKey } })}
            >
              <TableCell className="text-[11px]">{dateTime(r.finishedAt)}</TableCell>
              <TableCell className="text-fg">{r.issueKey}</TableCell>
              <TableCell>
                <span className="flex items-center gap-1">
                  <OutcomeBadge status={r.outcome} />
                  {degraded && (
                    <span className="size-1.5 rounded-full bg-parked" title="degraded — fallback reviewer" />
                  )}
                </span>
              </TableCell>
              <TableCell className="max-w-0">
                {r.reason ? (
                  <Tooltip content={r.reason} className="max-w-full">
                    <span className="block truncate text-[11px]">{r.reason}</span>
                  </Tooltip>
                ) : (
                  <span className="text-fg-faint">—</span>
                )}
              </TableCell>
              <TableCell>
                <span
                  className={cn(
                    "text-[11px]",
                    r.gateStrength === "real" ? "text-ok" : r.gateStrength === "weak" ? "text-live" : "text-fg-faint",
                  )}
                >
                  {r.gateStrength}
                </span>
              </TableCell>
              <TableCell className="text-right text-fg">{usd(r.costUsd)}</TableCell>
              <TableCell className="text-right">{turns}</TableCell>
              <TableCell>
                <CostSparkbar stages={r.stages} />
              </TableCell>
              <TableCell>
                {r.prUrl ? (
                  <a
                    href={r.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ok transition-colors duration-100 hover:text-fg"
                    title={r.prUrl}
                  >
                    <GitPullRequest className="size-3.5" strokeWidth={1.75} />
                  </a>
                ) : (
                  <span className="text-fg-faint">—</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
