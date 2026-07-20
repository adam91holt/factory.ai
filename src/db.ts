import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "./config.ts";
import { bus, type FactoryEvent } from "./events.ts";

// Durable event store (owner request 2026-07-20): every FactoryEvent — already
// redacted at emit — lands in SQLite so agent activity survives restarts.
// bun:sqlite is built in; no dependencies.

let db: Database | null = null;

export function startEventStore(): void {
  db = new Database(join(config.workRoot, "factory.db"));
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq INTEGER, at INTEGER, type TEXT, issue_key TEXT, json TEXT)`);
  db.run("CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_key, id)");
  const insert = db.prepare("INSERT INTO events (seq, at, type, issue_key, json) VALUES (?, ?, ?, ?, ?)");
  bus.subscribe((e: FactoryEvent) => {
    try {
      const key = (e as { issueKey?: string }).issueKey ?? null;
      insert.run(e.seq, e.at, e.type, key, JSON.stringify(e));
    } catch (error) {
      console.error(`[db] event write failed: ${error instanceof Error ? error.message : error}`);
    }
  });
}

/** Full historical event stream for one issue (all sessions). */
export function issueEvents(issueKey: string, limit = 2000): unknown[] {
  if (!db) return [];
  const rows = db.prepare("SELECT json FROM events WHERE issue_key = ? ORDER BY id ASC LIMIT ?")
    .all(issueKey, limit) as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as unknown);
}
