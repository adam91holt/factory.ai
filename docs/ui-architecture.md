# Factory Mission Control — UI Architecture

**Status:** authoritative spec, 2026-07-20. Two builders implement this in parallel:
**server-builder** (daemon side) and **ui-builder** (`ui/` package). This document is the
single shared contract — if anything here needs to change, change this doc first, then code.

Goals: a realtime, dark-first, information-dense mission-control UI for the factory daemon —
Linear issues visibly moving through lanes, active runs with per-stage progress, live agent
tool activity, costs/turns, parked/needs-human queues, and durable run history. The UI
**observes only**: the dashboard server exposes zero mutating endpoints, binds
`127.0.0.1` only, and every string that leaves the daemon passes the existing
`redactSecrets` scrubber. Nothing in this spec weakens the hardening in `agents.ts` /
`loop.ts` (env scrub, untrusted delimiters, dontAsk allowlists, claim re-verification).

Reference pattern: `../codexProxyTest/src/server.ts` (SSE broadcast + history replay,
multi-run registry, `summarizeToolInput`) and `../codexProxyTest/ui/src/store.ts`
(event → reducer → UI state). This design is that pattern, productionized: typed event
union, seq-numbered ring buffer, `Last-Event-ID` resume, snapshot endpoint, and a UI that
is a clear step up in polish.

---

## 1. System shape

```
┌────────────────────────── factory daemon (node, src/) ──────────────────────────┐
│ index.ts ── tick loop ── loop.ts ── runStage (agents.ts) ── SDK subprocesses    │
│     │           │            │            │                                     │
│     └──emit─────┴───emit─────┴───onEvent──┘        linear.ts ──emit── queue     │
│                        ▼                                             snapshot   │
│                 src/events.ts  (typed bus: emit + seq + ring buffer)            │
│                        │ subscribe                                              │
│                 src/server.ts  (127.0.0.1:DASHBOARD_PORT, default 8787)         │
│                   GET /events   SSE, replay via Last-Event-ID / ?since          │
│                   GET /state    MissionState JSON snapshot (+ seq)              │
│                   GET /runs     completed-run history (JSONL mirror)            │
│                   GET /*        static ui/dist when built                       │
└─────────────────────────────────────────────────────────────────────────────────┘
                          ▲ SSE + fetch (Vite dev proxy in dev)
┌────────────────────────── ui/ (own package, Vite + React 19) ───────────────────┐
│ single EventSource → store reducer (MissionState mirror) → TanStack Query cache │
│ Routes: / (Board) · /runs · /runs/$issueKey · /queue · /history                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Transport is **SSE only** (no WebSockets): one `EventSource`, `id:` set to the event
`seq`, so the browser resumes automatically after disconnects. Multiple clients supported.

---

## 2. Event schema — the shared contract

`src/events.ts` exports these types. The ui-builder **copies the block below verbatim**
into `ui/src/lib/events.ts` (duplicated by design; the daemon and UI share no imports).
Do not rename, reorder, or add fields without editing this doc.

```ts
// ============================================================================
// FactoryEvent schema v1 — VERBATIM SHARED BLOCK
// Lives in: src/events.ts (daemon)  AND  ui/src/lib/events.ts (copy).
// ============================================================================

/** Lane derived from Linear labels on unstarted issues (see §4 linear.ts diff). */
export type Lane = "todo" | "claimed" | "parked" | "needs_human";

export interface QueueIssue {
  id: string;
  identifier: string;   // e.g. "FAC-12"
  title: string;
  url: string;
  teamKey: string;
  stateName: string;
  stateType: string;    // Linear state type ("unstarted")
  labels: string[];
  createdAt: string;    // ISO
  lane: Lane;
}
// NOTE: issue descriptions are deliberately NOT included in any event.

export interface StageMeta {
  label: string;        // "implementer" | "reviewer-claude" | "reviewer-codex"
                        // | "reviewer-fallback" | "fixer" | "verify-repair-N"
  costUsd: number;
  turns: number;
  wallSeconds: number;
  error?: string;
  degraded?: boolean;
}

export interface GateMeta {
  name: string;               // npm script name, e.g. "typecheck", "test"
  baselinePassed: boolean;
  passed: boolean | null;     // null = no-gate (fails on clean baseline)
  outputTail: string;         // last ≤400 chars of failure output, redacted; "" on pass
}

export type RunOutcome = "pr_open" | "parked" | "needs_human" | "aborted";
export type GateStrength = "none" | "weak" | "real";
export type DaemonMode = "watch" | "once" | "dry";

