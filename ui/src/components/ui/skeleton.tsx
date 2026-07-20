import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/** Static placeholder block — pulse is reserved for live telemetry (§6.3). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-md bg-bg2", className)} {...props} />;
}
