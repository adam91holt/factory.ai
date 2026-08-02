import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import * as linear from "./linear.ts";
import { ensureWorkspace, repoFromTicket } from "./repos.ts";
import { runStage, untrusted, redactSecrets, type StageResult } from "./agents.ts";
import { withFactoryMeta } from "./meta.ts";
import { renderPrompt, cardPin, listRoutableCards } from "./catalog.ts";
import type { StagePin } from "./skills.ts";
import { roleTools } from "./routing.ts";
import { postStageComment, markNeedsHuman } from "./loop.ts";
import { bus, toStageMeta, type AgentStreamEvent } from "./events.ts";

// INTAKE authoring (Gap 5, the "garbage-in defense"). A rough-idea ticket
// (type:idea / Factory-Intake) does not go straight to the planner — an author
// stage turns it into a FULL epic contract, interviewing the human ONLY on
// genuine ambiguity, then upgrades the ticket to type:epic in place so the
// existing planner takes over. Interviewing (not guessing) is the whole point:
// an autonomous system's dominant failure is a confidently-built wrong thing.
//
// Two outcomes per run:
//   - AUTHORED: the author wrote a complete contract → rewrite the description
//     with a start-anchored type:epic block and requeue (planner picks it up).
//   - AWAITING: the author had genuine questions → post them as a comment, label
//     Factory-Awaiting-Answer (skipped from the queue so it does not re-loop),
//     and wait. A human answers + removes the label to requeue; the re-run reads
//     the answer comments.

/** Pure parse of the intake author's "QUESTIONS:" output protocol. Returns the
 * list of questions (bullet / numbered lines after the marker), or [] when the
 * author asked nothing (no marker, or "QUESTIONS: none"). Unit-testable — the
 * awaiting-vs-upgrade branch turns on this alone. */
export function extractQuestions(authorText: string): string[] {
  const markerIdx = authorText.search(/QUESTIONS:/i);
  if (markerIdx < 0) return [];
  // Everything after the first "QUESTIONS:" marker (including any text on the
  // same line, which is typically empty or "none").
  const afterColon = authorText.slice(markerIdx).replace(/^[\s\S]*?QUESTIONS:/i, "");
  const out: string[] = [];
  for (const raw of afterColon.split("\n")) {
    const t = raw.trim();
    if (t === "") { if (out.length > 0) break; continue; } // a blank line ends the block once it started
    const li = t.match(/^(?:[-*]|\d+[.)])\s+(.*\S)\s*$/); // "- q", "* q", "1. q", "2) q"
    if (li && li[1]) { out.push(li[1].trim()); continue; }
    if (out.length === 0) {
      // Non-list content before any bullet: "none"/"n/a" means no questions.
      if (/^(none|n\/a|no questions?)\.?$/i.test(t)) return [];
      break; // any other non-list line before a bullet → treat as no parseable questions
    }
    break; // a non-list line after bullets ends the block
  }
  return out.slice(0, 20);
}

/** Read the contract the intake author wrote to scratch/contract.md: first line
 * "# Title", the rest is the description. Returns null when the file is absent or
 * too thin to be a real contract. Never throws. */
