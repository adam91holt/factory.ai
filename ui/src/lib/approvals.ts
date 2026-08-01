import { isMockMode } from "./fixtures";

// ---------------------------------------------------------------------------
// Approvals client + pure review-queue helpers.
//
// CONTRACT (src/server.ts approvals routes + src/db.ts ApprovalItem — the
// backend is the authority; this file is the ONLY place the wire shape lives,
// duplicated by design like lessons.ts/telemetry.ts):
//
//   GET  /approvals                     → { pending: WireApprovalItem[]; count: number }
//   POST /approvals/:id/approve  {}     → 200 { ok, merged, sha, prUrl, warnings? }
//                                       | 4xx/5xx { error, item? }
//   POST /approvals/:id/pushback {feedback}
//                                       → 200 { ok, requeued, issueKey }
//                                       | 4xx/5xx { error, item? }
//
// The backend serves PENDING items only (a decided row disappears from the
// list on the next poll); the "Recently handled" section is session-local —
// we snapshot a card at the moment an action settles it (including a stale
// refusal, whose verbatim reason the backend returns in `item.resolution`).
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

/** Per-gate test-count ratchet slice ("tests 631 → 640") — db.ts ApprovalGateTests. */
export interface ApprovalGateTests { name: string; from: number | null; to: number | null }

/** The backend row exactly as GET /approvals serves it (db.ts ApprovalItem). */
export interface WireApprovalItem {
  id: number;
  createdAt: number;
  updatedAt: number;
  issueKey: string;
  title: string;
  repo: string;
  prUrl: string;
  gatedHeadSha: string | null;
  /** ONE verbatim string — loop.ts joins its hold reasons with "; " before filing. */
  holdReasons: string;
  gateSummary: { green: boolean; strength: string; tests: ApprovalGateTests[] } | null;
  /** "pass" | "fail" | "none" (loop.ts writes "none" when no review ran). */
  securityVerdict: string;
  /** "pass" | "fail" | "error" | "not-required". */
  tasteVerdict: string;
  findingsDigest: string;
  /** Preformatted by loop.ts, e.g. "6 files · 212 changed lines". */
  diffStat: string;
  costUsd: number;
  turns: number;
  status: ApprovalStatus;
  /** Why the row left pending — for a stale row this is the refusal reason. */
  resolution: string;
}