/** Event bodies as emitted by daemon code (bus stamps seq + at). */
export type FactoryEventBody =
  // ---- daemon lifecycle ----
  | { type: "daemon_started"; mode: DaemonMode; teamKeys: string[]; workRoot: string;
      wipLimit: number; watchIntervalSeconds: number }
  | { type: "daemon_stopped"; reason: "drained" | "one_shot" | "error" }
  // ---- tick loop ----
  | { type: "tick_started" }
  | { type: "tick_finished"; queued: number; eligible: number;
      markedNeedsHuman: number; processed: number; error?: string }
  | { type: "linear_backoff"; seconds: number }
  // ---- queue / board ----
  | { type: "queue_snapshot"; issues: QueueIssue[] }
  | { type: "issue_needs_human"; issueKey: string; reason: string }
  // ---- per-issue run lifecycle ----
  | { type: "run_started"; issueKey: string; title: string; repo: string; dryRun: boolean }
  | { type: "run_stage_started"; issueKey: string; stage: string; model: string;
      viaProxy: boolean }
  | { type: "run_tool_use"; issueKey: string; stage: string; tool: string;
      detail: string }                                 // detail: redacted, ≤160 chars
  | { type: "run_assistant_text"; issueKey: string; stage: string;
      text: string }                                   // redacted, ≤500 chars
  | { type: "run_stage_finished"; issueKey: string; stage: string; costUsd: number;
      turns: number; wallSeconds: number; resultText: string;   // redacted, ≤4000 chars
      error?: string; degraded?: boolean }
  | { type: "run_gates"; issueKey: string; round: number;      // 0 = pre-repair verify
      green: boolean; strength: GateStrength; gates: GateMeta[] }
  | { type: "run_finished"; issueKey: string; outcome: RunOutcome; reason?: string;
      prUrl: string | null; costUsd: number; stages: StageMeta[];
      gateStrength: GateStrength; guardedPaths: string[] };

/** Wire type: what SSE frames and the ring buffer contain. */
export type FactoryEvent = FactoryEventBody & { seq: number; at: number };

// ---------------------------------------------------------------------------
// MissionState — shape of GET /state; the UI store mirrors this exactly and
// keeps it current by folding FactoryEvents into it (same reducer semantics
// on both sides, see §3 and §5).
// ---------------------------------------------------------------------------

export interface StageView {
  stage: string;
  model: string;
  viaProxy: boolean;
  startedAt: number;
  finishedAt: number | null;
  costUsd: number;          // 0 until finished
  turns: number;
  toolCalls: number;        // count of run_tool_use seen
  lastActivity: string;     // "<tool> · <detail>" of the latest tool_use
  resultText: string;       // from run_stage_finished
  error?: string;
  degraded?: boolean;
}

export interface RunView {
  issueKey: string;
  title: string;
  repo: string;
  dryRun: boolean;
  startedAt: number;
  finishedAt: number | null;
  status: "active" | RunOutcome;
  stages: StageView[];                 // in start order; parallel reviewers overlap
  gates: { round: number; green: boolean; strength: GateStrength;
           gates: GateMeta[] } | null; // latest run_gates
  costUsd: number;                     // sum of finished stage costs
  prUrl: string | null;
  reason?: string;
}

export interface MissionState {
  seq: number;                         // last event seq folded in
  daemon: {
    mode: DaemonMode; teamKeys: string[]; workRoot: string; wipLimit: number;
    watchIntervalSeconds: number; startedAt: number;
    lastTick: { at: number; queued: number; eligible: number;
                markedNeedsHuman: number; processed: number; error?: string } | null;
    backoffSeconds: number;            // 0 unless linear_backoff seen last tick
  } | null;                            // null until daemon_started observed
  board: QueueIssue[];                 // latest queue_snapshot
  boardAt: number | null;
  runs: Record<string, RunView>;       // keyed by issueKey; this-process runs
  needsHuman: Array<{ issueKey: string; reason: string; at: number }>; // session log
}

// ---------------------------------------------------------------------------
// RunRecord — one row of GET /runs (durable history, JSONL mirror of the
// factory-report YAML meta; see §3 /runs).
// ---------------------------------------------------------------------------

export interface RunRecord {
  issueKey: string;
  outcome: RunOutcome;
  reason?: string;
  prUrl: string | null;
  costUsd: number;
  stages: StageMeta[];
  gateStrength: GateStrength;
  guardedPaths: string[];
  finishedAt: number;      // epoch ms
}

// ============================================================================
// END VERBATIM SHARED BLOCK
// ============================================================================
```

### 2.1 Daemon-only additions in `src/events.ts` (NOT copied to the UI)

```ts
/** Stream callback payloads runStage forwards to loop.ts (see §4 agents.ts). */
export type AgentStreamEvent =
  | { kind: "stage_started"; stage: string; model: string; viaProxy: boolean }
  | { kind: "tool_use"; stage: string; tool: string; detail: string }
  | { kind: "assistant_text"; stage: string; text: string }
  | { kind: "stage_finished"; stage: string; costUsd: number; turns: number;
      wallSeconds: number; resultText: string; error?: string; degraded?: boolean };

/** Allowlist-field summary of a tool_use input — codexProxyTest pattern. */
export function summarizeToolInput(input: unknown): string;
// Implementation: if input is a plain object, return the first present string
// among ["command","file_path","pattern","query","url","prompt","description"],
// whitespace-collapsed and sliced to 160 chars; otherwise "". Never JSON.stringify
// the whole input (raw inputs can carry file contents / ticket text).

