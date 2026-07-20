import { ExternalLink } from "lucide-react";
import type { QueueIssue } from "../../lib/events";
import { relTime } from "../../lib/format";
import { cn } from "../../lib/utils";

const LANE_KEY_COLOR: Record<QueueIssue["lane"], string> = {
  todo: "text-fg-dim",
  claimed: "text-live",
  parked: "text-parked",
  needs_human: "text-human",
};

function isFactoryLabel(l: string): boolean {
  return l.startsWith("Factory-");
}

export function IssueCard({ issue, now }: { issue: QueueIssue; now: number }) {
  const labels = issue.labels.filter((l) => !isFactoryLabel(l)).slice(0, 3);
  return (
    <div className="group rounded-xl border border-line bg-bg1 p-3.5 transition-colors duration-100 hover:border-line2 hover:bg-bg2">
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn("font-mono text-xs font-medium", LANE_KEY_COLOR[issue.lane])}>
          {issue.identifier}
        </span>
        <span className="font-mono text-[10.5px] text-fg-faint">{relTime(issue.createdAt, now)}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-fg">{issue.title}</div>
      <div className="mt-2 flex items-center gap-1.5">
        {labels.map((l) => (
          <span key={l} className="rounded border border-line px-1 py-px font-mono text-[10px] text-fg-faint">
            {l}
          </span>
        ))}
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-fg-faint opacity-0 transition-opacity duration-100 hover:text-fg group-hover:opacity-100"
          title="Open in Linear"
        >
          <ExternalLink className="size-3" strokeWidth={1.75} />
        </a>
      </div>
    </div>
  );
}
