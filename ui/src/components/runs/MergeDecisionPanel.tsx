import type { MergeDecision } from "../../lib/reconstruct";
import { Badge, type BadgeVariant } from "../ui/badge";
import { cn } from "../../lib/utils";

const TIER_VARIANT: Record<MergeDecision["tier"], BadgeVariant> = {
  human: "human",
  shadow: "codex",
  "auto-low-risk": "live",
  auto: "ok",
};

function browserClass(b: MergeDecision["browser"]): string {
  if (b === "pass") return "text-ok";
  if (b === "partial") return "text-live";
  if (b === "fail" || b === "missing") return "text-err";
  return "text-fg-faint";
}

/** The evidence-gated merge ladder's verdict — write-only until now: which tier
 *  the run reached, whether it WOULD merge, and whether it actually acted. */
export function MergeDecisionPanel({ decisions }: { decisions: MergeDecision[] }) {
  return (
    <div className="flex flex-col gap-2.5 p-3.5 pt-2">
      {decisions.map((d, i) => (
        <div key={i} className="rounded-lg border border-line bg-bg0 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={TIER_VARIANT[d.tier]} className="uppercase">{d.tier}</Badge>
            <span
              className={cn(
                "rounded border px-1.5 py-px font-mono text-[10px] uppercase tracking-wide",
                d.acted
                  ? "border-ok/35 text-ok"
                  : d.wouldMerge
                    ? "border-live/35 text-live"
                    : "border-line2 text-fg-faint",
              )}
            >
              {d.acted ? "merged" : d.wouldMerge ? "would merge" : "held"}
            </span>
            <span className="ml-auto font-mono text-[10.5px] text-fg-faint">streak {d.cleanStreak}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10.5px] text-fg-faint">
            <span>repo <span className="text-fg-dim">{d.repo}</span></span>
            <span>strength <span className={d.strength === "real" || d.strength === "strong" ? "text-ok" : "text-fg-dim"}>{d.strength}</span></span>
            <span>browser <span className={browserClass(d.browser)}>{d.browser}</span></span>
            <span>security <span className={d.security === "pass" ? "text-ok" : d.security === "fail" ? "text-err" : "text-fg-faint"}>{d.security ?? "n/a"}</span></span>
          </div>
          {d.reasons.length > 0 && (
            <ul className="mt-2 flex flex-col gap-0.5 font-mono text-[10.5px] leading-relaxed text-fg-dim">
              {d.reasons.map((r, j) => (
                <li key={j} className="flex gap-1.5">
                  <span className="text-fg-faint">·</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
