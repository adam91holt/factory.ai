import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Link } from "@tanstack/react-router";
import { CheckCheck, ChevronRight } from "lucide-react";
import {
  approveItem,
  fetchApprovals,
  pushbackItem,
  splitApprovals,
  statusLabel,
  type ApprovalItem,
  type ApprovalStatus,
} from "../lib/approvals";
import { relTime } from "../lib/format";
import { useNow } from "../lib/useNow";
import { ApprovalCard } from "../components/approvals/ApprovalCard";
import { Badge, type BadgeVariant } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";

// The review queue: every run the factory finished but deliberately did NOT
// merge, waiting on exactly one human decision. Approve asks the daemon to
// merge pinned to the gated head SHA (the backend refuses if the branch moved
// — that refusal renders verbatim on the card); push back sends feedback into
// a fixer round. One page, no settings, no filters beyond pending/handled —
// the owner asked for "simple, with the context I need there".

/** How often the queue re-polls. Matches the LessonsPage cadence — the queue
 *  changes at human speed, not SSE speed, so polling is the simple idiom here
 *  (and it doubles as the staleness check: a card that went stale server-side
 *  loses its approve button within one poll). */
export const APPROVALS_REFETCH_MS = 15_000;

function handledBadgeVariant(status: ApprovalStatus): BadgeVariant {
  switch (status) {
    case "approved": return "ok";
    case "pushed_back": return "human";
    case "stale": return "parked";
    case "pending": return "outline";
  }
}

function HandledRow({ item, now }: { item: ApprovalItem; now: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-line bg-bg1 px-3 py-2">
      <Badge variant={handledBadgeVariant(item.status)} className="uppercase tracking-[0.06em]">
        {statusLabel(item.status)}
      </Badge>
      <Link
        to="/runs/$issueKey"
        params={{ issueKey: item.issueKey }}
        className="font-mono text-[11.5px] text-fg transition-colors duration-100 hover:text-live"
      >
        {item.issueKey}
      </Link>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-dim">{item.title}</span>
      {item.staleReason && (
        <span className="truncate font-mono text-[10.5px] text-parked" title={item.staleReason}>
          {item.staleReason}
        </span>
      )}
      <span className="font-mono text-[10.5px] text-fg-faint">
        {relTime(item.handledAt ?? item.parkedAt, now)}
      </span>
    </div>
  );
}

export function ApprovalsPage() {
  const qc = useQueryClient();
  const now = useNow(30_000);
  const { data, isPending, isError } = useQuery({
    queryKey: ["approvals"],
    queryFn: fetchApprovals,
    staleTime: 10_000,
    refetchInterval: APPROVALS_REFETCH_MS,
  });

  // Per-item action errors, rendered VERBATIM on the owning card (the backend's
  // refusal text — "branch moved since gating — needs re-gate" — is the whole
  // point of surfacing them). Keyed by item id so one refusal never bleeds onto
  // a neighbouring card.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [listRef] = useAutoAnimate({ duration: 220, easing: "ease-out" });

  const settle = (id: string, res: { ok: true; id: string } | { error: string }) => {
    if ("error" in res) {
      setErrors((e) => ({ ...e, [id]: res.error }));
    } else {
      setErrors((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      });
    }
    // Refetch either way: success moves the card to "recently handled"; a
    // refusal usually means the item just went stale server-side.
    void qc.invalidateQueries({ queryKey: ["approvals"] });
  };
  const fail = (id: string, e: unknown) =>
    setErrors((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : "request failed" }));

  const approve = useMutation({
    mutationFn: (id: string) => approveItem(id),
    onSuccess: (res, id) => settle(id, res),
    onError: (e, id) => fail(id, e),
  });
  const pushback = useMutation({
    mutationFn: ({ id, feedback }: { id: string; feedback: string }) => pushbackItem(id, feedback),
    onSuccess: (res, { id }) => settle(id, res),
    onError: (e, { id }) => fail(id, e),
  });

  const { pending, handled } = splitApprovals(data?.items ?? []);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      <h1 className="text-sm font-bold tracking-wide text-fg">
        Review queue{" "}
        <span className="font-mono text-[11px] font-normal text-fg-faint">
          runs the factory finished but held for your decision — approve merges exactly what was gated
        </span>
      </h1>

      {isPending ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-err/30 bg-err/5 p-5 text-center font-mono text-[11px] text-err">
          could not load /approvals — is the daemon running with the approvals endpoints deployed?
        </div>
      ) : pending.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-12 text-center">
          <CheckCheck className="size-5 text-fg-faint" strokeWidth={1.5} />
          <div className="font-mono text-[12px] text-fg-dim">Nothing needs you.</div>
        </div>
      ) : (
        <div ref={listRef} className="flex flex-col gap-2">
          {pending.map((item) => (
            <ApprovalCard
              key={item.id}
              item={item}
              now={now}
              approvePending={approve.isPending && approve.variables === item.id}
              pushbackPending={pushback.isPending && pushback.variables?.id === item.id}
              error={errors[item.id] ?? null}
              onApprove={(id) => approve.mutate(id)}
              onPushback={(id, feedback) => pushback.mutate({ id, feedback })}
            />
          ))}
        </div>
      )}

      {handled.length > 0 && (
        <details className="group mt-1">
          <summary className="flex cursor-pointer list-none items-center gap-1 font-mono text-[10.5px] text-fg-faint hover:text-fg-dim [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 transition-transform duration-100 group-open:rotate-90" strokeWidth={2} />
            recently handled · {handled.length}
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {handled.map((item) => (
              <HandledRow key={item.id} item={item} now={now} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
