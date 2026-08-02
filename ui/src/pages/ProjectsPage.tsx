import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderKanban } from "lucide-react";
import {
  fetchProjects,
  openApprovalsCount,
  pendingPolicies,
  recentParkReasons,
  spend30d,
  type ProjectView,
} from "../lib/projects";
import { fetchRuns } from "../lib/api";
import { fetchApprovals } from "../lib/approvals";
import { APPROVALS_REFETCH_MS } from "./ApprovalsPage";
import { usd } from "../lib/format";
import { useNow } from "../lib/useNow";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { TierBadge } from "../components/projects/TierBadge";

/** Poll cadence — projects change at human speed (LessonsPage/Approvals idiom). */
export const PROJECTS_REFETCH_MS = 15_000;

function statusVariant(status: string): "ok" | "parked" | "outline" {
  if (status === "active") return "ok";
  if (status === "paused") return "parked";
  return "outline";
}

function ProjectRow({
  project,
  spend,
  parkReasons,
  approvals,
}: {
  project: ProjectView;
  spend: number;
  parkReasons: string[];
  approvals: number;
}) {
  const pending = pendingPolicies(project.policies).length;
  return (
    <Link
      to="/projects/$name"
      params={{ name: project.name }}
      className="group flex flex-col gap-2 rounded-xl border border-line bg-bg1 p-3.5 transition-colors duration-100 hover:border-line2 hover:bg-bg2/60"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-bold tracking-wide text-fg transition-colors duration-100 group-hover:text-live">
          {project.name}
        </span>
        <Badge variant={statusVariant(project.status)}>{project.status}</Badge>
        <span className="font-mono text-[10.5px] text-fg-faint">{project.team}</span>
        <span className="ml-auto flex items-center gap-2">
          {approvals > 0 && (
            <Badge variant="live" title="pending items in the review queue for this project's repos">
              {approvals} awaiting review
            </Badge>
          )}
          {pending > 0 && (
            <Badge variant="human" title="authority revisions awaiting approval">
              {pending} pending polic{pending === 1 ? "y" : "ies"}
            </Badge>
          )}
          <span className="font-mono text-[11.5px] text-fg" title="spend across this project's repos, last 30 days">
            {usd(spend)} <span className="text-[10px] text-fg-faint">/ 30d</span>
          </span>
        </span>
      </div>

      <div className="min-w-0 truncate text-[11.5px] text-fg-dim">
        {project.goal || <span className="text-fg-faint">no goal set — click through to add one</span>}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {project.ladder.length > 0
          ? project.ladder.map((l) => (
              <span key={l.repo} className="flex items-center gap-1.5">
                <span className="font-mono text-[10.5px] text-fg-dim">{l.repo}</span>
                <TierBadge tier={l.tier} cleanStreak={l.cleanStreak} />
              </span>
            ))
          : project.repos.map((r) => (
              <span key={r} className="font-mono text-[10.5px] text-fg-dim">{r}</span>
            ))}
      </div>

      {parkReasons.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-line pt-1.5">
          {parkReasons.map((reason) => (
            <div key={reason} className="truncate font-mono text-[10.5px] text-parked" title={reason}>
              parked · {reason}
            </div>
          ))}
        </div>
      )}
    </Link>
  );
}

export function ProjectsPage() {
  const now = useNow(30_000);
  const { data, isPending, isError } = useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
    staleTime: 10_000,
    refetchInterval: PROJECTS_REFETCH_MS,
  });
  // Durable run history feeds spend + park reasons; the review queue feeds the
  // open-approvals count. Both already exist — no new endpoints for the list.
  const { data: runs } = useQuery({ queryKey: ["runs"], queryFn: fetchRuns, staleTime: 30_000, retry: false });
  const { data: approvalsData } = useQuery({
    queryKey: ["approvals"],
    queryFn: fetchApprovals,
    staleTime: 10_000,
    refetchInterval: APPROVALS_REFETCH_MS,
    retry: false,
  });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      <h1 className="text-sm font-bold tracking-wide text-fg">
        Projects{" "}
        <span className="font-mono text-[11px] font-normal text-fg-faint">
          what the factory is building — goals & models edit live, authority changes wait for your approval
        </span>
      </h1>

      {isPending ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-err/30 bg-err/5 p-5 text-center font-mono text-[11px] text-err">
          could not load /projects — is the daemon running with the project routes deployed?
        </div>
      ) : (data?.projects.length ?? 0) === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-12 text-center">
          <FolderKanban className="size-5 text-fg-faint" strokeWidth={1.5} />
          <div className="font-mono text-[12px] text-fg-dim">
            no projects yet — add a projects/&lt;name&gt;.md card to register one
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {data!.projects.map((p) => (
            <ProjectRow
              key={p.name}
              project={p}
              spend={spend30d(runs ?? [], p.repos, now)}
              parkReasons={recentParkReasons(runs ?? [], p.repos, 2)}
              approvals={openApprovalsCount(approvalsData?.items ?? [], p.repos)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
