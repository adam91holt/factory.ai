import type { ReactNode } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { cn } from "../../lib/utils";

export function BoardLane({
  title,
  accent,
  count,
  children,
}: {
  title: string;
  accent: string; // tailwind bg-* class for the lane dot
  count: number;
  children: ReactNode;
}) {
  const [listRef] = useAutoAnimate({ duration: 220, easing: "ease-out" });
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-line bg-bg0">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className={cn("size-1.5 rounded-full", accent)} />
        <span className="text-[11.5px] font-medium tracking-wide text-fg-dim">{title}</span>
        <span className="ml-auto rounded-md border border-line bg-bg1 px-1.5 font-mono text-[10.5px] text-fg-faint">
          {count}
        </span>
      </header>
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {children}
      </div>
    </section>
  );
}
