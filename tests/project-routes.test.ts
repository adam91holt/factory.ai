import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { openTestDatabase, closeTestDatabase, getProjectRowByName, listProjectPolicies } from "../src/db.ts";
import { handleProjectRoutes } from "../src/server.ts";

// Loopback API contract for the project-config routes (issue #7). The handler
// under test is the EXACT function startDashboard mounts, and every mutation
// inside it goes through guardedJsonBody — the same gate as /catalog/save,
// /lessons/archive, /stop and the approvals actions. These tests exercise the
// gate over a real HTTP server (ephemeral port, loopback bind), pinning:
//   • non-POST on a write route → 405,
//   • cross-origin / non-JSON writes → 403 (refused before any body is read),
//   • DNS-rebinding (non-loopback Host) → 403,
//   • the two-tier semantics end to end over the wire.

let server: Server;
let base = "";
let dir = "";
const originalProjectsDir = config.projectsDir;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (handleProjectRoutes(url, req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "factory-projects-"));
  config.projectsDir = dir;
  writeFileSync(join(dir, "kiwi.md"), [
    "---", "name: kiwi", "team: FAC", "repos: [acme/kiwi]", "merge: review", "---", "", "notes",
  ].join("\n"));
  await openTestDatabase();
});
afterEach(async () => {
  config.projectsDir = originalProjectsDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
  await closeTestDatabase();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("GET /projects", () => {
  test("returns the synced project list as JSON", async () => {
    const res = await fetch(`${base}/projects`);
    expect(res.status).toBe(200);
    const payload = await res.json() as { projects: Array<{ name: string; repos: string[] }> };
    expect(payload.projects.map((p) => p.name)).toEqual(["kiwi"]);
    expect(payload.projects[0]?.repos).toEqual(["acme/kiwi"]);
  });

  test("POST /projects (the read route) → 405", async () => {
    const res = await post("/projects", {});
    expect(res.status).toBe(405);
  });
});

describe("guardedJsonBody gate on every write route (no new gate)", () => {
  const WRITE_ROUTES = ["/projects/save", "/projects/model", "/projects/groundskeeper", "/projects/policy/propose", "/projects/policy/1/approve", "/projects/policy/1/reject"];

  test("non-POST → 405 on every write route", async () => {
    for (const route of WRITE_ROUTES) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const res = await fetch(base + route, { method });
        expect({ route, method, status: res.status }).toEqual({ route, method, status: 405 });
      }
    }
  });

  test("cross-origin POST → 403, and nothing is applied", async () => {
    for (const route of WRITE_ROUTES) {
      const res = await post(route, { name: "kiwi", goal: "evil" }, { origin: "https://attacker.example" });
      expect({ route, status: res.status }).toEqual({ route, status: 403 });
    }
    // The drive-by wrote nothing (row was never even seeded by these refusals).
    expect(await getProjectRowByName("kiwi")).toBeNull();
  });

  test("loopback origins (built UI and vite dev proxy) are allowed", async () => {
    const res = await post("/projects/save", { name: "kiwi", goal: "g" }, { origin: "http://localhost:5173" });
    expect(res.status).toBe(200);
  });

  test("non-JSON content-type → 403 (the CORS-simple form vector)", async () => {
    const res = await fetch(`${base}/projects/save`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: '{"name":"kiwi","goal":"x"}',
    });
    expect(res.status).toBe(403);
  });

  test("non-loopback Host → 403 (DNS rebinding)", async () => {
    const res = await post("/projects/save", { name: "kiwi", goal: "x" }, { host: "attacker.example" });
    expect(res.status).toBe(403);
  });

  test("invalid JSON body → 400", async () => {
    const res = await fetch(`${base}/projects/save`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{nope",
    });
    expect(res.status).toBe(400);
  });
});

