import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useFactory, type FeedItem } from "../../lib/store";
import { clockTime } from "../../lib/format";
import { cn } from "../../lib/utils";

function stageChipClass(stage: string): string {
  if (stage === "reviewer-codex") return "border-codex/35 text-codex";
  if (stage.startsWith("reviewer")) return "border-claude/35 text-claude";
  if (stage === "fixer" || stage.startsWith("verify-repair")) return "border-parked/35 text-parked";
  return "border-live/35 text-live"; // implementer
}

function Row({ item }: { item: FeedItem }) {
  return (
    <div className="feed-in flex items-start gap-2 px-3 py-[5px] leading-[18px] hover:bg-bg2/50">
      <span className="shrink-0 font-mono text-[10px] text-fg-faint">{clockTime(item.at)}</span>
      <span
        className={cn(
          "shrink-0 rounded border bg-transparent px-1 font-mono text-[9.5px] uppercase tracking-wide",
          stageChipClass(item.stage),
        )}
      >
        {item.stage.replace("verify-repair-", "repair-")}
      </span>
      {item.kind === "tool" ? (
        <>
          <span className="shrink-0 font-mono text-[11px] font-medium text-fg">{item.tool}</span>
          <span className="min-w-0 break-all font-mono text-[11px] text-fg-dim">{item.body}</span>
        </>
      ) : (
        <span className="min-w-0 font-mono text-[11px] italic leading-[18px] text-fg-dim/90">
          {item.body}
        </span>
      )}
    </div>
  );
}

export function ToolFeed({ issueKey }: { issueKey: string }) {
  const feed = useFactory((s) => s.feeds[issueKey] ?? []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [feed, follow]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 divide-y divide-line/40 overflow-y-auto"
      >
        {feed.length === 0 ? (
          <div className="p-4 text-center font-mono text-[11px] text-fg-faint">
            no agent activity yet
          </div>
        ) : (
          feed.map((item) => <Row key={item.seq} item={item} />)
        )}
      </div>
      {!follow && (
        <button
          type="button"
          onClick={() => {
            setFollow(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-live/40 bg-bg2 px-2.5 py-1 font-mono text-[10.5px] text-live transition-colors duration-100 hover:bg-bg1"
        >
          <ArrowDown className="size-3" strokeWidth={2} /> live
        </button>
      )}
    </div>
  );
}
