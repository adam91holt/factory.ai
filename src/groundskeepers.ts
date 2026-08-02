import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { ensureWorkspace, resetWorkspaceToBase } from "./repos.ts";
import { isEligible } from "./loop.ts";
import { runStage, untrusted, redactSecrets } from "./agents.ts";
import { withFactoryMeta } from "./meta.ts";
import { eventStoreOpen, stageSpendForIssueSince, stageRunCountForIssueSince, parkedRunsSince, getTelemetry } from "./db.ts";
import { bus, toStageMeta, type AgentStreamEvent } from "./events.ts";

// Groundskeepers — per-project loop MASTERS (roadmap "Groundskeeper spec v2").
// Each groundskeepers/<name>.md is a scheduled work GENERATOR: on its cron it
// reviews a project (repo + team board + factory telemetry) and files 0..N
// contract-conforming tickets into its team, or logs "nothing worth doing".
// It is read-only over the world (read tools + web only; Write is for its output
// files) and the daemon — not the model — creates the tickets.
//
// Governance is mechanical and non-negotiable (spec §"Non-negotiable"):
//   (a) own weekly budget envelope; over → sleep,
//   (b) human tickets outrank — no run while the team has unclaimed eligible work,
//   (c) attention cap — no run while the team's needs-human/parked/in-review
//       pile exceeds 5,
//   (d) parks-spike — >3 parks in 24h flips the run into repair-tickets-only.
//
// SHIPS DISABLED: per-card `enabled: false` AND the global GROUNDSKEEPERS_ENABLED
// env gate (config.groundskeepersEnabled). BOTH must be true to run.

const GROUNDSKEEPERS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "groundskeepers");
const STATE_FILE = join(config.workRoot, ".groundskeepers.json");
const READONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GroundskeeperCard {
  name: string;
  enabled: boolean;
  schedule: string;          // 5-field cron (see cronMatches)
  team: string;              // Linear team KEY it files into
  repos: string[];
  model: string;             // the loop master's own model
  agents: string[];          // cards it may consult (reference; not auto-wired yet)
  tools: string[];           // ∩ READONLY_TOOLS at run time
  budget: { perRun: number; weekly: number };  // USD-notional
  maxTicketsPerRun: number;
  charter: string;           // frontmatter body: goals, taste bar, anti-goals
}

// ---------------------------------------------------------------------------
// Card loading. Its own tolerant YAML-frontmatter reader (catalog.ts's parser
// is flat-string-only; groundskeeper cards carry lists and a nested budget).
// ---------------------------------------------------------------------------

function stripQuotes(s: string): string {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

function parseList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner.split(",").map((x) => stripQuotes(x)).filter((x) => x !== "");
}

/** Parse an inline flow map like `{ perRun: 3, weekly: 15 }` into numbers. */
function parseInlineObject(raw: string): Record<string, number> {
  const inner = raw.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: Record<string, number> = {};
  for (const pair of inner.split(",")) {
    const [k, v] = pair.split(":");
    if (k && v !== undefined) {
      const n = Number(stripQuotes(v));
      if (Number.isFinite(n)) out[stripQuotes(k)] = n;
    }
  }
  return out;
}

function parseCard(raw: string, fallbackName: string): GroundskeeperCard | null {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) return null;
  const fields: Record<string, string> = {};
  for (const line of (fm[1] ?? "").split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && m[1]) fields[m[1]] = (m[2] ?? "").trim();
  }
  const budgetRaw = parseInlineObject(fields.budget ?? "{}");
  const perRun = typeof budgetRaw.perRun === "number" && Number.isFinite(budgetRaw.perRun) ? budgetRaw.perRun : 3;
  const weekly = typeof budgetRaw.weekly === "number" && Number.isFinite(budgetRaw.weekly) ? budgetRaw.weekly : 15;
  const maxTickets = Number(fields.maxTicketsPerRun);
  // enabled: fail closed — ONLY a bare, unquoted `true` arms a card. But a
  // silent no-op on `yes`/`1`/`"true"` is the kill-list's "owner arms a card,
  // nothing happens, no log" — warn loudly on anything unrecognized.
  const enabledRaw = (fields.enabled ?? "").trim();
  if (enabledRaw !== "" && !["true", "false"].includes(enabledRaw.toLowerCase())) {
    console.error(`[groundskeeper] ${fallbackName}: unrecognized enabled value ${JSON.stringify(enabledRaw)} — treating as FALSE (only a bare \`true\` enables)`);
  }
  return {
    name: stripQuotes(fields.name ?? fallbackName) || fallbackName,
    enabled: enabledRaw.toLowerCase() === "true",
    schedule: stripQuotes(fields.schedule ?? ""),
    team: stripQuotes(fields.team ?? ""),
    repos: parseList(fields.repos ?? "[]"),
    model: stripQuotes(fields.model ?? config.models.steward),
    agents: parseList(fields.agents ?? "[]"),
    tools: parseList(fields.tools ?? "[]"),
    budget: { perRun, weekly },
    maxTicketsPerRun: Number.isInteger(maxTickets) && maxTickets > 0 ? maxTickets : 1,
    charter: (fm[2] ?? "").trim(),
  };
}