export function extractContract(scratchDir: string): { title: string; description: string } | null {
  let body: string;
  try { body = readFileSync(join(scratchDir, "contract.md"), "utf8").trim(); } catch { return null; }
  const lines = body.split("\n");
  const title = (lines[0] ?? "").replace(/^#\s*/, "").trim();
  const description = lines.slice(1).join("\n").trim();
  if (!title || description.length < 50) return null;
  return { title, description };
}

/** Stamp a contract as a full epic: prepend a START-ANCHORED factory block with
 * type:epic (and repo when known) so the next tick routes it to the planner, and
 * strip any block the author embedded from untrusted repo/web content. Pure and
 * unit-testable — the exact upgrade the AUTHORED path applies. */
export function buildEpicUpgrade(contract: { title: string; description: string }, repo: string | null): { title: string; description: string } {
  const stamped = withFactoryMeta(contract.description, { type: "epic", ...(repo ? { repo } : {}) });
  return { title: contract.title, description: stamped };
}

export type IntakeDecision =
  | { action: "await"; questions: string[] }
  | { action: "upgrade"; contract: { title: string; description: string } }
  | { action: "needs_human"; reason: string };

/** Pure branch logic: questions win (genuine ambiguity → interview) over any
 * partial contract; otherwise a complete contract upgrades; neither is a
 * malformed run that needs a human. */
export function decideIntake(authorText: string, contract: { title: string; description: string } | null): IntakeDecision {
  const questions = extractQuestions(authorText);
  if (questions.length > 0) return { action: "await", questions };
  if (contract) return { action: "upgrade", contract };
  return { action: "needs_human", reason: "intake author produced neither clarifying questions nor a complete contract file" };
}

// `pins` (issue #16 WP2): stage label → version pins so run_stage_started
// records the card version. intake-scout runs a raw inline prompt (no card) so
// it carries no pin; no skills outside the pipeline's repo-facts context.
function forwardStage(issueKey: string, pins?: ReadonlyMap<string, StagePin>): (e: AgentStreamEvent) => void {
  return (e) => {
    if (e.kind === "stage_started") {
      const pin = pins?.get(e.stage);
      bus.emit({ type: "run_stage_started", issueKey, stage: e.stage, model: e.model, viaProxy: e.viaProxy,
        ...(pin ? { card: pin.card, skills: pin.skills } : {}) });
    }
    else if (e.kind === "tool_use") bus.emit({ type: "run_tool_use", issueKey, stage: e.stage, tool: e.tool, detail: e.detail });
    else if (e.kind === "assistant_text") bus.emit({ type: "run_assistant_text", issueKey, stage: e.stage, text: e.text });
    else bus.emit({ type: "run_stage_finished", issueKey, stage: e.stage, costUsd: e.costUsd, turns: e.turns, wallSeconds: e.wallSeconds, resultText: e.resultText, ...(e.error ? { error: e.error } : {}), ...(e.modelUsage ? { modelUsage: e.modelUsage } : {}) });
  };
}

/** Turn a rough-idea ticket into a full epic contract (or interview the human).
 * Modeled on planIssue: emits run lifecycle, runs a scout (read-only) then the
 * intake author, and resolves to exactly ONE terminal event per tick. Does NOT
 * claim the ticket (like the planner) — it upgrades in place and the planner
 * takes over next tick. */
export async function runIntake(issue: linear.Issue): Promise<void> {
  const repo = repoFromTicket(issue.description); // may be null — the contract may name it
  bus.emit({ type: "run_started", issueKey: issue.identifier, title: `[intake] ${issue.title}`, repo: repo ?? "", dryRun: config.dryRun });
  const deadline = Date.now() + config.caps.wallMinutesPerIssue * 60_000;
  const onEvent = forwardStage(issue.identifier, new Map<string, StagePin>([
    ["intake-author", { card: cardPin("intake-author"), skills: [] }],
  ]));
  const stages: StageResult[] = [];

  const finish = (outcome: "authored" | "awaiting_answer" | "parked" | "needs_human", reason: string): void => {
    bus.emit({ type: "run_finished", issueKey: issue.identifier, outcome, reason: redactSecrets(reason).clean.slice(0, 300), prUrl: null,
      costUsd: stages.reduce((s, x) => s + x.costUsd, 0), stages: stages.map(toStageMeta),
      gateStrength: "none", guardedPaths: [], dryRun: config.dryRun });
  };

  try {
    // Prior human answers (on a re-run after Factory-Awaiting-Answer was cleared)
    // are read from the ticket's own comments — UNTRUSTED, delimited before the model.
    const priorComments = await linear.fetchComments(issue.id).catch(() => [] as string[]);
    const answers = priorComments.filter((c) => !c.includes(linear.SENTINEL) && !c.startsWith("🤖")).slice(-10);

    // ---- scout: research context for the contract. Read-only; repo worktree
    // when the idea already names one, else a scratch dir with web tools only.
    const scratch = join(config.workRoot, ".intake-scratch", issue.identifier);
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    let scoutCwd = scratch;
    if (repo) {
      try { scoutCwd = (await ensureWorkspace(repo, `${issue.identifier}-intake`)).dir; }
      catch { scoutCwd = scratch; } // repo unreachable → web-only scout, don't park the idea
    }
    const spec = untrusted(`# ${issue.title}\n\n${issue.description}`);
    const scout = await runStage("intake-scout",
      `You are the research scout for a software factory's INTAKE stage. A human filed a rough idea (below). Research what it would take to specify it as a buildable epic: if a repo is in the current directory, read its stack/conventions; use WebSearch/WebFetch for external context. Return a dense brief: what exists, what is ambiguous, and what a complete contract needs.\n\n${spec}`,
      { model: config.models.scout, cwd: scoutCwd, allowedTools: roleTools("scout", listRoutableCards()).tools, maxTurns: config.caps.turnsImplementer, budgetUsd: config.caps.budgetUsdPerIssue, deadlineMs: deadline, onEvent });
    stages.push(scout);
    await postStageComment(issue, scout);

    // ---- intake author: writes contract.md OR emits QUESTIONS on real ambiguity.
    const answersBlock = answers.length ? `\n\nEARLIER COMMENTS / HUMAN ANSWERS (may answer your prior questions):\n${untrusted(answers.join("\n---\n"))}` : "";
    const author = await runStage("intake-author",
      renderPrompt("intake-author", { spec, brief: untrusted(`SCOUT BRIEF:\n${scout.text}`), answers: answersBlock },
        [
          "You are the intake author in a software factory. Turn the rough idea below into a COMPLETE epic contract, OR — only on GENUINE ambiguity that would change what gets built — ask the human.",
          "DECIDE HONESTLY: ask ONLY when a reasonable engineer could build materially different things from the idea. Document any assumption you CAN reasonably make (state it in the contract) rather than asking. Over-asking defeats autonomy; guessing on a real fork produces the wrong product.",
          `OUTPUT PROTOCOL — exactly one of:`,
          `  (A) If you can proceed: write ${join(scratch, "contract.md")} — first line "# <title>", then the FULL contract: ## Goal, ## Why, ## Outcomes (checkbox list), ## Repo (org/name), ## Verifications (Automated/Manual/Visual), and any documented assumptions under ## Assumptions. Then reply "READY".`,
          `  (B) If genuinely blocked: reply with a line "QUESTIONS:" followed by a bullet list of the specific questions (each "- <question>"). Do NOT write a contract file when you have real questions.`,
          "", spec, "", untrusted(`SCOUT BRIEF:\n${scout.text}`), answersBlock,
        ].join("\n")),
      { model: config.models.planner, cwd: scratch, allowedTools: roleTools("intake-author", listRoutableCards()).tools, maxTurns: 16, budgetUsd: config.caps.budgetUsdPerIssue, deadlineMs: deadline, onEvent });
    stages.push(author);
    await postStageComment(issue, author);
    if (author.error) { await markNeedsHuman(issue, `intake author failed: ${author.error}`, repo ?? undefined); finish("needs_human", `author error: ${author.error}`); return; }

    const contract = extractContract(scratch);
    const decision = decideIntake(author.text, contract);

    if (config.dryRun) {
      console.log(`[${issue.identifier}] dry-run intake: would ${decision.action}`);
      finish(decision.action === "await" ? "awaiting_answer" : decision.action === "upgrade" ? "authored" : "needs_human", `dry-run: ${decision.action}`);
      return;
    }

    if (decision.action === "await") {
      const body = [
        linear.SENTINEL, "",
        "**Intake — questions before building.** I need these answered to write a complete contract. Reply with answers, then remove the",
        `\`${linear.AWAITING_ANSWER_LABEL}\` label to requeue:`, "",
        ...decision.questions.map((q, i) => `${i + 1}. ${redactSecrets(q).clean}`),
      ].join("\n");
      await linear.postComment(issue, body).catch((e) => console.error(`[${issue.identifier}] intake questions comment failed: ${e}`));
      await linear.addLabel(issue, linear.AWAITING_ANSWER_LABEL).catch((e) => console.error(`[${issue.identifier}] awaiting label failed: ${e}`));
      // WP3 board stage: intake asked a question and is waiting on the human —
      // paused and retryable, so it shows in the Blocked column. The
      // Factory-Awaiting-Answer label still owns queue exclusion, so answering
      // + removing the label remains a single reversible edit.
      await linear.transition(issue, "blocked").catch((e) => console.error(`[${issue.identifier}] blocked transition failed: ${e}`));
      finish("awaiting_answer", `asked ${decision.questions.length} question(s)`);
      console.log(`[${issue.identifier}] intake awaiting answers (${decision.questions.length} question(s))`);
      return;
    }

    if (decision.action === "needs_human") {
      await markNeedsHuman(issue, decision.reason, repo ?? undefined);
      finish("needs_human", decision.reason);
      return;
    }

    // ---- AUTHORED: upgrade the ticket to a full epic contract in place.
    const upgrade = buildEpicUpgrade(decision.contract, repo);
    const { clean: cleanDesc, found } = redactSecrets(upgrade.description);
    if (found > 0) console.error(`[${issue.identifier}] redacted ${found} secret-like string(s) from authored contract`);
    await linear.updateIssueDescription(issue, cleanDesc.slice(0, 40_000), upgrade.title.slice(0, 250));
    // Drop the intake marker so the ticket is no longer routed to intake; the
    // start-anchored type:epic block now routes it to the planner next tick.
    await linear.removeLabel(issue, linear.INTAKE_LABEL).catch(() => {});
    await linear.addLabel(issue, linear.EPIC_LABEL).catch(() => {});
    await linear.postComment(issue, `${linear.SENTINEL}\n\n**Intake complete** — authored a full epic contract; the planner will decompose it next.`).catch(() => {});
    finish("authored", "authored a full epic contract and requeued as an epic");
    console.log(`[${issue.identifier}] intake authored → epic`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markNeedsHuman(issue, `intake failed: ${reason}`, repo ?? undefined).catch(() => {});
    finish("needs_human", reason);
    console.error(`[${issue.identifier}] intake failed: ${reason}`);
  } finally {
    const scratch = join(config.workRoot, ".intake-scratch", issue.identifier);
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  }
}
