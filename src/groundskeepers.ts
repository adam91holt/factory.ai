import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { ensureWorkspace } from "./repos.ts";
import { isEligible } from "./loop.ts";
import { runStage, untrusted } from "./agents.ts";
import { stageSpendForIssueSince, parkedRunsSince, getTelemetry } from "./db.ts";
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
  return {
    name: stripQuotes(fields.name ?? fallbackName) || fallbackName,
    enabled: (fields.enabled ?? "").toLowerCase() === "true",
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
  for (const f of files.sort()) {
    try {
      const card = parseCard(readFileSync(join(GROUNDSKEEPERS_DIR, f), "utf8"), f.slice(0, -3));
      if (card && card.name && card.schedule && card.team) cards.push(card);
      else console.error(`[groundskeeper] ${f}: missing name/schedule/team — skipped`);
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
    if (p === "*") return true;
    const step = p.match(/^\*\/(\d+)$/);
    if (step) {
      const n = Number(step[1]);
      if (n > 0 && value % n === 0) return true;
      continue;
    }
    const n = Number(p);
    if (Number.isInteger(n) && n === value) return true;
  }
  return false;
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
// Last-run state. One minute-bucket per card, persisted under FACTORY_WORK_ROOT
// so a card can't run twice within the same cron minute — even across restarts
// (marked BEFORE the run, so a crash mid-run never re-fires the same window).
// ---------------------------------------------------------------------------

interface RunState { lastRunMinute: string; lastRunAt: number }

function minuteBucket(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readState(): Record<string, RunState> {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, RunState>) : {};
  } catch {
    return {};
  }
}

function writeState(state: Record<string, RunState>): void {
  try {
    mkdirSync(config.workRoot, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error(`[groundskeeper] state write failed: ${error instanceof Error ? error.message : error}`);
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

/**
 * Evaluate the registry once per daemon tick. Returns immediately at ZERO cost
 * when the global gate is off. At most ONE loop-master STAGE runs per tick
 * (cheap governance skips fall through to the next due card), mirroring
 * stewardTick's one-heavy-op-per-tick discipline.
 */
export async function groundskeeperTick(): Promise<void> {
  if (!config.groundskeepersEnabled) return; // global kill-switch — no Linear, no db, no spend
  const cards = loadGroundskeepers().filter((c) => c.enabled);
  if (cards.length === 0) return;

  const now = new Date();
  const minute = minuteBucket(now);
  const state = readState();

  for (const card of cards) {
    if (!cronMatches(card.schedule, now)) continue;
    if (state[card.name]?.lastRunMinute === minute) continue; // already handled this cron-minute
    // Mark BEFORE running so a crash mid-run cannot re-fire this window.
    state[card.name] = { lastRunMinute: minute, lastRunAt: Date.now() };
    writeState(state);
    const ran = await runGroundskeeper(card).catch((error) => {
      console.error(`[gk:${card.name}] ${error instanceof Error ? error.message : error}`);
      return false;
    });
    if (ran) return; // one heavy run per tick
  }
}

/** Returns true iff the loop-master stage actually ran (governance passed). */
async function runGroundskeeper(card: GroundskeeperCard): Promise<boolean> {
  const issueKey = `GK-${card.name}`;

  // (a) Weekly budget envelope — this card's own run_stage_finished spend.
  const spent = stageSpendForIssueSince(issueKey, Date.now() - WEEK_MS);
  if (spent >= card.budget.weekly) {
    console.log(`[gk:${card.name}] weekly budget exhausted ($${spent.toFixed(2)} of $${card.budget.weekly}) — sleeping`);
    return false;
  }

  // (b) Humans outrank — never generate while eligible human work waits.
  const queue = await linear.fetchTeamQueue(card.team);
  const humanWork = queue.filter((i) => isEligible(i));
  if (humanWork.length > 0) {
    console.log(`[gk:${card.name}] ${humanWork.length} unclaimed eligible ticket(s) in ${card.team} — humans outrank, skipping`);
    return false;
  }

  // (c) Attention cap — don't add to a full human review pile.
  const [needsHuman, parked, inReview] = await Promise.all([
    linear.fetchByLabel(linear.NEEDS_HUMAN_LABEL, [card.team]),
    linear.fetchByLabel(linear.PARKED_LABEL, [card.team]),
    linear.fetchTeamInReview(card.team),
  ]);
  const attention = new Set([...needsHuman, ...parked, ...inReview].map((i) => i.identifier));
  if (attention.size > 5) {
    console.log(`[gk:${card.name}] attention pile ${attention.size} > 5 — skipping`);
    return false;
  }

  // (d) Parks-spike — a struggling factory files repair tickets, not ambitions.
  const parkSpike = parkedRunsSince(Date.now() - DAY_MS) > 3;

  const repo = card.repos[0] ?? "";
  const outDir = join(config.workRoot, ".groundskeeper-scratch", card.name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "tickets"), { recursive: true });

  // cwd = a throwaway worktree of the first repo (read-only; never pushed). No
  // repo → the scratch dir, so a board/telemetry-only groundskeeper still runs.
  let cwd = outDir;
  if (repo) {
    try {
      cwd = (await ensureWorkspace(repo, `${card.name}-gk`)).dir;
    } catch (error) {
      console.error(`[gk:${card.name}] workspace for ${repo} failed, using scratch cwd: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Read tools ∩ card list, PLUS Write (output files only — no Bash ever).
  const allowedTools = [...new Set([...card.tools.filter((t) => READONLY_TOOLS.includes(t)), "Write"])];

  const tel = getTelemetry();
  const telSummary = [
    `Spend to date: $${tel.totals.costUsd.toFixed(2)} over ${tel.totals.runs} runs (${tel.totals.degradedRuns} degraded).`,
    `Outcomes: pr_open ${tel.outcomes.pr_open}, planned ${tel.outcomes.planned}, parked ${tel.outcomes.parked}, needs_human ${tel.outcomes.needs_human}, aborted ${tel.outcomes.aborted}.`,
    tel.parkReasons.length ? `Top park reasons: ${tel.parkReasons.map((p) => `"${p.reason}" (${p.count})`).join("; ")}.` : "No park reasons recorded.",
    `Last 7 days spend: ${tel.daily.map((d) => `${d.date} $${d.costUsd.toFixed(2)}`).join(", ")}.`,
    `Parks in last 24h: ${parkedRunsSince(Date.now() - DAY_MS)}. This card's 7-day spend: $${spent.toFixed(2)} of $${card.budget.weekly}.`,
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
    bus.emit({ type: "run_finished", issueKey, outcome, reason, prUrl: null,
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
      for (const f of ticketFiles.slice(0, card.maxTicketsPerRun)) {
        const body = readFileSync(join(ticketsDir, f), "utf8").trim();
        const lines = body.split("\n");
        const title = (lines[0] ?? "").replace(/^#\s*/, "").trim();
        const description = lines.slice(1).join("\n").trim();
        if (title && description.length > 50) created.push(await linear.createIssue(card.team, title, description));
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
