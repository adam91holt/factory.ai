import type { RunView, StageView } from "../../lib/events";
import { Badge } from "../ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

function findStage(run: RunView, ...labels: string[]): StageView | undefined {
  for (const label of labels) {
    const s = run.stages.find((x) => x.stage === label);
    if (s) return s;
  }
  return undefined;
}

function Body({ stage, waiting }: { stage: StageView | undefined; waiting: string }) {
  if (!stage) {
    return <p className="font-mono text-[11px] text-fg-faint">{waiting}</p>;
  }
  if (stage.finishedAt === null) {
    return (
      <p className="pulse-live font-mono text-[11px] text-live">
        {stage.stage} running… {stage.lastActivity && `· ${stage.lastActivity}`}
      </p>
    );
  }
  if (stage.error) {
    return <p className="font-mono text-[11px] text-err">error: {stage.error}</p>;
  }
  return <ReviewText text={stage.resultText || "(empty result)"} />;
}

const SEVERITY_TONE: Record<string, string> = {
  critical: "text-err", high: "text-err", medium: "text-live", low: "text-fg-faint",
};

/** Structured gate outputs (issue #6) serialize the whole GateOutput JSON into
 *  the stage's result text — rendered raw it reads as a wall of escaped JSON
 *  (live mobile review 2026-08-02). When the text parses into that shape,
 *  render verdict + prose + findings properly; anything else falls back to the
 *  plain <pre>. Parse failure is never an error here — display only. */
interface ParsedReview {
  verdict?: string;
  prose?: string;
  findings?: Array<{ severity?: string; file?: string; line?: number; summary?: string }>;
}

function ReviewText({ text }: { text: string }) {
  let parsed: ParsedReview | null = null;
  try {
    const candidate = JSON.parse(text) as unknown;
    if (candidate && typeof candidate === "object" && "verdict" in candidate) {
      parsed = candidate as ParsedReview;
    }
  } catch { /* plain prose — fall through */ }
  if (!parsed) {
    return (
      <pre className="max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-dim">
        {text}
      </pre>
    );
  }
  const findings = parsed.findings ?? [];
  return (
    <div className="max-h-72 space-y-2 overflow-y-auto">
      {parsed.verdict && (
        <Badge variant={parsed.verdict === "pass" ? "ok" : parsed.verdict === "fail" ? "err" : "outline"} className="uppercase tracking-[0.06em]">
          {parsed.verdict}
        </Badge>
      )}
      {parsed.prose && (
        <p className="text-[12px] leading-relaxed text-fg-dim">{parsed.prose}</p>
      )}
      {findings.length > 0 && (
        <ul className="space-y-1.5">
          {findings.map((f: { severity?: string; file?: string; line?: number; summary?: string }, i: number) => (
            <li key={i} className="rounded-md border border-line bg-bg0/60 px-2.5 py-1.5">
              <div className="flex items-baseline gap-2 font-mono text-[10.5px]">
                <span className={SEVERITY_TONE[f.severity ?? ""] ?? "text-fg-faint"}>{(f.severity ?? "?").toUpperCase()}</span>
                {f.file && <span className="truncate text-fg-faint">{f.file}{typeof f.line === "number" ? `:${f.line}` : ""}</span>}
              </div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-fg-dim">{f.summary ?? ""}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FindingsPanel({ run }: { run: RunView }) {
  const claude = findStage(run, "reviewer-claude");
  const codex = findStage(run, "reviewer-codex", "reviewer-fallback");
  const fixer = findStage(run, "fixer");
  const codexDegraded = codex?.stage === "reviewer-fallback" || codex?.degraded === true;

  return (
    <Tabs defaultValue="claude" className="p-3.5 pt-2">
      <TabsList>
        <TabsTrigger value="claude">
          <span className="mr-1.5 inline-block size-1.5 rounded-full bg-claude align-middle" />
          Claude
        </TabsTrigger>
        <TabsTrigger value="codex">
          <span className="mr-1.5 inline-block size-1.5 rounded-full bg-codex align-middle" />
          Codex
        </TabsTrigger>
        <TabsTrigger value="fixer">
          <span className="mr-1.5 inline-block size-1.5 rounded-full bg-parked align-middle" />
          Fixer
        </TabsTrigger>
      </TabsList>
      <TabsContent value="claude">
        <Body stage={claude} waiting="reviewer-claude has not started" />
      </TabsContent>
      <TabsContent value="codex">
        {codexDegraded && (
          <Badge variant="parked" className="mb-2">DEGRADED — Claude fallback reviewer</Badge>
        )}
        <Body stage={codex} waiting="reviewer-codex has not started" />
      </TabsContent>
      <TabsContent value="fixer">
        <Body stage={fixer} waiting="fixer has not started" />
      </TabsContent>
    </Tabs>
  );
}
