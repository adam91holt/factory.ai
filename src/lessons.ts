import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "./config.ts";

// Lessons store — read/prune surface for the dashboard (GET /lessons,
// POST /lessons/archive). Capture/distillation is owned by the store child's
// ticket; this module implements the agreed API names (`listLessons`,
// `archiveLesson`) against the same schema so the routes work end-to-end and
// the store child's implementation can supersede this file wholesale.
//
// Stance (mirrors db.ts): lessons live in the same factory.db the event store
// uses, busy_timeout so a dashboard read never starves the daemon's writer. A
// missing table or closed store degrades to "no lessons" — the dashboard must
// render an empty state, never crash the pipeline. Archiving sets archived=1
// and NOTHING here (or anywhere) hard-deletes a row: pruning is
// human-initiated and reversible by hand, per the flywheel's anti-goal that
// nothing is ever silently deleted.

export interface Lesson {
  id: number;
  /** org/name of the repo the lesson was learned in. */
  repo: string;
  /** pipeline stage that produced the failure the lesson distills. */
  stage: string;
  /** the distilled lesson text — REDACTED at capture time, but still derived
   *  from untrusted failure output; the UI renders it as text, never markup. */
  lesson: string;
  /** Linear issue the lesson came from (e.g. "FAC-15"), if known. */
  sourceIssue: string | null;
  /** deep link to that issue, if known. */
  sourceUrl: string | null;
  /** epoch-ms capture time. */
  createdAt: number;
}

let handle: Database | null = null;

function open(): Database | null {
  if (handle) return handle;
  try {
    handle = new Database(join(config.workRoot, "factory.db"));
    handle.run("PRAGMA busy_timeout = 2000");
  } catch (error) {
    console.error(`[lessons] open failed: ${error instanceof Error ? error.message : error}`);
    handle = null;
  }
  return handle;
}

/** Coerce a stored field to a finite number (same guard as db.ts — the durable
 *  store outlives any single daemon version; never assume shapes). */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Active (non-archived) lessons, newest first. Empty when the store is
 *  closed, the table doesn't exist yet, or nothing has been captured. */
export function listLessons(): Lesson[] {
  const db = open();
  if (!db) return [];
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(
      `SELECT id, repo, stage, lesson, source_issue, source_url, created_at
       FROM lessons WHERE archived = 0 ORDER BY created_at DESC, id DESC`,
    ).all() as Array<Record<string, unknown>>;
  } catch {
    return []; // no lessons table yet — the flywheel hasn't captured anything
  }
  const out: Lesson[] = [];
  for (const r of rows) {
    const id = num(r.id);
    if (id <= 0) continue;
    out.push({
      id,
      repo: str(r.repo),
      stage: str(r.stage),
      lesson: str(r.lesson),
      sourceIssue: strOrNull(r.source_issue),
      sourceUrl: strOrNull(r.source_url),
      createdAt: num(r.created_at),
    });
  }
  return out;
}

/** Human-initiated prune: set archived=1 on one lesson. NEVER deletes the row
 *  — the lesson stays in factory.db for audit, it just stops being listed and
 *  stops being injected into prompts. Returns false when no active lesson has
 *  that id (or the store is unavailable). */
export function archiveLesson(id: number): boolean {
  const db = open();
  if (!db) return false;
  try {
    const res = db.prepare("UPDATE lessons SET archived = 1 WHERE id = ? AND archived = 0").run(id);
    return res.changes > 0;
  } catch {
    return false; // no lessons table yet — nothing to archive
  }
}
