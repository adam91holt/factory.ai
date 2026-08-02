import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { startEventStore, issueEvents, getTelemetry, flushEvents } from "./db.ts";
import { readCatalog, saveCatalogEntry } from "./catalog-manager.ts";
import { listLessons, archiveLesson } from "./lessons.ts";
import { approvalsView, approveItem, pushbackItem } from "./approvals.ts";
import {
  projectsView, saveProjectDescriptive, setProjectModel, setProjectGroundskeeper,
  proposeProjectPolicy, approvePolicyItem, rejectPolicyItem,
} from "./project-config.ts";
import { getIssueDetail, getEpicDag, type IssueDetail, type EpicDagPayload } from "./linear.ts";
import { redactSecrets } from "./agents.ts";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { bus, type FactoryEvent, type MissionState, type RunRecord, type RunView, type StageView } from "./events.ts";
import { killSwitch } from "./control.ts";

// Mission-control dashboard server. Contract: docs/ui-architecture.md §3.
// Almost observe-only: GET routes, loopback bind exclusively, no env echo, no
// file reads outside ui/dist and factory-history.jsonl. The exceptions are the
// guarded POSTs: /catalog/save (the catalog manager), which reads a
// bounded JSON body and writes ONE validated card/skill file under
// agents|skills|groundskeepers, then commits it; /lessons/archive, which flips
// archived=1 on ONE lesson row (never a delete); /stop (B6 kill switch,
// prerequisite-0), which aborts every in-flight stage and enters drain mode;
// and the approvals-inbox actions /approvals/:id/approve|pushback
// (approvals.ts — the human review lane; approve is the one human merge
// authority, still pinned through mergePr) — every one of them a human acting
// through the loopback UI, all behind the same guardedJsonBody()
// CSRF/DNS-rebinding gate. All emitted payload strings
// were redacted at emit time. node:http only (Bun implements it) — no new
// dependencies.

const UI_DIST = fileURLToPath(new URL("../ui/dist", import.meta.url));

/** B10: getIssueDetail() forwards Linear ticket content verbatim — the only
 * browser-bound path that isn't already redacted at emit time (unlike bus
 * events, which run through redactSecrets() before publish). Scrub every
 * free-text field Linear supplies before this ever reaches the response. */
export function redactIssueDetail(detail: IssueDetail): IssueDetail {
  const cleanNode = <T extends { title: string }>(n: T): T => ({ ...n, title: redactSecrets(n.title).clean });
  return {
    ...detail,
    title: redactSecrets(detail.title).clean,
    description: redactSecrets(detail.description).clean,
    parent: detail.parent ? cleanNode(detail.parent) : null,
    children: detail.children.map(cleanNode),
    siblings: detail.siblings.map(cleanNode),
  };
}

/** B10 discipline for /epic-dag: titles and touches globs are Linear-supplied
 * free text — scrub them before they reach a browser. dependsOn identifiers
 * are already charset-locked by meta.ts and need no scrub. */
export function redactEpicDag(payload: EpicDagPayload): EpicDagPayload {
  return {
    epic: { ...payload.epic, title: redactSecrets(payload.epic.title).clean },
    tickets: payload.tickets.map((t) => ({
      ...t,
      title: redactSecrets(t.title).clean,
      touches: t.touches.map((g) => redactSecrets(g).clean),
    })),
  };
}

function initialMission(): MissionState {
  return { seq: 0, daemon: null, board: [], boardAt: null, runs: {}, needsHuman: [] };
}

// ---------------------------------------------------------------------------
// applyEvent — pure fold of one FactoryEvent into MissionState (§5.3). The UI
// store (ui/src/lib/store.ts) implements the IDENTICAL reducer: same helpers,
// same tolerance for unknown issueKeys, same pruning. Keep the two in lockstep
// — /state hydration and pure event replay must produce the same state.
// ---------------------------------------------------------------------------

/** Finished runs retained in MissionState (newest by finishedAt); active runs
 *  are never pruned. Bounds long-lived daemon/tab memory (each run can hold
 *  ~4KB resultText per stage). */
