import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { fetchQueue, fetchStatesByIdentifiers, LinearRateLimited, recoverOrphanedClaims } from "./linear.ts";
import { processIssue, markNeedsHuman, isEligible } from "./loop.ts";
import { repoFromTicket } from "./repos.ts";
import { planIssue } from "./plan.ts";
import { stewardTick } from "./steward.ts";
import { reconcileTick } from "./reconcile.ts";
import { groundskeeperTick } from "./groundskeepers.ts";
import { postMergeTick } from "./postmerge.ts";
import { runIntake } from "./intake.ts";
import { bootstrapProject } from "./bootstrap.ts";
import { EPIC_LABEL, INTAKE_LABEL, BOOTSTRAP_LABEL } from "./linear.ts";
import { parseFactoryMeta, resolveTicketRoute } from "./meta.ts";
import { selectRunnable, deriveImplicitDeps, type Schedulable } from "./dag.ts";
import { redactSecrets } from "./agents.ts";
import { bus } from "./events.ts";
import { startDashboard } from "./server.ts";
import { startEventStore, flushEvents, listAgentRegisterRows, listSkillRegisterRows, syncModelCatalog } from "./db.ts";
import { importRegistersFromFiles } from "./register-io.ts";
import { isDraining } from "./control.ts";
import { startAlerts } from "./alerts.ts";
import { startSpendCap } from "./spend-cap.ts";
import { LinearBackoff } from "./backoff.ts";

// Watch loop. Serial ticks, WIP-limited, single-instance host lease. Hardened
// per code-review verdict 2026-07-20: lease guard handles empty/garbage files
// (C20/M1), ineligible issues are labeled out-of-queue instead of starving the
// batch (C6), rate-limit ticks back off instead of crashing (C25).

const LEASE = join(config.workRoot, ".factory.pid");

