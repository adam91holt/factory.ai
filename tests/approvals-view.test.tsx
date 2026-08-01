import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  approveDisabledReason,
  approveItem,
  mapApprovalItem,
  safeHref,
  splitApprovals,
  statusLabel,
  testCountDelta,
  type ApprovalGateTests,
  type ApprovalItem,
  type WireApprovalItem,
} from "../ui/src/lib/approvals.ts";

// The review queue's pure logic: the wire→view mapping (the UI's copy of the
// backend contract — db.ts ApprovalItem via GET /approvals), the pending/
// handled split the page renders, and — the safety-relevant piece —
// approveDisabledReason, which decides when [Approve & merge] is even offered.
// TIGHTEN-ONLY: the button must disappear for stale/handled items and for
// anything missing a PR or a gated head SHA (nothing to pin
// --match-head-commit to); the backend re-checks all of this, these tests pin
// the UI's belt to those braces.

function item(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: "1", issueKey: "FAC-1", title: "t", repo: "acme/x",
    parkedAt: 1000, holdReasons: ["guarded paths touched: src/config.ts"],
    prUrl: "https://github.com/acme/x/pull/1",
    costUsd: 1, turns: 10,
    gates: { green: true, strength: "strong", tests: [] },
    securityVerdict: "pass", tasteVerdict: "not-required",
    findings: null, diffStat: null, gatedHeadSha: "abc123",
    regateFailed: false, status: "pending", staleReason: null, handledAt: null,
    ...overrides,
  };
}

function wire(overrides: Partial<WireApprovalItem> = {}): WireApprovalItem {
  return {
    id: 7, createdAt: 1000, updatedAt: 2000, issueKey: "FAC-7", title: "t",
    repo: "acme/x", prUrl: "https://github.com/acme/x/pull/7",
    gatedHeadSha: "abc123def456",
    holdReasons: "guarded paths touched: src/config.ts; security review returned a FAIL verdict",
    gateSummary: { green: true, strength: "strong", tests: [{ name: "test", from: 631, to: 640 }] },
    securityVerdict: "fail", tasteVerdict: "not-required",
    findingsDigest: "reviewer: fine", diffStat: "3 files · 96 changed lines",
    costUsd: 2.5, turns: 33, regateFailed: false, status: "pending", resolution: "",
    ...overrides,
  };
}

describe("mapApprovalItem — the UI's copy of the backend wire contract", () => {
  test("maps a pending row: numeric id → string, createdAt → parkedAt, no handledAt", () => {
    const m = mapApprovalItem(wire());
    expect(m.id).toBe("7");
    expect(m.parkedAt).toBe(1000);
    expect(m.handledAt).toBeNull();
    expect(m.staleReason).toBeNull();
    expect(m.gates).toEqual({ green: true, strength: "strong", tests: [{ name: "test", from: 631, to: 640 }] });
  });

  test("hold reasons stay ONE verbatim string — never re-split on ';' (reasons may contain it)", () => {
    const m = mapApprovalItem(wire());
    expect(m.holdReasons).toEqual([
      "guarded paths touched: src/config.ts; security review returned a FAIL verdict",
    ]);
  });

  test("a stale row carries its resolution as the verbatim stale reason and updatedAt as handledAt", () => {
    const m = mapApprovalItem(wire({ status: "stale", resolution: "branch moved since gating — needs re-gate" }));
    expect(m.status).toBe("stale");
    expect(m.staleReason).toBe("branch moved since gating — needs re-gate");
    expect(m.handledAt).toBe(2000);
  });

  test("an UNKNOWN status from a newer backend degrades to stale — never approvable", () => {
    const m = mapApprovalItem(wire({ status: "wat" as WireApprovalItem["status"] }));
    expect(m.status).toBe("stale");
    expect(approveDisabledReason(m)).not.toBeNull();
  });

  test("the re-gate-failed flag maps through; a row without it never renders the banner", () => {
    expect(mapApprovalItem(wire({ regateFailed: true })).regateFailed).toBe(true);
    expect(mapApprovalItem(wire()).regateFailed).toBe(false);
    // An older backend omits the field entirely — must be false, not undefined.
    const legacy = wire();
    delete (legacy as Partial<WireApprovalItem>).regateFailed;
    expect(mapApprovalItem(legacy).regateFailed).toBe(false);
  });

  test("empty strings become nulls the card treats as absent (pr/findings/diffStat/holdReasons)", () => {
    const m = mapApprovalItem(wire({ prUrl: "", findingsDigest: "", diffStat: "", holdReasons: " " }));
    expect(m.prUrl).toBeNull();
    expect(m.findings).toBeNull();
    expect(m.diffStat).toBeNull();
    expect(m.holdReasons).toEqual([]);
  });
});

