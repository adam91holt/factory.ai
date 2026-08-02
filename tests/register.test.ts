// Agent + skill registers (issue #16 WP1). What this file pins, in order:
//
//   1. The DB INVARIANT itself — exactly-one-active-per-name is enforced by the
//      partial unique index in the REAL migrate() DDL, not by application
//      discipline (tested against the constraint, not the helpers).
//   2. The db.ts helpers — append-only versions, atomic activate/rollback,
//      structural caps (name charset, 64KB), closed-store contract.
//   3. catalog.ts PG-first — an EMPTY register behaves byte-identically to the
//      file catalog (the additive-only pin); an active register row wins over
//      the file; a register edit takes effect on the next read via the
//      generation counter (no polling, no invalidateCard, no restart);
//      rollback/disable are visible immediately; a closed store falls back to
//      files.
//   4. register-io — importer idempotency by canonical content hash, the
//      64KB/NAME_RE/redactSecrets write gate, and the export → import round
//      trip being a fixed point.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeTestDatabase, migrate, openTestDatabase,
  activeAgentRegisterSnapshot, activeSkillRegisterSnapshot, refreshRegisterSnapshot, registerGeneration,
  getActiveAgentRegisterRow, getActiveSkillRegisterRow,
  insertAgentRegisterVersion, insertSkillRegisterVersion,
  listAgentRegisterRows, listSkillRegisterRows,
  listActiveAgentRegisterRows, listActiveSkillRegisterRows,
  setAgentRegisterEnabled, setSkillRegisterEnabled,
} from "../src/db.ts";
import { pgliteStore } from "../src/store.ts";
import {
  cardEffort, cardTools, cardVersion, getCard, listCards, listRoutableCards, parseCardText, renderPrompt,
} from "../src/catalog.ts";
import {
  agentContentHash, exportRegistersToFiles, importRegistersFromFiles,
  saveAgentRegisterVersionFromContent, saveSkillRegisterVersionFromContent, serializeAgentCard, skillContentHash,
} from "../src/register-io.ts";

const AGENTS_DIR = fileURLToPath(new URL("../agents", import.meta.url));
const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

const diskAgentNames = (): string[] =>
  readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();

