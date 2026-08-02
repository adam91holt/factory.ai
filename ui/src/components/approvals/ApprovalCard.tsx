import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, ChevronRight, CornerUpLeft, GitPullRequest } from "lucide-react";
import type { ApprovalItem } from "../../lib/approvals";
import { approveDisabledReason, safeHref, testCountDelta } from "../../lib/approvals";
import { relTime, usd } from "../../lib/format";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";

// One pending review-queue item, with EVERYTHING needed to decide in place:
// why the daemon held it (verbatim), the evidence it gathered, and the two
// actions. Approve is a two-step arm (LessonsPage ArchiveButton idiom — one
// extra click, no modal); push back opens an inline textarea. All strings that
// originate in agent output (hold reasons, findings, errors) render as PLAIN
// TEXT only — they are redacted server-side but still untrusted-derived.

/** Evidence chip in the GateRounds visual language: green/red border+text. */
function EvidenceChip({ label, tone, title }: { label: string; tone: "ok" | "err" | "warn" | "dim"; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "rounded border px-1.5 py-px font-mono text-[10px] uppercase tracking-wide",
        tone === "ok" && "border-ok/35 text-ok",
        tone === "err" && "border-err/35 text-err",
        tone === "warn" && "border-parked/35 text-parked",
        tone === "dim" && "border-line2 text-fg-dim",
      )}
    >
      {label}
    </span>
  );
}

/** Verdict string → chip tone, or null to render no chip at all. The backend
 *  ships raw strings ("pass" | "fail" | "none" for security; "pass" | "fail" |
 *  "error" | "not-required" for taste) — only values that carry signal earn a
 *  chip; "none"/"not-required" mean the check wasn't warranted, so silence. */
function verdictTone(verdict: string): "ok" | "err" | "warn" | null {
  if (verdict === "pass") return "ok";
  if (verdict === "fail") return "err";
  if (verdict === "error") return "warn";
  return null;
}

/** Gates + tests ratchet + security + taste on one strip. Reuses the
 *  green/red/strength grading of GateRounds so evidence reads the same here as
 *  on the run drill-down. The backend's gateSummary carries overall
 *  green/strength plus per-gate TEST COUNTS only (no per-gate pass marks —
 *  those live on the run drill-down), so that is exactly what renders. */
function EvidenceStrip({ item }: { item: ApprovalItem }) {
  const g = item.gates;
  const tests = g ? testCountDelta(g.tests) : null;
  const security = verdictTone(item.securityVerdict);
  const taste = verdictTone(item.tasteVerdict);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {g ? (
        <>
          <EvidenceChip label={g.green ? "gates green" : "gates red"} tone={g.green ? "ok" : "err"} />
          <span
            className={cn(
              "font-mono text-[10px]",
              g.strength === "real" || g.strength === "strong" ? "text-ok" : g.strength === "weak" ? "text-live" : "text-err",
            )}
          >
            strength {g.strength}
          </span>
        </>
      ) : (
        <EvidenceChip label="gates not run" tone="warn" />
      )}
      {tests && (
        <span
          className={cn("font-mono text-[10px]", tests.decreased ? "text-err" : "text-fg-faint")}
          title={tests.decreased ? "passing test count decreased vs baseline" : "passing tests: baseline → post-change"}
        >
          tests {tests.baseline ?? "?"} → {tests.current ?? "?"}
        </span>
      )}
      {security && <EvidenceChip label={`security ${item.securityVerdict}`} tone={security} />}
      {taste && <EvidenceChip label={`taste ${item.tasteVerdict}`} tone={taste} />}
    </div>
  );
}

