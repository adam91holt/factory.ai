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
  return (
    <pre className="max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-dim">
      {stage.resultText || "(empty result)"}
    </pre>
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
