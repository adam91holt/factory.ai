import { config } from "./config.ts";
import { runStage, untrusted, redactSecrets } from "./agents.ts";
import { eventStoreOpen, insertLessonRow, activeLessonRowsForRepo, allLessonRows, archiveLessonRow, lessonRowCountSince, type LessonRow } from "./db.ts";

// Lessons store + distillation (level-4-roadmap.md, principle 7: "Every human
// intervention ends in a remediation... or it recurs"). Every failure the loop
// records — park, needs-human, taste-fail — is distilled AT THE MOMENT IT
// HAPPENS into a one-line "when X, do Y" lesson and stored durably in
// factory.db, so the next run on the same repo doesn't start naive.
//
// This module owns ALL lesson SQL access (via the db.ts row helpers on the
// shared handle — never a second writer against a running daemon) and the full
// API surface other children consume:
//   - captureLesson()  — best-effort distill-and-store, called by loop.ts hooks
//   - recordLesson()   — the raw write path (redact + cap at write time)
//   - lessonsForRepo() — capped read for prompt injection (child 02)
//   - listLessons() / archiveLesson() — human visibility + archive (child 04)
//
// Trust model: lessons are distilled FROM untrusted failure text and remain
// untrusted data. The distiller is tool-less and sees only redacted event text
// wrapped in an untrusted() frame; stored lessons pass redactSecrets and a hard
// length cap at write time. Nothing here frames a lesson as authoritative
// prompt content — that presentation problem belongs to child 02.

// ---------------------------------------------------------------------------
// Hard caps — in-code constants by design, NOT env-tunable: an env knob that
// can be set to infinity would turn the injection block (child 02) into an
// unbounded prompt-stuffing channel.
// ---------------------------------------------------------------------------

/** Max lessons lessonsForRepo ever returns (injection breadth cap). */
export const MAX_LESSONS_PER_REPO = 5;
/** Max cumulative lesson-text chars lessonsForRepo ever returns. */
export const MAX_LESSON_CHARS_PER_REPO = 1000;
/** Per-lesson write-time length cap. */
export const MAX_LESSON_LENGTH = 300;
/** Per-source-reason write-time length cap. */
const MAX_SOURCE_REASON_LENGTH = 500;
/** listLessons read bound — plenty for a UI page, never the whole table. */
const LIST_LESSONS_LIMIT = 500;

/** Distillation spend guard: max distiller *calls* per local calendar day. A
 *  park-storm (e.g. a broken repo parking every ticket) must not multiply
 *  haiku spend unboundedly. Counts attempts in-memory AND written rows in the
 *  db (survives restarts), takes the max. */
export const MAX_DISTILLER_CALLS_PER_DAY = 50;
const DISTILLER_MAX_TURNS = 4;
const DISTILLER_DEADLINE_MS = 90_000;

export type LessonOutcome = "parked" | "needs_human" | "taste_fail";

export interface LessonCaptureInput {
  repo: string;          // "" when no repo is known (e.g. contract failures)
  stage: string;         // pipeline stage nearest the failure
  issueKey: string;
  outcome: LessonOutcome;
  reason: string;
  /** errors from failed stages, e.g. "implementer: error_max_turns". */
  stageErrors?: string[];
  /** design-review findings on a taste-fail. */
  tasteFindings?: string;
}

export type { LessonRow } from "./db.ts";

// In-memory attempt counter for the current local day — covers distiller calls
// that fail before writing a row (the db count alone would undercount those).
let attemptDay = "";
let attemptsToday = 0;

function localDayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function startOfLocalDayMs(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function distillerCallsToday(): number {
  const now = new Date();
  const today = localDayKey(now);
  if (attemptDay !== today) { attemptDay = today; attemptsToday = 0; }
  return Math.max(attemptsToday, lessonRowCountSince(startOfLocalDayMs(now)));
}

/** Reduce distiller output to one clean lesson line, or null when unusable.
 *  Strips markdown fencing/bullets and takes the first substantive line. */
function extractLessonLine(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[\s>*#`-]+/, "").replace(/`+$/, "").trim();
    if (line === "" || /^```/.test(raw.trim())) continue;
    if (/^NO-LESSON\b/i.test(line)) return null;
    if (line.length < 10) continue; // fragments ("Sure!", "Ok.") are not lessons
    return line;
  }
  return null;
}

/** Raw write path — redacts and length-caps at write time, then inserts via
 *  the shared handle. Called only by captureLesson (and tests). Returns false
 *  (never throws) when the store is closed or inputs are unusable. */
export function recordLesson(input: { repo: string; stage: string; issueKey: string;
  lesson: string; sourceReason: string }): boolean {
  try {
    const lesson = redactSecrets(input.lesson).clean.trim().slice(0, MAX_LESSON_LENGTH);
    if (lesson === "") return false;
    return insertLessonRow({
      createdAt: Date.now(),
      repo: redactSecrets(input.repo).clean.slice(0, 200),
      stage: redactSecrets(input.stage).clean.slice(0, 100),
      issueKey: redactSecrets(input.issueKey).clean.slice(0, 50),
      lesson,
      sourceReason: redactSecrets(input.sourceReason).clean.trim().slice(0, MAX_SOURCE_REASON_LENGTH),
    });
  } catch (error) {
    console.error(`[lessons] write failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/** Distill one failure into a durable lesson — the capture hook loop.ts calls
 *  on park / needs-human / taste-fail. Best-effort fail-safe by contract:
 *  skips (with a log line) on dry-run, closed store, or exhausted daily
 *  distiller budget, and NEVER throws into the pipeline. */
export async function captureLesson(input: LessonCaptureInput): Promise<void> {
  try {
    // Rehearsals are excluded from durable history (server.ts run_finished
    // guard) — same rule here: a dry-run failure teaches nothing real.
    if (config.dryRun) return;
    if (!eventStoreOpen()) {
      console.log(`[lessons] event store closed — skipping capture for ${input.issueKey} (${input.outcome})`);
      return;
    }
    if (distillerCallsToday() >= MAX_DISTILLER_CALLS_PER_DAY) {
      console.error(`[lessons] daily distiller cap (${MAX_DISTILLER_CALLS_PER_DAY}) reached — skipping capture for ${input.issueKey}`);
      return;
    }
    attemptsToday += 1;

    // The distiller sees ONLY redacted event text, inside an untrusted frame,
    // with no tools — lesson content is data distilled from data.
    const record = redactSecrets([
      `outcome: ${input.outcome}`,
      `repo: ${input.repo || "(unknown)"}`,
      `stage: ${input.stage}`,
      `reason: ${input.reason.slice(0, 800)}`,
      ...(input.stageErrors?.length ? [`stage errors:\n${input.stageErrors.map((e) => `- ${e.slice(0, 300)}`).join("\n")}`] : []),
      ...(input.tasteFindings ? [`design-review findings:\n${input.tasteFindings.slice(0, 1200)}`] : []),
    ].join("\n")).clean;

    const distilled = await runStage("lesson-distiller",
      [
        "You are the lesson distiller in an automated software factory. A pipeline run just failed; its failure record is below.",
        `Produce EXACTLY ONE line of the form "When <recurring situation>, <concrete action>." — a reusable lesson a future automated run on the same repository could apply to avoid this failure.`,
        "Name the underlying cause, not the symptom; do NOT merely restate the failure reason. Keep it under 200 characters, plain text, no markdown, no preamble.",
        "If the record is too vague or one-off to support a genuinely reusable lesson, reply with exactly: NO-LESSON",
        "",
        untrusted(record),
      ].join("\n"),
      { model: config.models.distiller, cwd: config.workRoot, maxTurns: DISTILLER_MAX_TURNS,
        budgetUsd: 0.5, deadlineMs: Date.now() + DISTILLER_DEADLINE_MS });

    if (distilled.error) {
      console.error(`[lessons] distiller failed for ${input.issueKey}: ${distilled.error}`);
      return;
    }
    const lesson = extractLessonLine(distilled.text);
    if (lesson === null) {
      console.log(`[lessons] no reusable lesson distilled for ${input.issueKey} (${input.outcome})`);
      return;
    }
    const wrote = recordLesson({ repo: input.repo, stage: input.stage,
      issueKey: input.issueKey, lesson, sourceReason: `${input.outcome}: ${input.reason}` });
    if (wrote) console.log(`[lessons] ${input.issueKey} (${input.outcome}) → ${lesson.slice(0, 120)}`);
  } catch (error) {
    // Best-effort by contract: capture must never break park/needs-human flow.
    console.error(`[lessons] capture failed for ${input.issueKey}: ${error instanceof Error ? error.message : error}`);
  }
}

/** Active lessons for one repo, newest first — the injection read (child 02).
 *  Hard-capped by count AND cumulative chars via the in-code constants above;
 *  opts may only narrow the caps, never exceed them. */
export function lessonsForRepo(repo: string, opts?: { maxLessons?: number; maxChars?: number }): LessonRow[] {
  const maxLessons = Math.max(0, Math.min(opts?.maxLessons ?? MAX_LESSONS_PER_REPO, MAX_LESSONS_PER_REPO));
  const maxChars = Math.max(0, Math.min(opts?.maxChars ?? MAX_LESSON_CHARS_PER_REPO, MAX_LESSON_CHARS_PER_REPO));
  const rows = activeLessonRowsForRepo(repo, maxLessons);
  const out: LessonRow[] = [];
  let chars = 0;
  for (const row of rows) {
    if (chars + row.lesson.length > maxChars) break;
    chars += row.lesson.length;
    out.push(row);
  }
  return out;
}

/** Every lesson (archived included), newest first, bounded — the UI read
 *  (child 04). */
export function listLessons(): LessonRow[] {
  return allLessonRows(LIST_LESSONS_LIMIT);
}

/** Human-initiated archive: sets archived = 1, never deletes silently.
 *  Returns true when a row actually changed (child 04). */
export function archiveLesson(id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  return archiveLessonRow(id);
}
