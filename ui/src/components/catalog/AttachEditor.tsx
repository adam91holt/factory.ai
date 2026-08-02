import { useState } from "react";
import { Compass, Power } from "lucide-react";
import {
  attachEqual, parseProjectsInput, toggleEntry,
  type AttachPreview, type NormalizedAttach,
} from "../../lib/registers";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";

// Skill attach editor (issue #16 WP3). The daemon carries a skill when role ∩
// project ∩ match-terms all hold (skills.ts selectSkills); this editor writes
// that selector. Vocabularies are CLOSED and come from the server payload
// (roles = ROLE_CEILINGS keys, match terms = the factHolds grammar); projects
// are free entry, validated server-side. The preview is computed by the same
// pure selectSkills on the server — never re-implemented here.

const chipClass = (selected: boolean): string =>
  cn(
    "min-h-9 rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors duration-100 md:min-h-0",
    selected
      ? "border-claude/40 bg-claude/10 text-claude"
      : "border-line text-fg-dim hover:border-line2 hover:text-fg",
  );

export function AttachEditor({
  attach,
  savedAttach,
  enabled,
  roles,
  matchTerms,
  saving,
  preview,
  previewLoading,
  onChange,
  onSave,
  onToggleEnabled,
  onPreview,
}: {
  attach: NormalizedAttach;
  /** The attach on the ACTIVE version — dirty = draft differs from this. */
  savedAttach: NormalizedAttach;
  enabled: boolean;
  roles: string[];
  matchTerms: string[];
  saving: boolean;
  preview: AttachPreview | null;
  previewLoading: boolean;
  onChange: (next: NormalizedAttach) => void;
  onSave: () => void;
  onToggleEnabled: () => void;
  onPreview: () => void;
}) {
  const [projectsText, setProjectsText] = useState(attach.projects.join(", "));
  const dirty = !attachEqual(attach, savedAttach);

  const setProjects = (raw: string): void => {
    setProjectsText(raw);
    onChange({ ...attach, projects: parseProjectsInput(raw) });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="section-label mr-auto">Carry selector · when the daemon injects this skill</span>
        <button
          type="button"
          onClick={onToggleEnabled}
          disabled={saving}
          className={cn(
            "flex min-h-11 items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors duration-100 disabled:opacity-40 md:min-h-0",
            enabled
              ? "border-ok/40 bg-ok/10 text-ok hover:bg-ok/20"
              : "border-line text-fg-faint hover:border-line2 hover:text-fg-dim",
          )}
        >
          <Power className="size-3" strokeWidth={2} />
          {enabled ? "Enabled" : "Disabled"}
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10.5px] text-fg-faint">
          roles — which stages carry it (required; empty = carried nowhere)
        </span>
        <div className="flex flex-wrap gap-1.5">
          {roles.map((role) => (
            <button
              key={role}
              type="button"
              onClick={() => onChange({ ...attach, roles: toggleEntry(attach.roles, role) })}
              className={chipClass(attach.roles.includes(role))}
            >
              {role}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10.5px] text-fg-faint">
          match — repo facts that must ALL hold (never ticket text)
        </span>
        <div className="flex flex-wrap gap-1.5">
          {matchTerms.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => onChange({ ...attach, match: toggleEntry(attach.match, term) })}
              className={chipClass(attach.match.includes(term))}
            >
              {term}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="font-mono text-[10.5px] text-fg-faint" htmlFor="attach-projects">
          projects — repos it may carry into (empty = any; "org/name" or bare name, comma-separated)
        </label>
        <input
          id="attach-projects"
          value={projectsText}
          onChange={(e) => setProjects(e.target.value)}
          spellCheck={false}
          placeholder="org/repo, other-repo"
          className="w-full rounded-md border border-line bg-bg0 px-2.5 py-1.5 font-mono text-[11.5px] text-fg-dim outline-none transition-colors duration-100 placeholder:text-fg-faint/60 focus:border-line2 focus:text-fg"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onPreview}
          disabled={previewLoading}
          className="flex min-h-11 items-center gap-1.5 rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-fg-dim transition-colors duration-100 hover:border-line2 hover:text-fg disabled:opacity-40 md:min-h-0"
        >
          <Compass className="size-3" strokeWidth={1.75} />
          {previewLoading ? "Computing…" : "Where would this carry?"}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="flex min-h-11 items-center gap-1.5 rounded-md border border-live/40 bg-live/10 px-2.5 py-1 font-mono text-[11px] text-live transition-colors duration-100 hover:bg-live/20 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-fg-faint md:min-h-0"
        >
          {saving ? "Saving…" : "Save selector"}
        </button>
      </div>

      {preview && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-bg0/60 p-2.5">
          <span className="section-label">Carry preview</span>
          {preview.contradictory ? (
            <span className="font-mono text-[11px] text-err">
              contradictory match terms — this skill carries nowhere
            </span>
          ) : preview.carries.length === 0 ? (
            <span className="font-mono text-[11px] text-fg-faint">
              carries nowhere{preview.rejected[0] ? ` — ${preview.rejected[0].reason}` : ""}
            </span>
          ) : (
            <div className="flex flex-col gap-1">
              {preview.carries.map((c) => (
                <div key={c.role} className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="claude" className="px-1.5">{c.role}</Badge>
                  <span className="font-mono text-[10.5px] text-fg-dim">
                    {c.repos.join(", ")}
                  </span>
                </div>
              ))}
              {preview.conditions.length > 0 && (
                <span className="font-mono text-[10px] text-fg-faint">
                  in repos where: {preview.conditions.join(" ∧ ")}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