/** The view-model the page/cards render — wire item + session-derived fields. */
export interface ApprovalItem {
  /** String form of the backend's numeric row id — the action URLs' :id. */
  id: string;
  issueKey: string;
  /** Redacted at write time server-side (redactSecrets) — still render as plain text only. */
  title: string;
  repo: string;
  /** Epoch ms the item was filed (backend createdAt) — "parked 3h ago" on the card. */
  parkedAt: number;
  /** loop.ts hold reasons VERBATIM. The backend stores ONE joined string; it is
   *  kept whole (never re-split — reasons may themselves contain "; ").
   *  Untrusted-derived text: plain text only. */
  holdReasons: string[];
  prUrl: string | null;
  costUsd: number | null;
  turns: number | null;
  /** Backend gateSummary verbatim: overall green/strength + per-gate test ratchet. */
  gates: { green: boolean; strength: string; tests: ApprovalGateTests[] } | null;
  /** Raw backend verdict strings — cards decide which values earn a chip. */
  securityVerdict: string;
  tasteVerdict: string;
  /** Reviewer findings digest (redacted, plain text) — collapsible on the card. */
  findings: string | null;
  /** Preformatted diff stat string from the backend. */
  diffStat: string | null;
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

/** Wire → view-model. Pure; exported so the mapping is pinned by tests. */
export function mapApprovalItem(w: WireApprovalItem): ApprovalItem {
  // An unknown status can only come from a newer backend — degrade to "stale"
  // (never approvable) exactly like db.ts's own toApprovalItem does.
  const status: ApprovalStatus = ["pending", "stale", "approved", "pushed_back"].includes(w.status)
    ? w.status
    : "stale";
  return {
    id: String(w.id),
    issueKey: w.issueKey,
    title: w.title,
    repo: w.repo,
    parkedAt: w.createdAt,
    holdReasons: w.holdReasons.trim() === "" ? [] : [w.holdReasons],
    prUrl: w.prUrl.trim() === "" ? null : w.prUrl,
    costUsd: Number.isFinite(w.costUsd) ? w.costUsd : null,
    turns: Number.isFinite(w.turns) ? w.turns : null,
    gates: w.gateSummary,
    securityVerdict: w.securityVerdict,
    tasteVerdict: w.tasteVerdict,
    findings: w.findingsDigest.trim() === "" ? null : w.findingsDigest,
    diffStat: w.diffStat.trim() === "" ? null : w.diffStat,
    gatedHeadSha: w.gatedHeadSha,
    status,
    staleReason: status === "stale" && w.resolution.trim() !== "" ? w.resolution : null,
    handledAt: status === "pending" ? null : w.updatedAt,
  };
}

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
 *  Null when no gate parsed a count on either side. Operates on the backend's
 *  gateSummary.tests slices (name/from/to). */
export function testCountDelta(
  tests: ApprovalGateTests[],
): { baseline: number | null; current: number | null; decreased: boolean } | null {
  for (const t of tests) {
    const b = t.from ?? null;
    const c = t.to ?? null;
    if (b !== null || c !== null) {
      return { baseline: b, current: c, decreased: b !== null && c !== null && c < b };
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
// Fetch/POST client. The backend lists PENDING rows only, so "recently
// handled" is session state: when an action settles an item (success OR a
// stale refusal that carries the decided row back), we snapshot it here and
// fetchApprovals splices the snapshots in for splitApprovals to section.
// In ?mock=1 mode the queue is served (and mutated) from in-memory wire-shaped
// fixtures flowing through the SAME mapping — the convention of every view.
// ---------------------------------------------------------------------------

const sessionHandled = new Map<string, ApprovalItem>();
/** Last-fetched pending cards by id — the snapshot source when an action's
 *  response doesn't echo the row back (the success cases). */
const lastFetched = new Map<string, ApprovalItem>();

function recordHandled(id: string, status: Exclude<ApprovalStatus, "pending">, staleReason: string | null): void {
  const snap = lastFetched.get(id);
  if (!snap) return;
  sessionHandled.set(id, { ...snap, status, staleReason, handledAt: Date.now() });
}

export async function fetchApprovals(): Promise<ApprovalsPayload> {
  const pending = isMockMode() ? mockPending() : await fetchPendingWire();
  lastFetched.clear();
  for (const item of pending) lastFetched.set(item.id, item);
  // A superseded/re-filed issue gets a NEW row id, so a handled snapshot can
  // only collide with pending if the server resurrected the exact row — in
  // that unexpected case the server's view wins and the snapshot is dropped.
  const handled = [...sessionHandled.values()].filter((h) => !lastFetched.has(h.id));
  return { items: [...pending, ...handled] };
}

async function fetchPendingWire(): Promise<ApprovalItem[]> {
  const res = await fetch("/approvals", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /approvals → ${res.status}`);
  const payload = (await res.json()) as { pending: WireApprovalItem[] };
  return (payload.pending ?? []).map(mapApprovalItem);
}

/** POST one action; both endpoints answer { ok } on success and { error }
 *  (optionally with the decided wire row as `item`) on refusal. A refusal that
 *  reports the row already decided (stale/approved/pushed_back — e.g. this
 *  click lost a race, or the branch moved) snapshots it into the handled
 *  section so the card's disappearance from pending is explained, not silent. */
async function postAction(
  id: string,
  action: "approve" | "pushback",
  body: Record<string, unknown>,
): Promise<ApprovalActionResponse> {
  const res = await fetch(`/approvals/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as
    | { ok?: unknown; error?: unknown; item?: WireApprovalItem | null }
    | null;
  if (res.ok && json?.ok === true) {
    recordHandled(id, action === "approve" ? "approved" : "pushed_back", null);
    return { ok: true, id };
  }
  const error = typeof json?.error === "string" && json.error !== ""
    ? json.error
    : `POST /approvals/${id}/${action} → ${res.status}`;
  if (json?.item && json.item.status !== "pending") {
    const mapped = mapApprovalItem(json.item);
    sessionHandled.set(id, { ...mapped, staleReason: mapped.staleReason ?? error, handledAt: Date.now() });
  }
  return { error };
}

export async function approveItem(id: string): Promise<ApprovalActionResponse> {
  if (isMockMode()) return mockAct(id, "approved");
  // guardedJsonBody requires a parseable JSON body on every mutation route —
  // approve carries no fields, so it sends the empty object.
  return postAction(id, "approve", {});
}

export async function pushbackItem(id: string, feedback: string): Promise<ApprovalActionResponse> {
  if (isMockMode()) return mockAct(id, "pushed_back");
  return postAction(id, "pushback", { feedback });
}

// ---------------------------------------------------------------------------
// Mock fixtures (?mock=1) — realistic queue states in the WIRE shape (so the
// mapping above is exercised too): a guarded-path hold, a warranted-but-absent
// security review, a taste fail whose approve will be refused as stale.
// Session-local mutation state so approve/pushback visibly move a card to
// "recently handled" without a backend — via the same recordHandled path.
// ---------------------------------------------------------------------------

function mockAct(id: string, status: Exclude<ApprovalStatus, "pending" | "stale">): Promise<ApprovalActionResponse> {
  return new Promise((r) =>
    setTimeout(() => {
      if (id === "31") {
        const reason = "branch moved since gating — needs re-gate";
        recordHandled(id, "stale", reason);
        r({ error: reason });
        return;
      }
      recordHandled(id, status, null);
      r({ ok: true, id });
    }, 350),
  );
}

function mockPending(): ApprovalItem[] {
  const now = Date.now();
  const wire: WireApprovalItem[] = [
    {
      id: 27, createdAt: now - 3 * 3_600_000, updatedAt: now - 3 * 3_600_000,
      issueKey: "FAC-27", title: "Rotate webhook signing secret handling into config",
      repo: "rapido/api", prUrl: "https://github.com/rapido/api/pull/214",
      gatedHeadSha: "9b31c7de41aa", holdReasons: "guarded paths touched: src/config.ts, .env.example",
      gateSummary: { green: true, strength: "strong", tests: [{ name: "test", from: 631, to: 640 }] },
      securityVerdict: "pass", tasteVerdict: "not-required",
      findingsDigest: "reviewer-claude: no blocking findings; suggested narrowing the config type.\nreviewer-codex: confirmed guarded-path change is additive only.",
      diffStat: "6 files · 250 changed lines", costUsd: 3.42, turns: 61,
      status: "pending", resolution: "",
    },
    {
      id: 29, createdAt: now - 55 * 60_000, updatedAt: now - 55 * 60_000,
      issueKey: "FAC-29", title: "Client portal: invoice export to CSV",
      repo: "rapido/portal", prUrl: "https://github.com/rapido/portal/pull/88",
      gatedHeadSha: "51fe0a92cc03",
      holdReasons: "security review did not complete on a 842-line diff (stage error or no parseable verdict line) — cannot auto-merge unreviewed",
      gateSummary: { green: true, strength: "real", tests: [{ name: "test", from: 204, to: 213 }] },
      securityVerdict: "none", tasteVerdict: "pass",
      findingsDigest: "reviewer-claude: CSV escaping fixed in round 2.\nreviewer-codex: flagged missing pagination on export query (fixed).",
      diffStat: "11 files · 696 changed lines", costUsd: 5.87, turns: 94,
      status: "pending", resolution: "",
    },
    {
      id: 31, createdAt: now - 26 * 3_600_000, updatedAt: now - 26 * 3_600_000,
      issueKey: "FAC-31", title: "Switch tower sync to incremental cursor",
      repo: "rapido/api", prUrl: "https://github.com/rapido/api/pull/217",
      gatedHeadSha: "4f9c2ab77d10", holdReasons: "design taste gate failed (see design review)",
      gateSummary: { green: true, strength: "real", tests: [{ name: "test", from: 640, to: 640 }] },
      securityVerdict: "pass", tasteVerdict: "fail",
      findingsDigest: "design reviewer: cursor state machine is sound but the settings surface is cluttered.",
      diffStat: "4 files · 174 changed lines", costUsd: 2.11, turns: 40,
      status: "pending", resolution: "",
    },
    {
      id: 22, createdAt: now - 2 * 86_400_000, updatedAt: now - 2 * 86_400_000,
      issueKey: "FAC-22", title: "Fix flaky retry test in backoff suite",
      repo: "adam91holt/factory.ai", prUrl: "https://github.com/adam91holt/factory.ai/pull/61",
      gatedHeadSha: null,
      holdReasons: "passing test count DECREASED vs baseline (598 → 597) — possible gutted/skipped tests; human must adjudicate",
      gateSummary: { green: true, strength: "real", tests: [{ name: "test", from: 598, to: 597 }] },
      securityVerdict: "pass", tasteVerdict: "not-required",
      findingsDigest: "", diffStat: "2 files · 119 changed lines", costUsd: 1.09, turns: 22,
      status: "pending", resolution: "",
    },
  ];
  return wire.map(mapApprovalItem).filter((i) => !sessionHandled.has(i.id));
}
