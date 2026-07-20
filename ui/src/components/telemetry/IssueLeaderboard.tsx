import { useNavigate } from "@tanstack/react-router";
import type { Telemetry } from "../../lib/telemetry";
import { usd } from "../../lib/format";

type Row = Telemetry["costPerIssue"][number];

export function IssueLeaderboard({ rows }: { rows: Row[] }) {
  const navigate = useNavigate();
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-6 text-center font-mono text-[11px] text-fg-faint">
        no per-issue spend recorded yet
      </div>
    );
  }
  const max = Math.max(...rows.map((r) => r.costUsd), 0.0001);
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r, i) => (
        <button
          key={r.issueKey}
          type="button"
          onClick={() => void navigate({ to: "/runs/$issueKey", params: { issueKey: r.issueKey } })}
          className="group grid grid-cols-[1.25rem_5rem_1fr_auto] items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors duration-100 hover:bg-bg2"
        >
          <span className="text-right font-mono text-[10px] text-fg-faint tabular">{i + 1}</span>
          <span className="font-mono text-[11px] text-fg group-hover:text-live">{r.issueKey}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-bg2">
            <span className="block h-full rounded-full bg-live/60" style={{ width: `${Math.max(2, (r.costUsd / max) * 100)}%` }} />
          </span>
          <span className="whitespace-nowrap text-right font-mono text-[10.5px] text-fg-faint">
            <span className="text-fg tabular">{usd(r.costUsd)}</span>
            {r.runs > 1 && <span className="text-fg-faint"> · {r.runs} runs</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
