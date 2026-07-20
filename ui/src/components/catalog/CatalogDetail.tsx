import { Eye, RotateCcw, Save } from "lucide-react";
import type { CatalogKind, UsageStat } from "../../lib/catalog";
import { usd } from "../../lib/format";
import { Badge } from "../ui/badge";
import { Separator } from "../ui/separator";
import { cn } from "../../lib/utils";
import { FrontmatterHeader } from "./FrontmatterHeader";
import { DiffView } from "./DiffView";

const KIND_LABEL: Record<CatalogKind, string> = {
  agent: "agent card",
  skill: "skill pack",
  groundskeeper: "groundskeeper",
};
const SOURCE_LABEL: Record<CatalogKind, string> = {
  agent: "Card source · frontmatter + prompt",
  skill: "Skill source · SKILL.md",
  groundskeeper: "Card source · frontmatter + charter",
};

export function CatalogDetail({
  kind,
  name,
  frontmatter,
  invalid,
  usage,
  baseline,
  draft,
  dirty,
  saving,
  saveError,
  showDiff,
  onDraftChange,
  onToggleDiff,
  onSave,
  onReset,
}: {
  kind: CatalogKind;
  name: string;
  frontmatter: Record<string, unknown>;
  invalid?: string;
  usage: UsageStat | null;
  baseline: string;
  draft: string;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  showDiff: boolean;
  onDraftChange: (v: string) => void;
  onToggleDiff: () => void;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="font-mono text-[15px] font-medium text-fg">{name}</h2>
        <Badge variant="outline" className="tracking-[0.04em]">{KIND_LABEL[kind]}</Badge>
        {usage ? (
          <span className="font-mono text-[10.5px] text-fg-faint">
            {usage.runs} runs · {usd(usage.costUsd)} · {usage.avgTurns.toFixed(1)} avg turns
          </span>
        ) : (
          <span className="font-mono text-[10.5px] text-fg-faint">no telemetry yet</span>
        )}
      </div>

      <FrontmatterHeader frontmatter={frontmatter} invalid={invalid} />

      <Separator />

      <div className="flex items-center gap-2">
        <span className="section-label mr-auto">{SOURCE_LABEL[kind]}</span>
        {dirty && (
          <button
            type="button"
            onClick={onReset}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[11px] text-fg-dim transition-colors duration-100 hover:border-line2 hover:text-fg disabled:opacity-40"
          >
            <RotateCcw className="size-3" strokeWidth={1.75} />
            Discard
          </button>
        )}
        <button
          type="button"
          onClick={onToggleDiff}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors duration-100",
            showDiff
              ? "border-claude/40 bg-claude/10 text-claude"
              : "border-line text-fg-dim hover:border-line2 hover:text-fg",
          )}
        >
          <Eye className="size-3" strokeWidth={1.75} />
          Review changes
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="flex items-center gap-1.5 rounded-md border border-live/40 bg-live/10 px-2.5 py-1 font-mono text-[11px] text-live transition-colors duration-100 hover:bg-live/20 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-fg-faint"
        >
          <Save className="size-3" strokeWidth={1.75} />
          {saving ? "Saving…" : "Save & commit"}
        </button>
      </div>

      {saveError && (
        <div className="rounded-lg border border-err/30 bg-err/5 px-2.5 py-2 font-mono text-[11px] text-err">
          {saveError}
        </div>
      )}

      {showDiff && <DiffView before={baseline} after={draft} />}

      <textarea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        spellCheck={false}
        className="min-h-[22rem] w-full flex-1 resize-y rounded-lg border border-line bg-bg0 p-3 font-mono text-[12px] leading-[1.6] text-fg-dim outline-none transition-colors duration-100 focus:border-line2 focus:text-fg"
      />
    </div>
  );
}
