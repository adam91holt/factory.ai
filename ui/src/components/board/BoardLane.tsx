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
    <section className="flex min-w-0 flex-col rounded-xl border border-line bg-bg0 md:min-h-0 md:flex-1">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className={cn("size-1.5 rounded-full", accent)} />
        <span className="text-[11.5px] font-medium tracking-wide text-fg-dim">{title}</span>
        <span className="ml-auto rounded-md border border-line bg-bg1 px-1.5 font-mono text-[10.5px] text-fg-faint">
          {count}
        </span>
      </header>
      <div ref={listRef} className="flex flex-col gap-2 p-2 md:min-h-0 md:flex-1 md:overflow-y-auto">
        {children}
      </div>
    </section>
  );
}
