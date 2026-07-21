import { isMockMode, mockLessons } from "./fixtures";

// Lessons client — mirrors the GET /lessons payload and POST /lessons/archive
// contract from src/lessons.ts + src/server.ts (the JSON is the contract; the
// two are duplicated by design, like telemetry.ts). In ?mock=1 mode both are
// served from in-memory fixtures so the page renders (and "archives") with no
// daemon, exactly like every other view.

export interface Lesson {
  id: number;
  /** org/name of the repo the lesson was learned in. */
  repo: string;
  /** pipeline stage that produced the failure the lesson distills. */
  stage: string;
  /** distilled lesson text — derived from untrusted failure output; render as
   *  plain text ONLY, never markup. */
  lesson: string;
  /** Linear issue the lesson came from (e.g. "FAC-15"), if known. */
  sourceIssue: string | null;
  /** deep link to that issue, if known. */
  sourceUrl: string | null;
  /** epoch-ms capture time. */
  createdAt: number;
}

export interface LessonsPayload {
  lessons: Lesson[];
}

export type ArchiveResponse = { ok: true; id: number } | { error: string };

// Mock-mode archive state — ids "archived" this session, so the flow is
// exercised end-to-end (row leaves the list) without a backend.
const mockArchived = new Set<number>();

export async function fetchLessons(): Promise<LessonsPayload> {
  if (isMockMode()) {
    return { lessons: mockLessons().filter((l) => !mockArchived.has(l.id)) };
  }
  const res = await fetch("/lessons", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /lessons → ${res.status}`);
  return (await res.json()) as LessonsPayload;
}

export async function archiveLesson(id: number): Promise<ArchiveResponse> {
  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 250));
    mockArchived.add(id);
    return { ok: true, id };
  }
  const res = await fetch("/lessons/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return (await res.json()) as ArchiveResponse;
}