export const bus: {
  /** Stamps seq (monotonic from 1) + at (Date.now()), stores in the ring
   *  buffer, fans out to subscribers. Synchronous, never throws: a subscriber
   *  exception is caught and console.error'd. */
  emit(body: FactoryEventBody): void;
  /** Events with seq > sinceSeq, oldest first. */
  history(sinceSeq?: number): FactoryEvent[];
  subscribe(fn: (e: FactoryEvent) => void): () => void;
};
```

Bus rules (server-builder):
- Ring buffer cap **5000** events. On overflow drop oldest.
- `queue_snapshot` dedupe: when emitting a new `queue_snapshot`, remove any older
  `queue_snapshot` from the buffer first (snapshots are large and only the latest
  matters for replay; live subscribers still received the old ones).
- `src/events.ts` imports **nothing** from other src files (only `node:` builtins if
  needed). This keeps it cycle-free: `agents.ts`, `loop.ts`, `linear.ts`, `index.ts`,
  `server.ts` all import from it.

### 2.2 Size caps (enforced at emit sites, all after `redactSecrets`)

| Field | Cap |
|---|---|
| `run_tool_use.detail` | 160 chars |
| `run_assistant_text.text` | 500 chars |
| `run_stage_finished.resultText` | 4000 chars |
| `GateMeta.outputTail` | 400 chars (tail) |
| `run_finished.reason` / `issue_needs_human.reason` | 500 chars |
| `queue_snapshot.issues` | ≤50 (Linear query is `first: 50` already) |

---

## 3. Server — `src/server.ts`

Owned by server-builder. `node:http` only — **no new npm dependencies**. Exports:

```ts
export function startDashboard(): { close(): Promise<void> } | null;
```

**Enablement rule** (exactly): read `process.env.DASHBOARD_PORT`.
- Unset **and** (`config.oneShot` or `config.dryRun`) → return `null` (dashboard off for
  `--once` / `--dry-run` unless forced).
- Unset otherwise (watch mode) → port **8787**.
- Set to `"0"` → return `null` (explicit off).
- Set to anything else → `Number(...)`; if not a finite integer in 1..65535, `throw`.
- Listen on host `"127.0.0.1"` **explicitly** — never `0.0.0.0`, never unset.

**Routes** (all GET; any other method → 405; unknown path → 404):

- **`GET /events`** — SSE. Headers `content-type: text/event-stream`,
  `cache-control: no-cache`, `connection: keep-alive`. Resume point =
  `Number(req.headers["last-event-id"])` if finite, else `Number(url.searchParams.get("since"))`
  if finite, else 0. Write every `bus.history(resume)` event, then register the client.
  Frame format, exactly:

  ```
  id: <seq>
  data: <JSON.stringify(FactoryEvent)>
  <blank line>
  ```

  Heartbeat `: ping\n\n` every 25s per client (clear the interval on close).
  On `req.on("close")` remove the client from the set. Live events are fanned out from a
  single `bus.subscribe` made in `startDashboard`.

- **`GET /state`** — `application/json`, the current `MissionState`. The server maintains
  it by folding every bus event through a pure reducer `applyEvent(state, e): MissionState`
  (semantics in §5.3 — the UI implements the identical fold). `seq` is the seq of the last
  folded event.

- **`GET /runs`** — `application/json`, `RunRecord[]` newest-first, cap 500. Backing
  store: `join(config.workRoot, "factory-history.jsonl")`. Inside `startDashboard`,
  subscribe to the bus; on every `run_finished` append one line
  `JSON.stringify({...body-fields, finishedAt: e.at})`. Append failures are
  `console.error`'d, never thrown. Read per-request (file is small); tolerate missing
  file (→ `[]`) and skip unparseable lines. This mirrors the factory-report YAML meta
  that lands on Linear — Linear stays the source of truth; the JSONL is the local,
  queryable copy the History page reads.

- **Static UI** — `GET /` serves `ui/dist/index.html` if it exists (else a one-line
  plain-text pointer "UI not built — run npm run build in ui/"); `GET /assets/*` serves
  from `ui/dist/assets` with the same normalize + prefix-check path-traversal guard as
  `codexProxyTest/src/server.ts` (lines 561–579). Content types: `.js`→`text/javascript`,
  `.css`→`text/css`, `.svg`→`image/svg+xml`, else `application/octet-stream`.

`close()`: end all SSE clients, `server.close()`, unsubscribe bus subscriptions.

**Security posture:** no POST/PUT/DELETE; no request body is ever read; no env echo; no
file reads outside `ui/dist` and `factory-history.jsonl`; loopback bind; all payload
strings were redacted at emit time. The dashboard adds no new capability to any worker.

---

## 4. Surgical daemon diffs (server-builder)

Baseline: current committed `src/*.ts` (line numbers below refer to it). Every change is
additive or a minimal in-place edit; `npm run typecheck` must stay clean. **Do not**
reformat, reorder, or rewrite surrounding code.

### 4.1 `src/agents.ts`

Today `runStage` swallows every non-result message (the `for await` at lines 68–70 only
captures `type === "result"`). Minimal change: an optional `onEvent` callback.

1. Import (top, after existing imports):
   ```ts
   import { summarizeToolInput, type AgentStreamEvent } from "./events.ts";
   ```
2. `StageOptions` (lines 22–30): add one optional field:
   ```ts
   onEvent?: (event: AgentStreamEvent) => void;   // live stage telemetry (UI observes)
   ```
3. In `runStage`, immediately after `const t0 = Date.now();` (line 33):
   ```ts
   opts.onEvent?.({ kind: "stage_started", stage: label, model: opts.model, viaProxy: opts.viaProxy === true });
   ```
4. Replace the message loop (lines 68–70) with:
   ```ts
   for await (const message of q) {
     const m = message as { type?: string; message?: { content?: unknown } };
     if (m.type === "assistant" && Array.isArray(m.message?.content)) {
       for (const block of m.message.content as Array<Record<string, unknown>>) {
         if (block.type === "tool_use" && typeof block.name === "string") {
           opts.onEvent?.({ kind: "tool_use", stage: label, tool: block.name,
             detail: redactSecrets(summarizeToolInput(block.input)).clean.slice(0, 160) });
         } else if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
           opts.onEvent?.({ kind: "assistant_text", stage: label,
             text: redactSecrets(block.text).clean.slice(0, 500) });
         }
       }
     }
     if (m.type === "result") result = message as Record<string, unknown>;
   }
   ```
5. Both return paths emit `stage_finished`. In the success path (lines 77–84), build the
   object first:
   ```ts
   const out: StageResult = { label, text: ..., costUsd: ..., turns: ..., wallSeconds: ..., error: subtypeError };
   opts.onEvent?.({ kind: "stage_finished", stage: label, costUsd: out.costUsd, turns: out.turns,
     wallSeconds: out.wallSeconds, resultText: redactSecrets(out.text).clean.slice(0, 4000),
     ...(out.error ? { error: out.error } : {}) });
   return out;
   ```
   Same shape in the `catch` path (lines 86–90): `costUsd: 0, turns: 0, resultText: ""`,
   `error` from the caught error.

   Note: `degraded` is set by loop.ts *after* `runStage` returns (fallback reviewer), so
   `stage_finished.degraded` is never set here; the UI takes degraded from `run_finished`
   stage metas.

### 4.2 `src/linear.ts`

One insertion in `fetchQueue` (lines 67–81) so the board sees parked/needs-human issues
(they are in the query result — the label filter is client-side):

```ts
import { bus } from "./events.ts";           // top of file

// inside fetchQueue, replace the final return with:
const all = data.issues.nodes.map(toIssue);
const skip = new Set([EXECUTING_LABEL, PARKED_LABEL, NEEDS_HUMAN_LABEL]);
bus.emit({
  type: "queue_snapshot",
  issues: all.map((i) => ({
    id: i.id, identifier: i.identifier, title: i.title, url: i.url, teamKey: i.teamKey,
    stateName: i.stateName, stateType: i.stateType, labels: i.labels, createdAt: i.createdAt,
    lane: i.labels.includes(PARKED_LABEL) ? "parked"
      : i.labels.includes(NEEDS_HUMAN_LABEL) ? "needs_human"
      : i.labels.includes(EXECUTING_LABEL) ? "claimed" : "todo",
  })),
});
return all
  .filter((issue) => !issue.labels.some((l) => skip.has(l)))
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // FIFO regardless of server order (C21)
```

No description field is emitted. Behavior of the returned queue is unchanged.

### 4.3 `src/loop.ts`

1. Imports: add `import { bus, toStageMeta, type AgentStreamEvent } from "./events.ts";`
   (`toStageMeta(s: StageResult): StageMeta` is a trivial mapper exported by events.ts —
   it drops `text` and omits absent `error`/`degraded`. Type it against a structural
   parameter `{ label: string; costUsd: number; ... }` so events.ts needn't import
   agents.ts.)
2. Module-level helper (below `post`, ~line 35):
   ```ts
   function forwardStage(issueKey: string): (e: AgentStreamEvent) => void {
     return (e) => {
       if (e.kind === "stage_started") bus.emit({ type: "run_stage_started", issueKey, stage: e.stage, model: e.model, viaProxy: e.viaProxy });
       else if (e.kind === "tool_use") bus.emit({ type: "run_tool_use", issueKey, stage: e.stage, tool: e.tool, detail: e.detail });
       else if (e.kind === "assistant_text") bus.emit({ type: "run_assistant_text", issueKey, stage: e.stage, text: e.text });
       else bus.emit({ type: "run_stage_finished", issueKey, stage: e.stage, costUsd: e.costUsd, turns: e.turns, wallSeconds: e.wallSeconds, resultText: e.resultText, ...(e.error ? { error: e.error } : {}) });
     };
   }
   ```
3. `markNeedsHuman` (line 37): first statement:
   `bus.emit({ type: "issue_needs_human", issueKey: issue.identifier, reason: redactSecrets(reason).clean.slice(0, 500) });`
4. `abortExternal` (line 51): change signature to
   `abortExternal(issue, stages: StageResult[], where: string)` — three call sites
   (lines 112, 145, 165) pass the in-scope `stages`. First statement:
   ```ts
   bus.emit({ type: "run_finished", issueKey: issue.identifier, outcome: "aborted",
     reason: `moved externally during ${where}`, prUrl: null,
     costUsd: stages.reduce((s, x) => s + x.costUsd, 0), stages: stages.map(toStageMeta),
     gateStrength: "none", guardedPaths: [] });
   ```
5. `processIssue`: immediately after the claim block (after line 82):
   ```ts
   const onEvent = forwardStage(issue.identifier);
   bus.emit({ type: "run_started", issueKey: issue.identifier, title: issue.title, repo, dryRun: config.dryRun });
   ```
6. Add `onEvent,` to the options object of **all six** `runStage` call sites:
   implementer (line 107), reviewer-claude (line 124), reviewer-codex (line 126),
   reviewer-fallback (line 131), fixer (line 140), verify-repair (line 153).
7. Gate events. After `let summary = gateSummary(results);` (line 149) and after the
   in-loop `summary = gateSummary(results);` (line 157):
   ```ts
   bus.emit({ type: "run_gates", issueKey: issue.identifier, round: 0 /* or i + 1 in the loop */,
     green: summary.green, strength: summary.strength,
     gates: results.map((g) => ({ name: g.name, baselinePassed: g.baselinePassed, passed: g.passed,
       outputTail: g.passed === false ? redactSecrets(g.output).clean.slice(-400) : "" })) });
   ```
8. Delivery `run_finished`: right after `buildReport(...)` (line 181):
   ```ts
   bus.emit({ type: "run_finished", issueKey: issue.identifier,
     outcome: guardedStop ? "needs_human" : "pr_open",
     ...(guardedStop ? { reason: `guarded paths touched: ${guarded.join(", ")}`.slice(0, 500) } : {}),
     prUrl, costUsd: stages.reduce((s, x) => s + x.costUsd, 0),
     stages: stages.map(toStageMeta), gateStrength: summary.strength, guardedPaths: guarded });
   ```
9. `park` (line 200): after building `input`, before the try:
   ```ts
   bus.emit({ type: "run_finished", issueKey: issue.identifier, outcome: "parked",
     reason: redactSecrets(reason).clean.slice(0, 500), prUrl: null,
     costUsd: stages.reduce((s, x) => s + x.costUsd, 0), stages: stages.map(toStageMeta),
     gateStrength: "none", guardedPaths: [] });
   ```
   Note: `park` is also reached for pre-claim failures (missing sections path calls
   `markNeedsHuman`, not park, so every `park`/delivery emit is preceded by a
   `run_started` — except the claim-failed skip at line 80, which emits nothing. The UI
   reducer must tolerate a `run_finished` with no prior `run_started` by synthesizing a
   RunView, but with this wiring it won't happen.)

### 4.4 `src/index.ts`

1. Imports: `import { bus } from "./events.ts";` and
   `import { startDashboard } from "./server.ts";`
2. `tick()` (line 35): first statement `bus.emit({ type: "tick_started" });`.
   The three exits each emit `tick_finished`:
   - line 37 → `if (queue.length === 0) { bus.emit({ type: "tick_finished", queued: 0, eligible: 0, markedNeedsHuman: 0, processed: 0 }); return; }`
   - line 47 → same pattern with `queued: queue.length, eligible: 0, markedNeedsHuman: queue.length - eligible.length` — careful: at this exit `eligible.length === 0`.
   - end of `tick` → `bus.emit({ type: "tick_finished", queued: queue.length, eligible: eligible.length, markedNeedsHuman: queue.length - eligible.length, processed: batch.length });`
3. `main()`: after `acquireLease();` (line 56): `const dashboard = startDashboard();`.
   After the `console.log` (line 57):
   ```ts
   bus.emit({ type: "daemon_started", mode: config.dryRun ? "dry" : config.oneShot ? "once" : "watch",
     teamKeys: config.teamKeys, workRoot: config.workRoot,
     wipLimit: config.caps.wipLimit, watchIntervalSeconds: config.watchIntervalSeconds });
   ```
4. Rate-limit branch (line 67–70): add `bus.emit({ type: "linear_backoff", seconds: backoffSeconds });`
   and the generic catch adds `bus.emit({ type: "tick_finished", queued: 0, eligible: 0, markedNeedsHuman: 0, processed: 0, error: <message.slice(0,300)> });`
5. Before `rmSync(LEASE, ...)` (line 78):
   ```ts
   bus.emit({ type: "daemon_stopped", reason: config.oneShot ? "one_shot" : "drained" });
   await dashboard?.close();
   ```

### 4.5 `.env.example`

Append: `# DASHBOARD_PORT=8787   # mission-control UI (127.0.0.1 only; 0 disables; off by default in --once/--dry)`