const MAX_FINISHED_RUNS = 50;

function freshRun(issueKey: string, at: number): RunView {
  return {
    issueKey, title: "", repo: "", dryRun: false,
    startedAt: at, finishedAt: null, status: "active",
    stages: [], gates: null, costUsd: 0, prUrl: null,
  };
}

/** Find index of the last unfinished stage with this label (parallel reviewers overlap). */
function openStageIndex(stages: StageView[], label: string): number {
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i];
    if (s !== undefined && s.stage === label && s.finishedAt === null) return i;
  }
  return -1;
}

function withRun(m: MissionState, issueKey: string, at: number, fn: (run: RunView) => RunView): MissionState {
  const existing = m.runs[issueKey] ?? freshRun(issueKey, at);
  return { ...m, runs: { ...m.runs, [issueKey]: fn(existing) } };
}

function pruneFinishedRuns(runs: Record<string, RunView>): Record<string, RunView> {
  const finished = Object.values(runs).filter((r) => r.status !== "active");
  if (finished.length <= MAX_FINISHED_RUNS) return runs;
  finished.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const drop = new Set(finished.slice(MAX_FINISHED_RUNS).map((r) => r.issueKey));
  const next: Record<string, RunView> = {};
  for (const [key, run] of Object.entries(runs)) {
    if (!drop.has(key)) next[key] = run;
  }
  return next;
}

/** Pure fold of one FactoryEvent into MissionState — never mutates `mission`. */
export function applyEvent(mission: MissionState, e: FactoryEvent): MissionState {
  let m = mission;
  switch (e.type) {
    case "daemon_started":
      m = {
        ...m,
        daemon: {
          mode: e.mode, teamKeys: e.teamKeys, workRoot: e.workRoot, wipLimit: e.wipLimit,
          watchIntervalSeconds: e.watchIntervalSeconds, budgetUsdPerIssue: e.budgetUsdPerIssue,
          startedAt: e.at, lastTick: null, backoffSeconds: 0,
        },
      };
      break;
    case "daemon_stopped":
      break;
    case "tick_started":
      break;
    case "tick_finished":
      if (m.daemon) {
        m = {
          ...m,
          daemon: {
            ...m.daemon,
            lastTick: {
              at: e.at, queued: e.queued, eligible: e.eligible,
              markedNeedsHuman: e.markedNeedsHuman, processed: e.processed,
              ...(e.error ? { error: e.error } : {}),
            },
            backoffSeconds: e.error ? m.daemon.backoffSeconds : 0,
          },
        };
      }
      break;
    case "linear_backoff":
      if (m.daemon) m = { ...m, daemon: { ...m.daemon, backoffSeconds: e.seconds } };
      break;
    case "queue_snapshot":
      m = { ...m, board: e.issues, boardAt: e.at };
      break;
    case "issue_needs_human":
      m = {
        ...m,
        needsHuman: [
          ...m.needsHuman.filter((n) => n.issueKey !== e.issueKey),
          { issueKey: e.issueKey, reason: e.reason, at: e.at },
        ],
      };
      break;
    case "run_started":
      m = {
        ...m,
        runs: {
          ...m.runs,
          [e.issueKey]: {
            ...freshRun(e.issueKey, e.at),
            title: e.title,
            repo: e.repo,
            dryRun: e.dryRun,
          },
        },
      };
      break;
    case "run_stage_started":
      m = withRun(m, e.issueKey, e.at, (run) => ({
        ...run,
        stages: [
          ...run.stages,
          {
            stage: e.stage, model: e.model, viaProxy: e.viaProxy, startedAt: e.at,
            finishedAt: null, costUsd: 0, turns: 0, toolCalls: 0, lastActivity: "",
            resultText: "",
          },
        ],
      }));
      break;
    case "run_tool_use":
      m = withRun(m, e.issueKey, e.at, (run) => {
        const i = openStageIndex(run.stages, e.stage);
        if (i < 0) return run;
        const stages = run.stages.slice();
        const s = stages[i] as StageView;
        stages[i] = {
          ...s,
          toolCalls: s.toolCalls + 1,
          lastActivity: e.detail ? `${e.tool} · ${e.detail}` : e.tool,
        };
        return { ...run, stages };
      });
      break;
    case "run_assistant_text":
      m = withRun(m, e.issueKey, e.at, (run) => {
        const i = openStageIndex(run.stages, e.stage);
        if (i < 0) return run;
        const stages = run.stages.slice();
        const s = stages[i] as StageView;
        stages[i] = { ...s, lastActivity: e.text.slice(0, 120) };
        return { ...run, stages };
      });
      break;
    case "run_stage_finished":
      m = withRun(m, e.issueKey, e.at, (run) => {
        const i = openStageIndex(run.stages, e.stage);
        if (i < 0) return { ...run, costUsd: run.costUsd + e.costUsd };
        const stages = run.stages.slice();
        const s = stages[i] as StageView;
        stages[i] = {
          ...s,
          finishedAt: e.at,
          costUsd: e.costUsd,
          turns: e.turns,
          resultText: e.resultText,
          ...(e.error ? { error: e.error } : {}),
          ...(e.degraded ? { degraded: true } : {}),
        };
        return { ...run, stages, costUsd: run.costUsd + e.costUsd };
      });
      break;
    case "run_gates":
      m = withRun(m, e.issueKey, e.at, (run) => ({
        ...run,
        gates: { round: e.round, green: e.green, strength: e.strength, gates: e.gates },
      }));
      break;
    case "run_finished":
      m = withRun(m, e.issueKey, e.at, (run) => {
        const degradedLabels = new Set(e.stages.filter((s) => s.degraded).map((s) => s.label));
        return {
          ...run,
          status: e.outcome,
          finishedAt: e.at,
          prUrl: e.prUrl,
          costUsd: e.costUsd,
          ...(e.reason ? { reason: e.reason } : {}),
          stages: run.stages.map((s) =>
            degradedLabels.has(s.stage) ? { ...s, degraded: true } : s,
          ),
        };
      });
      m = { ...m, runs: pruneFinishedRuns(m.runs) };
      break;
  }
  return { ...m, seq: e.seq };
}

