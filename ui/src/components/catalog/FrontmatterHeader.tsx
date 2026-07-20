import { AlertCircle } from "lucide-react";
import { Badge } from "../ui/badge";

// Read-only, parsed view of a card's frontmatter — the form header above the
// editor. Values are never editable here (the textarea below is the source of
// truth); this is the at-a-glance "what is this card configured to do".

function ValueCell({ name, value }: { name: string; value: unknown }) {
  if (name === "enabled") {
    return value === true ? (
      <Badge variant="ok">enabled</Badge>
    ) : (
      <Badge variant="outline" className="text-fg-faint">disabled</Badge>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-fg-faint">—</span>;
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((v, i) => (
          <Badge key={i} variant="default">{String(v)}</Badge>
        ))}
      </div>
    );
  }
  const text = value === "" || value === undefined || value === null ? "—" : String(value);
  return <span className="font-mono text-[11.5px] text-fg-dim">{text}</span>;
}

export function FrontmatterHeader({
  frontmatter,
  invalid,
}: {
  frontmatter: Record<string, unknown>;
  invalid?: string;
}) {
  // `name` is redundant with the detail title; drop it from the grid.
  const entries = Object.entries(frontmatter).filter(([k]) => k !== "name");

  return (
    <div className="flex flex-col gap-2">
      {invalid && (
        <div className="flex items-start gap-2 rounded-lg border border-err/30 bg-err/5 px-2.5 py-2 text-[11px] text-err">
          <AlertCircle className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
          <span>
            This card does not pass loader validation and the daemon will skip it: {invalid}
          </span>
        </div>
      )}
      {entries.length === 0 ? (
        <div className="text-[11px] text-fg-faint">no frontmatter</div>
      ) : (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="section-label pt-0.5">{key}</dt>
              <dd className="min-w-0">
                <ValueCell name={key} value={value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