---

## 5. UI — `factory/ui` (ui-builder)

`ui/` is its **own npm package**. The root `package.json` is untouched by builders (the
integration agent adds `ui:dev` / `ui:build` root scripts at the very end). The UI never
imports from `../src` — the event types are the verbatim copy in `ui/src/lib/events.ts`.

### 5.1 Stack & package

- Vite 6, React 19, TypeScript strict, Tailwind CSS v4 (`@tailwindcss/vite`), shadcn/ui,
  TanStack Router v1 (code-based routes — **no** file-based codegen plugin), TanStack
  Query v5, `lucide-react`, `@formkit/auto-animate` (lane FLIP), `@fontsource/ibm-plex-mono`
  + `@fontsource/space-grotesk` (fonts are bundled — the page makes zero external requests).

`ui/package.json` (exact shape; versions may float within the majors shown):

```json
{
  "name": "@rapido/factory-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b --noEmit",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@tanstack/react-router": "^1.90.0",
    "@tanstack/react-query": "^5.60.0",
    "lucide-react": "^0.470.0",
    "@formkit/auto-animate": "^0.8.2",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.6.0",
    "@fontsource/ibm-plex-mono": "^5.1.0",
    "@fontsource/space-grotesk": "^5.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "@tailwindcss/vite": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.8.0",
    "vite": "^6.0.0"
  }
}
```