function ApproveButton({
  disabledReason,
  pending,
  onApprove,
}: {
  disabledReason: string | null;
  pending: boolean;
  onApprove: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  if (disabledReason !== null) {
    return (
      <span
        className="flex h-11 cursor-not-allowed items-center gap-1.5 rounded-md border border-line px-3 font-mono text-[11px] text-fg-faint md:h-7 md:px-2.5 md:text-[10.5px]"
        title={disabledReason}
      >
        <Check className="size-3" strokeWidth={1.75} />
        approve & merge — {disabledReason}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!armed) { setArmed(true); return; }
        setArmed(false);
        onApprove();
      }}
      className={cn(
        "flex h-11 items-center gap-1.5 rounded-md border px-3 font-mono text-[11px] md:h-7 md:px-2.5 md:text-[10.5px]",
        "transition-[color,background-color,border-color,transform] duration-100 active:scale-95",
        armed
          ? "border-ok/60 bg-ok/15 text-ok hover:bg-ok/25"
          : "border-ok/35 bg-ok/5 text-ok hover:bg-ok/10",
        pending && "cursor-wait opacity-50",
      )}
      title={
        armed
          ? "click again to merge — pinned to the gated head SHA; refused if the branch moved"
          : "approve: merge this PR exactly as gated"
      }
    >
      <Check className="size-3" strokeWidth={2} />
      {pending ? "merging…" : armed ? "confirm — merge now?" : "approve & merge"}
    </button>
  );
}

