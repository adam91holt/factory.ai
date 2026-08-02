import { useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";

// Inline editor for DESCRIPTIVE project fields (goal/description/team) — the
// tier that applies immediately. Authority fields never render through this
// component; they are read-only with a pending-state diff (AuthorityPanel).

export function EditableField({
  label,
  value,
  placeholder,
  multiline = false,
  saving,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  multiline?: boolean;
  saving: boolean;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  // A refetch landing new content while NOT editing keeps the display fresh;
  // while editing the draft is the human's, never clobbered.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = (): void => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };

  if (!editing) {
    return (
      <div className="group flex min-w-0 flex-col gap-0.5">
        <span className="section-label">{label}</span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex min-w-0 items-start gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors duration-100 hover:bg-bg2"
          title={`edit ${label}`}
        >
          <span className={`min-w-0 whitespace-pre-wrap text-[12px] leading-snug ${value ? "text-fg" : "text-fg-faint"}`}>
            {value || placeholder}
          </span>
          <Pencil className="mt-0.5 size-3 shrink-0 text-fg-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100" strokeWidth={1.75} />
        </button>
      </div>
    );
  }

  const inputClass =
    "w-full rounded-md border border-line2 bg-bg0 px-2 py-1.5 font-mono text-[11.5px] text-fg outline-none focus:border-live/60";
  return (
    <div className="flex flex-col gap-1">
      <span className="section-label">{label}</span>
      {multiline ? (
        <textarea
          className={`${inputClass} min-h-20 resize-y leading-relaxed`}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
        />
      ) : (
        <input
          className={inputClass}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setDraft(value); setEditing(false); }
          }}
        />
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={saving}
          onClick={commit}
          className="flex items-center gap-1 rounded-md border border-ok/40 bg-ok/10 px-2 py-0.5 font-mono text-[10.5px] text-ok transition-colors duration-100 hover:bg-ok/20 disabled:opacity-50"
        >
          <Check className="size-3" strokeWidth={2} /> save
        </button>
        <button
          type="button"
          onClick={() => { setDraft(value); setEditing(false); }}
          className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 font-mono text-[10.5px] text-fg-dim transition-colors duration-100 hover:bg-bg2"
        >
          <X className="size-3" strokeWidth={2} /> cancel
        </button>
      </div>
    </div>
  );
}
