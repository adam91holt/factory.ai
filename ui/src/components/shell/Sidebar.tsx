import { Link } from "@tanstack/react-router";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Activity, Columns3, History, Inbox } from "lucide-react";
import { useFactory } from "../../lib/store";
import { usd } from "../../lib/format";
import { LiveRunPill } from "./LiveRunPill";
import { Separator } from "../ui/separator";

const NAV = [
  { to: "/", label: "Board", icon: Columns3 },
  { to: "/runs", label: "Runs", icon: Activity },
  { to: "/queue", label: "Queue", icon: Inbox },
  { to: "/history", label: "History", icon: History },
] as const;

export function Sidebar() {
  const activeRuns = useFactory((s) =>
    Object.values(s.mission.runs)
      .filter((r) => r.status === "active")
      .sort((a, b) => b.startedAt - a.startedAt),
  );
  const sessionCost = useFactory((s) =>
    Object.values(s.mission.runs).reduce((sum, r) => sum + r.costUsd, 0),
  );
  const attention = useFactory(
    (s) => s.mission.board.filter((i) => i.lane === "needs_human" || i.lane === "parked").length,
  );
  const [pillsRef] = useAutoAnimate({ duration: 220, easing: "ease-out" });

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-bg1">
      <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
        <span className="flex size-7 items-center justify-center rounded-lg border border-live/40 bg-live/10">
          <span className="size-2 rounded-full border-2 border-live" />
        </span>
        <div className="leading-tight">
          <div className="text-[13px] font-bold tracking-wide text-fg">FACTORY</div>
          <div className="section-label">mission control</div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-2.5">
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: to === "/" }}
            className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] font-medium text-fg-dim transition-colors duration-100 hover:bg-bg2 hover:text-fg [&.active]:bg-bg2 [&.active]:text-fg [&.active]:shadow-[inset_2px_0_0_0] [&.active]:shadow-live"
          >
            <Icon className="size-3.5 text-fg-faint" strokeWidth={1.75} />
            {label}
            {label === "Queue" && attention > 0 && (
              <span className="ml-auto rounded-md border border-human/35 bg-human/10 px-1.5 font-mono text-[10.5px] text-human">
                {attention}
              </span>
            )}
          </Link>
        ))}
      </nav>

      <Separator className="mx-4 my-4 w-auto" />

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5">
        <div className="section-label mb-2 px-1.5">
          Active runs{activeRuns.length > 0 ? ` · ${activeRuns.length}` : ""}
        </div>
        <div ref={pillsRef} className="flex flex-col gap-1.5">
          {activeRuns.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line px-2.5 py-3 text-center font-mono text-[10.5px] text-fg-faint">
              idle — no runs in flight
            </div>
          ) : (
            activeRuns.map((run) => <LiveRunPill key={run.issueKey} run={run} />)
          )}
        </div>
      </div>

      <div className="border-t border-line px-4 py-3">
        <div className="section-label">Session spend</div>
        <div className="mt-0.5 font-mono text-sm text-fg">{usd(sessionCost)}</div>
      </div>
    </aside>
  );
}
