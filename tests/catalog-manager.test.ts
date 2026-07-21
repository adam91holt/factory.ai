import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { saveCatalogEntry, type SaveResult } from "../src/catalog-manager.ts";

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
