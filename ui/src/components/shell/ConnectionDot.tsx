import { useFactory } from "../../lib/store";
import { cn } from "../../lib/utils";

const LABEL = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
} as const;

export function ConnectionDot() {
  const connection = useFactory((s) => s.connection);
  return (
    <div className="flex items-center gap-1.5" title={`SSE stream: ${LABEL[connection]}`}>
      <span
        className={cn(
          "size-2 rounded-full",
          connection === "live" && "bg-ok shadow-[0_0_8px_-1px] shadow-ok/60",
          connection === "reconnecting" && "pulse-live bg-live",
          connection === "connecting" && "pulse-live bg-fg-faint",
        )}
      />
      <span
        className={cn(
          "font-mono text-[10.5px] uppercase tracking-[0.08em]",
          connection === "live" ? "text-fg-faint" : "text-live",
        )}
      >
        {LABEL[connection]}
      </span>
    </div>
  );
}
