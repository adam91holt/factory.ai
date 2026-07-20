import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** Lightweight CSS tooltip — hover/focus only, no portal, no dependency. */
export function Tooltip({
  content,
  side = "top",
  className,
  children,
}: {
  content: ReactNode;
  side?: "top" | "bottom";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("group/tip relative inline-flex max-w-full", className)} tabIndex={0}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 w-max max-w-[26rem] -translate-x-1/2 rounded-lg",
          "border border-line2 bg-bg2 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-fg-dim",
          "whitespace-pre-wrap opacity-0 transition-opacity duration-100",
          "group-hover/tip:opacity-100 group-focus-visible/tip:opacity-100",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {content}
      </span>
    </span>
  );
}
