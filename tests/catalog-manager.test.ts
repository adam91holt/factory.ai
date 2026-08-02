import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { saveCatalogEntry, validateAgentCardRouting, type SaveResult } from "../src/catalog-manager.ts";

// ONLY the rejection legs are exercised: every case below returns before
// saveCatalogEntry reaches its writeFileSync/git section, so the suite never
// touches the working tree, never commits, never needs cleanup.

const err = (r: SaveResult): string => String((r.json as { error?: unknown }).error ?? "");

// The "arm a nonexistent card" test below depends on `zz-gk-nonexistent.md`
// actually being absent from groundskeepers/. If someone ever adds a real,
// enabled card by that name (matching the default steward model),
// saveCatalogEntry's arming check would stop rejecting and the test would
// fall through into its writeFileSync/git-commit section — silently mutating
// and committing a real card mid test-run. Fail loudly instead of letting
// that happen quietly.
const NONEXISTENT_CARD_PATH = join(
  fileURLToPath(new URL("..", import.meta.url)),
  "groundskeepers",
  "zz-gk-nonexistent.md",
);
if (existsSync(NONEXISTENT_CARD_PATH)) {
  throw new Error(
    `tests/catalog-manager.test.ts: fixture collision — ${NONEXISTENT_CARD_PATH} now exists on disk. ` +
      "This test's rejection-only guarantee depends on that file being absent; pick a different " +
      "guaranteed-absent name (or delete/rename the new card) before running this suite.",
  );
}

const agentBody = (content: string, name = "zz-test-agent"): unknown =>
  ({ kind: "agent", name, content });

describe("saveCatalogEntry — body validation", () => {
  test("non-object bodies are 400", () => {
    expect(saveCatalogEntry(null).status).toBe(400);
    expect(saveCatalogEntry("str").status).toBe(400);
    expect(saveCatalogEntry(42).status).toBe(400);
  });

  test("unknown kind is 400", () => {
    const r = saveCatalogEntry({ kind: "daemon", name: "x", content: "y" });
    expect(r.status).toBe(400);
    expect(err(r)).toMatch(/kind must be one of/);
  });

  test("charset-locked name: traversal and separators are 400", () => {
    for (const name of ["../evil", "a/b", ".hidden", "", "-lead", "x".repeat(65)]) {
      const r = saveCatalogEntry({ kind: "agent", name, content: "---\nname: x\n---\nbody" });
      expect(r.status).toBe(400);
      expect(err(r)).toMatch(/name must match/);
    }
  });

  test("non-string content is 400; oversize content is 413", () => {
    expect(saveCatalogEntry({ kind: "agent", name: "ok", content: 7 }).status).toBe(400);
    const big = saveCatalogEntry(agentBody("x".repeat(64 * 1024 + 1)));
    expect(big.status).toBe(413);
    expect(err(big)).toMatch(/64KB cap/);
  });
});

describe("saveCatalogEntry — frontmatter validation (agent/skill)", () => {
  test("content without frontmatter is 422", () => {
    const r = saveCatalogEntry(agentBody("no fences here"));
    expect(r.status).toBe(422);
    expect(err(r)).toMatch(/frontmatter block/);
  });

  test("frontmatter missing name is 422", () => {
    const r = saveCatalogEntry(agentBody("---\ndescription: x\n---\nbody"));
    expect(r.status).toBe(422);
    expect(err(r)).toMatch(/missing a name/);
  });

  test("frontmatter name must equal the save name", () => {
    const r = saveCatalogEntry(agentBody("---\nname: other\n---\nbody"));
    expect(r.status).toBe(422);
    expect(err(r)).toMatch(/must equal the save name/);
  });

  test("skills additionally require a description", () => {
    const r = saveCatalogEntry({ kind: "skill", name: "zz-skill", content: "---\nname: zz-skill\n---\nbody" });
    expect(r.status).toBe(422);
    expect(err(r)).toMatch(/missing a description/);
  });
});

