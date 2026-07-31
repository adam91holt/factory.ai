import { ChevronRight } from "lucide-react";
import type { GateMeta } from "../../lib/events";
import type { GateRound } from "../../lib/reconstruct";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";

function gateBadge(passed: boolean | null) {
  if (passed === true) return <Badge variant="ok">PASS</Badge>;
  if (passed === false) return <Badge variant="err">FAIL</Badge>;
  return <Badge variant="outline" title="fails on the clean baseline — not counted">NO-GATE</Badge>;
}

/** Test-count ratchet evidence: "tests 631 → 640". Only rendered when a count
 *  exists on either side; a confirmed decrease is the withhold signal, so it
 *  reads as an error; an unknown side renders "?" (visible, non-blocking). */
function testCounts(gate: GateMeta) {
  const b = gate.baselineTestCount ?? null;
  const t = gate.testCount ?? null;
  if (b === null && t === null) return null;
  const decreased = b !== null && t !== null && t < b;
  return (
    <span
      className={cn("font-mono text-[9.5px]", decreased ? "text-err" : "text-fg-faint")}
      title={decreased ? "passing test count decreased vs baseline — auto-merge withheld" : "passing tests: baseline → post-change"}
    >
      tests {b ?? "?"} → {t ?? "?"}
    </span>
  );
}

function Gate({ gate }: { gate: GateMeta }) {
  return (
    <div className="rounded-lg border border-line bg-bg0 px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-fg">{gate.name}</span>
        {!gate.baselinePassed && <span className="font-mono text-[9.5px] text-fg-faint">baseline red</span>}
        {testCounts(gate)}
        <span className="ml-auto">{gateBadge(gate.passed)}</span>
      </div>
      {gate.outputTail !== "" && (
        <details className="group mt-1">
          <summary className="flex cursor-pointer list-none items-center gap-1 font-mono text-[10.5px] text-fg-faint hover:text-fg-dim [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 transition-transform duration-100 group-open:rotate-90" strokeWidth={2} />
            failure output
          </summary>
          <pre className="mt-1 overflow-x-auto rounded-md border border-err/20 bg-bg0 p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-err/90">
            {gate.outputTail}
          </pre>
        </details>
      )}
    </div>
  );
}

/** Every gate round in order — the reducer keeps only the latest, but the
 *  full sequence (round 0 pre-repair → each repair round) is the real story of
 *  how a run went green (or didn't). */
export function GateRounds({ rounds }: { rounds: GateRound[] }) {
  if (rounds.length === 0) {
    return <div className="p-3.5 text-center font-mono text-[11px] text-fg-faint">gates not run</div>;
  }
  return (
    <div className="flex flex-col gap-3 p-3.5 pt-2">
      {rounds.map((g, i) => (
        <div key={`${g.round}-${i}`} className="flex flex-col gap-2">
          <div className="flex items-center gap-2 font-mono text-[11px] text-fg-faint">
            <span>round {g.round === 0 ? "0 (pre-repair)" : g.round}</span>
            <span
              className={cn(
                "rounded border px-1.5 py-px text-[10px] uppercase tracking-wide",
                g.green ? "border-ok/35 text-ok" : "border-err/35 text-err",
              )}
            >
              {g.green ? "green" : "red"}
            </span>
            <span className="ml-auto">
              strength{" "}
              <span className={g.strength === "real" || g.strength === "strong" ? "text-ok" : g.strength === "weak" ? "text-live" : "text-err"}>
                {g.strength}
              </span>
            </span>
          </div>
          {g.gates.map((gate) => (
            <Gate key={gate.name} gate={gate} />
          ))}
        </div>
      ))}
    </div>
  );
}