/**
 * Validate a single groundskeeper card's raw markdown the way loadGroundskeepers
 * validates each file — same parser, same name/schedule/team presence checks,
 * same NAME_RE, same validateCron — WITHOUT touching disk. The catalog manager
 * runs this before writing a GK card so an unschedulable or malformed card is
 * rejected loudly at save time instead of being silently skipped at next load.
 * `expectedName` is the save target's name; a card whose frontmatter `name`
 * disagrees is rejected (the write path is <dir>/<expectedName>.md).
 */
export function validateGroundskeeperContent(
  raw: string,
  expectedName: string,
): { ok: true; card: GroundskeeperCard } | { ok: false; error: string } {
  const card = parseCard(raw, expectedName);
  if (!card) return { ok: false, error: "no YAML frontmatter block (--- ... ---) found" };
  if (!card.name) return { ok: false, error: "frontmatter is missing name" };
  if (!card.schedule) return { ok: false, error: "frontmatter is missing schedule (cron)" };
  if (!card.team) return { ok: false, error: "frontmatter is missing team (Linear key)" };
  if (!NAME_RE.test(card.name)) return { ok: false, error: `invalid name ${JSON.stringify(card.name)} (must match ${NAME_RE})` };
  if (card.name !== expectedName) return { ok: false, error: `frontmatter name ${JSON.stringify(card.name)} must equal the file name ${JSON.stringify(expectedName)}` };
  const cronError = validateCron(card.schedule);
  if (cronError) return { ok: false, error: `bad schedule ${JSON.stringify(card.schedule)} — ${cronError}` };
  return { ok: true, card };
}

// card.name flows into rmSync(join(...), { recursive, force }), git branch
// names, the state key, and the GK-<name> budget envelope — a traversal like
// `name: ../..` would aim a recursive force-delete at $HOME. Charset-locked.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Load every groundskeepers/<name>.md. Malformed cards are skipped (logged),
 *  never fatal — a broken card must not take the daemon down. */
