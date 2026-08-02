import { AlertTriangle, Menu } from "lucide-react";
import { useFactory } from "../../lib/store";
import { relTime } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { isMockMode } from "../../lib/fixtures";
import { Badge } from "../ui/badge";
import { ConnectionDot } from "./ConnectionDot";

const MODE_LABEL = { watch: "WATCH", once: "ONCE", dry: "DRY RUN" } as const;

export function Topbar({ onMenu }: { onMenu?: () => void } = {}) {
  const daemon = useFactory((s) => s.mission.daemon);
  const now = useNow(5000);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-bg1 px-3 md:gap-4 md:px-4">
      <button
        type="button"
        aria-label="Open menu"
        onClick={onMenu}
        className="-ml-1 flex size-11 items-center justify-center rounded-lg text-fg-dim transition-colors duration-100 hover:bg-bg2 hover:text-fg md:hidden"
      >
        <Menu className="size-5" strokeWidth={1.75} />
      </button>
      {daemon ? (
        <Badge variant={daemon.mode === "dry" ? "codex" : "live"} className="tracking-[0.06em]">
          {MODE_LABEL[daemon.mode]}
        </Badge>
      ) : (
        <Badge variant="outline" className="tracking-[0.06em]">NO DAEMON</Badge>
      )}
      {isMockMode() && (
        <Badge variant="claude" className="tracking-[0.06em]">MOCK FEED</Badge>
      )}

      {daemon && (
        // Dense operator stats are desktop-only; on a phone the badges +
        // connection dot carry the state and the numbers live one tap away.
        <div className="hidden items-center gap-4 font-mono text-[11px] text-fg-faint lg:flex">
          <span>
            teams <span className="text-fg-dim">{daemon.teamKeys.join(",")}</span>
          </span>
          <span>
            wip <span className="text-fg-dim">{daemon.wipLimit}</span>
          </span>
          <span>
            interval <span className="text-fg-dim">{daemon.watchIntervalSeconds}s</span>
          </span>
          {daemon.lastTick ? (
            <span>
              tick <span className="text-fg-dim">{relTime(daemon.lastTick.at, now)}</span>
              {" · "}
              <span className="text-fg-dim">{daemon.lastTick.queued}</span> queued
              {" · "}
              <span className="text-fg-dim">{daemon.lastTick.eligible}</span> eligible
              {" · "}
              <span className="text-fg-dim">{daemon.lastTick.processed}</span> processed
              {daemon.lastTick.error && (
                <span className="text-err"> · tick error</span>
              )}
            </span>
          ) : (
            <span>first tick pending</span>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-4">
        {daemon && daemon.backoffSeconds > 0 && (
          <span className="flex items-center gap-1.5 rounded-md border border-live/35 bg-live/10 px-2 py-0.5 font-mono text-[11px] text-live">
            <AlertTriangle className="size-3" strokeWidth={2} />
            Linear rate-limited — backing off {daemon.backoffSeconds}s
          </span>
        )}
        <ConnectionDot />
      </div>
    </header>
  );
}
