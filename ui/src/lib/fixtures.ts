import type { FactoryEvent, FactoryEventBody, QueueIssue, RunRecord } from "./events";

// ---------------------------------------------------------------------------
// Mock fixtures — ?mock=1 replays a realistic factory session through the
// exact same ingest path as live SSE, so every view renders with data before
// (or without) the daemon. Nothing here is imported in live mode's hot path.
// ---------------------------------------------------------------------------

export function isMockMode(): boolean {
  return new URLSearchParams(window.location.search).get("mock") === "1";
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function iso(agoMs: number, now: number): string {
  return new Date(now - agoMs).toISOString();
}

function issue(
  now: number,
  n: number,
  title: string,
  lane: QueueIssue["lane"],
  ageMs: number,
  extraLabels: string[] = [],
): QueueIssue {
  const laneLabels: Record<QueueIssue["lane"], string[]> = {
    todo: [],
    claimed: ["Factory-Executing"],
    parked: ["Factory-Parked"],
    needs_human: ["Factory-Needs-Human"],
  };
  return {
    id: `mock-${n}`,
    identifier: `FAC-${n}`,
    title,
    url: `https://linear.app/rapido/issue/FAC-${n}`,
    teamKey: "FAC",
    stateName: "Todo",
    stateType: "unstarted",
    labels: [...laneLabels[lane], ...extraLabels],
    createdAt: iso(ageMs, now),
    lane,
  };
}

function board(now: number, fac20Lane: QueueIssue["lane"] | "gone", fac21Claimed: boolean): QueueIssue[] {
  const rows: QueueIssue[] = [
    issue(now, 21, "Add retry with jittered backoff to webhook dispatcher", fac21Claimed ? "claimed" : "todo", 26 * HOUR, ["backend"]),
    issue(now, 22, "Nightly cleanup job for expired portal sessions", "todo", 22 * HOUR, ["backend", "chore"]),
    issue(now, 23, "Expose /healthz readiness endpoint on the API", "todo", 9 * HOUR),
    issue(now, 24, "Client portal: render factory report YAML inline", "todo", 3 * HOUR, ["portal"]),
    issue(now, 19, "Migrate invoice PDFs to per-client S3 buckets", "needs_human", 31 * HOUR, ["backend"]),
    issue(now, 15, "Refactor billing period rollover for leap seconds", "parked", 4 * DAY + 6 * HOUR, ["billing"]),
    issue(now, 18, "Bump minimum TLS version on the API gateway", "parked", 2 * DAY + 3 * HOUR, ["infra"]),
  ];
  if (fac20Lane !== "gone") rows.splice(2, 0, issue(now, 20, "Rate-limit the public search endpoint", fac20Lane, 14 * HOUR, ["backend"]));
  return rows;
}

interface Step {
  /** ms after the previous step (live phase only). */
  delay: number;
  body: FactoryEventBody;
}

// ---- FAC-17 — a completed run replayed as history (Delivered lane + detail) --

function fac17History(): FactoryEventBody[] {
  const K = "FAC-17";
  const impl = (tool: string, detail: string): FactoryEventBody =>
    ({ type: "run_tool_use", issueKey: K, stage: "implementer", tool, detail });
  return [
    { type: "run_started", issueKey: K, title: "Add CSV export to the admin transactions table", repo: "rapido/portal", dryRun: false },
    { type: "run_stage_started", issueKey: K, stage: "implementer", model: "sonnet", viaProxy: false },
    impl("Read", "src/pages/admin/Transactions.tsx"),
    impl("Grep", "downloadBlob"),
    { type: "run_assistant_text", issueKey: K, stage: "implementer", text: "The table already memoizes filtered rows; I will serialize that same array so the export always matches what the admin sees, then stream it as a Blob download." },
    impl("Write", "src/lib/exportCsv.ts"),
    impl("Edit", "src/pages/admin/Transactions.tsx"),
    impl("Bash", "bun run typecheck"),
    impl("Bash", "bun test src/lib/exportCsv.test.ts"),
    { type: "run_stage_finished", issueKey: K, stage: "implementer", costUsd: 1.8342, turns: 21, wallSeconds: 341, resultText: "Added a CSV export button to the admin transactions table. New src/lib/exportCsv.ts serializes the currently-filtered rows (same memoized array the table renders) with RFC 4180 quoting, and the button streams it as a dated file (transactions-2026-07-20.csv). Covered by exportCsv.test.ts: quoting, empty set, 10k-row snapshot." },
    { type: "run_stage_started", issueKey: K, stage: "reviewer-claude", model: "opus", viaProxy: false },
    { type: "run_stage_started", issueKey: K, stage: "reviewer-codex", model: "gpt-5.6-sol", viaProxy: true },
    { type: "run_stage_finished", issueKey: K, stage: "reviewer-codex", costUsd: 0.4102, turns: 1, wallSeconds: 58, resultText: "1. Numbers are serialized with toString() — amounts like 1200.5 export as \"1200.5\" not \"1200.50\"; finance tooling that round-trips the CSV will diff. Hunk: exportCsv.ts formatCell(). Expected: use the table's existing money formatter.\n2. The filename uses local time but the table filters on UTC day boundaries — an export at 00:30 NZT is stamped with a date containing zero rows from that date. Hunk: exportCsv.ts fileName()." },
    { type: "run_stage_finished", issueKey: K, stage: "reviewer-claude", costUsd: 0.9925, turns: 1, wallSeconds: 84, resultText: "1. Ticket requires the export to respect the active column visibility toggles; exportCsv.ts serializes ALL columns unconditionally. Scenario: admin hides \"internal ref\", exports, internal refs leak into the file. Expected: filter by visibleColumns.\n2. escapeCell() quotes commas and quotes but not leading =/+/-/@ — spreadsheet formula injection from attacker-controlled merchant names. Expected: prefix-quote formula-significant cells." },
    { type: "run_stage_started", issueKey: K, stage: "fixer", model: "sonnet", viaProxy: false },
    { type: "run_tool_use", issueKey: K, stage: "fixer", tool: "Edit", detail: "src/lib/exportCsv.ts" },
    { type: "run_tool_use", issueKey: K, stage: "fixer", tool: "Bash", detail: "bun test src/lib/exportCsv.test.ts" },
    { type: "run_stage_finished", issueKey: K, stage: "fixer", costUsd: 0.7218, turns: 12, wallSeconds: 176, resultText: "1. fixed — export now maps over visibleColumns.\n2. fixed — formula-significant prefixes are quoted per OWASP CSV-injection guidance; test added.\n3. fixed — money cells use formatMoney() (two decimals).\n4. rejected — filename now uses the table's UTC day, matching the filter boundary; the reviewer's NZT scenario is covered by that fix rather than a timezone option the ticket didn't ask for." },
    { type: "run_gates", issueKey: K, round: 0, green: true, strength: "real", gates: [
      { name: "typecheck", baselinePassed: true, passed: true, outputTail: "" },
      { name: "test", baselinePassed: true, passed: true, outputTail: "" },
      { name: "lint", baselinePassed: true, passed: true, outputTail: "" },
    ] },
    { type: "run_finished", issueKey: K, outcome: "pr_open", prUrl: "https://github.com/rapido/portal/pull/214", costUsd: 3.9587,
      stages: [
        { label: "implementer", costUsd: 1.8342, turns: 21, wallSeconds: 341 },
        { label: "reviewer-claude", costUsd: 0.9925, turns: 1, wallSeconds: 84 },
        { label: "reviewer-codex", costUsd: 0.4102, turns: 1, wallSeconds: 58 },
        { label: "fixer", costUsd: 0.7218, turns: 12, wallSeconds: 176 },
      ],
      gateStrength: "real", guardedPaths: [], dryRun: false },
  ];
}

// ---- FAC-20 — the run that is live while you watch --------------------------

const K20 = "FAC-20";

function fac20HistoryPrefix(): FactoryEventBody[] {
  const impl = (tool: string, detail: string): FactoryEventBody =>
    ({ type: "run_tool_use", issueKey: K20, stage: "implementer", tool, detail });
  return [
    { type: "run_started", issueKey: K20, title: "Rate-limit the public search endpoint", repo: "rapido/api", dryRun: false },
    { type: "run_stage_started", issueKey: K20, stage: "implementer", model: "sonnet", viaProxy: false },
    impl("Read", "package.json"),
    impl("Glob", "src/routes/**/*.ts"),
    impl("Read", "src/routes/search.ts"),
    impl("Grep", "registerRoutes"),
    { type: "run_assistant_text", issueKey: K20, stage: "implementer", text: "search.ts registers GET /v1/search with no throttling. Plan: a token-bucket limiter (60 req/min, burst 10) keyed by client IP as Express middleware, with X-RateLimit-* headers and a 429 JSON body matching the API's error envelope." },
    impl("Read", "src/middleware/auth.ts"),
  ];
}

function fac20LiveSteps(): Step[] {
  const impl = (delay: number, tool: string, detail: string): Step =>
    ({ delay, body: { type: "run_tool_use", issueKey: K20, stage: "implementer", tool, detail } });
  const fix = (delay: number, tool: string, detail: string): Step =>
    ({ delay, body: { type: "run_tool_use", issueKey: K20, stage: "fixer", tool, detail } });
  const rep = (delay: number, tool: string, detail: string): Step =>
    ({ delay, body: { type: "run_tool_use", issueKey: K20, stage: "verify-repair-1", tool, detail } });
  return [
    impl(1800, "Write", "src/middleware/rateLimit.ts"),
    impl(3400, "Edit", "src/routes/search.ts"),
    impl(2600, "Bash", "bun run typecheck"),
    { delay: 2400, body: { type: "run_assistant_text", issueKey: K20, stage: "implementer", text: "Typecheck clean. Writing tests: steady-state under the limit, burst refusal with Retry-After, and bucket refill after 1s of simulated clock." } },
    impl(2200, "Write", "src/middleware/rateLimit.test.ts"),
    impl(3800, "Bash", "bun test src/middleware/rateLimit.test.ts"),
    impl(2800, "Edit", "src/middleware/rateLimit.ts"),
    impl(3000, "Bash", "bun test src/middleware/rateLimit.test.ts"),
    impl(2000, "Bash", "git status"),
    { delay: 2600, body: { type: "run_stage_finished", issueKey: K20, stage: "implementer", costUsd: 2.1418, turns: 24, wallSeconds: 78, resultText: "Implemented a token-bucket rate limiter for GET /v1/search: 60 requests/min with burst 10 per client IP (RATE_LIMIT_SEARCH_RPM overridable), X-RateLimit-Limit/Remaining/Reset headers on every response, and 429s that reuse the API's JSON error envelope with Retry-After. In-memory buckets with lazy expiry — no new dependency. Tests cover steady-state, burst refusal and refill." } },
    { delay: 1500, body: { type: "run_stage_started", issueKey: K20, stage: "reviewer-claude", model: "opus", viaProxy: false } },
    { delay: 300, body: { type: "run_stage_started", issueKey: K20, stage: "reviewer-codex", model: "gpt-5.6-sol", viaProxy: true } },
    { delay: 9000, body: { type: "run_stage_finished", issueKey: K20, stage: "reviewer-codex", costUsd: 0.4470, turns: 1, wallSeconds: 9, resultText: "1. Buckets are keyed by req.ip, but the app sets trust proxy — behind the gateway every request shares the LB address unless X-Forwarded-For depth is configured; one noisy client can exhaust the shared bucket for everyone. Hunk: rateLimit.ts keyFor(). Expected: key on the resolved client IP the auth middleware already computes.\n2. Lazy expiry only prunes a bucket when that key is hit again — a scanner cycling spoofed IPs grows the Map unboundedly. Expected: periodic sweep or LRU cap." } },
    { delay: 4500, body: { type: "run_stage_finished", issueKey: K20, stage: "reviewer-claude", costUsd: 1.0212, turns: 1, wallSeconds: 14, resultText: "1. Ticket verification #2 requires the limiter to exempt authenticated partner keys; middleware runs before auth so partner traffic is throttled like anonymous traffic. Scenario: partner integration doing 100 req/min gets 429s the ticket says it must not. Expected: order after auth and branch on req.partnerKey.\n2. Reset header is computed with Math.floor(Date.now()/1000)+window — off by the elapsed fraction; clients honoring it retry early and get another 429." } },
    { delay: 2000, body: { type: "run_stage_started", issueKey: K20, stage: "fixer", model: "sonnet", viaProxy: false } },
    fix(2500, "Read", "src/middleware/rateLimit.ts"),
    fix(2400, "Edit", "src/middleware/rateLimit.ts"),
    fix(2800, "Edit", "src/routes/search.ts"),
    fix(2200, "Edit", "src/middleware/rateLimit.test.ts"),
    fix(3600, "Bash", "bun test src/middleware/rateLimit.test.ts"),
    { delay: 2600, body: { type: "run_stage_finished", issueKey: K20, stage: "fixer", costUsd: 0.8121, turns: 14, wallSeconds: 16, resultText: "1. fixed — limiter now runs after auth and keys on the auth-resolved client IP; partner-key requests bypass per ticket verification #2 (test added).\n2. fixed — bucket map swept every 60s, capped at 50k keys with oldest-first eviction.\n3. fixed — Reset derived from the bucket's actual refill instant.\n4. rejected — switching to a Redis store contradicts the ticket's \"no new infrastructure\" constraint; in-memory is explicit in the ticket." } },
    { delay: 3000, body: { type: "run_gates", issueKey: K20, round: 0, green: false, strength: "real", gates: [
      { name: "typecheck", baselinePassed: true, passed: true, outputTail: "" },
      { name: "test", baselinePassed: true, passed: false, outputTail: "FAIL src/middleware/rateLimit.test.ts > exempts partner keys\nexpected 200, received 429\n  at rateLimit.test.ts:84:29\n\n 1 fail · 41 pass · 42 total [4.18s]\nerror: script \"test\" exited with code 1" },
      { name: "lint", baselinePassed: true, passed: true, outputTail: "" },
    ] } },
    { delay: 1800, body: { type: "run_stage_started", issueKey: K20, stage: "verify-repair-1", model: "sonnet", viaProxy: false } },
    rep(2600, "Read", "src/middleware/rateLimit.test.ts"),
    rep(2400, "Edit", "src/middleware/rateLimit.ts"),
    rep(3400, "Bash", "bun test src/middleware/rateLimit.test.ts"),
    { delay: 2200, body: { type: "run_stage_finished", issueKey: K20, stage: "verify-repair-1", costUsd: 0.3644, turns: 7, wallSeconds: 11, resultText: "The partner-key exemption checked req.partner before the auth middleware had populated it in the test harness; registered the limiter via the shared router factory so ordering matches production. All 42 tests pass." } },
    { delay: 2600, body: { type: "run_gates", issueKey: K20, round: 1, green: true, strength: "real", gates: [
      { name: "typecheck", baselinePassed: true, passed: true, outputTail: "" },
      { name: "test", baselinePassed: true, passed: true, outputTail: "" },
      { name: "lint", baselinePassed: true, passed: true, outputTail: "" },
    ] } },
    { delay: 2400, body: { type: "run_finished", issueKey: K20, outcome: "pr_open", prUrl: "https://github.com/rapido/api/pull/342", costUsd: 4.7865,
      stages: [
        { label: "implementer", costUsd: 2.1418, turns: 24, wallSeconds: 78 },
        { label: "reviewer-claude", costUsd: 1.0212, turns: 1, wallSeconds: 14 },
        { label: "reviewer-codex", costUsd: 0.4470, turns: 1, wallSeconds: 9 },
        { label: "fixer", costUsd: 0.8121, turns: 14, wallSeconds: 16 },
        { label: "verify-repair-1", costUsd: 0.3644, turns: 7, wallSeconds: 11 },
      ],
      gateStrength: "real", guardedPaths: [], dryRun: false } },
  ];
}

// ---- replay ----------------------------------------------------------------

export function replayFixtures(ingest: (e: FactoryEvent) => void, onLive: () => void): () => void {
  const now = Date.now();
  let seq = 0;
  const stamp = (body: FactoryEventBody, at: number): FactoryEvent =>
    ({ ...body, seq: ++seq, at } as FactoryEvent);

  // History burst — what /events?since=0 would replay.
  const history: FactoryEvent[] = [];
  const startAt = now - 8 * MIN;
  history.push(stamp({ type: "daemon_started", mode: "watch", teamKeys: ["FAC"], workRoot: "~/FactoryWork", wipLimit: 2, watchIntervalSeconds: 60, budgetUsdPerIssue: 25 }, startAt));
  history.push(stamp({ type: "tick_started" }, startAt + 400));
  history.push(stamp({ type: "queue_snapshot", issues: board(now, "claimed", false) }, startAt + 1600));
  history.push(stamp({ type: "issue_needs_human", issueKey: "FAC-19", reason: "ticket is missing required sections: ## Verifications (see factory docs/ticket-contract.md)" }, startAt + 2100));
  history.push(stamp({ type: "tick_finished", queued: 6, eligible: 5, markedNeedsHuman: 1, processed: 2 }, startAt + 2600));
  // FAC-17 completed run, spread over ~5 minutes of the past.
  const f17 = fac17History();
  f17.forEach((body, i) => history.push(stamp(body, startAt + 5_000 + i * Math.round((4.6 * MIN) / f17.length))));
  // FAC-20 started ~80s ago, implementer mid-flight.
  const f20 = fac20HistoryPrefix();
  f20.forEach((body, i) => history.push(stamp(body, now - 80_000 + i * 9_000)));
  // Most recent tick — keeps the board snapshot fresh at boot.
  history.push(stamp({ type: "tick_started" }, now - 24_000));
  history.push(stamp({ type: "queue_snapshot", issues: board(now, "claimed", false) }, now - 23_000));
  history.push(stamp({ type: "tick_finished", queued: 5, eligible: 4, markedNeedsHuman: 0, processed: 1 }, now - 22_000));
  for (const e of history) ingest(e);
  onLive();

  // Live trickle — the rest of FAC-20, then quiet heartbeat ticks.
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let cancelled = false;
  const steps = fac20LiveSteps();
  let cursor = 0;
  const scheduleNext = (): void => {
    const step = steps[cursor];
    if (cancelled || step === undefined) {
      if (!cancelled) scheduleTicks();
      return;
    }
    timers.push(setTimeout(() => {
      ingest(stamp(step.body, Date.now()));
      if (step.body.type === "run_finished") {
        ingest(stamp({ type: "queue_snapshot", issues: board(Date.now(), "gone", true) }, Date.now()));
        ingest(stamp({ type: "run_started", issueKey: "FAC-21", title: "Add retry with jittered backoff to webhook dispatcher", repo: "rapido/api", dryRun: false }, Date.now()));
        ingest(stamp({ type: "run_stage_started", issueKey: "FAC-21", stage: "implementer", model: "sonnet", viaProxy: false }, Date.now()));
        ingest(stamp({ type: "run_tool_use", issueKey: "FAC-21", stage: "implementer", tool: "Read", detail: "src/webhooks/dispatch.ts" }, Date.now()));
      }
      cursor += 1;
      scheduleNext();
    }, step.delay));
  };
  const scheduleTicks = (): void => {
    const tools: Array<[string, string]> = [
      ["Grep", "deliverWithRetry"],
      ["Edit", "src/webhooks/dispatch.ts"],
      ["Bash", "bun test src/webhooks"],
      ["Read", "src/webhooks/queue.ts"],
      ["Edit", "src/webhooks/dispatch.test.ts"],
    ];
    let n = 0;
    const loop = (): void => {
      if (cancelled) return;
      timers.push(setTimeout(() => {
        const t = Date.now();
        const pick = tools[n % tools.length] as [string, string];
        ingest(stamp({ type: "run_tool_use", issueKey: "FAC-21", stage: "implementer", tool: pick[0], detail: pick[1] }, t));
        if (n % 4 === 3) {
          ingest(stamp({ type: "tick_started" }, t));
          ingest(stamp({ type: "queue_snapshot", issues: board(t, "gone", true) }, t + 200));
          ingest(stamp({ type: "tick_finished", queued: 5, eligible: 4, markedNeedsHuman: 1, processed: 1 }, t + 400));
        }
        n += 1;
        loop();
      }, 4000 + Math.random() * 3000));
    };
    loop();
  };
  scheduleNext();

  return () => {
    cancelled = true;
    for (const t of timers) clearTimeout(t);
  };
}

// ---- /runs history rows -----------------------------------------------------

export function mockRunRecords(): RunRecord[] {
  const now = Date.now();
  const rows: RunRecord[] = [
    {
      issueKey: "FAC-17", outcome: "pr_open", prUrl: "https://github.com/rapido/portal/pull/214",
      costUsd: 3.9587, gateStrength: "real", guardedPaths: [], finishedAt: now - 3 * MIN,
      stages: [
        { label: "implementer", costUsd: 1.8342, turns: 21, wallSeconds: 341 },
        { label: "reviewer-claude", costUsd: 0.9925, turns: 1, wallSeconds: 84 },
        { label: "reviewer-codex", costUsd: 0.4102, turns: 1, wallSeconds: 58 },
        { label: "fixer", costUsd: 0.7218, turns: 12, wallSeconds: 176 },
      ],
    },
    {
      issueKey: "FAC-16", outcome: "pr_open", prUrl: "https://github.com/rapido/api/pull/338",
      costUsd: 7.2143, gateStrength: "real", guardedPaths: [], finishedAt: now - 5 * HOUR,
      stages: [
        { label: "implementer", costUsd: 3.4110, turns: 34, wallSeconds: 902 },
        { label: "reviewer-claude", costUsd: 1.2050, turns: 1, wallSeconds: 96 },
        { label: "reviewer-codex", costUsd: 0.5233, turns: 1, wallSeconds: 61 },
        { label: "fixer", costUsd: 1.4402, turns: 22, wallSeconds: 410 },
        { label: "verify-repair-1", costUsd: 0.6348, turns: 9, wallSeconds: 205 },
      ],
    },
    {
      issueKey: "FAC-15", outcome: "parked", reason: "gates still failing after 3 repair rounds",
      prUrl: null, costUsd: 18.6212, gateStrength: "real", guardedPaths: [], finishedAt: now - 26 * HOUR,
      stages: [
        { label: "implementer", costUsd: 4.9821, turns: 40, wallSeconds: 1180 },
        { label: "reviewer-claude", costUsd: 1.3311, turns: 1, wallSeconds: 102 },
        { label: "reviewer-codex", costUsd: 0.6120, turns: 1, wallSeconds: 66 },
        { label: "fixer", costUsd: 3.8000, turns: 30, wallSeconds: 844 },
        { label: "verify-repair-1", costUsd: 2.9204, turns: 18, wallSeconds: 630 },
        { label: "verify-repair-2", costUsd: 2.6106, turns: 17, wallSeconds: 588 },
        { label: "verify-repair-3", costUsd: 2.3650, turns: 15, wallSeconds: 561 },
      ],
    },
    {
      issueKey: "FAC-14", outcome: "needs_human", reason: "guarded paths touched: .github/workflows/ci.yml",
      prUrl: "https://github.com/rapido/api/pull/331", costUsd: 5.1120, gateStrength: "real",
      guardedPaths: [".github/workflows/ci.yml"], finishedAt: now - 2 * DAY,
      stages: [
        { label: "implementer", costUsd: 2.6108, turns: 28, wallSeconds: 745 },
        { label: "reviewer-claude", costUsd: 1.0480, turns: 1, wallSeconds: 88 },
        { label: "reviewer-codex", costUsd: 0.4418, turns: 1, wallSeconds: 55 },
        { label: "fixer", costUsd: 1.0114, turns: 15, wallSeconds: 320 },
      ],
    },
    {
      issueKey: "FAC-13", outcome: "pr_open", prUrl: "https://github.com/rapido/portal/pull/209",
      costUsd: 2.4402, gateStrength: "weak", guardedPaths: [], finishedAt: now - 2 * DAY - 7 * HOUR,
      stages: [
        { label: "implementer", costUsd: 1.2210, turns: 16, wallSeconds: 402 },
        { label: "reviewer-claude", costUsd: 0.8121, turns: 1, wallSeconds: 79 },
        { label: "reviewer-fallback", costUsd: 0.2080, turns: 1, wallSeconds: 40, degraded: true },
        { label: "fixer", costUsd: 0.1991, turns: 4, wallSeconds: 95 },
      ],
    },
    {
      issueKey: "FAC-11", outcome: "aborted", reason: "moved externally during review",
      prUrl: null, costUsd: 3.0125, gateStrength: "none", guardedPaths: [], finishedAt: now - 3 * DAY,
      stages: [
        { label: "implementer", costUsd: 2.1080, turns: 25, wallSeconds: 688 },
        { label: "reviewer-claude", costUsd: 0.5121, turns: 1, wallSeconds: 74 },
        { label: "reviewer-codex", costUsd: 0.3924, turns: 1, wallSeconds: 52 },
      ],
    },
    {
      issueKey: "FAC-9", outcome: "parked", reason: "wall-clock cap reached",
      prUrl: null, costUsd: 12.8834, gateStrength: "real", guardedPaths: [], finishedAt: now - 4 * DAY,
      stages: [
        { label: "implementer", costUsd: 6.5210, turns: 40, wallSeconds: 1650 },
        { label: "reviewer-claude", costUsd: 1.4102, turns: 1, wallSeconds: 110 },
        { label: "reviewer-codex", costUsd: 0.6122, turns: 1, wallSeconds: 68 },
        { label: "fixer", costUsd: 4.3400, turns: 30, wallSeconds: 1105 },
      ],
    },
  ];
  return rows;
}
