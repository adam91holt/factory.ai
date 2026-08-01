import type { BrowserEvidence, GateMeta, GateStrength } from "./events";
import { isMockMode } from "./fixtures";

// ---------------------------------------------------------------------------
// Approvals client + pure review-queue helpers.
//
// CONTRACT (inbox-backend stream — src/server.ts approvals routes). The JSON is
// the contract, duplicated by design like lessons.ts/telemetry.ts. Everything
// wire-shaped lives in THIS one file so reconciling with the backend branch is
// a one-file diff:
//
//   GET  /approvals                    → ApprovalsPayload
//   POST /approvals/approve  {id}      → ApprovalActionResponse
//   POST /approvals/pushback {id, feedback} → ApprovalActionResponse
//
// TIGHTEN-ONLY invariant (mirrors the backend's): this UI holds NO merge
// authority of its own. [Approve & merge] only asks the daemon to run the
// existing mergePr path pinned to the head SHA the gates ran against
// (--match-head-commit); if the branch moved since gating the backend REFUSES
// and the error ("branch moved since gating — needs re-gate") is rendered
// verbatim on the card. The UI's job is context + explicit human intent, never
// a second merge path.
// ---------------------------------------------------------------------------

export type ApprovalStatus = "pending" | "stale" | "approved" | "pushed_back";

export interface ApprovalItem {
  /** Stable id the action POSTs target (backend-chosen; issueKey is the natural key). */
  id: string;
  issueKey: string;
  /** Redacted at emit time server-side (redactSecrets) — still render as plain text only. */
  title: string;
  repo: string;
  /** Epoch ms the run parked / entered needsHuman — "waiting 3h" on the card. */
  parkedAt: number;
  /** loop.ts holdReasons VERBATIM — the exact strings the daemon recorded when
   *  it withheld the merge. Untrusted-derived text: plain text only. */
  holdReasons: string[];
  prUrl: string | null;
  linearUrl: string | null;
  costUsd: number | null;
  turns: number | null;
  /** Latest run_gates snapshot — same shape the run views use. */
  gates: { green: boolean; strength: GateStrength; gates: GateMeta[] } | null;
  securityVerdict: "pass" | "fail" | null;
  /** Design taste gate: null = not a UI-touching diff / not run. */
  tasteVerdict: "pass" | "fail" | null;
  browser: BrowserEvidence | null;
  /** Reviewer findings digest (redacted, plain text) — collapsible on the card. */
  findings: string | null;
  diffStat: { files: number; additions: number; deletions: number } | null;
  /** The SHA the gates ran against — what an approval merge is pinned to. */
  gatedHeadSha: string | null;
  status: ApprovalStatus;
  /** Why the item can no longer be approved (e.g. branch moved since gating). */
  staleReason: string | null;
  /** Epoch ms the item left "pending" (approved / pushed back / went stale). */
  handledAt: number | null;
}

export interface ApprovalsPayload {
  items: ApprovalItem[];
}

export type ApprovalActionResponse = { ok: true; id: string } | { error: string };

// ---------------------------------------------------------------------------
// Pure helpers — kept out of the components so the queue split and the
// approve-gating logic are unit-testable without a DOM (history.ts pattern).
// ---------------------------------------------------------------------------

/** Split the payload into the two sections the page renders: PENDING (oldest
 *  first — the item that has waited longest is the one to look at) and
 *  RECENTLY HANDLED (stale/approved/pushed-back, newest handled first, capped
 *  so the queue keeps context without clutter). Pure; never mutates input. */
export function splitApprovals(
  items: ApprovalItem[],
  handledLimit = 10,
): { pending: ApprovalItem[]; handled: ApprovalItem[] } {
  const pending = items
    .filter((i) => i.status === "pending")
    .sort((a, b) => a.parkedAt - b.parkedAt);
  const handled = items
    .filter((i) => i.status !== "pending")
    .sort((a, b) => (b.handledAt ?? b.parkedAt) - (a.handledAt ?? a.parkedAt))
    .slice(0, handledLimit);
  return { pending, handled };
}

/** Why [Approve & merge] is disabled, or null when the human may act.
 *
 *  TIGHTEN-ONLY: ambiguity resolves toward DISABLED. A stale item, an already-
 *  handled item, an item with no PR, or one with no recorded gated head SHA
 *  (nothing to pin --match-head-commit to) can never be approved from here —
 *  the backend re-checks all of this too; this is belt to its braces, so the
 *  button never even offers an action the backend must refuse. */
