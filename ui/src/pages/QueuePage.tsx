import { useFactory } from "../lib/store";
import { useNow } from "../lib/useNow";
import { QueueTable } from "../components/queue/QueueTable";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export function QueuePage() {
  const board = useFactory((s) => s.mission.board);
  const needsHumanLog = useFactory((s) => s.mission.needsHuman);
  const runs = useFactory((s) => s.mission.runs);
  const now = useNow(30_000);

  const needsHuman = board.filter((i) => i.lane === "needs_human");
  const parked = board.filter((i) => i.lane === "parked");

  // Session-observed reasons, joined onto the board rows.
  const humanReasons = new Map<string, string>();
  for (const n of needsHumanLog) humanReasons.set(n.issueKey, n.reason);
  for (const r of Object.values(runs)) {
    if (r.status === "needs_human" && r.reason && !humanReasons.has(r.issueKey)) {
      humanReasons.set(r.issueKey, r.reason);
    }
  }
  const parkedReasons = new Map<string, string>();
  for (const r of Object.values(runs)) {
    if (r.status === "parked" && r.reason) parkedReasons.set(r.issueKey, r.reason);
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3">
      <h1 className="text-sm font-bold tracking-wide text-fg">
        Queue health{" "}
        <span className="font-mono text-[11px] font-normal text-fg-faint">
          issues waiting on you — the factory never retries these on its own
        </span>
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>
            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-human align-[1px]" />
            Needs human · {needsHuman.length}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <QueueTable
            issues={needsHuman}
            reasons={humanReasons}
            emptyText="nothing needs a human — remove the Factory-Needs-Human label to requeue an issue"
            now={now}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-parked align-[1px]" />
            Parked · {parked.length}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <QueueTable
            issues={parked}
            reasons={parkedReasons}
            emptyText="nothing parked — caps and failures park issues here with the worktree kept"
            now={now}
          />
        </CardContent>
      </Card>
    </div>
  );
}