describe("saveCatalogEntry — groundskeeper cards", () => {
  test("invalid GK card (bad cron) is 422 with the loader's error", () => {
    const content = "---\nname: zz-gk\nschedule: not a cron\nteam: FAC\n---\ncharter";
    const r = saveCatalogEntry({ kind: "groundskeeper", name: "zz-gk", content });
    expect(r.status).toBe(422);
    expect(err(r)).toMatch(/groundskeeper card invalid/);
  });

  test("arming a card with no on-disk armed counterpart is refused (no UI self-arming)", () => {
    // zz-gk-nonexistent has no file on disk → the arming ceiling rejects.
    const content = "---\nname: zz-gk-nonexistent\nenabled: true\nschedule: 0 9 * * 1\nteam: FAC\n---\ncharter";
    const r = saveCatalogEntry({ kind: "groundskeeper", name: "zz-gk-nonexistent", content });
    expect(r.status).toBe(422);
    expect(err(r)).toMatch(/refusing to arm/);
  });
});

describe("saveCatalogEntry — secret rejection", () => {
  test("content containing a secret-like string is a hard 422, never written", () => {
    const content = "---\nname: zz-test-agent\n---\ntoken: sk-ant-abcdefghijk123456";
    const r = saveCatalogEntry(agentBody(content));
    expect(r.status).toBe(422);
    expect(err(r)).toMatch(/secret-like string/);
  });
});

// ---------------------------------------------------------------------------
// Agent routing (routing.ts): the write route's privilege ceiling on AGENT
// cards. Before routing, agent cards were EXEMPT from any ceiling here, on the
// explicit stated grounds that their `tools:`/`when:` frontmatter was
// reference-only. That premise is now false — `tools:` selects a stage's real
// allowlist and `role:`/`match:` decide which card runs a stage — so the
// exemption had to go. Every case below is a rejection, so this block keeps
// the file's "never writes, never commits, needs no cleanup" guarantee.
// ---------------------------------------------------------------------------

const ZZ_TEST_AGENT_PATH = join(fileURLToPath(new URL("..", import.meta.url)), "agents", "zz-test-agent.md");
const IMPLEMENTER_MD = join(fileURLToPath(new URL("..", import.meta.url)), "agents", "implementer.md");
const IMPLEMENTER_UI_MD = join(fileURLToPath(new URL("..", import.meta.url)), "agents", "implementer-ui.md");

