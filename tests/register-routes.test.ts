import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import {
  closeTestDatabase, openTestDatabase,
  getActiveAgentRegisterRow, getActiveSkillRegisterRow,
  listSkillRegisterRows,
} from "../src/db.ts";
import { getCard } from "../src/catalog.ts";
import { handleRegisterRoutes } from "../src/server.ts";
import {
  attachableRoles, factsSatisfying, matchTermVocabulary, normalizeAttach, validateAttachInput,
  type AttachPreview, type RegistersPayload,
} from "../src/register-manager.ts";
import { ROLE_CEILINGS } from "../src/routing.ts";

// Loopback API contract for the register routes (issue #16 WP3). The handler
// under test is the EXACT function startDashboard mounts, and every mutation
// inside it goes through guardedJsonBody — the same shared gate as every
// other write route (no new gate, no copy). Pins, in order:
//   1. the guard itself on every register write route (405/403/400);
//   2. the versioned-save lifecycle over the wire: save → v1, unchanged skip,
//      edit → v2, history who/when, one-tap rollback re-enabling v1 — and the
//      rollback being visible to the NEXT getCard() (generation counter);
//   3. the agent routing lock: a register save can no more mint or repoint a
//      specialist than /catalog/save can (same pure validator);
//   4. skill attach editing: closed-vocabulary validation (roles from
//      ROLE_CEILINGS, match terms from the factHolds grammar, projects shape-
//      checked server-side), attach carry-forward on content saves, the
//      enabled toggle, and the carry preview computed by the same pure
//      selectSkills the daemon runs.

let server: Server;
let base = "";
let dir = "";
const originalProjectsDir = config.projectsDir;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (handleRegisterRoutes(url, req, res)) return;
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
  // A known project card so the preview's repo universe is deterministic.
  dir = mkdtempSync(join(tmpdir(), "factory-register-routes-"));
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

const getRegisters = async (): Promise<RegistersPayload> => {
  const res = await fetch(`${base}/registers`);
  expect(res.status).toBe(200);
  return await res.json() as RegistersPayload;
};

const agentCard = (name: string, prompt: string): string =>
  `---\nname: ${name}\nmodel: implementer\neffort: high\n---\n\n${prompt}\n`;