// #3: startup fires a burst of sequential Linear calls — orphan recovery,
// then the first tick's queue fetch plus steward/reconcile/groundskeeper/
// postmerge (each of which is itself 1+ calls, reconcile one PER team) — with
// zero spacing between them, which was enough on its own to trip the rate
// limit before the daemon had processed a single ticket. `pace()` is a small
// jittered pause dropped between those calls so the very first burst spreads
// out over ~1-2s instead of firing as one uninterrupted volley. Injectable
// `sleep` so nothing here ever depends on a real timer in a test.
const PACE_BASE_MS = 400;
const PACE_JITTER_MS = 400;
async function pace(sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<void> {
  await sleep(PACE_BASE_MS + Math.random() * PACE_JITTER_MS);
}

// The four background passes run at the end of every tick path (idle, empty-
// eligible, and busy) — factored out once so the #3 pacing between them lives
// in exactly one place instead of three copy-pasted blocks.
async function runBackgroundPasses(): Promise<void> {
  await stewardTick().catch((error) => console.error(`[steward] ${error instanceof Error ? error.message : error}`));
  await pace();
  await reconcileTick(new Set(inFlight.keys())).catch((error) => console.error(`[reconcile] ${error instanceof Error ? error.message : error}`));
  await pace();
  await groundskeeperTick().catch((error) => console.error(`[groundskeeper] ${error instanceof Error ? error.message : error}`));
  await pace();
  await postMergeTick().catch((error) => console.error(`[postmerge] ${error instanceof Error ? error.message : error}`));
}

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
let restartAfterDrain = false;
// identifier → its declared `touches` globs (the file-mutex key). Was a Set;
// now a Map so the scheduler can read in-flight children's touches to serialize
// any candidate whose globs would overlap. .size/.has/.delete are unchanged.
const inFlight = new Map<string, string[]>();

// Runtime orphan sweep (B3/B5 audit improvement #5): recoverOrphanedClaims was
// startup-only, so an issue that went invisibly-in-flight mid-run (e.g. a
// mutation failure that left the Executing label attached with nothing
// tracking it in-process) stayed stuck until the daemon happened to restart.
// Re-running the same recovery periodically — excluding THIS process's own
// live inFlight claims — converts that into self-healing without risking a
// genuinely-running claim being reset out from under itself. Cadence is ticks,
// not wall-clock, so it scales with however often tick() actually runs (fast
// idle polling vs. slower busy polling both eventually hit the sweep).
const ORPHAN_SWEEP_EVERY_N_TICKS = 20;
let tickCount = 0;

async function sweepOrphanedClaims(): Promise<void> {
  const recovered = await recoverOrphanedClaims(new Set(inFlight.keys())).catch(() => [] as string[]);
  if (recovered.length > 0) console.log(`[recover] runtime sweep reset ${recovered.length} orphaned claim(s) not tracked by this process: ${recovered.join(", ")}`);
}

async function tick(): Promise<boolean> {
  bus.emit({ type: "tick_started" });
  tickCount += 1;
  if (tickCount % ORPHAN_SWEEP_EVERY_N_TICKS === 0) {
    await sweepOrphanedClaims().catch((error) => console.error(`[recover] runtime sweep failed: ${error instanceof Error ? error.message : error}`));
  }
  const queue = await fetchQueue();
  if (queue.length === 0) {
    bus.emit({ type: "tick_finished", queued: 0, eligible: 0, markedNeedsHuman: 0, processed: 0 });
    await runBackgroundPasses();
    return false;
  }

  // Ineligible issues get labeled out of the queue — they never consume WIP
  // slots or starve the FIFO head (C6).
  // Factory-Epic tickets route to the PLAN stage (one per tick bounds spend);
  // their children arrive as ordinary tickets on later ticks (plan v1.1).
  // Gap-5 bookends: an idea ticket routes to intake authoring (rough idea → full
  // epic contract, interviewing only on genuine ambiguity); a bootstrap ticket
  // routes to project bootstrap (idea → private repo → green scaffold). Both run
  // BEFORE the epic branch and are excluded from the eligible pipeline loop —
  // they upgrade/scaffold in place rather than flowing through implement→PR.
  // B5: routing is resolved through resolveTicketRoute (meta.ts), which treats
  // the factory META block as AUTHORITATIVE over labels when it declares
  // epic/idea/bootstrap — so a ticket whose meta was rewritten to type:epic but
  // whose Factory-Intake label lingered (a swallowed removeLabel failure, e.g.
  // intake.ts ~193) still routes to exactly one bookend instead of being
  // excluded from every one of them and silently skipped forever.
  const routeOf = (i: { labels: string[]; description: string }) => resolveTicketRoute(i.description,
    { epic: i.labels.includes(EPIC_LABEL), idea: i.labels.includes(INTAKE_LABEL), bootstrap: i.labels.includes(BOOTSTRAP_LABEL) });
  const isEpic = (i: { labels: string[]; description: string }) => routeOf(i) === "epic";
  const isIdea = (i: { labels: string[]; description: string }) => routeOf(i) === "idea";
  const isBootstrap = (i: { labels: string[]; description: string }) => routeOf(i) === "bootstrap";
  const special = (i: { labels: string[]; description: string }) => routeOf(i) !== null;

  // One heavy bookend op of each kind per tick (bounds spend, like the epic).
  // Bootstrap takes precedence over idea/epic when a ticket is somehow both.
  // Prerequisite-0 kill switch/spend cap (B6/T5): drain mode means "claim
  // nothing new" — these three ARE new-work claims (each spends real budget on
  // a ticket that wasn't already in flight), so they're gated exactly like the
  // batch claim below. In-flight work from before drain started is untouched.
  const bootstrap = isDraining() ? undefined : queue.find((i) => isBootstrap(i) && !isEpic(i));
  if (bootstrap) await bootstrapProject(bootstrap).catch((error) => {
    console.error(`[${bootstrap.identifier}] bootstrap unhandled: ${error instanceof Error ? error.message : error}`);
  });
  const idea = isDraining() ? undefined : queue.find((i) => isIdea(i) && !isBootstrap(i) && !isEpic(i));
  if (idea) await runIntake(idea).catch((error) => {
    console.error(`[${idea.identifier}] intake unhandled: ${error instanceof Error ? error.message : error}`);
  });

  const isEpicOnly = (i: { labels: string[]; description: string }) => isEpic(i) && !isIdea(i) && !isBootstrap(i);
  const epic = isDraining() ? undefined : queue.find(isEpicOnly);
  if (epic) await planIssue(epic).catch((error) => {
    console.error(`[${epic.identifier}] planner unhandled: ${error instanceof Error ? error.message : error}`);
  });

  const eligible = [];
  for (const issue of queue) {
    if (special(issue)) continue;
    if (isEligible(issue)) eligible.push(issue);
    // Repo may still be parseable even when the ticket fails other contract
    // checks — thread it through so the distilled lesson stays repo-scoped.
    else await markNeedsHuman(issue, "ticket does not meet the contract (missing sections or unparseable Repo) — see factory docs/ticket-contract.md", repoFromTicket(issue.description) ?? undefined);
  }
  if (eligible.length === 0) {
    bus.emit({ type: "tick_finished", queued: queue.length, eligible: 0, markedNeedsHuman: queue.length - eligible.length, processed: 0 });
    // Same background passes as the other two return paths — a board holding
    // only epics/ineligible tickets must not pause steward/groundskeeper forever.
    await runBackgroundPasses();
    return false;
  }

  // Rolling WIP semaphore (owner request): claim whenever capacity exists —
  // never barrier a fast issue behind a slow sibling's completion. Gap 1 layers
  // DAG scheduling on top: a candidate is claimed only when its declared
  // dependencies are all completed (topological frontier) and its `touches`
  // globs don't collide with an in-flight or already-admitted sibling (file
  // mutex). A child that declares neither behaves exactly as before.
  // Draining → zero capacity: selectRunnable defers every candidate, so the
  // batch below is empty and nothing new gets claimed (B6/T5, control.ts).
  const capacity = isDraining() ? 0 : config.caps.wipLimit - inFlight.size;
  const candidates = eligible
    .filter((i) => !inFlight.has(i.identifier))
    .map((issue) => {
      const meta = parseFactoryMeta(issue.description);
      const schedulable: Schedulable = { identifier: issue.identifier, dependsOn: meta.depends_on ?? [], touches: meta.touches ?? [] };
      return { issue, schedulable };
    });
  // Implicit depends_on (issue #6 Part 2, dag.ts): when the decomposer gave
  // two queued siblings overlapping `touches` but omitted the edge between
  // them, derive the ordering (later ticket waits for the earlier one) instead
  // of relying on the file mutex alone, which serializes without ordering.
  // Explicit depends_on entries are never removed; children declaring no
  // touches (or no overlap) pass through untouched — today's behavior. Each
  // derived edge is logged loudly so the ordering is auditable, and the
  // decomposer's omission is visible rather than silently papered over.
  const { augmented, added } = deriveImplicitDeps(candidates.map((c) => c.schedulable));
  for (const a of added) {
    console.log(`[dag] implicit depends_on: ${a.identifier} now waits for ${a.dependsOn} (touches overlap: ${a.overlap}) — decomposer omitted the edge; explicit depends_on untouched`);
  }
  // One dependency-state query per tick, and only when some candidate declares
  // (or was derived) deps — negligible rate-limit impact. It re-validates the
  // frontier against LIVE Linear state each tick (the freshness pattern), so a
  // dep merged/closed out-of-band immediately unblocks its dependents. A
  // LinearRateLimited here propagates up to tick()'s existing backoff, like
  // every other query.
  const depIds = [...new Set(augmented.flatMap((c) => c.dependsOn))];
  const depTypes = depIds.length > 0 ? await fetchStatesByIdentifiers(depIds) : new Map<string, string>();
  const busyTouches = [...inFlight.values()];
  const { run } = selectRunnable(augmented, (id) => depTypes.get(id), busyTouches, capacity);
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
  // B7: this busy path used to omit postMergeTick while both the empty-queue
  // and eligible-empty return paths ran it — folded into runBackgroundPasses
  // so all three paths (and the #3 pacing between its calls) stay identical.
  await runBackgroundPasses();
  return batch.length > 0 || inFlight.size > 0;
}

/** First-boot register seeding (fix-list ④, 2026-08-02). Imports the checked-
 *  in agents/ + skills/ card files into the registers IFF both registers are
 *  completely empty — the daemon process doing the import is what makes the
 *  in-memory snapshot correct immediately (every write path refreshes it), so
 *  the very first stage pins `name@1` instead of the `@0` file fallback.
 *  Never overwrites: any existing row means an operator (or a previous boot)
 *  already owns the register state. Failure is non-fatal by design — the file
 *  fallback keeps every stage runnable, so a seeding error must not stop the
 *  daemon; it is logged and the pins stay honest (@0). */
async function seedRegistersIfEmpty(): Promise<void> {
  try {
    const [agents, skills] = await Promise.all([listAgentRegisterRows(), listSkillRegisterRows()]);
    if (agents.length > 0 || skills.length > 0) return;
    const report = await importRegistersFromFiles({ createdBy: "daemon-boot" });
    const saved = (rs: Array<{ ok: boolean }>) => rs.filter((r) => r.ok).length;
    const failed = [...report.agents, ...report.skills].filter((r) => !r.ok);
    console.log(`[registers] first boot: seeded ${saved(report.agents)} agent card(s), ${saved(report.skills)} skill(s) from files`);
    for (const f of failed) console.error(`[registers] seed skipped ${f.name}: ${(f as { error?: string }).error ?? "?"}`);
  } catch (error) {
    console.error(`[registers] boot seeding failed (file fallback stays in effect): ${error instanceof Error ? error.message : error}`);
  }
}

/** Sync the model catalog from the proxy's /v1/models into Postgres — the
 *  dashboard's per-project model PICK LIST (project-config.ts), refreshed every
 *  boot. Best-effort and non-fatal: an unreachable proxy keeps the previous
 *  catalog (syncModelCatalog no-ops on an empty list), and routing never
 *  depends on this — the env roster stays the authority for defaults. */
async function syncModelCatalogFromProxy(): Promise<void> {
  if (!config.proxyAuthToken) return;
  try {
    const res = await fetch(`${config.proxyBaseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${config.proxyAuthToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GET /v1/models -> HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    await syncModelCatalog(models);
    console.log(`[models] catalog synced: ${models.length} model(s) from the proxy`);
  } catch (error) {
    console.error(`[models] catalog sync failed (previous catalog stays): ${error instanceof Error ? error.message : error}`);
  }
}

async function main(): Promise<void> {
  if (config.serverOnly) {
    // Dashboard-only mode: serve mission control, never touch Linear. No
    // daemon_started emit — the pipeline daemon genuinely is not running, and
    // /state honestly reports daemon: null. No lease either: a viewer must not
    // block (or unlock) a real daemon — the port collision is the real guard,
    // and server.ts exits non-zero on a failed bind in this mode.
    const dashboard = await startDashboard();
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
  await startEventStore();
  // Seed the agent/skill registers from the checked-in card files when they
  // are EMPTY (first boot on a fresh store) — otherwise every stage of the
  // first runs pins `@0` (file fallback) and a dashboard rollback has nothing
  // to roll to. Live-found 2026-08-02: seeding via an external importer
  // process left THIS process's snapshot stale, so pins stayed @0 until a
  // register write happened to pass through the daemon. Non-empty registers
  // are left alone: the register, not the files, is authoritative after that
  // (deliberate edits must not be silently overwritten at boot), and the
  // importer stays reachable for an operator refresh via register-io.ts.
  await seedRegistersIfEmpty();
  await syncModelCatalogFromProxy();
  // Self-heal orphaned claims from a prior process (restart mid-run) before we
  // start ticking, so in-flight tickets resume instead of stranding In-Progress.
  const recovered = await recoverOrphanedClaims().catch(() => [] as string[]);
  if (recovered.length > 0) console.log(`[recover] reset ${recovered.length} orphaned claim(s) from a prior run: ${recovered.join(", ")}`);
  // #3: give Linear a beat between orphan recovery and the first tick's own
  // burst (queue fetch + steward/reconcile/groundskeeper/postmerge) — see
  // pace() above.
  await pace();
  const dashboard = await startDashboard();
  // Prerequisite-0 (B6 kill switch / T5 spend cap + alerting, docs/planning/
  // autonomy.md "Build order" item 0): wire both bus subscribers before the
  // tick loop starts so the very first stage's spend and the very first
  // needs-human/park/deploy-revert are covered, not just ones after warm-up.
  startAlerts();
  startSpendCap();

  console.log(`factory watching teams [${config.teamKeys.join(", ")}] · workRoot ${config.workRoot} · ${config.dryRun ? "DRY-RUN" : "live"}`);
  bus.emit({ type: "daemon_started", mode: config.dryRun ? "dry" : config.oneShot ? "once" : "watch",
    teamKeys: config.teamKeys, workRoot: config.workRoot,
    wipLimit: config.caps.wipLimit, watchIntervalSeconds: config.watchIntervalSeconds,
    budgetUsdPerIssue: config.caps.budgetUsdPerIssue });

  process.on("SIGINT", () => { draining = true; console.log("draining — will exit after current tick"); });
  process.on("SIGTERM", () => { draining = true; });
  // Config/code reload without operator choreography (fix-list #5: every cap
  // or roster change used to need kill + wait-for-drain + manual restart,
  // observed twice live 2026-08-02). SIGHUP drains exactly like SIGTERM, then
  // the exit path below execs a fresh daemon that re-reads .env and the code
  // on disk. In-flight work is never cut — this is drain-then-exec, not a
  // hot reload.
  process.on("SIGHUP", () => { restartAfterDrain = true; draining = true; console.log("SIGHUP — draining, then self-restarting on current code/.env"); });

  // #2: a single transient 503/429 used to park EVERY tick for a flat 300s —
  // freezing all claiming for five minutes over one blip. This grows from a
  // small base and resets to it on the next successful tick, so one blip
  // costs seconds; only a SUSTAINED outage climbs toward the (much lower) cap.
  const linearBackoff = new LinearBackoff();

  do {
    let backoffSeconds = 0;
    let busy = false;
    try {
      busy = await tick();
      linearBackoff.reset();
    } catch (error) {
      if (error instanceof LinearRateLimited) {
        backoffSeconds = Math.round(linearBackoff.next()); // whole seconds for the dashboard/log
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
    // Write-behind event queue (db.ts): drain at the tick boundary so steady-
    // state queue depth is bounded by ONE tick's emissions, not by uptime.
    await flushEvents();
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
  // Last flush AFTER the final emit — the daemon_stopped row must reach the
  // durable log before the process exits.
  await flushEvents();
  await dashboard?.close();
  rmSync(LEASE, { force: true });
  if (restartAfterDrain) {
    // Lease already released above, so the child acquires it cleanly. stdio
    // inherit keeps the operator's existing log redirection; detached+unref
    // lets THIS process exit without reaping the child.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [fileURLToPath(new URL("index.ts", import.meta.url)), ...process.argv.slice(2)],
      { detached: true, stdio: "inherit" });
    child.unref();
    console.log(`[restart] fresh daemon spawned (pid ${child.pid}) — this process exits now`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
