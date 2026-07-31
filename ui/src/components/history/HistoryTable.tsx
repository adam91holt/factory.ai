import { GitPullRequest } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { RunRecord, StageMeta } from "../../lib/events";
import { dateTime, relTime, secs, usd } from "../../lib/format";
import { classifyOutcome } from "../../lib/history";
import { OutcomeBadge } from "../OutcomeBadge";
import { OutcomeClassBadge } from "../OutcomeClassBadge";
import { Tooltip } from "../ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { cn } from "../../lib/utils";
import { useNow } from "../../lib/useNow";

function stageColor(label: string): string {
  if (label === "reviewer-codex") return "bg-codex/70";
  if (label.startsWith("reviewer")) return "bg-claude/70";
  if (label === "fixer" || label.startsWith("verify-repair")) return "bg-parked/70";
  if (label === "scout" || label === "decomposer" || label === "planner" || label === "steward") return "bg-fg-dim/60"; // planning stages — neutral slate
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

function modelFamily(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("gpt") || m.includes("codex") || m.includes("sol")) return "bg-codex";
  return "bg-claude";
}

/** Distinct models as colored dots (claude vs codex family), names on hover. */
function ModelDots({ models }: { models: string[] }) {
  if (models.length === 0) return <span className="text-fg-faint">—</span>;
  return (
    <Tooltip content={models.join("\n")}>
      <span className="flex items-center gap-1">
        {models.map((m) => (
          <span key={m} className={cn("size-1.5 rounded-full", modelFamily(m))} />
        ))}
        <span className="ml-0.5 font-mono text-[10.5px] text-fg-faint">{models.length}</span>
      </span>
    </Tooltip>
  );
}

/** Run wall-clock: exact when startedAt is recorded, else the sum of stage wall
 *  time (an approximation — parallel reviewers overlap), flagged on hover. */
function duration(r: RunRecord): { text: string; approx: boolean } {
  if (typeof r.startedAt === "number" && r.finishedAt > r.startedAt) {
    return { text: secs((r.finishedAt - r.startedAt) / 1000), approx: false };
  }
  const sum = r.stages.reduce((s, x) => s + x.wallSeconds, 0);
  return { text: sum > 0 ? secs(sum) : "—", approx: sum > 0 };
}

export function HistoryTable({ records }: { records: RunRecord[] }) {
  const navigate = useNavigate();
  const now = useNow(30_000);
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
          <TableHead className="w-24">Finished</TableHead>
          <TableHead className="w-16">Issue</TableHead>
          <TableHead className="w-28">Repo</TableHead>
          <TableHead className="w-28">Outcome</TableHead>
          <TableHead className="w-14">Models</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead className="w-14">Gates</TableHead>
          <TableHead className="w-16 text-right">Cost</TableHead>
          <TableHead className="w-14 text-right">Turns</TableHead>
          <TableHead className="w-16 text-right">Wall</TableHead>
          <TableHead className="w-24">Stage cost</TableHead>
          <TableHead className="w-10">PR</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((r) => {
          const turns = r.stages.reduce((s, x) => s + x.turns, 0);
          const degraded = r.stages.some((s) => s.degraded);
          const dur = duration(r);
          // Ledger chip only on the outcomes the old view lumped together
          // (needs_human / parked / aborted / …): that is where routed-vs-
          // escalated carries signal. pr_open's routedness is definitional
          // (human-merge tier), so stamping every PR row would be noise.
          const cls = r.outcome === "pr_open" ? null : classifyOutcome(r.outcome, r.reason);
          return (
            <TableRow
              key={`${r.issueKey}-${r.finishedAt}`}
              className="h-9 cursor-pointer hover:bg-bg2"
              onClick={() => void navigate({ to: "/runs/$issueKey", params: { issueKey: r.issueKey } })}
            >
              <TableCell className="text-[11px]">
                <Tooltip content={dateTime(r.finishedAt)}>
                  <span className="whitespace-nowrap">{relTime(r.finishedAt, now)}</span>
                </Tooltip>
              </TableCell>
              <TableCell className="text-fg">{r.issueKey}</TableCell>
              <TableCell className="text-[11px] text-fg-dim">
                {r.repo ? (
                  <Tooltip content={r.title ?? r.repo}>
                    <span className="block max-w-[7rem] truncate">{r.repo}</span>
                  </Tooltip>
                ) : (
                  <span className="text-fg-faint">—</span>
                )}
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-1">
                  <OutcomeBadge status={r.outcome} />
                  {cls && (
                    <Tooltip content={r.reason ?? "no recorded reason — escalated by default"}>
                      <span><OutcomeClassBadge cls={cls} /></span>
                    </Tooltip>
                  )}
                  {degraded && (
                    <span className="size-1.5 rounded-full bg-parked" title="degraded — fallback reviewer" />
                  )}
                </span>
              </TableCell>
              <TableCell>
                <ModelDots models={r.models ?? []} />
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
                    r.gateStrength === "real" || r.gateStrength === "strong"
                      ? "text-ok"
                      : r.gateStrength === "weak"
                        ? "text-live"
                        : "text-fg-faint",
                  )}
                >
                  {r.gateStrength}
                </span>
              </TableCell>
              <TableCell className="text-right text-fg">{usd(r.costUsd)}</TableCell>
              <TableCell className="text-right">{turns}</TableCell>
              <TableCell className="text-right text-[11px]">
                {dur.approx ? (
                  <Tooltip content="sum of stage wall time (approximate)">
                    <span>~{dur.text}</span>
                  </Tooltip>
                ) : (
                  dur.text
                )}
              </TableCell>
              <TableCell>
                <CostSparkbar stages={r.stages} />
              </TableCell>
              <TableCell>
                {r.prUrl ? (
                  <a
                    href={r.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
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