function PushbackForm({
  pending,
  onPushback,
}: {
  pending: boolean;
  onPushback: (feedback: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-11 items-center gap-1.5 rounded-md border border-line px-3 font-mono text-[11px] text-fg-dim transition-colors duration-100 hover:border-line2 hover:bg-bg2 hover:text-fg md:h-7 md:px-2.5 md:text-[10.5px]"
        title="send it back to the factory with feedback — a fixer round picks it up"
      >
        <CornerUpLeft className="size-3" strokeWidth={1.75} />
        push back
      </button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-1.5">
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="What should change?"
        rows={3}
        autoFocus
        className="w-full resize-y rounded-md border border-line bg-bg0 px-2.5 py-2 font-mono text-[11.5px] text-fg outline-none placeholder:text-fg-faint focus:border-line2"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={pending || feedback.trim() === ""}
          onClick={() => onPushback(feedback.trim())}
          className={cn(
            "flex h-11 items-center gap-1.5 rounded-md border border-human/40 bg-human/10 px-3 font-mono text-[11px] text-human md:h-7 md:px-2.5 md:text-[10.5px]",
            "transition-colors duration-100 hover:bg-human/20",
            (pending || feedback.trim() === "") && "cursor-not-allowed opacity-50",
          )}
        >
          <CornerUpLeft className="size-3" strokeWidth={1.75} />
          {pending ? "sending…" : "send back"}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setFeedback(""); }}
          className="h-7 rounded-md px-2 font-mono text-[10.5px] text-fg-faint hover:text-fg-dim"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

export function ApprovalCard({
  item,
  now,
  approvePending,
  pushbackPending,
  error,
  onApprove,
  onPushback,
}: {
  item: ApprovalItem;
  now: number;
  approvePending: boolean;
  pushbackPending: boolean;
  /** Verbatim backend refusal for THIS item (e.g. "branch moved since gating"). */
  error: string | null;
  /** Carries the SHA THIS card rendered — the backend refuses the merge if the
   *  item has moved on since (lib/approvals approveItem). */
  onApprove: (id: string, gatedHeadSha: string | null) => void;
  onPushback: (id: string, feedback: string) => void;
}) {
  const disabledReason = approveDisabledReason(item);
  const prHref = safeHref(item.prUrl);

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-bg1 px-3.5 py-3 transition-colors duration-100 hover:border-line2">
      {/* header: identity + when + cost */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Link
          to="/runs/$issueKey"
          params={{ issueKey: item.issueKey }}
          className="font-mono text-[13px] font-medium text-fg transition-colors duration-100 hover:text-live"
          title="open the full run drill-down"
        >
          {item.issueKey}
        </Link>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-dim">{item.title}</span>
        <Badge variant="outline">{item.repo}</Badge>
        <span className="font-mono text-[10.5px] text-fg-faint" title={new Date(item.parkedAt).toISOString()}>
          parked {relTime(item.parkedAt, now)}
        </span>
        {(item.costUsd !== null || item.turns !== null) && (
          <span className="font-mono text-[10.5px] text-fg-faint">
            {item.costUsd !== null && usd(item.costUsd)}
            {item.costUsd !== null && item.turns !== null && " · "}
            {item.turns !== null && `${item.turns} turns`}
          </span>
        )}
      </div>

      {/* WHY IT'S HERE — the daemon's hold reasons, verbatim and prominent */}
      <div className="rounded-lg border border-human/35 bg-human/5 px-3 py-2">
        <div className="section-label mb-1 text-human">why it&apos;s here</div>
        {item.holdReasons.length === 0 ? (
          <p className="font-mono text-[11px] text-fg-faint">no hold reason recorded</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {item.holdReasons.map((r, i) => (
              <li key={i} className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-fg">
                {r}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Known-red combination. Sits ABOVE the evidence strip because the strip
          below it says "gates green" — true of this branch alone, against an
          obsolete main. Approve stays enabled: the human is the authority here,
          but the override has to be an informed one. */}
      {item.regateFailed && (
        <div className="flex items-start gap-2 rounded-lg border border-err/60 bg-err/10 px-3 py-2">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-err" strokeWidth={2} />
          <div className="flex flex-col gap-0.5">
            <div className="font-mono text-[11.5px] font-medium text-err">
              Re-gate against current main FAILED — merging anyway ships a known-red combination
            </div>
            <div className="font-mono text-[10.5px] leading-relaxed text-fg-dim">
              The gate results below are green for this branch alone. The factory merged current main in,
              re-ran the gates, and they failed — so this PR was never pushed past that point and its head
              is still the older gated commit.
            </div>
          </div>
        </div>
      )}

      <EvidenceStrip item={item} />

      {/* findings digest — collapsible, plain text */}
      {item.findings !== null && item.findings !== "" && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 font-mono text-[10.5px] text-fg-faint hover:text-fg-dim [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 transition-transform duration-100 group-open:rotate-90" strokeWidth={2} />
            review findings
          </summary>
          <pre className="mt-1 max-h-56 overflow-y-auto rounded-md border border-line bg-bg0 p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-fg-dim">
            {item.findings}
          </pre>
        </details>
      )}

      {/* diff stat + links */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-fg-faint">
        {item.diffStat && (
          // Preformatted by the backend (loop.ts): "6 files · 212 changed lines".
          <span>{item.diffStat}</span>
        )}
        {item.gatedHeadSha && (
          <span title="the head SHA the gates ran against — an approval merge is pinned to exactly this commit">
            gated @ {item.gatedHeadSha.slice(0, 10)}
          </span>
        )}
        {item.prUrl && (
          // A URL that isn't http(s) renders as inert text, never a target —
          // the string comes from the daemon, not from whoever is reading it.
          prHref !== null ? (
            <a href={prHref} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-ok transition-colors duration-100 hover:text-fg">
              <GitPullRequest className="size-3" strokeWidth={1.75} />
              {item.prUrl.replace("https://github.com/", "")}
            </a>
          ) : (
            <span className="flex items-center gap-1 text-fg-faint" title="not a usable http(s) link — shown as text">
              <GitPullRequest className="size-3" strokeWidth={1.75} />
              {item.prUrl}
            </span>
          )
        )}
        <Link
          to="/runs/$issueKey"
          params={{ issueKey: item.issueKey }}
          className="text-fg-dim transition-colors duration-100 hover:text-live"
        >
          full run →
        </Link>
      </div>

      {/* backend refusal, verbatim — e.g. "branch moved since gating — needs re-gate" */}
      {error && (
        <div className="rounded-lg border border-err/30 bg-err/5 px-3 py-2 font-mono text-[11px] text-err feed-in">
          {error}
        </div>
      )}

      {/* actions */}
      <div className="flex flex-wrap items-start gap-2 border-t border-line pt-2.5">
        <ApproveButton
          disabledReason={disabledReason}
          pending={approvePending}
          onApprove={() => onApprove(item.id, item.gatedHeadSha)}
        />
        <PushbackForm pending={pushbackPending} onPushback={(fb) => onPushback(item.id, fb)} />
      </div>
    </div>
  );
}