function resolvePort(): number | null {
  const raw = process.env.DASHBOARD_PORT?.trim();
  if (raw === undefined || raw === "") {
    if (config.oneShot || config.dryRun) return null; // off in --once/--dry unless forced
    return 8787;
  }
  if (raw === "0") return null; // explicit off
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DASHBOARD_PORT must be an integer in 1..65535 or 0 to disable (got "${raw}")`);
  }
  return port;
}

function readRunRecords(historyPath: string): RunRecord[] {
  let text: string;
  try {
    text = readFileSync(historyPath, "utf8");
  } catch {
    return []; // missing file is fine — no runs finished yet
  }
  const records: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as RunRecord);
    } catch {
      // skip unparseable lines
    }
  }
  return records.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 500);
}

/** Read a request body with a hard byte cap (defends the one write route). The
 *  content cap in catalog-manager is 64KB; 256KB here leaves room for JSON
 *  escaping/whitespace while still bounding memory. Resolves null if the cap is
 *  tripped (the stream is destroyed) or the stream errors. */
function readBoundedBody(req: IncomingMessage, capBytes: number): Promise<string | null> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (value: string | null): void => { if (!done) { done = true; resolveBody(value); } };
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > capBytes) { req.destroy(); finish(null); return; }
      chunks.push(c);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(null));
  });
}

// ---------------------------------------------------------------------------
// guardedJsonBody — the shared gate in front of EVERY mutation route
// (/catalog/save, /lessons/archive). Extracted, not duplicated, so the two
// write routes cannot drift apart or silently weaken. Each write route is
// reachable from the owner's browser at 127.0.0.1 — loopback bind is NOT a
// boundary against a page the owner happens to have open (the browser runs the
// attacker's JS and can POST here). Require a same-origin JSON write:
//   • POST only — anything else is 405 (and the OPTIONS preflight a
//     cross-origin fetch() triggers gets no CORS headers → the browser never
//     sends the POST).
//   • Content-Type application/json (load-bearing): the CORS-"simple"
//     form/text-plain vector cannot set it, and setting it cross-origin forces
//     the preflight above.
//   • Origin, when present, must be a LOOPBACK origin (http/https on
//     127.0.0.1 or localhost, any port). A page the owner visits lives on a
//     public origin, so this refuses every drive-by while still allowing the
//     built dashboard AND the vite dev proxy (its own port).
//   • Host, when present, must be a loopback host — kills DNS-rebinding (a
//     rebound attacker domain sends Host: attacker.com, not 127.0.0.1).
//   • Body bounded at 256KB and parsed as JSON here, so no route ever holds
//     an unbounded or unparsed body.
// The real UI sends content-type application/json same-origin, so nothing
// legitimate is affected (ui/src/lib/catalog.ts, ui/src/lib/lessons.ts).
// Resolves { body } with the parsed JSON, or null after having written the
// refusal response itself (wrapped so a legitimate JSON body of `null` can't
// be mistaken for a refusal and leave the request hanging).
// ---------------------------------------------------------------------------
export async function guardedJsonBody(req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | null> {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end('{"error":"method not allowed"}');
    return null;
  }
  const isLoopbackHostname = (h: string): boolean => h === "127.0.0.1" || h === "localhost";
  // Operator-declared extra origins (config.trustedOrigins — e.g. the
  // tailscale-serve HTTPS name). Exact full-origin match; the host leg
  // accepts the same names, so Origin and Host stay mutually consistent.
  const trusted = config.trustedOrigins;
  const trustedHosts = new Set(trusted.map((o) => { try { return new URL(o).host; } catch { return ""; } }).filter(Boolean));
  const origin = req.headers.origin;
  let originOk = true;
  if (origin !== undefined) {
    try {
      const u = new URL(origin);
      originOk = ((u.protocol === "http:" || u.protocol === "https:") && isLoopbackHostname(u.hostname))
        || trusted.includes(origin.trim().replace(/\/+$/, "").toLowerCase());
    } catch { originOk = false; }
  }
  const host = req.headers.host;
  const hostOk = host === undefined
    || isLoopbackHostname(host.replace(/:\d+$/, "").toLowerCase())
    || trustedHosts.has(host.toLowerCase());
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentType !== "application/json" || !originOk || !hostOk) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end('{"error":"cross-origin or non-JSON write refused"}');
    return null;
  }
  const body = await readBoundedBody(req, 256 * 1024);
  if (body === null) {
    res.writeHead(413, { "content-type": "application/json" });
    res.end('{"error":"request body too large or unreadable"}');
    return null;
  }
  try {
    return { body: JSON.parse(body) as unknown };
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"invalid JSON body"}');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Project-config routes (issue #7). Extracted from the createServer callback so
// tests can mount them on an ephemeral server and exercise the REAL gate:
// every mutation goes through guardedJsonBody — the SAME function as
// /catalog/save, /lessons/archive, /stop and the approvals actions. No new
// gate, no copy. Returns true when the request was handled (or refused) here.
// ---------------------------------------------------------------------------
export function handleProjectRoutes(url: URL, req: IncomingMessage, res: ServerResponse): boolean {
  const respond = (p: Promise<{ status: number; json: unknown }>, label: string): void => {
    void p.then((result) => {
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.json));
    }).catch((error: unknown) => {
      console.error(`[dashboard] ${label} failed: ${error instanceof Error ? error.message : error}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `${label} failed` }));
    });
  };

  if (url.pathname === "/projects") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end('{"error":"method not allowed"}');
      return true;
    }
    // Same SPA/API split as /catalog, /lessons, /approvals: browser navigations
    // get the app shell, fetch() clients get JSON.
    if ((req.headers.accept ?? "").includes("text/html") && serveIndex(res)) return true;
    respond(projectsView().then((view) => ({ status: 200, json: view })), "projects view");
    return true;
  }

  const writes: Record<string, (body: unknown) => Promise<{ status: number; json: unknown }>> = {
    "/projects/save": saveProjectDescriptive,
    "/projects/model": setProjectModel,
    "/projects/groundskeeper": setProjectGroundskeeper,
    "/projects/policy/propose": proposeProjectPolicy,
  };
  const write = writes[url.pathname];
  if (write) {
    void guardedJsonBody(req, res).then((guarded) => {
      if (guarded === null) return; // refusal already written
      respond(write(guarded.body), url.pathname);
    });
    return true;
  }

  // Authority approve/reject — the pending→active claim. Mirrors the approvals
  // action route shape; the atomicity lives in db.ts, and approve is BOUND to
  // the reviewed {key, value} in the body (approvals.ts gatedHeadSha pattern)
  // so a blind or stale approve-by-id refuses.
  const policyAction = url.pathname.match(/^\/projects\/policy\/(\d{1,12})\/(approve|reject)$/);
  if (policyAction) {
    void guardedJsonBody(req, res).then((guarded) => {
      if (guarded === null) return; // refusal already written
      const id = Number(policyAction[1]);
      respond(policyAction[2] === "approve" ? approvePolicyItem(id, guarded.body) : rejectPolicyItem(id), `policy ${policyAction[2]}`);
    });
    return true;
  }

  return false;
}

