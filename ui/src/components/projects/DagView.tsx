import { useMemo } from "react";
import { buildEpicDag, type DagContext, type DagLane, type DagTicket } from "../../lib/epicdag";

// Client-side DAG canvas: HTML nodes absolutely positioned over one SVG edge
// layer — no graph library, no new deps. Dependency edges are solid, arrowed
// hairlines; touches-overlap serialisation is a VISUALLY DISTINCT dashed amber
// link with a ∩ marker and no arrowhead — it is a scheduling constraint, not a
// dependency, and must never read as one.

const NODE_W = 184;
const NODE_H = 72;
const GAP_X = 56;
const GAP_Y = 18;
const PAD = 14;

const LANE_STYLE: Record<DagLane, { label: string; border: string; text: string; chip: string }> = {
  "ready": { label: "ready", border: "border-ok/45", text: "text-ok", chip: "border-ok/35 bg-ok/10 text-ok" },
  "in-flight": { label: "in flight", border: "border-live/55", text: "text-live", chip: "border-live/35 bg-live/10 text-live" },
  "deferred": { label: "deferred", border: "border-parked/45", text: "text-parked", chip: "border-parked/35 bg-parked/10 text-parked" },
  "blocked": { label: "blocked", border: "border-line2", text: "text-fg-dim", chip: "border-line2 bg-transparent text-fg-dim" },
  "needs-human": { label: "needs human", border: "border-human/45", text: "text-human", chip: "border-human/35 bg-human/10 text-human" },
  "done": { label: "done", border: "border-line", text: "text-fg-faint", chip: "border-line bg-bg2 text-fg-faint" },
};

function nodeXY(layer: number, row: number): { x: number; y: number } {
  return { x: PAD + layer * (NODE_W + GAP_X), y: PAD + row * (NODE_H + GAP_Y) };
}

export function DagLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 font-mono text-[10px] text-fg-faint">
      {(Object.keys(LANE_STYLE) as DagLane[]).map((lane) => (
        <span key={lane} className="flex items-center gap-1">
          <span className={`inline-block size-2 rounded-full border ${LANE_STYLE[lane].chip}`} />
          {LANE_STYLE[lane].label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke="var(--color-line2)" strokeWidth="1.5" /></svg>
        depends on
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke="var(--color-live)" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
        serialised — touches overlap (constraint, not a dependency)
      </span>
    </div>
  );
}

export function DagCanvas({ tickets, ctx }: { tickets: DagTicket[]; ctx: DagContext }) {
  const view = useMemo(() => buildEpicDag(tickets, ctx), [tickets, ctx]);
  const pos = useMemo(
    () => new Map(view.nodes.map((n) => [n.identifier, nodeXY(n.layer, n.row)])),
    [view],
  );

  if (view.nodes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center font-mono text-[11px] text-fg-faint">
        no child tickets on this epic yet
      </div>
    );
  }

  const width = PAD * 2 + view.layerCount * NODE_W + (view.layerCount - 1) * GAP_X;
  const height = PAD * 2 + view.maxRows * NODE_H + (view.maxRows - 1) * GAP_Y;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="overflow-x-auto rounded-lg border border-line bg-bg0/50">
        <div className="relative" style={{ width, height, minWidth: width }}>
          <svg className="absolute inset-0" width={width} height={height} aria-hidden>
            <defs>
              <marker id="dag-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0.5 L7.5,4 L0,7.5 Z" fill="var(--color-line2)" />
              </marker>
            </defs>
            {view.edges.map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const sameColumn = a.x === b.x;
              const x1 = sameColumn ? a.x + NODE_W / 2 : a.x + NODE_W;
              const y1 = sameColumn ? a.y + NODE_H : a.y + NODE_H / 2;
              const x2 = sameColumn ? b.x + NODE_W / 2 : b.x;
              const y2 = sameColumn ? b.y : b.y + NODE_H / 2;
              const d = sameColumn
                ? `M ${x1} ${y1} C ${x1 - GAP_X * 0.8} ${(y1 + y2) / 2}, ${x2 - GAP_X * 0.8} ${(y1 + y2) / 2}, ${x2} ${y2}`
                : `M ${x1} ${y1} C ${x1 + GAP_X / 2} ${y1}, ${x2 - GAP_X / 2} ${y2}, ${x2} ${y2}`;
              return e.kind === "dep" ? (
                <path key={i} d={d} fill="none" stroke="var(--color-line2)" strokeWidth="1.5" markerEnd="url(#dag-arrow)" />
              ) : (
                <g key={i}>
                  <path d={d} fill="none" stroke="var(--color-live)" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.75">
                    <title>{`serialised: ${e.overlap ?? "touches overlap"}`}</title>
                  </path>
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 - 4}
                    textAnchor="middle"
                    fill="var(--color-live)"
                    opacity="0.9"
                    style={{ font: "600 10px var(--font-mono)" }}
                  >
                    ∩
                  </text>
                </g>
              );
            })}
          </svg>
          {view.nodes.map((n) => {
            const p = pos.get(n.identifier)!;
            const s = LANE_STYLE[n.lane];
            return (
              <div
                key={n.identifier}
                className={`absolute flex flex-col gap-0.5 rounded-lg border bg-bg1 px-2 py-1.5 transition-colors duration-100 ${s.border} ${n.lane === "done" ? "opacity-60" : ""}`}
                style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                title={n.reason ?? `${n.identifier} · ${n.stateName}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`font-mono text-[11px] ${s.text} ${n.lane === "in-flight" ? "pulse-live" : ""}`}>
                    {n.identifier}
                  </span>
                  <span className={`ml-auto rounded-md border px-1 font-mono text-[9px] uppercase tracking-[0.05em] ${s.chip}`}>
                    {s.label}
                  </span>
                </div>
                <div className="truncate text-[11px] leading-tight text-fg-dim">{n.title}</div>
                {n.reason !== null ? (
                  <div className={`truncate font-mono text-[9.5px] leading-tight ${n.lane === "blocked" ? "text-fg-faint" : s.text}`}>
                    {n.reason}
                  </div>
                ) : (
                  <div className="truncate font-mono text-[9.5px] leading-tight text-fg-faint">{n.stateName}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <DagLegend />
    </div>
  );
}