const skillCard = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: a test skill\n---\n\n${body}\n`;

// ---------------------------------------------------------------------------
// 1. The shared gate, on every write route.
// ---------------------------------------------------------------------------

describe("guardedJsonBody gate on every register write route (no new gate)", () => {
  const WRITE_ROUTES = [
    "/registers/save", "/registers/rollback",
    "/registers/skill/attach", "/registers/skill/enabled", "/registers/skill/preview",
  ];

  test("GET /registers is the one read; POST to it → 405", async () => {
    const res = await post("/registers", {});
    expect(res.status).toBe(405);
  });

  test("non-POST → 405 on every write route", async () => {
    for (const route of WRITE_ROUTES) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const res = await fetch(base + route, { method });
        expect({ route, method, status: res.status }).toEqual({ route, method, status: 405 });
      }
    }
  });

  test("cross-origin POST → 403, and nothing is written", async () => {
    for (const route of WRITE_ROUTES) {
      const res = await post(route, { kind: "agent", name: "ghost", content: agentCard("ghost", "p") },
        { origin: "https://attacker.example" });
      expect({ route, status: res.status }).toEqual({ route, status: 403 });
    }
    expect(await getActiveAgentRegisterRow("ghost")).toBeNull();
  });

  test("non-JSON content-type → 403; invalid JSON body → 400", async () => {
    const nonJson = await fetch(`${base}/registers/save`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
    });
    expect(nonJson.status).toBe(403);
    const badJson = await fetch(`${base}/registers/save`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{nope",
    });
    expect(badJson.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 2. Versioned saves + history + rollback over the wire.
// ---------------------------------------------------------------------------

describe("register saves are append-only PG versions; rollback is re-enable", () => {
  test("save → v1; identical re-save is unchanged; edit → v2; history records who/when", async () => {
    const v1 = await post("/registers/save", { kind: "agent", name: "reg-route-card", content: agentCard("reg-route-card", "first prompt") });
    expect(await v1.json()).toEqual({ ok: true, name: "reg-route-card", version: 1, unchanged: false });

    const again = await post("/registers/save", { kind: "agent", name: "reg-route-card", content: agentCard("reg-route-card", "first prompt") });
    expect(await again.json()).toEqual({ ok: true, name: "reg-route-card", version: 1, unchanged: true });

    const v2 = await post("/registers/save", { kind: "agent", name: "reg-route-card", content: agentCard("reg-route-card", "second prompt") });
    expect(await v2.json()).toEqual({ ok: true, name: "reg-route-card", version: 2, unchanged: false });

    const payload = await getRegisters();
    const entry = payload.agents.find((a) => a.name === "reg-route-card");
    expect(entry?.activeVersion).toBe(2);
    expect(entry?.versions.map((v) => ({ version: v.version, active: v.active, createdBy: v.createdBy })))
      .toEqual([
        { version: 2, active: true, createdBy: "dashboard" },
        { version: 1, active: false, createdBy: "dashboard" },
      ]);
    expect(entry?.versions.every((v) => v.createdAt > 0)).toBe(true);
    expect(entry?.content).toContain("second prompt");
  });

  test("rollback re-enables version N and the NEXT getCard() serves it (no restart)", async () => {
    await post("/registers/save", { kind: "agent", name: "reg-route-card", content: agentCard("reg-route-card", "first prompt") });
    await post("/registers/save", { kind: "agent", name: "reg-route-card", content: agentCard("reg-route-card", "second prompt") });
    expect(getCard("reg-route-card")?.prompt).toBe("second prompt");

    const res = await post("/registers/rollback", { kind: "agent", name: "reg-route-card", version: 1 });
    expect(await res.json()).toEqual({ ok: true, name: "reg-route-card", version: 1 });

    // The generation counter makes the rollback visible immediately.
    expect(getCard("reg-route-card")?.prompt).toBe("first prompt");
    const payload = await getRegisters();
    expect(payload.agents.find((a) => a.name === "reg-route-card")?.activeVersion).toBe(1);
  });

  test("rollback to a version that does not exist → 404, active version unchanged", async () => {
    await post("/registers/save", { kind: "agent", name: "reg-route-card", content: agentCard("reg-route-card", "first prompt") });
    const res = await post("/registers/rollback", { kind: "agent", name: "reg-route-card", version: 9 });
    expect(res.status).toBe(404);
    expect((await getActiveAgentRegisterRow("reg-route-card"))?.version).toBe(1);
  });

  test("structural refusals: bad kind/name/content shapes → 400, frontmatter rules → 422", async () => {
    expect((await post("/registers/save", { kind: "groundskeeper", name: "x", content: "c" })).status).toBe(400);
    expect((await post("/registers/save", { kind: "agent", name: "../evil", content: "c" })).status).toBe(400);
    expect((await post("/registers/save", { kind: "agent", name: "x", content: 42 })).status).toBe(400);
    expect((await post("/registers/save", { kind: "agent", name: "x", content: "no frontmatter" })).status).toBe(422);
    expect((await post("/registers/save", { kind: "agent", name: "x", content: "---\nname: y\n---\np" })).status).toBe(422);
    expect((await post("/registers/save", { kind: "skill", name: "x", content: "---\nname: x\n---\nbody" })).status).toBe(422); // no description
    expect((await post("/registers/rollback", { kind: "agent", name: "x", version: 0 })).status).toBe(400);
  });

  test("secret-like content is a HARD reject over the wire — nothing lands in the register", async () => {
    const secret = agentCard("leaky", `use ${process.env.LINEAR_API_KEY} for auth`);
    const res = await post("/registers/save", { kind: "agent", name: "leaky", content: secret });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("secret");
    expect(await getActiveAgentRegisterRow("leaky")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The agent routing lock — same validator as /catalog/save.
// ---------------------------------------------------------------------------

describe("agent routing declarations are locked on the register save route too", () => {
  test("introducing role:/match: on a new card is refused; the prompt body stays editable", async () => {
    const routed = `---\nname: fresh-card\nrole: implementer\nmatch: ui\n---\n\nprompt\n`;
    const res = await post("/registers/save", { kind: "agent", name: "fresh-card", content: routed });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/routing declaration/);
    expect(await getActiveAgentRegisterRow("fresh-card")).toBeNull();
  });

  test("changing match: away from the ACTIVE register baseline is refused; keeping it is allowed", async () => {
    // Seed an active row that legitimately declares routing (daemon-side write,
    // not the browser route — e.g. the file importer).
    const { insertAgentRegisterVersion } = await import("../src/db.ts");
    await insertAgentRegisterVersion({
      name: "spec-card", frontmatter: { name: "spec-card", role: "implementer", match: "ui" },
      prompt: "p1", contentHash: "h1", createdBy: "import",
    });

    const repointed = `---\nname: spec-card\nrole: implementer\nmatch: no-ui\n---\n\np2\n`;
    const refused = await post("/registers/save", { kind: "agent", name: "spec-card", content: repointed });
    expect(refused.status).toBe(422);
    expect((await getActiveAgentRegisterRow("spec-card"))?.prompt).toBe("p1");

    const bodyEdit = `---\nname: spec-card\nrole: implementer\nmatch: ui\n---\n\np2\n`;
    const ok = await post("/registers/save", { kind: "agent", name: "spec-card", content: bodyEdit });
    expect(ok.status).toBe(200);
    expect((await getActiveAgentRegisterRow("spec-card"))?.prompt).toBe("p2");
  });

  test("a tools: selector outside the ceiling is refused (typo → loud, not a silent narrow)", async () => {
    const card = `---\nname: implementer\ntools: [Read, TotallyNotATool]\n---\n\nprompt\n`;
    const res = await post("/registers/save", { kind: "agent", name: "implementer", content: card });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("TotallyNotATool");
  });
});

// ---------------------------------------------------------------------------
// 4. Skill attach editing, enabled toggle, carry preview.
// ---------------------------------------------------------------------------

describe("skill attach editing (closed vocabularies, append-only versions)", () => {
  const seedSkill = async (): Promise<void> => {
    const res = await post("/registers/save", { kind: "skill", name: "test-skill", content: skillCard("test-skill", "guidance") });
    expect(res.status).toBe(200);
  };

  test("a valid attach mints a new version with the SAME content and the new selector", async () => {
    await seedSkill();
    const res = await post("/registers/skill/attach", {
      name: "test-skill",
      attach: { roles: ["implementer", "fixer"], projects: ["acme/kiwi"], match: ["ui", "gate:test"] },
    });
    expect(await res.json()).toEqual({
      ok: true, name: "test-skill", version: 2,
      attach: { roles: ["implementer", "fixer"], projects: ["acme/kiwi"], match: ["ui", "gate:test"] },
    });
    const active = await getActiveSkillRegisterRow("test-skill");
    expect(active?.version).toBe(2);
    expect(active?.content).toContain("guidance");
    expect(active?.attach).toEqual({ roles: ["implementer", "fixer"], projects: ["acme/kiwi"], match: ["ui", "gate:test"] });
  });

  test("attach survives a later CONTENT save (a content edit never silently detaches)", async () => {
    await seedSkill();
    await post("/registers/skill/attach", { name: "test-skill", attach: { roles: ["implementer"], match: ["ui"] } });
    await post("/registers/save", { kind: "skill", name: "test-skill", content: skillCard("test-skill", "guidance v2") });
    const active = await getActiveSkillRegisterRow("test-skill");
    expect(active?.content).toContain("guidance v2");
    expect(normalizeAttach(active?.attach ?? {})).toEqual({ roles: ["implementer"], projects: [], match: ["ui"] });
  });

  test("unknown role / unknown match term / bad project shape → 422, NOTHING written", async () => {
    await seedSkill();
    const cases = [
      { attach: { roles: ["superuser"] } },                    // not a wired stage slot
      { attach: { roles: ["implementer"], match: ["always"] } }, // not in the factHolds grammar
      { attach: { roles: ["implementer"], match: ["gate:nope"] } }, // unknown gate name
      { attach: { roles: ["implementer"], projects: ["a/b/c"] } },  // too many segments
      { attach: { roles: "implementer" } },                    // malformed shape
      { attach: { roles: ["implementer", "implementer"] } },   // duplicates
    ];
    for (const c of cases) {
      const res = await post("/registers/skill/attach", { name: "test-skill", ...c });
      expect({ case: c, status: res.status }).toEqual({ case: c, status: 422 });
    }
    expect((await getActiveSkillRegisterRow("test-skill"))?.version).toBe(1);
  });

  test("attach against a name with no active version → 404", async () => {
    const res = await post("/registers/skill/attach", { name: "nope", attach: { roles: ["implementer"] } });
    expect(res.status).toBe(404);
  });

  test("enabled toggle: off disables the active row, on re-enables the newest version", async () => {
    await seedSkill();
    const off = await post("/registers/skill/enabled", { name: "test-skill", enabled: false });
    expect(await off.json()).toEqual({ ok: true, name: "test-skill", version: null, enabled: false });
    expect(await getActiveSkillRegisterRow("test-skill")).toBeNull();
    expect((await getRegisters()).skills.find((s) => s.name === "test-skill")?.enabled).toBe(false);

    const on = await post("/registers/skill/enabled", { name: "test-skill", enabled: true });
    expect(await on.json()).toEqual({ ok: true, name: "test-skill", version: 1, enabled: true });
    expect((await getActiveSkillRegisterRow("test-skill"))?.version).toBe(1);
    // Idempotent: enabling an enabled skill is an ok no-op.
    expect((await post("/registers/skill/enabled", { name: "test-skill", enabled: true })).status).toBe(200);
    expect((await listSkillRegisterRows("test-skill")).length).toBe(1);
  });
});

describe("carry preview — computed by the SAME pure selectSkills as the daemon", () => {
  test("roles ∩ projects ∩ satisfiable match terms → carried pairs over the known repo universe", async () => {
    const res = await post("/registers/skill/preview", {
      name: "test-skill",
      attach: { roles: ["implementer", "fixer"], projects: [], match: ["ui"] },
    });
    expect(res.status).toBe(200);
    const p = await res.json() as AttachPreview;
    // Projects empty → any repo in the universe (the kiwi project card's repo).
    expect(p.repos).toEqual(["acme/kiwi"]);
    expect(p.carries).toEqual([
      { role: "fixer", repos: ["acme/kiwi"] },
      { role: "implementer", repos: ["acme/kiwi"] },
    ].sort((a, b) => attachableRoles().indexOf(a.role) - attachableRoles().indexOf(b.role)));
    expect(p.conditions).toEqual(["ui"]);
    expect(p.contradictory).toBe(false);
  });

  test("a projects filter narrows to the named repo; unknown repos still evaluate", async () => {
    const res = await post("/registers/skill/preview", {
      attach: { roles: ["implementer"], projects: ["other/repo"], match: [] },
    });
    const p = await res.json() as AttachPreview;
    expect(p.repos).toEqual(["acme/kiwi", "other/repo"]);
    expect(p.carries).toEqual([{ role: "implementer", repos: ["other/repo"] }]);
  });

  test("contradictory match terms carry NOWHERE and say so", async () => {
    const res = await post("/registers/skill/preview", {
      attach: { roles: ["implementer"], match: ["ui", "no-ui"] },
    });
    const p = await res.json() as AttachPreview;
    expect(p.contradictory).toBe(true);
    expect(p.carries).toEqual([]);
  });

  test("no roles declared → carried nowhere, surfaced as a structural rejection (fail-closed)", async () => {
    const res = await post("/registers/skill/preview", { attach: { roles: [] } });
    const p = await res.json() as AttachPreview;
    expect(p.carries).toEqual([]);
    expect(p.rejected.some((r) => r.reason.includes("no attach.roles"))).toBe(true);
  });

  test("an invalid attach is a 422, same validator as the write", async () => {
    const res = await post("/registers/skill/preview", { attach: { roles: ["implementer"], match: ["always"] } });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe("register-manager pure helpers", () => {
  test("attachableRoles is exactly the wired stage slots; matchTerms is exactly the factHolds grammar", () => {
    expect(attachableRoles()).toEqual(Object.keys(ROLE_CEILINGS));
    const vocab = matchTermVocabulary();
    expect(vocab).toContain("ui");
    expect(vocab).toContain("no-playwright");
    expect(vocab).toContain("gate:test:e2e");
    expect(vocab).toContain("no-gate:typecheck");
    expect(new Set(vocab).size).toBe(vocab.length);
  });

  test("factsSatisfying builds the minimal satisfying facts and detects contradictions", () => {
    expect(factsSatisfying(["ui", "gate:test"])).toEqual({ ui: true, playwright: true, gates: ["test"] });
    expect(factsSatisfying(["no-ui", "no-playwright"])).toEqual({ ui: false, playwright: false, gates: [] });
    expect(factsSatisfying(["ui", "no-ui"])).toBeNull();
    expect(factsSatisfying(["gate:test", "no-gate:test"])).toBeNull();
    expect(factsSatisfying(["mystery"])).toBeNull();
  });

  test("validateAttachInput: absent keys are empty constraints; non-object attach refused", () => {
    expect(validateAttachInput({})).toEqual({ ok: true, attach: { roles: [], projects: [], match: [] } });
    expect(validateAttachInput(null).ok).toBe(false);
    expect(validateAttachInput([]).ok).toBe(false);
    expect(validateAttachInput({ roles: ["implementer"], projects: ["kiwi"], match: ["no-gate:e2e"] }))
      .toEqual({ ok: true, attach: { roles: ["implementer"], projects: ["kiwi"], match: ["no-gate:e2e"] } });
  });

  test("caps: roles/projects/match over their in-code caps are refused", () => {
    const many = (n: number, prefix: string): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    expect(validateAttachInput({ projects: many(33, "repo-") }).ok).toBe(false);
    // 9 valid match terms trips the 8-term cap before term validation.
    const nineTerms = ["ui", "no-ui", "playwright", "no-playwright", "gate:test", "gate:build", "gate:lint", "gate:check", "gate:typecheck"];
    expect(validateAttachInput({ match: nineTerms }).ok).toBe(false);
  });
});