/** Serve ui/dist/index.html if built. Returns false (nothing written) otherwise. */
function serveIndex(res: ServerResponse): boolean {
  const index = join(UI_DIST, "index.html");
  if (!existsSync(index)) return false;
  try {
    const body = readFileSync(index);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function contentType(path: string): string {
  return path.endsWith(".js") ? "text/javascript"
    : path.endsWith(".css") ? "text/css"
    : path.endsWith(".svg") ? "image/svg+xml"
    : "application/octet-stream";
}

export async function startDashboard(): Promise<{
  close(): Promise<void> } | null> {
  const port = resolvePort();
  if (port === null) return null;
  await startEventStore();

  const historyPath = join(config.workRoot, "factory-history.jsonl");
  const clients = new Set<{ res: ServerResponse; heartbeat: ReturnType<typeof setInterval> }>();

  // Fold everything already in the ring buffer, then stay current via the bus.
  let mission = bus.history().reduce(applyEvent, initialMission());
  const unsubscribe = bus.subscribe((e) => {
    mission = applyEvent(mission, e);
    // Dry-run rehearsals never enter durable history — factory-history.jsonl
    // records real deliveries only (dry outcomes are "pr_open" with no PR).
    if (e.type === "run_finished" && !e.dryRun) {
      // mission was folded above, so mission.runs[issueKey] is this finished
      // run — carrying repo/title/startedAt and the per-stage models the bare
      // run_finished body omits. Enrich the durable record with them so the
      // history view has repo, timing and models without re-reading the event
      // log per row. All additive/optional — missing fields degrade gracefully.
      const rv = mission.runs[e.issueKey];
      const models = rv
        ? [...new Set(rv.stages.map((s) => s.model).filter((m): m is string => !!m))]
        : [];
      const record: RunRecord = {
        issueKey: e.issueKey, outcome: e.outcome,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
        prUrl: e.prUrl, costUsd: e.costUsd, stages: e.stages,
        gateStrength: e.gateStrength, guardedPaths: e.guardedPaths,
        finishedAt: e.at,
        ...(rv?.repo ? { repo: rv.repo } : {}),
        ...(rv?.title ? { title: rv.title } : {}),
        ...(rv ? { startedAt: rv.startedAt } : {}),
        ...(models.length ? { models } : {}),
      };
      try {
        appendFileSync(historyPath, `${JSON.stringify(record)}\n`);
      } catch (error) {
        console.error(`[dashboard] history append failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    const frame = `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const client of clients) client.res.write(frame);
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    // Write route: bounded JSON body → strict validation + git commit in
    // catalog-manager. Guard semantics live in guardedJsonBody(). Kept ahead of
    // the GET-only guard below.
    if (url.pathname === "/catalog/save") {
      void guardedJsonBody(req, res).then((guarded) => {
        if (guarded === null) return; // refusal already written
        const result = saveCatalogEntry(guarded.body);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.json));
      });
      return;
    }

    // Write route: human-initiated lesson prune. Same guard as /catalog/save.
    // archiveLesson() sets archived=1 — a lesson row is NEVER hard-deleted, it
    // just stops being listed and stops being injected into prompts.
    if (url.pathname === "/lessons/archive") {
      void guardedJsonBody(req, res).then(async (guarded) => {
        if (guarded === null) return; // refusal already written
        const id = (guarded.body as { id?: unknown } | null)?.id;
        if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"body must be {\\"id\\": <positive integer>}"}');
          return;
        }
        try {
          const archived = await archiveLesson(id);
          if (!archived) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end('{"error":"no active lesson with that id"}');
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, id }));
        } catch (error) {
          console.error(`[dashboard] lesson archive failed: ${error instanceof Error ? error.message : error}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"archive failed"}');
        }
      });
      return;
    }

    // Write route: kill switch (B6, prerequisite-0). Same guard as /catalog/save
    // and /lessons/archive. Aborts every in-flight stage's AbortController
    // (agents.ts) AND enters drain mode (control.ts) so index.ts stops claiming
    // new work starting next tick — a human acting on a runaway factory needs
    // ONE button, not a `pkill` (docs/planning/autonomy.md "Prerequisite 0").
    if (url.pathname === "/stop") {
      void guardedJsonBody(req, res).then((guarded) => {
        if (guarded === null) return; // refusal already written
        const reasonRaw = (guarded.body as { reason?: unknown } | null)?.reason;
        const reason = typeof reasonRaw === "string" && reasonRaw.trim() !== ""
          ? reasonRaw.trim().slice(0, 200)
          : "manual /stop";
        const { abortedStages } = killSwitch(reason);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, draining: true, abortedCount: abortedStages.length, abortedStages }));
      });
      return;
    }

    // Write routes: approvals inbox actions (stream inbox-backend). Same
    // guardedJsonBody gate as every other mutation route. approve is the ONE
    // human merge authority this server exposes — approvals.ts re-verifies
    // the PR head against the gated SHA and merges through the existing
    // pinned mergePr path (or refuses); pushback posts owner feedback and
    // requeues, and structurally cannot merge (its dep set has no merge).
    // Both act only on a pending item claimed atomically in db.ts, so a
    // double-click or concurrent request can never double-act.
    const approvalAction = url.pathname.match(/^\/approvals\/(\d{1,12})\/(approve|pushback)$/);
    if (approvalAction) {
      void guardedJsonBody(req, res).then(async (guarded) => {
        if (guarded === null) return; // refusal already written
        const id = Number(approvalAction[1]);
        try {
          // approve binds to the evidence the caller SAW: body.gatedHeadSha is
          // the SHA rendered on their card, and a mismatch (superseded row,
          // stale tab) is refused rather than merged — see approvals.ts.
          const result = approvalAction[2] === "approve"
            ? await approveItem(id, (guarded.body as { gatedHeadSha?: unknown } | null)?.gatedHeadSha)
            : await pushbackItem(id, (guarded.body as { feedback?: unknown } | null)?.feedback);
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify(result.json));
        } catch (error) {
          console.error(`[dashboard] approval ${approvalAction[2]} failed: ${error instanceof Error ? error.message : error}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"approval action failed"}');
        }
      });
      return;
    }

    // Project-config routes (issue #7): GET /projects plus the guarded write
    // routes — all mutations behind the same guardedJsonBody gate as above.
    if (handleProjectRoutes(url, req, res)) return;

    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("method not allowed");
      return;
    }

    if (url.pathname === "/events") {
      const lastIdRaw = req.headers["last-event-id"];
      const lastId = Number(Array.isArray(lastIdRaw) ? lastIdRaw[0] : lastIdRaw);
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw === null ? Number.NaN : Number(sinceRaw);
      const resume = Number.isFinite(lastId) ? lastId : Number.isFinite(since) ? since : 0;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Flush headers immediately — with an empty history nothing else is
      // written until the first heartbeat, leaving clients hanging on connect.
      res.write(": connected\n\n");
      for (const e of bus.history(resume)) {
        res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
      const client = { res, heartbeat };
      clients.add(client);
      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(client);
      });
      return;
    }

    if (url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(mission));
      return;
    }

    if (url.pathname === "/run-events") {
      const key = url.searchParams.get("key") ?? "";
      // Wider than /issue: groundskeeper runs use GK-<card-name> issueKeys and
      // their events live in the same durable event log. /issue stays strict —
      // it forwards to Linear, where only ABC-123 identifiers exist.
      if (!/^[A-Z]+-[A-Za-z0-9-]{1,80}$/.test(key)) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"bad key"}'); return; }
      // Async store: adopt the promise idiom this file already uses at /issue
      // and /catalog/save rather than making the whole handler async (that
      // would perturb return-vs-writeHead ordering across the SSE/static
      // branches). Every chain gets a terminal .catch, so a rejected read can
      // never become an unhandled rejection or a hung response.
      void issueEvents(key)
        .then((events) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(events)); })
        .catch((error: unknown) => {
          console.error(`[dashboard] run-events failed: ${error instanceof Error ? error.message : error}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"run events unavailable"}');
        });
      return;
    }

    if (url.pathname === "/issue") {
      const key = url.searchParams.get("key") ?? "";
      if (!/^[A-Z]+-\d+$/.test(key)) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"bad key"}'); return; }
      getIssueDetail(key)
        .then((detail) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(redactIssueDetail(detail))); })
        .catch((error: unknown) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error).slice(0, 200) }));
        });
      return;
    }

    if (url.pathname === "/epic-dag") {
      // The Epic DAG panel's ONE read: epic + child meta assembled daemon-side
      // from a SINGLE Linear query (linear.ts getEpicDag) — never 1 + N /issue
      // round-trips from the browser on the daemon's API key.
      const key = url.searchParams.get("key") ?? "";
      if (!/^[A-Z]+-\d+$/.test(key)) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"bad key"}'); return; }
      getEpicDag(key)
        .then((payload) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(redactEpicDag(payload))); })
        .catch((error: unknown) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error).slice(0, 200) }));
        });
      return;
    }

    const wantsHtml = (req.headers.accept ?? "").includes("text/html");

    if (url.pathname === "/runs") {
      // /runs is both the history API and a UI route: browser navigations
      // (Accept: text/html) get the SPA shell, API clients get JSON — the same
      // bypass rule as the ui/ dev proxy.
      if (wantsHtml && serveIndex(res)) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(readRunRecords(historyPath)));
      return;
    }

    if (url.pathname === "/telemetry") {
      // Same SPA/API split as /runs: browser navigations (reload, bookmark,
      // deep link) get the app shell; API clients get JSON. And the aggregate
      // reads durable rows — a bad row or a store error must 500 this request,
      // never take down the daemon serving the pipeline.
      if (wantsHtml && serveIndex(res)) return;
      void getTelemetry()
        .then((t) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(t)); })
        .catch((error: unknown) => {
          console.error(`[dashboard] telemetry failed: ${error instanceof Error ? error.message : error}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"telemetry unavailable"}');
        });
      return;
    }

    if (url.pathname === "/catalog") {
      // Same SPA/API split as /runs and /telemetry: browser navigations to the
      // /catalog page get the app shell; fetch() clients get the JSON payload.
      // A read error must 500 this request, never crash the pipeline daemon.
      if (wantsHtml && serveIndex(res)) return;
      void readCatalog()
        .then((payload) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); })
        .catch((error: unknown) => {
          console.error(`[dashboard] catalog failed: ${error instanceof Error ? error.message : error}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"catalog unavailable"}');
        });
      return;
    }

    if (url.pathname === "/lessons") {
      // Same SPA/API split as /runs, /telemetry and /catalog: browser
      // navigations to the /lessons page get the app shell; fetch() clients
      // get the JSON list. Fresh read every time — deliberately NOT the
      // getTelemetry watermark cache (it only watches stage/run rows and would
      // serve stale lessons after a capture or archive). A read error must 500
      // this request, never crash the pipeline daemon; a missing table is an
      // empty list, not an error.
      if (wantsHtml && serveIndex(res)) return;
      void listLessons()
        .then((rows) => {
          const body = JSON.stringify({ lessons: rows
            .filter((l) => !l.archived)                                   // archive actually hides (F1)
            .map((l) => ({ id: l.id, repo: l.repo, stage: l.stage, lesson: l.lesson,
              createdAt: l.createdAt, sourceIssue: l.issueKey || null, sourceUrl: null })) }); // UI shape (F2)
          res.writeHead(200, { "content-type": "application/json" });
          res.end(body);
        })
        .catch((error: unknown) => {
          console.error(`[dashboard] lessons failed: ${error instanceof Error ? error.message : error}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"lessons unavailable"}');
        });
      return;
    }

    if (url.pathname === "/approvals") {
      // Same SPA/API split as /runs, /telemetry, /catalog and /lessons.
      // Fresh read every request (no watermark cache) — a just-approved or
      // just-pushed-back item must disappear from the list immediately. All
      // stored strings were redacted at write time (approvals.ts); `count`
      // backs the nav badge. A read error must 500 this request only.
      if (wantsHtml && serveIndex(res)) return;
      void approvalsView()
        .then((view) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(view)); })
        .catch((error: unknown) => {
          console.error(`[dashboard] approvals failed: ${error instanceof Error ? error.message : error}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"approvals unavailable"}');
        });
      return;
    }

    if (url.pathname === "/") {
      if (serveIndex(res)) return;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("UI not built — run bun run build in ui/");
      return;
    }

    if (url.pathname.startsWith("/assets/")) {
      // normalize + prefix-check path-traversal guard (codexProxyTest pattern).
      const rel = normalize(url.pathname).replace(/^\/+/, "");
      const full = join(UI_DIST, rel);
      // Trailing separator matters: "assetsfoo".startsWith("assets") would pass.
      const assetsBase = join(UI_DIST, "assets");
      if (full !== assetsBase && !full.startsWith(assetsBase + sep)) {
        res.writeHead(400);
        res.end();
        return;
      }
      try {
        const body = readFileSync(full);
        res.writeHead(200, { "content-type": contentType(full) });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
      return;
    }

    // SPA fallback: browser deep links (/runs/FAC-12, /queue, /history) get the
    // shell when built; everything else stays a hard 404.
    if (wantsHtml && serveIndex(res)) return;

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.on("error", (error) => {
    console.error(`[dashboard] server error: ${error instanceof Error ? error.message : error}`);
    // In --server-only the dashboard IS the process — a failed bind (e.g.
    // EADDRINUSE) must exit non-zero instead of idling on a dead listener.
    // In daemon modes the pipeline keeps running without the dashboard.
    if (config.serverOnly) process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[dashboard] mission control on http://127.0.0.1:${port}`);
  });

  return {
    async close(): Promise<void> {
      unsubscribe();
      // Write-behind queue: drain before tearing the server down so a shutdown
      // never strands events that were emitted but not yet inserted.
      await flushEvents().catch(() => { /* best-effort */ });
      for (const client of clients) {
        clearInterval(client.heartbeat);
        client.res.end();
      }
      clients.clear();
      return new Promise((resolveClose) => {
        server.close(() => resolveClose());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    },
  };
}
