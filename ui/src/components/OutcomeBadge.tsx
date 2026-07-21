import type { RunOutcome } from "../lib/events";
import { Badge, type BadgeVariant } from "./ui/badge";
import { cn } from "../lib/utils";

type Status = "active" | RunOutcome;

export const MAP: Record<Status, { label: string; variant: BadgeVariant }> = {
  active: { label: "RUNNING", variant: "live" },
  pr_open: { label: "PR OPEN", variant: "ok" },
  planned: { label: "PLANNED", variant: "ok" },
  parked: { label: "PARKED", variant: "parked" },
  needs_human: { label: "NEEDS HUMAN", variant: "human" },
  aborted: { label: "ABORTED", variant: "err" },
  stale: { label: "STALE", variant: "parked" },
  bootstrapped: { label: "BOOTSTRAPPED", variant: "ok" },
  authored: { label: "AUTHORED", variant: "ok" },
  awaiting_answer: { label: "AWAITING ANSWER", variant: "human" },
};

export function OutcomeBadge({ status, className }: { status: Status; className?: string }) {
  const m = MAP[status];
  return (
    <Badge variant={m.variant} className={cn("tracking-[0.06em]", className)}>
      {status === "active" && <span className="pulse-live inline-block size-1.5 rounded-full bg-live" />}
      {m.label}
    </Badge>
  );
}