export function loadGroundskeepers(): GroundskeeperCard[] {
  let files: string[];
  try {
    files = readdirSync(GROUNDSKEEPERS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const cards: GroundskeeperCard[] = [];
  const seen = new Set<string>();
  for (const f of files.sort()) {
    try {
      const card = parseCard(readFileSync(join(GROUNDSKEEPERS_DIR, f), "utf8"), f.slice(0, -3));
      if (!card || !card.name || !card.schedule || !card.team) {
        console.error(`[groundskeeper] ${f}: missing name/schedule/team — skipped`);
        continue;
      }
      if (!NAME_RE.test(card.name)) {
        console.error(`[groundskeeper] ${f}: invalid name ${JSON.stringify(card.name)} (must match ${NAME_RE}) — skipped`);
        continue;
      }
      const cronError = validateCron(card.schedule);
      if (cronError) {
        console.error(`[groundskeeper] ${f}: bad schedule ${JSON.stringify(card.schedule)} — ${cronError} — skipped`);
        continue;
      }
      if (seen.has(card.name)) {
        console.error(`[groundskeeper] ${f}: duplicate name "${card.name}" (state/budget keys would collide) — skipped`);
        continue;
      }
      seen.add(card.name);
      cards.push(card);
    } catch (error) {
      console.error(`[groundskeeper] failed to read ${f}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Minimal cron matcher. 5 fields: minute hour day-of-month month day-of-week.
// SUPPORTED per field: "*", "*/n" (step from 0), single integers, and
// comma-lists of those (e.g. "0,30", "1,15", "*/2"). Day-of-week is 0-6 (Sun=0).
// LIMITS (documented deliberately): no ranges ("1-5"), no names ("MON"), no
// "L"/"#"/"?" specials. day-of-month and day-of-week are ANDed (both must
// match) — not the cron OR-when-both-restricted convention; keep one of them "*"
// to avoid surprise. Evaluated in the daemon's LOCAL time.
// ---------------------------------------------------------------------------

function fieldMatches(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    const p = part.trim();
    // Empty list elements ("9,17," / ",") must NOT match: Number("") === 0, so
    // a trailing-comma typo would silently add midnight/Sunday firings.
    if (p === "") continue;
    if (p === "*") return true;
    const step = p.match(/^\*\/(\d+)$/);
    if (step) {
      const n = Number(step[1]);
      if (n > 0 && value % n === 0) return true;
      continue;
    }
    // Strict digits only — Number() would also accept "0x5", "1e1", "1.0".
    if (/^\d+$/.test(p) && Number(p) === value) return true;
  }
  return false;
}

const CRON_FIELD_RANGES: ReadonlyArray<readonly [name: string, lo: number, hi: number]> = [
  ["minute", 0, 59], ["hour", 0, 23], ["day-of-month", 1, 31], ["month", 1, 12], ["day-of-week", 0, 6],
];

/** Validate an expression against EXACTLY the grammar cronMatches implements.
 * Anything else (ranges, names, dow 7, 6 fields, out-of-range, empty list
 * elements) is rejected LOUDLY at card load — the alternative is an enabled
 * card that silently never fires. Returns an error string, or null when valid. */
export function validateCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `expected 5 fields, got ${fields.length}`;
  for (let i = 0; i < 5; i++) {
    const [name, lo, hi] = CRON_FIELD_RANGES[i]!;
    for (const part of fields[i]!.split(",")) {
      const p = part.trim();
      if (p === "") return `${name}: empty list element`;
      if (p === "*") continue;
      const step = p.match(/^\*\/(\d+)$/);
      if (step) {
        if (Number(step[1]) < 1) return `${name}: */0 is invalid`;
        continue;
      }
      if (!/^\d+$/.test(p)) return `${name}: unsupported token "${p}" (only *, */n, integers, comma-lists; no ranges/names)`;
      const n = Number(p);
      if (n < lo || n > hi) return `${name}: ${n} out of range ${lo}-${hi}`;
    }
  }
  return null;
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hr, dom, mon, dow] = fields as [string, string, string, string, string];
  return fieldMatches(min, date.getMinutes())
    && fieldMatches(hr, date.getHours())
    && fieldMatches(dom, date.getDate())
    && fieldMatches(mon, date.getMonth() + 1)
    && fieldMatches(dow, date.getDay());
}

// ---------------------------------------------------------------------------
// Last-run state. One minute-bucket per card plus the catch-up cursor,
// persisted under FACTORY_WORK_ROOT so a card can't run twice within the same
// cron minute — even across restarts (marked BEFORE the run, so a crash
// mid-run never re-fires the same window). Writes are atomic (tmp + rename);
// an existing-but-unreadable file fails CLOSED for the tick, never open.
// ---------------------------------------------------------------------------

interface RunState { lastRunMinute: string; lastRunAt: number }
interface GkState {
  /** Epoch ms of the last cron evaluation — the catch-up scan resumes here. */
  lastEvaluatedAt: number | null;
  cards: Record<string, RunState>;
}

function minuteBucket(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Missing file → fresh state. Existing-but-unreadable file → null, and the
 *  caller must SKIP the tick (a vanished dedupe history re-fires any matching
 *  window — fail-open on a spend guard). Tolerates the legacy flat-map shape. */
function readState(): GkState | null {
  let raw: string;
  try {
    raw = readFileSync(STATE_FILE, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { lastEvaluatedAt: null, cards: {} } : null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.cards === "object" && parsed.cards !== null) {
      return {
        lastEvaluatedAt: typeof parsed.lastEvaluatedAt === "number" ? parsed.lastEvaluatedAt : null,
        cards: parsed.cards as Record<string, RunState>,
      };
    }
    return { lastEvaluatedAt: null, cards: parsed as unknown as Record<string, RunState> }; // legacy flat map
  } catch {
    return null;
  }
}

function writeState(state: GkState): boolean {
  try {
    mkdirSync(config.workRoot, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE); // atomic on the same filesystem — no torn state file
    return true;
  } catch (error) {
    console.error(`[groundskeeper] state write failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tick + run.
// ---------------------------------------------------------------------------

function forwardStage(issueKey: string): (e: AgentStreamEvent) => void {
  return (e) => {
    if (e.kind === "stage_started") bus.emit({ type: "run_stage_started", issueKey, stage: e.stage, model: e.model, viaProxy: e.viaProxy });
    else if (e.kind === "tool_use") bus.emit({ type: "run_tool_use", issueKey, stage: e.stage, tool: e.tool, detail: e.detail });
    else if (e.kind === "assistant_text") bus.emit({ type: "run_assistant_text", issueKey, stage: e.stage, text: e.text });
    else bus.emit({ type: "run_stage_finished", issueKey, stage: e.stage, costUsd: e.costUsd, turns: e.turns, wallSeconds: e.wallSeconds, resultText: e.resultText, ...(e.error ? { error: e.error } : {}), ...(e.modelUsage ? { modelUsage: e.modelUsage } : {}) });
  };
}

const MINUTE_MS = 60_000;
let storeClosedWarned = false;

/**
 * Evaluate the registry once per daemon tick. Returns immediately at ZERO cost
 * when the global gate is off. At most ONE loop-master STAGE runs per tick
 * (cheap governance skips fall through to the next due card), mirroring
 * stewardTick's one-heavy-op-per-tick discipline.
 *
 * Scheduling is CATCH-UP based: a tick can straddle a scheduled minute (model
 * stages run for minutes; Linear backoff sleeps 300 s), so every minute since
 * the last evaluation (capped at 24 h) is tested — a straddled window fires
 * late instead of silently vanishing for a day/week. Multiple missed windows
 * collapse into ONE run (newest matching minute wins).
 */
export async function groundskeeperTick(): Promise<void> {
  if (!config.groundskeepersEnabled) return; // global kill-switch — no Linear, no db, no spend
  const cards = loadGroundskeepers().filter((c) => c.enabled);
  if (cards.length === 0) return;

  // Fail CLOSED when the durable event store is not open: the weekly budget
  // envelope and parks-spike gates read from it, and a closed store would read
  // "$0 spent, 0 parks" forever — the gates would silently vanish.
  if (!eventStoreOpen()) {
    if (!storeClosedWarned) {
      storeClosedWarned = true;
      console.error("[groundskeeper] event store closed (dashboard disabled?) — REFUSING to run: budget/parks gates unenforceable");
    }
    return;
  }

  const state = readState();
  if (state === null) {
    // Exists but unreadable: skip this tick (fail closed) and move the corrupt
    // file aside so the next tick starts from clean, loudly-logged state.
    console.error(`[groundskeeper] state file unreadable — skipping tick, moving it to ${STATE_FILE}.corrupt`);
    try { renameSync(STATE_FILE, `${STATE_FILE}.corrupt`); } catch { /* next tick skips again */ }
    return;
  }

  const nowMs = Date.now();
  // INCLUSIVE lower bound: the minute containing lastEvaluatedAt is re-tested so
  // a card that was due but not reached (an earlier card took the tick's one
  // run slot) fires next tick; lastRunMinute dedupe blocks genuine re-fires.
  // First armed tick (or a >24h gap, or a backwards clock step) scans only the
  // current minute — never a day of history, never re-fires on clock rewind.
  const scanFromMs = Math.min(nowMs, Math.max(state.lastEvaluatedAt ?? nowMs, nowMs - DAY_MS));
  const firstBucket = Math.floor(scanFromMs / MINUTE_MS);
  const lastBucket = Math.floor(nowMs / MINUTE_MS);
  state.lastEvaluatedAt = nowMs;

  let dirty = true; // cursor advanced — persist even when nothing fires
  for (const card of cards) {
    let due: Date | null = null;
    for (let b = lastBucket; b >= firstBucket; b--) {
      const d = new Date(b * MINUTE_MS);
      if (cronMatches(card.schedule, d)) { due = d; break; } // newest match wins
    }
    if (!due) continue;
    const bucket = minuteBucket(due);
    if (state.cards[card.name]?.lastRunMinute === bucket) continue; // already handled this cron-minute
    // Mark BEFORE running so a crash mid-run cannot re-fire this window; if the
    // mark cannot be persisted, do NOT run — an unrecorded run can double-fire.
    state.cards[card.name] = { lastRunMinute: bucket, lastRunAt: nowMs };
    if (!writeState(state)) {
      console.error(`[gk:${card.name}] cannot persist run state — refusing to run unrecorded`);
      return;
    }
    dirty = false;
    const ran = await runGroundskeeper(card).catch((error) => {
      console.error(`[gk:${card.name}] ${error instanceof Error ? error.message : error}`);
      return false;
    });
    if (ran) return; // one heavy run per tick
  }
  if (dirty) writeState(state);
}

/** Returns true iff the loop-master stage actually ran (governance passed). */
async function runGroundskeeper(card: GroundskeeperCard): Promise<boolean> {
  const issueKey = `GK-${card.name}`;

  // (a) Weekly budget envelope — this card's own run_stage_finished spend, AND
  // a pessimistic runs × perRun bound: aborted/crashed stages record costUsd 0
  // despite real API spend, so recorded dollars alone would under-count.
  const spent = await stageSpendForIssueSince(issueKey, Date.now() - WEEK_MS);
  const runCount = await stageRunCountForIssueSince(issueKey, Date.now() - WEEK_MS);
  if (spent >= card.budget.weekly || runCount * card.budget.perRun >= card.budget.weekly) {
    console.log(`[gk:${card.name}] weekly budget exhausted ($${spent.toFixed(2)} recorded, ${runCount} run(s) × $${card.budget.perRun} of $${card.budget.weekly}) — sleeping`);
    return false;
  }

  // (b) Humans outrank — never generate while eligible human work waits.
  const queue = await linear.fetchTeamQueue(card.team);
  const humanWork = queue.filter((i) => isEligible(i));
  if (humanWork.length > 0) {
    console.log(`[gk:${card.name}] ${humanWork.length} unclaimed eligible ticket(s) in ${card.team} — humans outrank, skipping`);
    return false;
  }

  // (c) Attention cap — don't add to a full human review pile. Labels survive
  // on completed/cancelled issues, so filter to OPEN issues or six stale labels
  // would sleep the card forever. NOTE: the in-review leg counts started-type
  // states NAMED like "review" (fetchTeamInReview) — a team whose review column
  // has another name contributes 0 to this leg by design.
  const [needsHumanAll, parkedAll, inReview] = await Promise.all([
    linear.fetchByLabel(linear.NEEDS_HUMAN_LABEL, [card.team]),
    linear.fetchByLabel(linear.PARKED_LABEL, [card.team]),
    linear.fetchTeamInReview(card.team),
  ]);
  const open = (i: linear.Issue): boolean => i.stateType !== "completed" && i.stateType !== "canceled";
  const needsHuman = needsHumanAll.filter(open);
  const parked = parkedAll.filter(open);
  const attention = new Set([...needsHuman, ...parked, ...inReview].map((i) => i.identifier));
  if (attention.size > 5) {
    console.log(`[gk:${card.name}] attention pile ${attention.size} > 5 — skipping`);
    return false;
  }

  // (d) Parks-spike — a struggling factory files repair tickets, not ambitions.
  const parksLast24h = await parkedRunsSince(Date.now() - DAY_MS);
  const parkSpike = parksLast24h > 3;

  const repo = card.repos[0] ?? "";
  const outDir = join(config.workRoot, ".groundskeeper-scratch", card.name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "tickets"), { recursive: true });

  // cwd = a throwaway worktree of the first repo (read-only; never pushed),
  // hard-reset to origin's CURRENT head each run — a reused worktree must not
  // review the frozen snapshot it was created from. Workspace failure SKIPS the
  // run: reviewing an empty scratch dir would file tickets grounded in nothing.
  // No repo configured → the scratch dir, so a board/telemetry-only
  // groundskeeper still runs.
  let cwd = outDir;
  if (repo) {
    try {
      const ws = await ensureWorkspace(repo, `${card.name}-gk`);
      resetWorkspaceToBase(ws);
      cwd = ws.dir;
    } catch (error) {
      console.error(`[gk:${card.name}] workspace for ${repo} failed — skipping run: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  // Read tools ∩ card list, PLUS Write SCOPED to the scratch dir (`//` = absolute
  // path in permission-rule syntax). A bare "Write" under dontAsk would let a
  // prompt-injected run rewrite groundskeepers/*.md (self-arming), the state
  // file, or factory src — output files only, no Bash ever.
  const allowedTools = [...new Set([...card.tools.filter((t) => READONLY_TOOLS.includes(t)), `Write(/${outDir}/**)`])];

  const tel = await getTelemetry();
  const telSummary = [
    `Spend to date: $${tel.totals.costUsd.toFixed(2)} over ${tel.totals.runs} runs (${tel.totals.degradedRuns} degraded).`,
    `Outcomes: pr_open ${tel.outcomes.pr_open}, planned ${tel.outcomes.planned}, parked ${tel.outcomes.parked}, needs_human ${tel.outcomes.needs_human}, aborted ${tel.outcomes.aborted}.`,
    tel.parkReasons.length ? `Top park reasons: ${tel.parkReasons.map((p) => `"${p.reason}" (${p.count})`).join("; ")}.` : "No park reasons recorded.",
    `Last 7 days spend: ${tel.daily.map((d) => `${d.date} $${d.costUsd.toFixed(2)}`).join(", ")}.`,
    `Parks in last 24h: ${parksLast24h}. This card's 7-day spend: $${spent.toFixed(2)} of $${card.budget.weekly}.`,
  ].join("\n");
  const boardSummary = [
    `Team ${card.team}: ${queue.length} unstarted ticket(s) (0 eligible+unclaimed, else this run would not happen), ${inReview.length} in review, ${parked.length} parked, ${needsHuman.length} needs-human.`,
    queue.length ? `Unstarted titles: ${queue.slice(0, 15).map((i) => `${i.identifier} ${i.title}`).join(" | ")}` : "Board is clear.",
  ].join("\n");

  const directive = parkSpike
    ? "\n\nDIRECTIVE (parks-spike active): more than 3 tickets parked in the last 24h — the factory is struggling. THIS RUN you may file ONLY factory-repair tickets that target recurring park reasons or factory reliability. Do NOT file feature, content, or polish tickets.\n"
    : "";

  const ticketsDir = join(outDir, "tickets");
  const prompt = [
    card.charter,
    directive,
    "",
    "=== FACTORY TELEMETRY (recent, from the durable event log) ===",
    untrusted(telSummary),
    "",
    "=== TEAM BOARD ===",
    untrusted(boardSummary),
    "",
    "You are a groundskeeper: a scheduled work generator for THIS project. Review the repository in your working directory, the team board, and the telemetry above, then DECIDE what (if anything) is worth building. You have read-only tools only; you cannot change the repo or the board. The daemon files whatever tickets you write.",
    "",
    "OUTPUT PROTOCOL — write files under this absolute directory (it already exists):",
    `- To file work: ${ticketsDir}/<NN>-<slug>.md (NN = 01, 02, ...), at MOST ${card.maxTicketsPerRun} file(s). First line: "# <title>". The rest MUST follow the factory ticket contract exactly: ## Goal, ## Why, ## Outcomes (checkbox list), ## Repo (${repo || "the project repo"}), ## Verifications (Automated / Manual / Visual), ## Area (the file paths this ticket owns).`,
    `- If nothing clears the bar: write ${join(outDir, "decision.md")} explaining what you reviewed and WHY nothing is worth doing. "Nothing worth doing" is a first-class, respected outcome — never invent low-value work to fill the quota.`,
    "Then reply with one line summarising your decision.",
  ].join("\n");

  const deadline = Date.now() + config.caps.wallMinutesPerIssue * 60_000;
  bus.emit({ type: "run_started", issueKey, title: `[groundskeeper] ${card.name}`, repo, dryRun: config.dryRun });

  const stage = await runStage("groundskeeper", prompt, {
    model: card.model, cwd, allowedTools, maxTurns: config.caps.turnsImplementer,
    budgetUsd: card.budget.perRun, deadlineMs: deadline, onEvent: forwardStage(issueKey),
  });

  const finish = (outcome: "planned" | "parked", reason: string): void => {
    // reason carries model-written decision text or error strings that can
    // interpolate Linear HTTP bodies — redact at the emit seam like every other
    // emitted string (§2.2).
    bus.emit({ type: "run_finished", issueKey, outcome, reason: redactSecrets(reason).clean.slice(0, 300), prUrl: null,
      costUsd: stage.costUsd, stages: [toStageMeta(stage)], gateStrength: "none", guardedPaths: [], dryRun: config.dryRun });
  };

  try {
    if (stage.error) throw new Error(stage.error);
    const ticketFiles = existsSync(ticketsDir)
      ? readdirSync(ticketsDir).filter((f) => f.endsWith(".md")).sort()
      : [];
    let decision = "";
    try { decision = readFileSync(join(outDir, "decision.md"), "utf8").trim(); } catch { /* optional */ }

    if (ticketFiles.length === 0) {
      console.log(`[gk:${card.name}] nothing worth doing${decision ? `: ${decision.slice(0, 160)}` : ""}`);
      finish("planned", `nothing worth doing${decision ? `: ${decision.slice(0, 140)}` : ""}`);
      return true;
    }

    const created: string[] = [];
    if (config.dryRun) {
      console.log(`[gk:${card.name}] dry-run: would file ${Math.min(ticketFiles.length, card.maxTicketsPerRun)} ticket(s)`);
    } else {
      // Humans-outrank is re-checked at FILE time, not only at run start — the
      // stage can hold the token for up to 45 min, and a human ticket that
      // arrived meanwhile must not queue behind machine-generated work.
      const freshHuman = (await linear.fetchTeamQueue(card.team)).filter((i) => isEligible(i));
      if (freshHuman.length > 0) {
        const held = `held ${Math.min(ticketFiles.length, card.maxTicketsPerRun)} drafted ticket(s) — ${freshHuman.length} human ticket(s) arrived mid-run`;
        console.log(`[gk:${card.name}] ${held}`);
        finish("planned", held);
        return true;
      }
      for (const f of ticketFiles.slice(0, card.maxTicketsPerRun)) {
        const body = readFileSync(join(ticketsDir, f), "utf8").trim();
        const lines = body.split("\n");
        // Ticket files are MODEL-WRITTEN after reading untrusted repo/web
        // content — redact like every other outbound surface (loop.ts post()),
        // and cap lengths so a runaway file can't flood Linear.
        const titleR = redactSecrets((lines[0] ?? "").replace(/^#\s*/, "").trim());
        const descR = redactSecrets(lines.slice(1).join("\n").trim());
        if (titleR.found + descR.found > 0) {
          console.error(`[gk:${card.name}] redacted ${titleR.found + descR.found} secret-like string(s) from drafted ticket ${f}`);
        }
        const title = titleR.clean.slice(0, 250);
        const description = descR.clean.slice(0, 10_000);
        // Stamp with a TRUSTED block at offset 0 (and strip any block the model
        // embedded from untrusted repo/web content) so an injected repo/type/
        // model in the drafted body can never be honored downstream.
        if (title && description.length > 50) {
          const stamped = withFactoryMeta(description, { type: "task", ...(repo ? { repo } : {}) });
          created.push(await linear.createIssue(card.team, title, stamped));
        }
      }
    }
    const reason = config.dryRun
      ? `dry-run: ${Math.min(ticketFiles.length, card.maxTicketsPerRun)} ticket(s) drafted`
      : `filed ${created.length} ticket(s)${created.length ? `: ${created.join(", ")}` : ""}`;
    console.log(`[gk:${card.name}] ${reason}`);
    finish("planned", reason);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[gk:${card.name}] failed: ${reason}`);
    finish("parked", reason.slice(0, 200));
    return true; // it DID run a stage (spent budget); the outcome is just parked
  }
}