const fileCard = (name: string): ReturnType<typeof parseCardText> =>
  parseCardText(readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8"));

const CARD = (prompt: string, extra: Record<string, string> = {}): { name: string; frontmatter: Record<string, string>; prompt: string; contentHash: string; createdBy: string } => ({
  name: "reg-card", frontmatter: { name: "reg-card", effort: "high", ...extra }, prompt,
  contentHash: `hash-${prompt}`, createdBy: "test",
});

// ---------------------------------------------------------------------------
// 1. The constraint IS the invariant — tested against migrate()'s real DDL.
// ---------------------------------------------------------------------------

describe("register schema — exactly-one-active is a DATABASE invariant", () => {
  test("the partial unique index in the real DDL refuses a second active version", async () => {
    // Own engine + the REAL migrate(): this asserts on the shipped schema, not
    // a mirror of it. (db.ts's seam handle is private by design.)
    const s = await pgliteStore();
    try {
      await migrate(s);
      for (const table of ["agent_register", "skill_register"] as const) {
        const insert = table === "agent_register"
          ? (version: number, enabled: boolean): Promise<number> =>
              s.exec(`INSERT INTO agent_register (name, version, frontmatter, prompt, content_hash, enabled, created_at) VALUES ('x', $1, '{}'::jsonb, 'p', '', $2, 1)`, [version, enabled])
          : (version: number, enabled: boolean): Promise<number> =>
              s.exec(`INSERT INTO skill_register (name, version, content, enabled, created_at) VALUES ('x', $1, 'c', $2, 1)`, [version, enabled]);
        await insert(1, true);
        // A second ACTIVE version conflicts on the partial index.
        await expect(insert(2, true)).rejects.toThrow();
        // Any number of DISABLED versions is fine (append-only history).
        await insert(2, false);
        await insert(3, false);
        // UNIQUE(name, version): a version number can never be re-minted.
        await expect(insert(2, false)).rejects.toThrow();
        // Activating a second row while one is active conflicts too — the
        // rollback path MUST deactivate first (what setRegisterEnabled does).
        await expect(
          s.exec(`UPDATE ${table} SET enabled = TRUE WHERE name = 'x' AND version = 2`),
        ).rejects.toThrow();
        // migrate() is idempotent over a populated register.
        await migrate(s);
      }
    } finally {
      await s.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. db.ts helpers.
// ---------------------------------------------------------------------------

describe("register row helpers (db.ts)", () => {
  beforeEach(async () => { await openTestDatabase(); });
  afterEach(async () => { await closeTestDatabase(); });

  test("insert appends monotonic versions and the newest is the only active one", async () => {
    const v1 = await insertAgentRegisterVersion(CARD("prompt one"));
    expect(v1).toEqual({ id: 1, version: 1 });
    const v2 = await insertAgentRegisterVersion(CARD("prompt two"));
    expect(v2?.version).toBe(2);

    const all = await listAgentRegisterRows("reg-card");
    expect(all.map((r) => [r.version, r.enabled])).toEqual([[2, true], [1, false]]);
    const active = await getActiveAgentRegisterRow("reg-card");
    expect(active?.version).toBe(2);
    expect(active?.prompt).toBe("prompt two");
    expect(active?.frontmatter).toEqual({ name: "reg-card", effort: "high" });
    expect(active?.createdBy).toBe("test");
    expect((await listActiveAgentRegisterRows()).length).toBe(1);
  });

  test("rollback: re-enabling version N deactivates the rest; a nonexistent version is a refused no-op", async () => {
    await insertAgentRegisterVersion(CARD("prompt one"));
    await insertAgentRegisterVersion(CARD("prompt two"));

    expect(await setAgentRegisterEnabled("reg-card", 1, true)).toBe(true);
    let rows = await listAgentRegisterRows("reg-card");
    expect(rows.map((r) => [r.version, r.enabled])).toEqual([[2, false], [1, true]]);

    // Rolling back to a version that does not exist must NOT deactivate the
    // current one (the probe-first guard).
    expect(await setAgentRegisterEnabled("reg-card", 99, true)).toBe(false);
    expect((await getActiveAgentRegisterRow("reg-card"))?.version).toBe(1);

    // Disabling the active version leaves NO active version (file fallback).
    expect(await setAgentRegisterEnabled("reg-card", 1, false)).toBe(true);
    expect(await getActiveAgentRegisterRow("reg-card")).toBeNull();
    rows = await listAgentRegisterRows("reg-card");
    expect(rows.every((r) => !r.enabled)).toBe(true);
    // ...and a later re-enable brings it back.
    expect(await setAgentRegisterEnabled("reg-card", 2, true)).toBe(true);
    expect((await getActiveAgentRegisterRow("reg-card"))?.prompt).toBe("prompt two");
  });

  test("skill rows carry description + attach through a jsonb round trip", async () => {
    const attach = { roles: ["implementer"], match: ["ui"] };
    const v1 = await insertSkillRegisterVersion({
      name: "reg-skill", description: "a skill", content: "# body", attach,
      contentHash: "h1", createdBy: "test",
    });
    expect(v1?.version).toBe(1);
    const active = await getActiveSkillRegisterRow("reg-skill");
    expect(active?.description).toBe("a skill");
    expect(active?.content).toBe("# body");
    expect(active?.attach).toEqual(attach);

    await insertSkillRegisterVersion({
      name: "reg-skill", description: "a skill v2", content: "# body v2", attach: {},
      contentHash: "h2", createdBy: "test",
    });
    expect((await listSkillRegisterRows("reg-skill")).map((r) => [r.version, r.enabled])).toEqual([[2, true], [1, false]]);
    expect(await setSkillRegisterEnabled("reg-skill", 1, true)).toBe(true);
    expect((await getActiveSkillRegisterRow("reg-skill"))?.content).toBe("# body");
    expect((await listActiveSkillRegisterRows()).length).toBe(1);
  });

  test("structural caps live in db.ts too: charset-locked name, 64KB cap → refused, nothing written", async () => {
    expect(await insertAgentRegisterVersion({ ...CARD("p"), name: "../escape" })).toBeNull();
    expect(await insertAgentRegisterVersion({ ...CARD("p"), name: "" })).toBeNull();
    expect(await insertAgentRegisterVersion(CARD("x".repeat(64 * 1024 + 1)))).toBeNull();
    expect(await insertSkillRegisterVersion({
      name: "no/slash", description: "", content: "c", attach: {}, contentHash: "h", createdBy: "t",
    })).toBeNull();
    expect(await listAgentRegisterRows()).toEqual([]);
    expect(await listSkillRegisterRows()).toEqual([]);
  });

  test("a write that FAILS at the database leaves the active version standing and the snapshot in sync (atomic deactivate+insert)", async () => {
    const v1 = await insertAgentRegisterVersion(CARD("GOOD PROMPT v1"));
    expect(v1?.version).toBe(1);

    // A frontmatter value with a NUL byte passes the structural gate (Postgres
    // only sees it as the escaped-NUL jsonb sequence) and fails INSIDE the database -
    // the representative of the whole DB-side error class (statement timeout,
    // disk full, …). The atomic statement must roll the deactivate back with
    // the failed insert: the register keeps its active row.
    const nul = String.fromCharCode(0);
    const failed = await insertAgentRegisterVersion({
      ...CARD("EVIL PROMPT"), frontmatter: { name: "reg-card", evil: `x${nul}y` },
    });
    expect(failed).toBeNull();

    const active = await getActiveAgentRegisterRow("reg-card");
    expect(active?.version).toBe(1);
    expect(active?.prompt).toBe("GOOD PROMPT v1");
    expect((await listAgentRegisterRows("reg-card")).map((r) => [r.version, r.enabled])).toEqual([[1, true]]);
    // The snapshot the daemon serves from must agree with the DB — the failed
    // write may never leave a stale row behind.
    expect(activeAgentRegisterSnapshot().get("reg-card")?.prompt).toBe("GOOD PROMPT v1");

    // A raw NUL in the prompt itself is refused at the structural gate before
    // any SQL is issued — same outcome, clearer error.
    expect(await insertAgentRegisterVersion(CARD(`EVIL${nul}PROMPT`))).toBeNull();
    expect((await getActiveAgentRegisterRow("reg-card"))?.version).toBe(1);

    // Skill twin: a NUL inside the attach jsonb fails at the database; the
    // active version and its snapshot entry both keep standing.
    const s1 = await insertSkillRegisterVersion({
      name: "reg-skill", description: "d", content: "GOOD SKILL v1", attach: {}, contentHash: "h1", createdBy: "t",
    });
    expect(s1?.version).toBe(1);
    expect(await insertSkillRegisterVersion({
      name: "reg-skill", description: "d", content: "EVIL", attach: { evil: `x${nul}y` }, contentHash: "h2", createdBy: "t",
    })).toBeNull();
    expect((await getActiveSkillRegisterRow("reg-skill"))?.content).toBe("GOOD SKILL v1");
    expect((await listSkillRegisterRows("reg-skill")).map((r) => [r.version, r.enabled])).toEqual([[1, true]]);
    expect(activeSkillRegisterSnapshot().get("reg-skill")?.content).toBe("GOOD SKILL v1");
  });

  test("the snapshot mirrors the active rows and the generation bumps on every write", async () => {
    const g0 = registerGeneration();
    await insertAgentRegisterVersion(CARD("prompt one"));
    expect(registerGeneration()).toBeGreaterThan(g0);
    expect(activeAgentRegisterSnapshot().get("reg-card")?.prompt).toBe("prompt one");

    const g1 = registerGeneration();
    await insertSkillRegisterVersion({
      name: "reg-skill", description: "", content: "c", attach: {}, contentHash: "h", createdBy: "t",
    });
    expect(registerGeneration()).toBeGreaterThan(g1);
    expect(activeSkillRegisterSnapshot().get("reg-skill")?.content).toBe("c");

    const g2 = registerGeneration();
    await setAgentRegisterEnabled("reg-card", 1, false);
    expect(registerGeneration()).toBeGreaterThan(g2);
    expect(activeAgentRegisterSnapshot().has("reg-card")).toBe(false);
  });
});

describe("register helpers — closed-store contract (reads empty, writes refused, no throw)", () => {
  beforeEach(async () => { await closeTestDatabase(); });

  test("every register helper keeps the closed-store semantics of its section", async () => {
    expect(await insertAgentRegisterVersion(CARD("p"))).toBeNull();
    expect(await insertSkillRegisterVersion({
      name: "s", description: "", content: "c", attach: {}, contentHash: "h", createdBy: "t",
    })).toBeNull();
    expect(await getActiveAgentRegisterRow("x")).toBeNull();
    expect(await getActiveSkillRegisterRow("x")).toBeNull();
    expect(await listAgentRegisterRows()).toEqual([]);
    expect(await listSkillRegisterRows()).toEqual([]);
    expect(await listActiveAgentRegisterRows()).toEqual([]);
    expect(await listActiveSkillRegisterRows()).toEqual([]);
    expect(await setAgentRegisterEnabled("x", 1, true)).toBe(false);
    expect(await setSkillRegisterEnabled("x", 1, true)).toBe(false);
    expect(activeAgentRegisterSnapshot().size).toBe(0);
    expect(activeSkillRegisterSnapshot().size).toBe(0);
    await refreshRegisterSnapshot(); // must not throw with no store
  });
});

// ---------------------------------------------------------------------------
// 3. catalog.ts PG-first with files as fallback.
// ---------------------------------------------------------------------------

describe("catalog PG-first — empty register is byte-identical to the file catalog", () => {
  beforeEach(async () => { await openTestDatabase(); });
  afterEach(async () => { await closeTestDatabase(); });

  test("with an OPEN but EMPTY register, every card resolves exactly as from disk", () => {
    expect(listCards()).toEqual(diskAgentNames());
    for (const name of diskAgentNames()) {
      expect(getCard(name), `getCard(${name}) diverged from the file`).toEqual(fileCard(name));
      expect(cardVersion(name)).toBeUndefined();
    }
    expect(cardEffort("implementer")).toBe("high");
    // renderPrompt goes through the same card — identical substitution result.
    const viaCatalog = renderPrompt("implementer", { repo: "acme/x" }, "FALLBACK");
    const viaFile = fileCard("implementer").prompt.replace(/\{\{(\w+)\}\}/g, (w, k: string) => (k === "repo" ? "acme/x" : w));
    expect(viaCatalog).toBe(viaFile);
    // And a missing card still falls through to the call-site fallback.
    expect(renderPrompt("no-such-card", {}, "FALLBACK")).toBe("FALLBACK");
  });

  test("with the store CLOSED the same equalities hold (fresh-checkout behaviour)", async () => {
    await closeTestDatabase();
    expect(listCards()).toEqual(diskAgentNames());
    for (const name of diskAgentNames()) {
      expect(getCard(name)).toEqual(fileCard(name));
    }
  });
});

describe("catalog PG-first — an active register row wins, generation invalidates, rollback applies", () => {
  beforeEach(async () => { await openTestDatabase(); });
  afterEach(async () => { await closeTestDatabase(); });

  test("a register edit takes effect on the NEXT read — no invalidateCard, no restart", async () => {
    // Warm the cache from the FILE first.
    const fromFile = getCard("implementer");
    expect(fromFile).toEqual(fileCard("implementer"));

    // Write version 1 to the register: the very next getCard sees it.
    await insertAgentRegisterVersion({
      name: "implementer", frontmatter: { name: "implementer", effort: "low" },
      prompt: "REGISTER PROMPT v1 for {{repo}}", contentHash: "h1", createdBy: "test",
    });
    expect(getCard("implementer")?.prompt).toBe("REGISTER PROMPT v1 for {{repo}}");
    expect(cardEffort("implementer")).toBe("low");
    expect(cardVersion("implementer")).toBe(1);
    expect(renderPrompt("implementer", { repo: "acme/x" }, "FALLBACK")).toBe("REGISTER PROMPT v1 for acme/x");

    // Version 2 supersedes on the next read.
    await insertAgentRegisterVersion({
      name: "implementer", frontmatter: { name: "implementer", effort: "high" },
      prompt: "REGISTER PROMPT v2", contentHash: "h2", createdBy: "test",
    });
    expect(getCard("implementer")?.prompt).toBe("REGISTER PROMPT v2");
    expect(cardVersion("implementer")).toBe(2);

    // ROLLBACK: re-enable version 1 — the next read uses it.
    expect(await setAgentRegisterEnabled("implementer", 1, true)).toBe(true);
    expect(getCard("implementer")?.prompt).toBe("REGISTER PROMPT v1 for {{repo}}");
    expect(cardVersion("implementer")).toBe(1);

    // Disabling ALL versions falls back to the git-committed file.
    expect(await setAgentRegisterEnabled("implementer", 1, false)).toBe(true);
    expect(getCard("implementer")).toEqual(fileCard("implementer"));
    expect(cardVersion("implementer")).toBeUndefined();
  });

  test("a register-ONLY card (no file) is listed and routable; closing the store removes it", async () => {
    await insertAgentRegisterVersion({
      name: "pg-only-card", frontmatter: { name: "pg-only-card", role: "implementer", match: "ui playwright", tools: "[Read]" },
      prompt: "specialist body", contentHash: "h", createdBy: "test",
    });
    expect(listCards()).toContain("pg-only-card");
    expect(getCard("pg-only-card")?.prompt).toBe("specialist body");
    const routable = listRoutableCards().find((c) => c.name === "pg-only-card");
    expect(routable).toEqual({ name: "pg-only-card", role: "implementer", match: "ui playwright", tools: "[Read]" });
    expect(cardTools("pg-only-card")).toBe("[Read]");

    await closeTestDatabase();
    expect(listCards()).not.toContain("pg-only-card");
    expect(getCard("pg-only-card")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. register-io: importer idempotency, write gate, export round trip.
// ---------------------------------------------------------------------------

describe("register-io — importer seeds from files and is idempotent by content hash", () => {
  beforeEach(async () => { await openTestDatabase(); });
  afterEach(async () => { await closeTestDatabase(); });

  test("first import creates version 1 of every card/skill; a re-run creates NOTHING new", async () => {
    const first = await importRegistersFromFiles({ createdBy: "seed" });
    expect(first.agents.map((r) => r.name).sort()).toEqual(diskAgentNames());
    expect(first.agents.every((r) => r.ok && !r.unchanged)).toBe(true);
    expect(first.skills.length).toBeGreaterThanOrEqual(2); // factory-design, game-feel
    expect(first.skills.every((r) => r.ok && !r.unchanged)).toBe(true);

    // The seeded register serves EXACTLY what the files say (PG-first now, but
    // nothing observable changed — the additive-only property with a full DB).
    for (const name of diskAgentNames()) {
      expect(getCard(name), `register round-trip diverged for ${name}`).toEqual(fileCard(name));
      expect(cardVersion(name)).toBe(1);
    }

    // IDEMPOTENT: same files, same hashes — no new versions anywhere.
    const second = await importRegistersFromFiles({ createdBy: "seed" });
    expect(second.agents.every((r) => r.ok && r.unchanged)).toBe(true);
    expect(second.skills.every((r) => r.ok && r.unchanged)).toBe(true);
    for (const name of diskAgentNames()) {
      expect((await listAgentRegisterRows(name)).length).toBe(1);
    }
    expect((await listSkillRegisterRows("factory-design")).length).toBe(1);
  }, 30_000);

  test("a changed file DOES mint a new version on re-import", async () => {
    await importRegistersFromFiles();
    const changed = await saveAgentRegisterVersionFromContent(
      "implementer", "---\nname: implementer\n---\n\nedited body", "operator");
    expect(changed).toEqual({ ok: true, name: "implementer", version: 2, unchanged: false });
    expect(getCard("implementer")?.prompt).toBe("edited body");
    // Saving the SAME content again is unchanged (hash short-circuit).
    const again = await saveAgentRegisterVersionFromContent(
      "implementer", "---\nname: implementer\n---\n\nedited body", "operator");
    expect(again).toEqual({ ok: true, name: "implementer", version: 2, unchanged: true });
  }, 30_000);
});

describe("register-io — the write gate (NAME_RE, 64KB, redactSecrets)", () => {
  beforeEach(async () => { await openTestDatabase(); });
  afterEach(async () => { await closeTestDatabase(); });

  test("a charset-violating name is refused", async () => {
    const r = await saveAgentRegisterVersionFromContent("../../etc/passwd", "---\nname: x\n---\nbody", "t");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("name must match");
    expect(await listAgentRegisterRows()).toEqual([]);
  });

  test("content over the 64KB cap is refused", async () => {
    const r = await saveSkillRegisterVersionFromContent("big-skill", "x".repeat(64 * 1024 + 1), "t");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("64KB cap");
    expect(await listSkillRegisterRows()).toEqual([]);
  });

  test("secret-like content is a HARD reject — a secret never lands in a register row", async () => {
    // The dummy Linear key from tests/setup.ts matches the lin_api_ pattern.
    const secret = process.env.LINEAR_API_KEY ?? "lin_api_TESTDUMMY0000000000";
    const agent = await saveAgentRegisterVersionFromContent("leaky", `---\nname: leaky\n---\nuse ${secret} here`, "t");
    expect(agent.ok).toBe(false);
    if (!agent.ok) expect(agent.error).toContain("secret-like");
    const skill = await saveSkillRegisterVersionFromContent("leaky-skill", `key: ${secret}`, "t");
    expect(skill.ok).toBe(false);
    expect(await listAgentRegisterRows()).toEqual([]);
    expect(await listSkillRegisterRows()).toEqual([]);
  });
});

describe("register-io — git export writes active versions back; export→import is a fixed point", () => {
  beforeEach(async () => { await openTestDatabase(); });
  afterEach(async () => { await closeTestDatabase(); });

  test("export writes serialized cards/skills to files, and re-importing them changes nothing", async () => {
    let tmp: string | null = null;
    try {
      tmp = mkdtempSync(join(tmpdir(), "factory-register-export-"));
      const agentsDir = join(tmp, "agents");
      const skillsDir = join(tmp, "skills");

      await importRegistersFromFiles(); // seed from the real repo files
      // A register-authored edit so the export provably carries REGISTER state,
      // not a copy of the source files.
      await saveAgentRegisterVersionFromContent("implementer", "---\nname: implementer\neffort: high\n---\n\nEXPORTED BODY", "operator");

      const exported = await exportRegistersToFiles({ agentsDir, skillsDir });
      expect(exported.failed).toEqual([]);
      expect(exported.agents.sort()).toEqual(diskAgentNames());
      expect(exported.skills.length).toBeGreaterThanOrEqual(2);

      const implFile = readFileSync(join(agentsDir, "implementer.md"), "utf8");
      expect(implFile).toContain("EXPORTED BODY");
      expect(implFile.startsWith("---\n")).toBe(true);
      // Skills export byte-for-byte.
      expect(readFileSync(join(skillsDir, "factory-design", "SKILL.md"), "utf8"))
        .toBe(readFileSync(join(SKILLS_DIR, "factory-design", "SKILL.md"), "utf8"));

      // FIXED POINT, leg 1: re-importing the export mints no versions.
      const reimport = await importRegistersFromFiles({ agentsDir, skillsDir });
      expect(reimport.agents.every((r) => r.ok && r.unchanged)).toBe(true);
      expect(reimport.skills.every((r) => r.ok && r.unchanged)).toBe(true);

      // FIXED POINT, leg 2: re-exporting touches nothing (files already match).
      const again = await exportRegistersToFiles({ agentsDir, skillsDir });
      expect(again).toEqual({ agents: [], skills: [], failed: [] });
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test("serializeAgentCard round-trips through parseCardText to the same canonical hash", () => {
    const fm = { name: "z-card", tools: "[Read, Bash]", effort: "low" };
    const prompt = "line one\n\nline two";
    const parsed = parseCardText(serializeAgentCard(fm, prompt));
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.prompt).toBe(prompt);
    expect(agentContentHash(parsed.frontmatter, parsed.prompt)).toBe(agentContentHash(fm, prompt));
    // Key order never changes the hash (jsonb re-orders keys).
    expect(agentContentHash({ b: "2", a: "1" }, "p")).toBe(agentContentHash({ a: "1", b: "2" }, "p"));
    expect(skillContentHash("abc")).not.toBe(skillContentHash("abd"));
  });
});