shadcn/ui components: generate with `npx shadcn@latest init` (style *new-york*, CSS
variables on) then `npx shadcn@latest add badge card separator scroll-area table tabs
tooltip skeleton`. Generated files live in `ui/src/components/ui/` and may be edited to
match the tokens in §6. If the CLI misbehaves offline, hand-write the same eight
components with the standard shadcn implementations.

`ui/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/events": "http://127.0.0.1:8787",
      "/state": "http://127.0.0.1:8787",
      "/runs": "http://127.0.0.1:8787",
    },
  },
});
```

### 5.2 File tree (ownership: everything below is ui-builder's)

```
ui/
  package.json  vite.config.ts  tsconfig.json  index.html
  src/
    main.tsx                     # QueryClientProvider + RouterProvider + store boot
    router.tsx                   # code-based route tree (all routes declared here)
    styles/globals.css           # Tailwind v4 @theme tokens + font-face imports (§6)
    lib/
      events.ts                  # VERBATIM copy of §2 shared block
      store.ts                   # factory store: MissionState mirror + feeds (§5.3)
      sse.ts                     # startStream(store, queryClient) — single EventSource
      api.ts                     # fetchState(): MissionState, fetchRuns(): RunRecord[]
      format.ts                  # usd(), secs(), relTime(), laneLabel()
      utils.ts                   # cn() (shadcn helper)
    components/
      shell/AppShell.tsx         # sidebar + topbar + <Outlet/>
      shell/Sidebar.tsx          # nav + LiveRunPill list + session cost total
      shell/Topbar.tsx           # mode chip · last tick · backoff banner · ConnectionDot
      shell/LiveRunPill.tsx      # issueKey · stage · pulsing dot · running cost
      shell/ConnectionDot.tsx    # SSE status (live / reconnecting / stale)
      board/BoardLane.tsx        # one lane column (auto-animate list)
      board/IssueCard.tsx        # identifier, title, age, labels, Linear link
      runs/RunCard.tsx           # list-page card
      runs/StageTimeline.tsx     # horizontal per-stage segments (§5.4)
      runs/ToolFeed.tsx          # live tool_use/assistant_text feed
      runs/GatePanel.tsx         # per-round gate results
      runs/FindingsPanel.tsx     # reviewer resultText + fixer disposition
      runs/CostMeter.tsx         # spend vs $25 budget cap
      queue/QueueTable.tsx       # parked + needs-human with aging
      history/HistoryTable.tsx   # RunRecord rows
      OutcomeBadge.tsx           # shared outcome/status chip
  components.json                # shadcn config
```