describe("saveCatalogEntry — agent-card routing ceiling", () => {
  // These cases pass REAL card names (implementer, implementer-ui) so the
  // ceiling is exercised against the ceiling those cards actually have. That
  // is only safe while every case REJECTS: if a future edit weakened one of
  // these rejections, saveCatalogEntry would fall through to its
  // writeFileSync + git commit section and mutate a live agent card — which
  // is exactly what happened once while proving these tests are not vacuous.
  // Snapshot the bytes and re-check them after every case so that failure is
  // loud and immediate instead of a silent commit.
  const guarded = [IMPLEMENTER_MD, IMPLEMENTER_UI_MD];
  const before = new Map(guarded.map((f) => [f, readFileSync(f, "utf8")]));
  afterEach(() => {
    for (const f of guarded) {
      expect(readFileSync(f, "utf8"), `${f} was MODIFIED by a save that should have been rejected`).toBe(before.get(f)!);
    }
    expect(existsSync(ZZ_TEST_AGENT_PATH), "a rejected save created agents/zz-test-agent.md").toBe(false);
  });

  test("introducing a role:/match: routing declaration from the UI is refused", () => {
    // zz-test-agent has no file on disk → its on-disk routing is "nothing", so
    // this is an INTRODUCTION. Minting a specialist through the browser would
    // let the dashboard decide which agent runs a stage.
    for (const fm of ["role: implementer\nmatch: ui", "role: implementer", "match: ui"]) {
      const r = saveCatalogEntry(agentBody(`---\nname: zz-test-agent\n${fm}\n---\nbody`));
      expect(r.status).toBe(422);
      expect(err(r)).toMatch(/routing declaration/);
    }
  });

  test("changing an existing specialist's match: terms from the UI is refused", () => {
    const current = readFileSync(IMPLEMENTER_UI_MD, "utf8");
    const repointed = current.replace("match: ui playwright", "match: no-ui");
    expect(repointed).not.toBe(current); // guard: the fixture line still exists
    const r = saveCatalogEntry({ kind: "agent", name: "implementer-ui", content: repointed });
    expect(r.status).toBe(422);
    expect(err(r)).toMatch(/refusing to change an agent card's `match:`/);
  });

  test("removing an existing specialist's role: from the UI is refused", () => {
    const current = readFileSync(IMPLEMENTER_UI_MD, "utf8");
    const stripped = current.replace("role: implementer\n", "");
    expect(stripped).not.toBe(current);
    const r = saveCatalogEntry({ kind: "agent", name: "implementer-ui", content: stripped });
    expect(r.status).toBe(422);
    expect(err(r)).toMatch(/refusing to change an agent card's `role:`/);
  });

  test("a tools: line naming a selector outside the stage's ceiling is refused", () => {
    const current = readFileSync(IMPLEMENTER_MD, "utf8");
    // Agent/Task are IN the implementer ceiling since the 2026-08-02
    // orchestration enablement, so they are no longer refusal examples here —
    // SendMessage (a side-channel, denied everywhere) takes that slot.
    for (const greedy of ["Bash(gh pr merge:*)", "Bash(git push:*)", "SendMessage", "WebFetch"]) {
      const content = current.replace(
        "tools: [Read, Glob, Grep, Write, Edit, Bash, Task, Agent]",
        `tools: [Read, ${greedy}]`,
      );
      expect(content).not.toBe(current);
      const r = saveCatalogEntry({ kind: "agent", name: "implementer", content });
      expect(r.status).toBe(422);
      expect(err(r)).toMatch(/not in this stage's ceiling/);
      expect(err(r)).toContain(greedy);
    }
  });

  test("a tools: line on a card that is not wired to any stage is refused as inert", () => {
    const r = saveCatalogEntry(agentBody("---\nname: zz-test-agent\ntools: [Read]\n---\nbody"));
    expect(r.status).toBe(422);
    expect(err(r)).toMatch(/not wired to any stage/);
  });

  test("an ordinary prompt-body edit is still allowed — the ceiling only guards routing", () => {
    // Validation-level assertion (no write): identical routing frontmatter,
    // different body, and a NARROWER but valid tools line all pass the ceiling.
    expect(validateAgentCardRouting("implementer", { name: "implementer", tools: "[Read, Glob, Grep, Write, Edit, Bash]" }, IMPLEMENTER_MD)).toBeNull();
    expect(validateAgentCardRouting("implementer", { name: "implementer", tools: "[Read]" }, IMPLEMENTER_MD)).toBeNull();
    expect(validateAgentCardRouting("implementer", { name: "implementer" }, IMPLEMENTER_MD)).toBeNull();
    // …and the specialist's own declaration, unchanged, is accepted.
    expect(validateAgentCardRouting("implementer-ui",
      { name: "implementer-ui", role: "implementer", match: "ui playwright", tools: "[Read, Glob, Grep, Write, Edit, Bash]" },
      IMPLEMENTER_UI_MD)).toBeNull();
  });

  test("a specialist's tools are measured against its ROLE's ceiling, not its own name", () => {
    // implementer-ui has no ceiling under its own name; it inherits the
    // implementer role's. A steward-only verb must still be refused.
    expect(validateAgentCardRouting("implementer-ui",
      { name: "implementer-ui", role: "implementer", match: "ui playwright", tools: "[Read, Bash(gh pr view:*)]" },
      IMPLEMENTER_UI_MD)).toMatch(/not in this stage's ceiling/);
  });
});
