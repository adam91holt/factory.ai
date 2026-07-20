import { createServer, type ServerResponse } from "node:http";
import { startEventStore, issueEvents } from "./db.ts";
import { getIssueDetail } from "./linear.ts";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { bus, type FactoryEvent, type MissionState, type RunRecord, type RunView, type StageView } from "./events.ts";

// Mission-control dashboard server. Contract: docs/ui-architecture.md §3.
// Observe-only: GET routes exclusively, loopback bind exclusively, no request
// body ever read, no env echo, no file reads outside ui/dist and
// factory-history.jsonl. All payload strings were redacted at emit time.
// node:http only (Bun implements it) — no new dependencies.

const UI_DIST = fileURLToPath(new URL("../ui/dist", import.meta.url));

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

export function startDashboard(): {
  close(): Promise<void> } | null {
  const port = resolvePort();
  if (port === null) return null;
  startEventStore();

  const historyPath = join(config.workRoot, "factory-history.jsonl");
  const clients = new Set<{ res: ServerResponse; heartbeat: ReturnType<typeof setInterval> }>();

  // Fold everything already in the ring buffer, then stay current via the bus.
  let mission = bus.history().reduce(applyEvent, initialMission());
  const unsubscribe = bus.subscribe((e) => {
    mission = applyEvent(mission, e);
    // Dry-run rehearsals never enter durable history — factory-history.jsonl
    // records real deliveries only (dry outcomes are "pr_open" with no PR).
    if (e.type === "run_finished" && !e.dryRun) {
      const record: RunRecord = {
        issueKey: e.issueKey, outcome: e.outcome,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
        prUrl: e.prUrl, costUsd: e.costUsd, stages: e.stages,
        gateStrength: e.gateStrength, guardedPaths: e.guardedPaths,
        finishedAt: e.at,
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
      if (!/^[A-Z]+-\d+$/.test(key)) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"bad key"}'); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(issueEvents(key)));
      return;
    }

    if (url.pathname === "/issue") {
      const key = url.searchParams.get("key") ?? "";
      if (!/^[A-Z]+-\d+$/.test(key)) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"bad key"}'); return; }
      getIssueDetail(key)
        .then((detail) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(detail)); })
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
    close(): Promise<void> {
      unsubscribe();
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
