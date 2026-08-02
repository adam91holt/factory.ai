// GET /issue/:key/transcript (issue #11's read surface) over a real HTTP
// server — the handler under test is the EXACT function startDashboard mounts
// (handleTranscriptRoute), same extraction pattern as project-routes.test.ts.
// Pins:
//   • the happy path returns redacted-at-write rows as parsed JSON, in id
//     order, with the keyset cursor (`nextAfter`) walking the whole stream,
//   • the stage filter narrows, GK-style keys work (groundskeeper stages
//     transcribe too), and an unknown issue is an empty 200 — not a 404 probe,
//   • malformed inputs (stage charset, cursor, limit) → 400 before any query,
//   • non-GET → 405; a non-matching path stays unhandled (returns false) so
//     the server's own routing continues.

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openTestDatabase, closeTestDatabase, insertTestTranscriptRow } from "../src/db.ts";
import { handleTranscriptRoute } from "../src/server.ts";
import type { TranscriptRow } from "../src/db.ts";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (handleTranscriptRoute(url, req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => { await openTestDatabase(); });
afterEach(async () => { await closeTestDatabase(); });

interface Page { issueKey: string; stage: string | null; rows: TranscriptRow[]; nextAfter: number | null }

describe("GET /issue/:key/transcript", () => {
  test("returns the transcript page and the cursor walks it to the end", async () => {
    for (let i = 1; i <= 3; i++) {
      await insertTestTranscriptRow("FAC-42", "implementer", "assistant_text", { n: i }, 1000 + i, i);
    }
    const r1 = await fetch(`${base}/issue/FAC-42/transcript?limit=2`);
    expect(r1.status).toBe(200);
    const p1 = await r1.json() as Page;
    expect(p1.issueKey).toBe("FAC-42");
    expect(p1.rows.map((r) => r.body.n)).toEqual([1, 2]);
    expect(p1.nextAfter).toBe(p1.rows[1]!.id);

    const r2 = await fetch(`${base}/issue/FAC-42/transcript?limit=2&after=${p1.nextAfter}`);
    const p2 = await r2.json() as Page;
    expect(p2.rows.map((r) => r.body.n)).toEqual([3]);
    expect(p2.nextAfter).toBeNull();
  });

  test("stage filter narrows; GK-style keys are served; unknown issue is an empty 200", async () => {
    await insertTestTranscriptRow("GK-factory", "groundskeeper", "tool_use", { tool: "Bash" }, 1000, 1);
    await insertTestTranscriptRow("GK-factory", "steward", "result", { ok: true }, 2000, 1);

    const filtered = await (await fetch(`${base}/issue/GK-factory/transcript?stage=steward`)).json() as Page;
    expect(filtered.rows.length).toBe(1);
    expect(filtered.rows[0]!.stage).toBe("steward");
    expect(filtered.stage).toBe("steward");

    const empty = await fetch(`${base}/issue/FAC-404/transcript`);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as Page).rows).toEqual([]);
  });

  test("malformed inputs are refused with 400 before any read", async () => {
    expect((await fetch(`${base}/issue/FAC-1/transcript?stage=${encodeURIComponent("bad stage!")}`)).status).toBe(400);
    expect((await fetch(`${base}/issue/FAC-1/transcript?after=-1`)).status).toBe(400);
    expect((await fetch(`${base}/issue/FAC-1/transcript?after=abc`)).status).toBe(400);
    expect((await fetch(`${base}/issue/FAC-1/transcript?limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/issue/FAC-1/transcript?limit=nope`)).status).toBe(400);
    // Over-cap limit is CLAMPED (db.ts in-code constant), not an error.
    expect((await fetch(`${base}/issue/FAC-1/transcript?limit=999999`)).status).toBe(200);
  });

  test("non-GET → 405; a non-matching path falls through to the server's own 404", async () => {
    expect((await fetch(`${base}/issue/FAC-1/transcript`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/issue/fac-1/transcript`)).status).toBe(404);   // lowercase key: no match
    expect((await fetch(`${base}/issue/FAC-1/transcripts`)).status).toBe(404);  // wrong suffix
    expect((await fetch(`${base}/transcript`)).status).toBe(404);
  });
});