export function approveDisabledReason(item: ApprovalItem): string | null {
  if (item.status === "approved") return "already approved";
  if (item.status === "pushed_back") return "already pushed back";
  if (item.status === "stale") return item.staleReason ?? "stale — needs re-gate";
  // A pending item the backend has flagged (e.g. it noticed the branch moved
  // between polls) keeps its card but loses the button, reason shown verbatim.
  if (item.staleReason !== null) return item.staleReason;
  if (item.prUrl === null) return "no PR recorded — nothing to merge";
  if (item.gatedHeadSha === null) return "no gated head SHA recorded — cannot pin the merge to gated evidence";
  return null;
}

/** Test-count ratchet evidence for the strip: the first gate carrying counts
 *  ("tests 631 → 640"); `decreased` is the withhold signal and renders red.
 *  Null when no gate parsed a count on either side. */
export function testCountDelta(
  gates: GateMeta[],
): { baseline: number | null; current: number | null; decreased: boolean } | null {
  for (const g of gates) {
    const b = g.baselineTestCount ?? null;
    const t = g.testCount ?? null;
    if (b !== null || t !== null) {
      return { baseline: b, current: t, decreased: b !== null && t !== null && t < b };
    }
  }
  return null;
}

/** Human-readable label for a handled row's terminal status. */
export function statusLabel(status: ApprovalStatus): string {
  switch (status) {
    case "pending": return "pending";
    case "stale": return "stale";
    case "approved": return "approved";
    case "pushed_back": return "pushed back";
  }
}

// ---------------------------------------------------------------------------
// Fetch/POST client. In ?mock=1 mode the queue is served (and mutated) from
// in-memory fixtures so the page renders and both actions are exercisable with
// no daemon — the same convention as every other view.
// ---------------------------------------------------------------------------

