import { Cpu } from "lucide-react";
import { EFFORT_OPTIONS, type ProjectModelRow, type ProjectsPayload } from "../../lib/projects";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

// Per-role model configuration. The dropdown is CONSTRAINED to the roster the
// backend serves from config.models — never free text (the write route
// re-validates; this is the belt to its braces). "default" clears the row so
// the stage falls back to the operator's config default.

const selectClass =
  "rounded-md border border-line bg-bg0 px-1.5 py-1 font-mono text-[10.5px] text-fg outline-none transition-colors duration-100 hover:border-line2 focus:border-live/60 disabled:opacity-50";

export function ModelsPanel({
  models,
  roster,
  saving,
  error,
  onSet,
}: {
  models: ProjectModelRow[];
  roster: ProjectsPayload["roster"];
  saving: string | null;
  error: string | null;
  onSet: (role: string, model: string | null, effort: string | null) => void;
}) {
  const byRole = new Map(models.map((m) => [m.role, m]));
  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-1.5">
          <Cpu className="size-3" strokeWidth={1.75} />
          Models
        </CardTitle>
        <span className="font-mono text-[10px] text-fg-faint">
          per-role overrides, roster-constrained — options come from config.models, never free text
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {roster.roles.length === 0 ? (
          <span className="font-mono text-[10.5px] text-fg-faint">
            roster unavailable — model config requires the daemon's /projects roster
          </span>
        ) : (
          roster.roles.map((role) => {
            const row = byRole.get(role);
            return (
              <div key={role} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-bg2/60">
                <span className="w-32 shrink-0 truncate font-mono text-[10.5px] text-fg-dim">{role}</span>
                <select
                  className={selectClass}
                  value={row?.model ?? ""}
                  disabled={saving === role}
                  onChange={(e) => {
                    const v = e.target.value;
                    onSet(role, v === "" ? null : v, row?.effort ?? null);
                  }}
                >
                  <option value="">default</option>
                  {roster.models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <select
                  className={selectClass}
                  value={row?.effort ?? ""}
                  disabled={saving === role || !row}
                  title={row ? "reasoning effort" : "set a model first"}
                  onChange={(e) => {
                    if (!row) return;
                    onSet(role, row.model, e.target.value === "" ? null : e.target.value);
                  }}
                >
                  <option value="">effort: default</option>
                  {EFFORT_OPTIONS.map((eff) => (
                    <option key={eff} value={eff}>effort: {eff}</option>
                  ))}
                </select>
                {row && <span className="ml-auto font-mono text-[9.5px] text-fg-faint">override</span>}
              </div>
            );
          })
        )}
        {error && (
          <div className="mt-1 rounded-md border border-err/30 bg-err/5 px-2 py-1.5 font-mono text-[10.5px] text-err">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
