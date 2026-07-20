import { useMemo } from "react";
import { diffStat, lineDiff } from "../../lib/catalog";
import { cn } from "../../lib/utils";

// Hand-rolled line diff of the editor draft vs the loaded card (no diff libs).
// Shown behind the "Review changes" toggle so a save is never a blind write.

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);

  if (lines === null) {
    return (
      <div className="rounded-lg border border-dashed border-line p-4 text-center font-mono text-[11px] text-fg-faint">
        content too large to diff inline
      </div>
    );
  }

  const stat = diffStat(lines);
  if (stat.added === 0 && stat.removed === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-4 text-center font-mono text-[11px] text-fg-faint">
        no changes yet — edit the card to see a diff
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg0">
      <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 font-mono text-[10.5px]">
        <span className="text-ok">+{stat.added}</span>
        <span className="text-err">−{stat.removed}</span>
        <span className="text-fg-faint">lines</span>
      </div>
      <div className="max-h-80 overflow-auto">
        <pre className="min-w-full font-mono text-[11px] leading-[1.55]">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "flex gap-2 px-3",
                l.type === "add" && "bg-ok/10 text-ok",
                l.type === "del" && "bg-err/10 text-err",
                l.type === "same" && "text-fg-faint",
              )}
            >
              <span className="select-none opacity-60">
                {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
              </span>
              <span className="whitespace-pre-wrap break-words">{l.text || " "}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
