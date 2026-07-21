import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { fetchQueue, fetchStatesByIdentifiers, LinearRateLimited, recoverOrphanedClaims } from "./linear.ts";
import { processIssue, markNeedsHuman, isEligible } from "./loop.ts";
import { repoFromTicket } from "./repos.ts";
import { planIssue } from "./plan.ts";
import { stewardTick } from "./steward.ts";
import { reconcileTick } from "./reconcile.ts";
import { groundskeeperTick } from "./groundskeepers.ts";
import { EPIC_LABEL } from "./linear.ts";
import { parseFactoryMeta } from "./meta.ts";
import { selectRunnable, type Schedulable } from "./dag.ts";
import { redactSecrets } from "./agents.ts";
import { bus } from "./events.ts";
import { startDashboard } from "./server.ts";
import { startEventStore } from "./db.ts";

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
// identifier → its declared `touches` globs (the file-mutex key). Was a Set;
// now a Map so the scheduler can read in-flight children's touches to serialize
// any candidate whose globs would overlap. .size/.has/.delete are unchanged.
const inFlight = new Map<string, string[]>();

async function tick(): Promise<boolean> {
  bus.emit({ type: "tick_started" });
  const queue = await fetchQueue();
  if (queue.length === 0) {
    bus.emit({ type: "tick_finished", queued: 0, eligible: 0, markedNeedsHuman: 0, processed: 0 });
    await stewardTick().catch((error) => console.error(`[steward] ${error instanceof Error ? error.message : error}`));
    await reconcileTick().catch((error) => console.error(`[reconcile] ${error instanceof Error ? error.message : error}`));
    await groundskeeperTick().catch((error) => console.error(`[groundskeeper] ${error instanceof Error ? error.message : error}`));
    return false;
  }

  // Ineligible issues get labeled out of the queue — they never consume WIP
  // slots or starve the FIFO head (C6).
  // Factory-Epic tickets route to the PLAN stage (one per tick bounds spend);
  // their children arrive as ordinary tickets on later ticks (plan v1.1).
  const isEpic = (i: { labels: string[]; description: string }) => i.labels.includes(EPIC_LABEL) || parseFactoryMeta(i.description).type === "epic";
  const epic = queue.find(isEpic);
  if (epic) await planIssue(epic).catch((error) => {
    console.error(`[${epic.identifier}] planner unhandled: ${error instanceof Error ? error.message : error}`);
  });

  const eligible = [];
  for (const issue of queue) {
    if (isEpic(issue)) continue;
    if (isEligible(issue)) eligible.push(issue);
    // Repo may still be parseable even when the ticket fails other contract
    // checks — thread it through so the distilled lesson stays repo-scoped.
    else await markNeedsHuman(issue, "ticket does not meet the contract (missing sections or unparseable Repo) — see factory docs/ticket-contract.md", repoFromTicket(issue.description) ?? undefined);
  }
  if (eligible.length === 0) {
    bus.emit({ type: "tick_finished", queued: queue.length, eligible: 0, markedNeedsHuman: queue.length - eligible.length, processed: 0 });
    // Same background passes as the other two return paths — a board holding
    // only epics/ineligible tickets must not pause steward/groundskeeper forever.
    await stewardTick().catch((error) => console.error(`[steward] ${error instanceof Error ? error.message : error}`));
    await reconcileTick().catch((error) => console.error(`[reconcile] ${error instanceof Error ? error.message : error}`));
    await groundskeeperTick().catch((error) => console.error(`[groundskeeper] ${error instanceof Error ? error.message : error}`));
    return false;
  }

  // Rolling WIP semaphore (owner request): claim whenever capacity exists —
  // never barrier a fast issue behind a slow sibling's completion. Gap 1 layers
  // DAG scheduling on top: a candidate is claimed only when its declared
  // dependencies are all completed (topological frontier) and its `touches`
  // globs don't collide with an in-flight or already-admitted sibling (file
  // mutex). A child that declares neither behaves exactly as before.
  const capacity = config.caps.wipLimit - inFlight.size;
  const candidates = eligible
    .filter((i) => !inFlight.has(i.identifier))
    .map((issue) => {
      const meta = parseFactoryMeta(issue.description);
      const schedulable: Schedulable = { identifier: issue.identifier, dependsOn: meta.depends_on ?? [], touches: meta.touches ?? [] };
      return { issue, schedulable };
    });
  // One dependency-state query per tick, and only when some candidate declares
  // deps — negligible rate-limit impact. It re-validates the frontier against
  // LIVE Linear state each tick (the freshness pattern), so a dep merged/closed
  // out-of-band immediately unblocks its dependents. A LinearRateLimited here
  // propagates up to tick()'s existing backoff, like every other query.
  const depIds = [...new Set(candidates.flatMap((c) => c.schedulable.dependsOn))];
  const depTypes = depIds.length > 0 ? await fetchStatesByIdentifiers(depIds) : new Map<string, string>();
  const busyTouches = [...inFlight.values()];
  const { run } = selectRunnable(candidates.map((c) => c.schedulable), (id) => depTypes.get(id), busyTouches, capacity);
  const runSet = new Set(run);
  const batch = candidates.filter((c) => runSet.has(c.schedulable.identifier));
  if (batch.length > 0) console.log(`[tick] claiming ${batch.length} (in-flight ${inFlight.size}/${config.caps.wipLimit})`);
  for (const { issue, schedulable } of batch) {
    inFlight.set(issue.identifier, schedulable.touches);
    void processIssue(issue)
      .catch((error) => console.error(`[${issue.identifier}] unhandled: ${error instanceof Error ? error.message : error}`))
      .finally(() => inFlight.delete(issue.identifier));
  }
  bus.emit({ type: "tick_finished", queued: queue.length, eligible: eligible.length, markedNeedsHuman: queue.length - eligible.length, processed: batch.length });
  await stewardTick().catch((error) => console.error(`[steward] ${error instanceof Error ? error.message : error}`));
  await reconcileTick().catch((error) => console.error(`[reconcile] ${error instanceof Error ? error.message : error}`));
  await groundskeeperTick().catch((error) => console.error(`[groundskeeper] ${error instanceof Error ? error.message : error}`));
  return batch.length > 0 || inFlight.size > 0;
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
  // Durable event store must be open regardless of dashboard enablement —
  // --once/--dry-run/DASHBOARD_PORT=0 all resolve the dashboard port to null,
  // but steward closeout (childStatusBlock → lastParkReasonForIssue) and
  // groundskeeper governance both read from this store on every tick.
  startEventStore();
  // Self-heal orphaned claims from a prior process (restart mid-run) before we
  // start ticking, so in-flight tickets resume instead of stranding In-Progress.
  const recovered = await recoverOrphanedClaims().catch(() => [] as string[]);
  if (recovered.length > 0) console.log(`[recover] reset ${recovered.length} orphaned claim(s) from a prior run: ${recovered.join(", ")}`);
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
    let busy = false;
    try {
      busy = await tick();
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
    // Adaptive polling: fast when idle so new tickets get picked up quickly,
    // standard cadence while work is in flight.
    const interval = busy ? config.watchIntervalSeconds : config.idleIntervalSeconds;
    await new Promise((resolve) => setTimeout(resolve, (interval + backoffSeconds) * 1000));
  } while (!draining);

  while (inFlight.size > 0) {
    console.log(`[drain] waiting for ${inFlight.size} in-flight issue(s)`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  bus.emit({ type: "daemon_stopped", reason: config.oneShot ? "one_shot" : "drained" });
  await dashboard?.close();
  rmSync(LEASE, { force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