describe("two-tier writes over the wire", () => {
  test("descriptive save applies immediately; authority field in the same body is refused", async () => {
    const ok = await post("/projects/save", { name: "kiwi", goal: "ship the kiwi" });
    expect(ok.status).toBe(200);
    expect((await getProjectRowByName("kiwi"))?.goal).toBe("ship the kiwi");

    const refused = await post("/projects/save", { name: "kiwi", deployEnabled: true });
    expect(refused.status).toBe(400);
    const row = await getProjectRowByName("kiwi");
    expect(await listProjectPolicies(row!.id)).toEqual([]); // nothing landed, not even pending
  });

  test("authority propose lands PENDING; approve claims atomically; double-approve → 409", async () => {
    const proposed = await post("/projects/policy/propose", { name: "kiwi", key: "merge", value: "shadow" });
    expect(proposed.status).toBe(200);
    const { policyId } = await proposed.json() as { policyId: number };

    let view = await (await fetch(`${base}/projects`)).json() as { projects: Array<{ effective: { merge: string } | null; policies: Array<{ id: number; state: string }> }> };
    expect(view.projects[0]?.policies.find((p) => p.id === policyId)?.state).toBe("pending");
    expect(view.projects[0]?.effective?.merge).toBe("review"); // unchanged until approved

    // Approve is BOUND to the reviewed revision: a blind {} body refuses (400),
    // a mismatched value refuses (409), and only the restated {key, value} lands.
    expect((await post(`/projects/policy/${policyId}/approve`, {})).status).toBe(400);
    expect((await post(`/projects/policy/${policyId}/approve`, { key: "merge", value: "auto" })).status).toBe(409);
    expect((await post(`/projects/policy/${policyId}/approve`, { key: "merge", value: "shadow" })).status).toBe(200);
    expect((await post(`/projects/policy/${policyId}/approve`, { key: "merge", value: "shadow" })).status).toBe(409);
    expect((await post(`/projects/policy/${policyId}/reject`, {})).status).toBe(409);

    view = await (await fetch(`${base}/projects`)).json() as typeof view;
    expect(view.projects[0]?.effective?.merge).toBe("shadow");
  });

  test("re-proposing a key supersedes the earlier pending revision over the wire — the stale id cannot be approved", async () => {
    const first = await (await post("/projects/policy/propose", { name: "kiwi", key: "merge", value: "auto" })).json() as { policyId: number };
    const second = await (await post("/projects/policy/propose", { name: "kiwi", key: "merge", value: "shadow" })).json() as { policyId: number };
    // The retracted first proposal is dead even with matching evidence.
    expect((await post(`/projects/policy/${first.policyId}/approve`, { key: "merge", value: "auto" })).status).toBe(409);
    const view = await (await fetch(`${base}/projects`)).json() as { projects: Array<{ effective: { merge: string } | null; policies: Array<{ id: number; state: string }> }> };
    expect(view.projects[0]?.policies.find((p) => p.id === first.policyId)?.state).toBe("superseded");
    expect(view.projects[0]?.policies.find((p) => p.id === second.policyId)?.state).toBe("pending");
    expect(view.projects[0]?.effective?.merge).toBe("review"); // nothing activated
  });

  test("propose validation refuses unknown keys and malformed values with 400", async () => {
    expect((await post("/projects/policy/propose", { name: "kiwi", key: "budget", value: 9 })).status).toBe(400);
    expect((await post("/projects/policy/propose", { name: "kiwi", key: "deployEnabled", value: "true" })).status).toBe(400);
    expect((await post("/projects/policy/propose", { name: "kiwi", key: "repos", value: ["../.."] })).status).toBe(400);
  });

  test("model route: roster-validated write; unknown project 404", async () => {
    const ok = await post("/projects/model", { name: "kiwi", role: "fixer", model: config.models.fixer, effort: "high" });
    expect(ok.status).toBe(200);
    expect((await post("/projects/model", { name: "kiwi", role: "fixer", model: "free-text-model" })).status).toBe(400);
    expect((await post("/projects/model", { name: "ghost", role: "fixer", model: config.models.fixer })).status).toBe(404);
  });
});

describe("GET /projects — additive UI context (roster / gates / ladder / drain)", () => {
  interface Payload {
    projects: Array<{ name: string; ladder: Array<{ repo: string; tier: string; cleanStreak: number }> }>;
    roster: { roles: string[]; models: string[] };
    groundskeepersEnabled: boolean;
    drain: { draining: boolean; reason: string | null };
  }

  test("roster mirrors config.models exactly — the dropdown allowlist, never free text", async () => {
    const payload = await (await fetch(`${base}/projects`)).json() as Payload;
    expect(payload.roster.roles.sort()).toEqual(Object.keys(config.models).sort());
    expect(payload.roster.models).toEqual([...new Set(Object.values(config.models))].sort());
  });

  test("groundskeepersEnabled reflects the GLOBAL env gate (the UI's inert signal)", async () => {
    const payload = await (await fetch(`${base}/projects`)).json() as Payload;
    expect(payload.groundskeepersEnabled).toBe(config.groundskeepersEnabled);
  });

  test("every repo carries a ladder tier; an unenrolled repo with no earned state is human-merge", async () => {
    const payload = await (await fetch(`${base}/projects`)).json() as Payload;
    const kiwi = payload.projects.find((p) => p.name === "kiwi");
    expect(kiwi?.ladder).toEqual([{ repo: "acme/kiwi", tier: "human", cleanStreak: 0 }]);
  });

  test("drain state is present and read-only-shaped (no drain entered in this suite)", async () => {
    const payload = await (await fetch(`${base}/projects`)).json() as Payload;
    expect(payload.drain.draining).toBe(false);
  });
});