Routes (`router.tsx`): `/` → Board, `/runs` → run list (active first),
`/runs/$issueKey` → run detail, `/queue` → queue health, `/history` → history.
Root route renders `AppShell`.

### 5.3 Data flow — single EventSource → store → TanStack Query

- **Store** (`lib/store.ts`): a module singleton with
  `getState(): UiState`, `subscribe(fn)`, consumed via `useSyncExternalStore`
  (export `useFactory<T>(selector: (s: UiState) => T): T`, with reference-equality
  memo per selector).
  `UiState = { connection: "connecting" | "live" | "reconnecting"; mission: MissionState;
  feeds: Record<string /*issueKey*/, FeedItem[]> }` where
  `FeedItem = { seq: number; at: number; stage: string; kind: "tool" | "text"; tool?: string; body: string }`
  (ring-capped at **500 per run**, from `run_tool_use` / `run_assistant_text`).
- **Reducer** — `applyEvent(mission, e)` folds a `FactoryEvent` into `MissionState`.
  Both the server (§3 `/state`) and the UI implement this fold; semantics:
  - `daemon_started` → set `daemon`, reset `backoffSeconds: 0`.
  - `tick_finished` → `daemon.lastTick = { at: e.at, ...counts }`; reset backoff to 0 on success.
  - `linear_backoff` → `daemon.backoffSeconds = e.seconds`.
  - `queue_snapshot` → replace `board`, set `boardAt = e.at`.
  - `run_started` → upsert `runs[issueKey]` fresh RunView (`status: "active"`, empty stages).
  - `run_stage_started` → push StageView (`finishedAt: null`, `toolCalls: 0`).
  - `run_tool_use` → find last unfinished StageView with that stage label; `toolCalls++`,
    `lastActivity = tool + " · " + detail`.
  - `run_assistant_text` → update that stage's `lastActivity = text.slice(0, 120)`.
  - `run_stage_finished` → close the matching StageView (set finishedAt/cost/turns/
    resultText/error), add cost to `run.costUsd`.
  - `run_gates` → set `run.gates`.
  - `run_finished` → `status = outcome`, `finishedAt`, `prUrl`, `reason`, overwrite
    `costUsd` with the event's total; merge `degraded` flags from `e.stages` into stage
    views by label. Synthesize the RunView if unknown.
  - `issue_needs_human` → append to `needsHuman` (dedupe by issueKey, keep latest).
  - Every event → `mission.seq = e.seq`.
