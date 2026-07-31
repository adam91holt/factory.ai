import type { OutcomeClass } from "../lib/history";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";

// Routed-vs-escalated ledger chip (classifyOutcome in lib/history.ts).
// ROUTED is deliberately calm — an outline chip in the dim foreground — because
// it means the system handed off BY DESIGN; ESCALATED uses the warning (parked/
// amber) treatment because it is genuine friction a human should look at.
// err/red is reserved for hard failures (aborted), so escalated sits one notch
// below it, matching how the rest of the dashboard grades severity.
export function OutcomeClassBadge({ cls, className }: { cls: OutcomeClass; className?: string }) {
  return (
    <Badge
      variant={cls === "routed" ? "outline" : "parked"}
      className={cn("tracking-[0.06em]", className)}
    >
      {cls === "routed" ? "ROUTED" : "ESCALATED"}
    </Badge>
  );
}
