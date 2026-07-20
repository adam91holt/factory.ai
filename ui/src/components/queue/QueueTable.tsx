import { ExternalLink } from "lucide-react";
import type { QueueIssue } from "../../lib/events";
import { ageMs, relTime } from "../../lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { cn } from "../../lib/utils";

const H24 = 24 * 3_600_000;
const H72 = 72 * 3_600_000;

/** Aging bar: amber past 24h, coral past 72h. */
function AgeBar({ createdAt, now }: { createdAt: string; now: number }) {
  const age = ageMs(createdAt, now);
  const frac = Math.min(1, age / H72);
  const color = age > H72 ? "bg-err" : age > H24 ? "bg-live" : "bg-fg-faint";
  const text = age > H72 ? "text-err" : age > H24 ? "text-live" : "text-fg-faint";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-16 overflow-hidden rounded-full bg-bg2">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.max(4, frac * 100)}%` }} />
      </div>
      <span className={cn("font-mono text-[10.5px]", text)}>{relTime(createdAt, now)}</span>
    </div>
  );
}

export function QueueTable({
  issues,
  reasons,
  emptyText,
  now,
}: {
  issues: QueueIssue[];
  reasons: Map<string, string>;
  emptyText: string;
  now: number;
}) {
  if (issues.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-5 text-center font-mono text-[11px] text-fg-faint">
        {emptyText}
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-20">Issue</TableHead>
          <TableHead>Title</TableHead>
          <TableHead className="w-[38%]">Reason</TableHead>
          <TableHead className="w-36">Age</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {issues.map((issue) => (
          <TableRow key={issue.id} className="h-9">
            <TableCell className="text-fg">{issue.identifier}</TableCell>
            <TableCell className="max-w-0 truncate font-sans text-[12.5px] text-fg-dim">
              {issue.title}
            </TableCell>
            <TableCell className="max-w-0 truncate text-[11px]" title={reasons.get(issue.identifier) ?? ""}>
              {reasons.get(issue.identifier) ?? <span className="text-fg-faint">— set before this session</span>}
            </TableCell>
            <TableCell>
              <AgeBar createdAt={issue.createdAt} now={now} />
            </TableCell>
            <TableCell>
              <a
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                className="text-fg-faint transition-colors duration-100 hover:text-fg"
                title="Open in Linear"
              >
                <ExternalLink className="size-3.5" strokeWidth={1.75} />
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
