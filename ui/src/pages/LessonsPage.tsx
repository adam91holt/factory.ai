import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Archive, ArrowUpRight, BookOpenText, Check } from "lucide-react";
import { archiveLesson, fetchLessons, type Lesson } from "../lib/lessons";
import { relTime } from "../lib/format";
import { useNow } from "../lib/useNow";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";

// The factory's memory ledger. Every row is something the flywheel distilled
// from a failure and now injects into future prompts — which is exactly why a
// human must be able to read it and strike it out. Archiving flips archived=1
// (nothing is ever deleted); the row leaves the ledger, the prompt-injection
// surface shrinks by one line.

/** Same stage → colour mapping as the history sparkbar, so a stage reads the
 *  same everywhere in mission control. */
function stageAccent(stage: string): string {
  if (stage === "reviewer-codex") return "bg-codex/70";
  if (stage.startsWith("reviewer")) return "bg-claude/70";
  if (stage === "fixer" || stage.startsWith("verify-repair")) return "bg-parked/70";
  if (stage === "scout" || stage === "decomposer" || stage === "planner" || stage === "steward") return "bg-fg-dim/60";
  return "bg-live/70";
}

/** Archive with a two-step arm: first press arms (turns red, asks), second
 *  press fires, 3s of silence disarms. The press itself scales — a strike from
 *  the ledger should feel like one. */
function ArchiveButton({
  lessonId,
  pending,
  onArchive,
}: {
  lessonId: number;
  pending: boolean;
  onArchive: (id: number) => void;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onArchive(lessonId);
      }}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 font-mono text-[10.5px]",
        "transition-[color,background-color,border-color,transform] duration-100 active:scale-95",
        armed
          ? "border-err/50 bg-err/10 text-err hover:bg-err/20"
          : "border-transparent text-fg-faint hover:border-line hover:bg-bg2 hover:text-fg-dim",
        pending && "cursor-wait opacity-50",
      )}
      title={armed ? "click again to archive — sets archived=1, never deletes" : "archive this lesson"}
    >
      <Archive className="size-3" strokeWidth={1.75} />
      {pending ? "archiving…" : armed ? "confirm — forget this?" : "archive"}
    </button>
  );
}

function LessonRow({
  lesson,
  now,
  pending,
  onArchive,
}: {
  lesson: Lesson;
  now: number;
  pending: boolean;
  onArchive: (id: number) => void;
}) {
  return (
    <div className="group relative flex gap-3 rounded-lg border border-line bg-bg1 px-3.5 py-3 transition-colors duration-100 hover:border-line2">
      {/* stage-coloured spine — the ledger's margin rule */}
      <span className={cn("mt-0.5 w-0.5 shrink-0 self-stretch rounded-full", stageAccent(lesson.stage))} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10.5px] text-fg-faint">#{lesson.id}</span>
          <Badge variant="outline">{lesson.repo || "unknown repo"}</Badge>
          <Badge>{lesson.stage || "unknown stage"}</Badge>
          {lesson.sourceIssue &&
            (lesson.sourceUrl ? (
              <a
                href={lesson.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-0.5 font-mono text-[10.5px] text-fg-dim transition-colors duration-100 hover:text-live"
                title={`source issue ${lesson.sourceIssue}`}
              >
                {lesson.sourceIssue}
                <ArrowUpRight className="size-3" strokeWidth={1.75} />
              </a>
            ) : (
              <span className="font-mono text-[10.5px] text-fg-dim">{lesson.sourceIssue}</span>
            ))}
          <span className="ml-auto font-mono text-[10.5px] text-fg-faint" title={new Date(lesson.createdAt).toISOString()}>
            {relTime(lesson.createdAt, now)}
          </span>
        </div>

        {/* Lesson text is distilled from UNTRUSTED failure output — plain text
            only, preserved whitespace, never rendered as markup. */}
        <p className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-fg">
          {lesson.lesson}
        </p>
      </div>

      <div className="flex shrink-0 items-start">
        <ArchiveButton lessonId={lesson.id} pending={pending} onArchive={onArchive} />
      </div>
    </div>
  );
}

