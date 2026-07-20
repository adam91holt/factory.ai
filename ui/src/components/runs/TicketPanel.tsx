import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Card, CardHeader, CardTitle } from "../ui/card";

interface Lineage { identifier: string; title: string; stateName: string }
interface IssueDetail {
  identifier: string; title: string; description: string; url: string;
  stateName: string; labels: string[];
  parent: Lineage | null; children: Lineage[]; siblings: Lineage[];
}

function Row({ item, tag }: { item: Lineage; tag: string }) {
  return (
    <Link to="/runs/$issueKey" params={{ issueKey: item.identifier }}
      className="flex items-baseline gap-2 rounded-md px-1.5 py-1 hover:bg-bg2">
      <span className="font-mono text-[10px] uppercase text-fg-faint">{tag}</span>
      <span className="font-mono text-[11.5px] text-live">{item.identifier}</span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-dim">{item.title}</span>
      <span className="font-mono text-[10px] text-fg-faint">{item.stateName}</span>
    </Link>
  );
}

export function TicketPanel({ issueKey }: { issueKey: string }) {
  const { data, isError } = useQuery<IssueDetail>({
    queryKey: ["issue", issueKey],
    queryFn: async () => {
      const res = await fetch(`/issue?key=${issueKey}`);
      if (!res.ok) throw new Error(`issue fetch ${res.status}`);
      return res.json() as Promise<IssueDetail>;
    },
    staleTime: 60_000,
    retry: 1,
  });
  if (isError) return null; // endpoint absent until daemon restart — hide quietly
  if (!data) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-baseline justify-between">
          <span>Ticket</span>
          <a href={data.url} target="_blank" rel="noreferrer"
            className="font-mono text-[10.5px] font-normal text-live hover:underline">
            open in Linear ↗
          </a>
        </CardTitle>
      </CardHeader>
      <div className="px-4 pb-4">
        {(data.parent || data.siblings.length > 0 || data.children.length > 0) && (
          <div className="mb-3 flex flex-col gap-0.5 rounded-lg border border-line bg-bg0/40 p-1.5">
            {data.parent && <Row item={data.parent} tag="epic" />}
            {data.children.map((c) => <Row key={c.identifier} item={c} tag="child" />)}
            {data.siblings.map((c) => <Row key={c.identifier} item={c} tag="sibling" />)}
          </div>
        )}
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-fg-dim">
          {data.description || "(no description)"}
        </div>
      </div>
    </Card>
  );
}