- **Boot & resume** (`lib/sse.ts`): on app start, `fetchState()` seeds
  `mission` (TanStack Query `queryKey: ["state"]`, then written into the store), then open
  `new EventSource("/events?since=" + mission.seq)`. `onmessage`: parse, ignore if
  `seq <= mission.seq`, else fold + append feeds. The browser auto-reconnects and sends
  `Last-Event-ID`; additionally, `onerror` sets `connection: "reconnecting"`, and on the
  next `onopen` re-run `fetchState()` and hard-reset the store if the fetched `seq` is
  **lower** than ours (daemon restarted — seq reset). On `run_finished`, call
  `queryClient.invalidateQueries({ queryKey: ["runs"] })`.
- **TanStack Query** owns the request/cache lifecycle for the two snapshot endpoints:
  `["state"]` (fetched on boot/reconnect only, `staleTime: Infinity` — SSE keeps it live)
  and `["runs"]` (History page, `staleTime: 30s`, invalidated on `run_finished`). All
  live rendering reads the store via `useFactory`.

### 5.4 Pages

- **Board (`/`)** — five fixed lanes: **Todo · Needs Human · Parked · Executing ·
  Delivered**. Todo/Needs Human/Parked come from `mission.board` by `lane`; Executing =
  `runs` with `status === "active"` (card shows current stage + pulsing cost); Delivered =
  this-session `runs` with `status === "pr_open"` (PR link). An issue moving lanes
  animates via auto-animate FLIP. Lane headers show counts; board staleness
  (`now - boardAt > 2 × watchInterval`) renders a subtle "snapshot stale" tag.
- **Run detail (`/runs/$issueKey`)** — header (issueKey, title, repo, OutcomeBadge,
  CostMeter, degraded badge); **StageTimeline**: one horizontal track per stage in start
  order — implementer → (reviewer-claude ∥ reviewer-codex) → fixer → verify-repair-N —
  segment width ∝ wallSeconds, colored by state (active amber pulse / ok / error), turns
  + cost under each; **ToolFeed**: the per-run feed, newest at bottom, auto-follow unless
  scrolled up, monospace, tool name chip + detail; **FindingsPanel**: reviewer stages'
  `resultText` (tabs: Claude / Codex(+degraded) / Fixer disposition); **GatePanel**:
  latest round's gates with pass/FAIL/no-gate and `outputTail` in a collapsible.
- **Queue (`/queue`)** — two tables (Needs Human, Parked) from `board` lanes joined with
  session `needsHuman` reasons and parked `run_finished` reasons; age column
  (`now - createdAt`) with an aging bar that shifts amber → coral past 24h/72h; row
  action: open in Linear (plain link — the UI never mutates).
- **History (`/history`)** — `["runs"]` table: finishedAt, issueKey, OutcomeBadge,
  reason (truncated, tooltip), gateStrength, cost, total turns, PR link, and a per-stage
  cost sparkbar (tiny stacked bar from `stages`). Client-side filter by outcome.

---

## 6. Design language — "flight deck"

Dark-only, committed (this is a local operator console; no light theme, no toggle).
The look: graphite blues, instrument-amber for anything alive, restrained glow. It must
read as an instrument panel, not a SaaS template — codexProxyTest/ui is the floor, not
the target.

### 6.1 Tokens (`ui/src/styles/globals.css`, Tailwind v4 `@theme`)

