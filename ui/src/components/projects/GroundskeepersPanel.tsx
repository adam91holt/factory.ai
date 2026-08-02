import { Sprout } from "lucide-react";
import { groundskeeperToggleState, type ProjectGroundskeeperRow } from "../../lib/projects";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

// Per-project groundskeeper rows — the THIRD gate. A toggle here arms nothing
// by itself: the global GROUNDSKEEPERS_ENABLED env gate AND the card's own
// enabled flag must both hold (double-gated OFF by design). When the global
// gate is off, every toggle renders visibly INERT — the switch still saves,
// but the banner and per-row chip say plainly that nothing will run.

export function GroundskeepersPanel({
  rows,
  cards,
  globallyEnabled,
  saving,
  error,
  onToggle,
}: {
  /** Per-project rows from the store. */
  rows: ProjectGroundskeeperRow[];
  /** Known groundskeeper card names (catalog) — union'd with stored rows. */
  cards: string[];
  globallyEnabled: boolean;
  saving: string | null;
  error: string | null;
  onToggle: (card: string, enabled: boolean, cadence: string | null) => void;
}) {
  const byCard = new Map(rows.map((r) => [r.card, r]));
  const names = [...new Set([...cards, ...rows.map((r) => r.card)])].sort();

  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-1.5">
          <Sprout className="size-3" strokeWidth={1.75} />
          Groundskeepers
        </CardTitle>
        <span className="font-mono text-[10px] text-fg-faint">
          third gate — a row arms only when the global env gate AND the card's own flag are also on
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {!globallyEnabled && (
          <div className="rounded-md border border-parked/35 bg-parked/5 px-2 py-1.5 font-mono text-[10.5px] text-parked">
            GROUNDSKEEPERS_ENABLED=0 — the global gate is OFF, so every toggle below is inert: switches save, nothing runs.
          </div>
        )}
        {names.length === 0 ? (
          <span className="font-mono text-[10.5px] text-fg-faint">
            no groundskeeper cards — add groundskeepers/&lt;name&gt;.md to see toggles here
          </span>
        ) : (
          names.map((card) => {
            const row = byCard.get(card);
            const enabled = row?.enabled === true;
            const state = groundskeeperToggleState(enabled, globallyEnabled);
            return (
              <div
                key={card}
                className={`flex items-center gap-2 rounded-md px-1 py-1 ${state === "inert" ? "opacity-70" : ""}`}
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  disabled={saving === card}
                  onClick={() => onToggle(card, !enabled, row?.cadence ?? null)}
                  className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors duration-100 disabled:opacity-50 ${
                    enabled
                      ? state === "inert" ? "border-parked/50 bg-parked/25" : "border-ok/50 bg-ok/25"
                      : "border-line2 bg-bg2"
                  }`}
                  title={state === "inert" ? "saved as enabled, but inert while GROUNDSKEEPERS_ENABLED=0" : enabled ? "disable for this project" : "enable for this project"}
                >
                  <span
                    className={`absolute top-0.5 size-2.5 rounded-full transition-[left] duration-100 ${
                      enabled
                        ? `left-3.5 ${state === "inert" ? "bg-parked" : "bg-ok"}`
                        : "left-0.5 bg-fg-faint"
                    }`}
                  />
                </button>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{card}</span>
                {row?.cadence && (
                  <span className="font-mono text-[9.5px] text-fg-faint" title="cadence">{row.cadence}</span>
                )}
                {state === "inert" && <Badge variant="parked">inert — global gate off</Badge>}
                {state === "armed" && <Badge variant="ok">armed</Badge>}
                {state === "off" && <Badge variant="outline">off</Badge>}
              </div>
            );
          })
        )}
        {error && (
          <div className="rounded-md border border-err/30 bg-err/5 px-2 py-1.5 font-mono text-[10.5px] text-err">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
