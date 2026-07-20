import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { fetchQueue, LinearRateLimited } from "./linear.ts";
import { processIssue, markNeedsHuman, isEligible } from "./loop.ts";
import { redactSecrets } from "./agents.ts";
import { bus } from "./events.ts";
import { startDashboard } from "./server.ts";

// Watch loop. Serial ticks, WIP-limited, single-instance host lease. Hardened
// per code-review verdict 2026-07-20: lease guard handles empty/garbage files
// (C20/M1), ineligible issues are labeled out-of-queue instead of starving the
// batch (C6), rate-limit ticks back off instead of crashing (C25).

const LEASE = join(config.workRoot, ".factory.pid");

function acquireLease(): void {
  mkdirSync(config.workRoot, { recursive: true });
  if (existsSync(LEASE)) {
    const pid = Number(readFileSync(LEASE, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      rmSync(LEASE); // truncated/garbage lease (M1: pid 0 would signal the process group)
    } else {
      try {
        process.kill(pid, 0); // throws ESRCH if not running
        throw new Error(`another factory instance is running (pid ${pid})`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        rmSync(LEASE); // stale lease from a dead process
      }
    }
  }
  writeFileSync(LEASE, String(process.pid));
}

let draining = false;

async function tick(): Promise<void> {
  bus.emit({ type: "tick_started" });
  const queue = await fetchQueue();
  if (queue.length === 0) { bus.emit({ type: "tick_finished", queued: 0, eligible: 0, markedNeedsHuman: 0, processed: 0 }); return; }

  // Ineligible issues get labeled out of the queue — they never consume WIP
  // slots or starve the FIFO head (C6).
  const eligible = [];
  for (const issue of queue) {
    if (isEligible(issue)) eligible.push(issue);
    else await markNeedsHuman(issue, "ticket does not meet the contract (missing sections or unparseable Repo) — see factory docs/ticket-contract.md");
  }
  if (eligible.length === 0) { bus.emit({ type: "tick_finished", queued: queue.length, eligible: 0, markedNeedsHuman: queue.length - eligible.length, processed: 0 }); return; }

  console.log(`[tick] ${eligible.length} eligible (${queue.length - eligible.length} marked needs-human); WIP limit ${config.caps.wipLimit}`);
  const batch = eligible.slice(0, config.caps.wipLimit);
  await Promise.all(batch.map((issue) => processIssue(issue).catch((error) => {
    console.error(`[${issue.identifier}] unhandled: ${error instanceof Error ? error.message : error}`);
  })));
  bus.emit({ type: "tick_finished", queued: queue.length, eligible: eligible.length, markedNeedsHuman: queue.length - eligible.length, processed: batch.length });
}

async function main(): Promise<void> {
  if (config.serverOnly) {
    // Dashboard-only mode: serve mission control, never touch Linear. No
    // daemon_started emit — the pipeline daemon genuinely is not running, and
    // /state honestly reports daemon: null. No lease either: a viewer must not
    // block (or unlock) a real daemon — the port collision is the real guard,
    // and server.ts exits non-zero on a failed bind in this mode.
    const dashboard = startDashboard();
    if (!dashboard) throw new Error("--server-only requires the dashboard enabled (set DASHBOARD_PORT, not 0)");
    console.log("factory --server-only: mission control up, Linear polling disabled — Ctrl-C to exit");
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      process.on("SIGTERM", () => resolve());
    });
    await dashboard.close();
    return;
  }

  acquireLease();
  const dashboard = startDashboard();

  console.log(`factory watching teams [${config.teamKeys.join(", ")}] · workRoot ${config.workRoot} · ${config.dryRun ? "DRY-RUN" : "live"}`);
  bus.emit({ type: "daemon_started", mode: config.dryRun ? "dry" : config.oneShot ? "once" : "watch",
    teamKeys: config.teamKeys, workRoot: config.workRoot,
    wipLimit: config.caps.wipLimit, watchIntervalSeconds: config.watchIntervalSeconds,
    budgetUsdPerIssue: config.caps.budgetUsdPerIssue });

  process.on("SIGINT", () => { draining = true; console.log("draining — will exit after current tick"); });
  process.on("SIGTERM", () => { draining = true; });

  do {
    let backoffSeconds = 0;
    try {
      await tick();
    } catch (error) {
      if (error instanceof LinearRateLimited) {
        backoffSeconds = 300; // park the whole tick cycle at window scale (C25)
        bus.emit({ type: "linear_backoff", seconds: backoffSeconds });
        console.error(`[tick] ${error.message} — backing off ${backoffSeconds}s`);
      } else {
        console.error(`[tick] failed: ${error instanceof Error ? error.message : error}`);
        bus.emit({ type: "tick_finished", queued: 0, eligible: 0, markedNeedsHuman: 0, processed: 0,
          // Linear errors interpolate HTTP response bodies — redact like every
          // other emitted string (§2.2).
          error: redactSecrets(error instanceof Error ? error.message : String(error)).clean.slice(0, 300) });
      }
    }
    if (config.oneShot || draining) break;
    await new Promise((resolve) => setTimeout(resolve, (config.watchIntervalSeconds + backoffSeconds) * 1000));
  } while (!draining);

  bus.emit({ type: "daemon_stopped", reason: config.oneShot ? "one_shot" : "drained" });
  await dashboard?.close();
  rmSync(LEASE, { force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