```css
@import "tailwindcss";
@import "@fontsource/ibm-plex-mono/400.css";
@import "@fontsource/ibm-plex-mono/500.css";
@import "@fontsource/space-grotesk/500.css";
@import "@fontsource/space-grotesk/700.css";

@theme {
  --color-bg0: #0a0c10;      /* page */
  --color-bg1: #10141b;      /* panel */
  --color-bg2: #171d28;      /* raised / hover */
  --color-line: #232b38;     /* hairlines */
  --color-line2: #334054;    /* emphasized borders */
  --color-fg: #e8edf4;
  --color-fg-dim: #96a0b5;
  --color-fg-faint: #5c6880;

  --color-live: #ffb224;     /* running / active — instrument amber */
  --color-ok: #3ddc97;       /* pass / pr_open */
  --color-err: #ff5d5d;      /* fail / error */
  --color-parked: #fb923c;   /* parked */
  --color-human: #f472b6;    /* needs-human */
  --color-claude: #a78bfa;   /* claude-model chip */
  --color-codex: #22d3ee;    /* codex / viaProxy chip */

  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
  --font-sans: "Space Grotesk", system-ui, sans-serif;
}
```

Semantic mapping is fixed: **live=amber, ok=mint, err=coral, parked=orange,
human=pink, claude=violet, codex=cyan** — used consistently for dots, chips, timeline
segments, badges. Never introduce another accent.

### 6.2 Type & density

- **Mono for data, sans for chrome.** All values (keys, costs, durations, tool names,
  feed lines, table cells) are IBM Plex Mono 12px/1.5 (11px in the feed). Navigation,
  page titles, lane headers are Space Grotesk; section labels are 10.5px uppercase
  `tracking-[0.08em]` in `fg-faint`.
- 8px spacing grid; table/feed rows 28px; cards `p-3.5 rounded-xl`; panels
  `bg-bg1 border border-line`; raised state = `bg-bg2` + `border-line2` (hierarchy via
  border/background steps, **no drop shadows**). The single permitted glow:
  active run cards / segments get `shadow-[0_0_18px_-6px] shadow-live/40`.
- Numbers always tabular: costs as `$1.2345` (4dp under $1, 2dp above), durations `4m 12s`.

### 6.3 Motion rules

- **Pulse** (the only looping animation): 2.4s ease-in-out opacity 0.55→1, applied to
  live dots, the active timeline segment, and the running cost figure. Nothing else loops.
- **Lane / list moves**: auto-animate FLIP, 220ms ease-out — an issue card visibly slides
  between Board lanes; run pills reorder in the sidebar.
- **Feed entries**: 150ms fade + 2px rise on mount; the feed auto-follows unless the user
  has scrolled up (then show a "↓ live" jump chip).
- Hover/focus transitions ≤120ms, color/border only. No spinners besides the connection
  dot. `prefers-reduced-motion: reduce` disables pulse and FLIP entirely.

---

## 7. Builder contracts

**File ownership — hard boundaries:**

| | server-builder | ui-builder |
|---|---|---|
| Creates | `src/events.ts`, `src/server.ts` | everything under `ui/` |
| Edits (surgical, per §4 only) | `src/agents.ts`, `src/loop.ts`, `src/linear.ts`, `src/index.ts`, `.env.example` | nothing outside `ui/` |
| Must NOT touch | root `package.json`, `ui/`, `docs/`, any other src behavior | root `package.json`, anything in `src/`, `docs/` |

- **Shared types**: source of truth is §2's verbatim block. server-builder puts it in
  `src/events.ts` (plus §2.1 daemon-only additions); ui-builder copies the verbatim block
  character-for-character into `ui/src/lib/events.ts`. They are duplicated **by design** —
  no cross-package imports, ever.
- **No new root dependencies**: the daemon side uses `node:http` only; `npm run
  typecheck` (root) must pass with zero changes to `package.json`/`tsconfig.json`.
- **UI acceptance**: `cd ui && npm run typecheck && npm run build` clean; `npm run dev`
  against a daemon started with `DASHBOARD_PORT=8787 npm run factory:dry` shows the
  Board hydrating from `/state` and at least `daemon_started`/`tick_*`/`queue_snapshot`
  events streaming. (In `--dry` the dashboard is off *unless* `DASHBOARD_PORT` is set —
  setting it is the supported way to develop the UI without live Linear writes.)
- **Server acceptance**: with `DASHBOARD_PORT=8787`, `curl 127.0.0.1:8787/state` returns
  MissionState; `curl -N 127.0.0.1:8787/events` replays history then streams; a second
  concurrent client works; `curl -N '127.0.0.1:8787/events?since=<seq>'` skips old
  events; killing the daemon closes clients cleanly and `factory-history.jsonl` contains
  one line per finished run.
- **Integration agent (afterwards, not the builders)**: adds root scripts
  `"ui:dev": "npm --prefix ui run dev"`, `"ui:build": "npm --prefix ui run build"`;
  verifies the built `ui/dist` is served at `http://127.0.0.1:8787/`.
- Neither builder commits, pushes, calls Linear, or binds any host other than 127.0.0.1.
