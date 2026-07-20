import type { Telemetry } from "../../lib/telemetry";
import { compact, usd } from "../../lib/format";
import { cn } from "../../lib/utils";

type Model = Telemetry["perModel"][number];

/** Codex/proxy models render in the cyan vendor hue; every Claude model
 *  (sonnet/opus/fable) in violet — the only two vendor colors in the system. */
function isCodex(model: string): boolean {
  return /gpt|sol|codex|o[0-9]/i.test(model) && !/claude/i.test(model);
}

export function ModelBreakdown({ models }: { models: Model[] }) {
  if (models.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-6 text-center font-mono text-[11px] text-fg-faint">
        no model usage recorded yet
      </div>
    );
  }
  const maxTokens = Math.max(...models.map((m) => m.tokensIn + m.tokensOut), 1);

  return (
    <div className="flex flex-col gap-3">
      {models.map((m) => {
        const total = m.tokensIn + m.tokensOut;
        const codex = isCodex(m.model);
        return (
          <div key={m.model} className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              <span className={cn("size-2 shrink-0 rounded-full", codex ? "bg-codex" : "bg-claude")} />
              <span className="font-mono text-[12px] text-fg">{m.model}</span>
              <span className="font-mono text-[10.5px] text-fg-faint">{m.calls} calls</span>
              <span className="ml-auto font-mono text-[12px] text-fg tabular">{usd(m.costUsd)}</span>
            </div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-bg2" title={`${compact(total)} tokens`}>
              <div
                className={cn("h-full", codex ? "bg-codex/40" : "bg-claude/40")}
                style={{ width: `${(m.tokensIn / maxTokens) * 100}%` }}
              />
              <div
                className={cn("h-full", codex ? "bg-codex" : "bg-claude")}
                style={{ width: `${(m.tokensOut / maxTokens) * 100}%` }}
              />
            </div>
            <div className="flex gap-3 font-mono text-[10px] text-fg-faint">
              <span>in {compact(m.tokensIn)}</span>
              <span>out {compact(m.tokensOut)}</span>
              <span>cache-read {compact(m.cacheRead)}</span>
            </div>
          </div>
        );
      })}
      <div className="mt-0.5 flex items-center gap-3 border-t border-line pt-2 font-mono text-[10px] text-fg-faint">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-fg-faint/50" /> input tokens
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-fg-dim" /> output tokens
        </span>
      </div>
    </div>
  );
}