describe("splitApprovals — the two sections of the review queue", () => {
  test("pending sorts oldest-first (longest wait on top), handled newest-handled-first", () => {
    const items = [
      item({ id: "a", parkedAt: 3000 }),
      item({ id: "b", parkedAt: 1000 }),
      item({ id: "c", status: "approved", handledAt: 500 }),
      item({ id: "d", status: "pushed_back", handledAt: 900 }),
      item({ id: "e", status: "stale", handledAt: null, parkedAt: 700 }),
    ];
    const { pending, handled } = splitApprovals(items);
    expect(pending.map((i) => i.id)).toEqual(["b", "a"]);
    // e has no handledAt — falls back to parkedAt (700) for ordering.
    expect(handled.map((i) => i.id)).toEqual(["d", "e", "c"]);
  });

  test("handled is capped (last 10 by default) so the queue keeps context without clutter", () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      item({ id: `h${i}`, status: "approved", handledAt: i }),
    );
    const { handled } = splitApprovals(items);
    expect(handled.length).toBe(10);
    // the 10 MOST RECENTLY handled survive, newest first
    expect(handled[0]!.id).toBe("h14");
    expect(handled[9]!.id).toBe("h5");
  });

  test("never mutates its input", () => {
    const items = [item({ id: "a", parkedAt: 2 }), item({ id: "b", parkedAt: 1 })];
    splitApprovals(items);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("approveDisabledReason — when [Approve & merge] may not be offered", () => {
  test("a clean pending item is approvable", () => {
    expect(approveDisabledReason(item())).toBeNull();
  });

  test("stale item is disabled with its verbatim stale reason", () => {
    const r = approveDisabledReason(
      item({ status: "stale", staleReason: "branch moved since gating — needs re-gate" }),
    );
    expect(r).toBe("branch moved since gating — needs re-gate");
  });

  test("stale item with no recorded reason still refuses (never silently enables)", () => {
    expect(approveDisabledReason(item({ status: "stale" }))).toContain("stale");
  });

  test("a PENDING item the backend flagged stale between polls loses the button too", () => {
    const r = approveDisabledReason(item({ staleReason: "branch moved since gating — needs re-gate" }));
    expect(r).toBe("branch moved since gating — needs re-gate");
  });

  test("already-handled items can never be re-approved", () => {
    expect(approveDisabledReason(item({ status: "approved" }))).toBe("already approved");
    expect(approveDisabledReason(item({ status: "pushed_back" }))).toBe("already pushed back");
  });

  test("no PR / no gated head SHA → disabled (nothing to merge / nothing to pin to)", () => {
    expect(approveDisabledReason(item({ prUrl: null }))).toContain("no PR");
    expect(approveDisabledReason(item({ gatedHeadSha: null }))).toContain("gated head SHA");
  });
});

describe("testCountDelta — the a→b ratchet evidence on the strip", () => {
  const slice = (over: Partial<ApprovalGateTests>): ApprovalGateTests => ({
    name: "test", from: null, to: null, ...over,
  });

  test("first slice with counts wins; decrease flags red", () => {
    const d = testCountDelta([
      slice({ name: "typecheck" }),
      slice({ from: 640, to: 631 }),
    ]);
    expect(d).toEqual({ baseline: 640, current: 631, decreased: true });
  });

  test("increase is not a decrease; unknown side is tolerated", () => {
    expect(testCountDelta([slice({ from: 631, to: 640 })])!.decreased).toBe(false);
    expect(testCountDelta([slice({ from: null, to: 640 })])).toEqual({
      baseline: null, current: 640, decreased: false,
    });
  });

  test("no slice carries counts → null (strip renders nothing)", () => {
    expect(testCountDelta([slice({ name: "typecheck" }), slice({ name: "build" })])).toBeNull();
  });
});

describe("safeHref — only http(s) may become a clickable target", () => {
  test("http/https pass through", () => {
    expect(safeHref("https://github.com/acme/x/pull/1")).toBe("https://github.com/acme/x/pull/1");
    expect(safeHref("http://127.0.0.1:8787/approvals")).toBe("http://127.0.0.1:8787/approvals");
    expect(safeHref("https://linear.app/x/issue/FAC-1")).toBe("https://linear.app/x/issue/FAC-1");
  });

  test("script-bearing and document-bearing schemes get NO href", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("  JavaScript:alert(1)")).toBeNull();
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHref("blob:https://evil.example/x")).toBeNull();
    expect(safeHref("vbscript:msgbox(1)")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
  });

  test("absent / malformed / relative is not a link either", () => {
    expect(safeHref(null)).toBeNull();
    expect(safeHref("   ")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
    expect(safeHref("/runs/FAC-1")).toBeNull();
  });
});

describe("approveItem sends the evidence the card rendered", () => {
  // The client reads isMockMode() (window.location.search) and fetch; both are
  // stubbed here so the request shape itself can be asserted without a DOM.
  const realFetch = globalThis.fetch;
  let lastRequest: { url: string; body: unknown } | null = null;

  beforeAll(() => {
    (globalThis as { window?: unknown }).window = { location: { search: "" } };
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      lastRequest = { url, body: JSON.parse(String(init?.body ?? "null")) };
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as { window?: unknown }).window;
  });

  test("the gated head SHA on the card travels with the click (backend 409s a mismatch)", async () => {
    const res = await approveItem("41", "abc123def456");
    expect(res).toEqual({ ok: true, id: "41" });
    expect(lastRequest?.url).toBe("/approvals/41/approve");
    expect(lastRequest?.body).toEqual({ gatedHeadSha: "abc123def456" });
  });

  test("an item with no gated SHA sends null — never an omitted field the backend must guess at", async () => {
    await approveItem("42", null);
    expect(lastRequest?.body).toEqual({ gatedHeadSha: null });
  });
});

describe("statusLabel", () => {
  test("covers every status", () => {
    expect(statusLabel("pending")).toBe("pending");
    expect(statusLabel("stale")).toBe("stale");
    expect(statusLabel("approved")).toBe("approved");
    expect(statusLabel("pushed_back")).toBe("pushed back");
  });
});