export async function fetchApprovals(): Promise<ApprovalsPayload> {
  if (isMockMode()) return { items: mockApprovalItems() };
  const res = await fetch("/approvals", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /approvals → ${res.status}`);
  return (await res.json()) as ApprovalsPayload;
}

export async function approveItem(id: string): Promise<ApprovalActionResponse> {
  if (isMockMode()) return mockAct(id, "approved");
  const res = await fetch("/approvals/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return (await res.json()) as ApprovalActionResponse;
}

export async function pushbackItem(id: string, feedback: string): Promise<ApprovalActionResponse> {
  if (isMockMode()) return mockAct(id, "pushed_back");
  const res = await fetch("/approvals/pushback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, feedback }),
  });
  return (await res.json()) as ApprovalActionResponse;
}

// ---------------------------------------------------------------------------
// Mock fixtures (?mock=1) — realistic queue states: a guarded-path hold, a
// warranted-but-absent security review, a stale item (branch moved), and two
// recently handled rows. Session-local mutation state so approve/pushback
// visibly move a card to "recently handled" without a backend.
// ---------------------------------------------------------------------------

const mockHandled = new Map<string, { status: ApprovalStatus; at: number }>();

function mockAct(id: string, status: ApprovalStatus): Promise<ApprovalActionResponse> {
  return new Promise((r) =>
    setTimeout(() => {
      if (id === "FAC-31") {
        r({ error: "branch moved since gating — needs re-gate (gated 4f9c2ab, head now 7d01e33)" });
        return;
      }
      mockHandled.set(id, { status, at: Date.now() });
      r({ ok: true, id });
    }, 350),
  );
}

function mockGates(green: boolean, strength: GateStrength, tests: [number, number]): ApprovalItem["gates"] {
  return {
    green,
    strength,
    gates: [
      { name: "typecheck", baselinePassed: true, passed: true, outputTail: "" },
      { name: "test", baselinePassed: true, passed: green, outputTail: green ? "" : "2 tests failed",
        baselineTestCount: tests[0], testCount: tests[1] },
      { name: "build", baselinePassed: true, passed: true, outputTail: "" },
    ],
  };
}

function mockApprovalItems(): ApprovalItem[] {
  const now = Date.now();
  const base: ApprovalItem[] = [
    {
      id: "FAC-27", issueKey: "FAC-27", title: "Rotate webhook signing secret handling into config",
      repo: "rapido/api", parkedAt: now - 3 * 3_600_000,
      holdReasons: ["guarded paths touched: src/config.ts, .env.example"],
      prUrl: "https://github.com/rapido/api/pull/214", linearUrl: "https://linear.app/rapido/issue/FAC-27",
      costUsd: 3.42, turns: 61, gates: mockGates(true, "strong", [631, 640]),
      securityVerdict: "pass", tasteVerdict: null, browser: "pass",
      findings: "reviewer-claude: no blocking findings; suggested narrowing the config type.\nreviewer-codex: confirmed guarded-path change is additive only.",
      diffStat: { files: 6, additions: 212, deletions: 38 }, gatedHeadSha: "9b31c7de41aa",
      status: "pending", staleReason: null, handledAt: null,
    },
    {
      id: "FAC-29", issueKey: "FAC-29", title: "Client portal: invoice export to CSV",
      repo: "rapido/portal", parkedAt: now - 55 * 60_000,
      holdReasons: [
        "security review did not complete on a 842-line diff (stage error or no parseable verdict line) — cannot auto-merge unreviewed",
      ],
      prUrl: "https://github.com/rapido/portal/pull/88", linearUrl: "https://linear.app/rapido/issue/FAC-29",
      costUsd: 5.87, turns: 94, gates: mockGates(true, "real", [204, 213]),
      securityVerdict: null, tasteVerdict: "pass", browser: "partial",
      findings: "reviewer-claude: CSV escaping fixed in round 2.\nreviewer-codex: flagged missing pagination on export query (fixed).",
      diffStat: { files: 11, additions: 604, deletions: 92 }, gatedHeadSha: "51fe0a92cc03",
      status: "pending", staleReason: null, handledAt: null,
    },
    {
      id: "FAC-31", issueKey: "FAC-31", title: "Switch tower sync to incremental cursor",
      repo: "rapido/api", parkedAt: now - 26 * 3_600_000,
      holdReasons: ["design taste gate failed (see design review)"],
      prUrl: "https://github.com/rapido/api/pull/217", linearUrl: "https://linear.app/rapido/issue/FAC-31",
      costUsd: 2.11, turns: 40, gates: mockGates(true, "real", [640, 640]),
      securityVerdict: "pass", tasteVerdict: "fail", browser: "missing",
      findings: "design reviewer: cursor state machine is sound but the settings surface is cluttered.",
      diffStat: { files: 4, additions: 130, deletions: 44 }, gatedHeadSha: "4f9c2ab77d10",
      status: "pending", staleReason: null, handledAt: null,
    },
    {
      id: "FAC-22", issueKey: "FAC-22", title: "Fix flaky retry test in backoff suite",
      repo: "adam91holt/factory.ai", parkedAt: now - 2 * 86_400_000,
      holdReasons: ["change DELETES test files (tests/backoff-old.test.ts) — categorical human review"],
      prUrl: "https://github.com/adam91holt/factory.ai/pull/61", linearUrl: "https://linear.app/rapido/issue/FAC-22",
      costUsd: 1.09, turns: 22, gates: mockGates(true, "real", [598, 597]),
      securityVerdict: "pass", tasteVerdict: null, browser: "not-required",
      findings: null, diffStat: { files: 2, additions: 41, deletions: 78 }, gatedHeadSha: null,
      status: "stale", staleReason: "branch moved since gating — needs re-gate", handledAt: now - 86_400_000,
    },
    {
      id: "FAC-19", issueKey: "FAC-19", title: "Add spend-cap alerting to Slack",
      repo: "adam91holt/factory.ai", parkedAt: now - 3 * 86_400_000,
      holdReasons: ["guarded paths touched: src/alerts.ts"],
      prUrl: "https://github.com/adam91holt/factory.ai/pull/57", linearUrl: "https://linear.app/rapido/issue/FAC-19",
      costUsd: 0.84, turns: 18, gates: mockGates(true, "strong", [590, 598]),
      securityVerdict: "pass", tasteVerdict: null, browser: "pass",
      findings: null, diffStat: { files: 3, additions: 96, deletions: 12 }, gatedHeadSha: "e2ab99c01f44",
      status: "approved", staleReason: null, handledAt: now - 2 * 86_400_000,
    },
  ];
  return base.map((item) => {
    const acted = mockHandled.get(item.id);
    return acted ? { ...item, status: acted.status, handledAt: acted.at } : item;
  });
}