export function LessonsPage() {
  const qc = useQueryClient();
  const now = useNow(30_000);
  const { data, isPending, isError } = useQuery({
    queryKey: ["lessons"],
    queryFn: fetchLessons,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [lastArchived, setLastArchived] = useState<number | null>(null);
  const [listRef] = useAutoAnimate({ duration: 220, easing: "ease-out" });

  const mutation = useMutation({
    mutationFn: archiveLesson,
    onSuccess: (res, id) => {
      if ("error" in res) {
        setArchiveError(res.error);
        return;
      }
      setArchiveError(null);
      setLastArchived(id);
      void qc.invalidateQueries({ queryKey: ["lessons"] });
    },
    onError: (e) => setArchiveError(e instanceof Error ? e.message : "archive request failed"),
  });

  // Auto-dismiss the archived toast.
  useEffect(() => {
    if (lastArchived === null) return;
    const t = setTimeout(() => setLastArchived(null), 5000);
    return () => clearTimeout(t);
  }, [lastArchived]);

  const lessons = data?.lessons ?? [];
  const repos = [...new Set(lessons.map((l) => l.repo).filter((r) => r !== ""))].sort();
  const shown = repoFilter === null ? lessons : lessons.filter((l) => l.repo === repoFilter);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-sm font-bold tracking-wide text-fg">Lessons</h1>
        <span className="font-mono text-[11px] text-fg-faint">
          {lessons.length} active · distilled from failures, injected into future prompts — archive strikes a
          lesson from the loop, never deletes it
        </span>
        {repos.length > 1 && (
          <div className="ml-auto flex items-center gap-1">
            {[null, ...repos].map((r) => (
              <button
                key={r ?? "all"}
                type="button"
                onClick={() => setRepoFilter(r)}
                className={cn(
                  "rounded-md border px-2 py-0.5 font-mono text-[10.5px] transition-colors duration-100",
                  repoFilter === r
                    ? "border-line2 bg-bg2 text-fg"
                    : "border-transparent text-fg-faint hover:border-line hover:text-fg-dim",
                )}
              >
                {r ?? "all"}
              </button>
            ))}
          </div>
        )}
      </div>

      {archiveError && (
        <div className="rounded-lg border border-err/30 bg-err/5 px-3 py-2 font-mono text-[11px] text-err feed-in">
          archive failed: {archiveError}
        </div>
      )}

      {isPending ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-err/30 bg-err/5 p-5 text-center font-mono text-[11px] text-err">
          could not load /lessons — is the daemon running with DASHBOARD_PORT set?
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center">
          <BookOpenText className="size-5 text-fg-faint" strokeWidth={1.5} />
          <div className="font-mono text-[11px] text-fg-faint">
            {lessons.length === 0
              ? "the ledger is empty — no lessons captured yet. The flywheel writes one when a run fails and the failure distills into something reusable."
              : `no lessons for ${repoFilter} — clear the filter to see the rest`}
          </div>
        </div>
      ) : (
        <div ref={listRef} className="flex flex-col gap-1.5">
          {shown.map((l) => (
            <LessonRow
              key={l.id}
              lesson={l}
              now={now}
              pending={mutation.isPending && mutation.variables === l.id}
              onArchive={(id) => mutation.mutate(id)}
            />
          ))}
        </div>
      )}

      {lastArchived !== null && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2.5 rounded-lg border border-ok/40 bg-bg1 px-3 py-2.5 shadow-lg feed-in">
          <span className="flex size-4 items-center justify-center rounded-full bg-ok/15">
            <Check className="size-3 text-ok" strokeWidth={2.5} />
          </span>
          <span className="font-mono text-[12px] text-fg">
            lesson #{lastArchived} archived — row kept in factory.db, out of the loop
          </span>
        </div>
      )}
    </div>
  );
}
