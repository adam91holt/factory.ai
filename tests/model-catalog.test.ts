import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openTestDatabase, closeTestDatabase, syncModelCatalog, listCatalogModels } from "../src/db.ts";
import { validateProjectModels } from "../src/project-config.ts";

// Model catalog (proxy /v1/models → PG): the dashboard's per-project model
// PICK LIST. Pinned invariants:
//   1. Sync replaces availability: ids in the list are available, previously
//      seen ids missing from the list flip unavailable (kept for history).
//   2. An empty sync is a NO-OP — an unreachable proxy at boot must not blank
//      the catalog the dashboard is using.
//   3. validateProjectModels accepts catalog models but still drops ids
//      nobody vouches for (the never-free-text discipline survives).
//   4. Closed store degrades to an empty pick list, never a throw.

beforeEach(async () => {
  await openTestDatabase();
});
afterEach(async () => {
  await closeTestDatabase();
});

describe("syncModelCatalog / listCatalogModels", () => {
  test("round-trip: synced models list back sorted and available", async () => {
    await syncModelCatalog(["claude-sonnet-5", "gpt-5.6-sol", "claude-fable-5"]);
    expect(await listCatalogModels()).toEqual(["claude-fable-5", "claude-sonnet-5", "gpt-5.6-sol"]);
  });

  test("a model that disappears from the proxy flips unavailable; re-appearing restores it", async () => {
    await syncModelCatalog(["a-model", "b-model"]);
    await syncModelCatalog(["b-model"]);
    expect(await listCatalogModels()).toEqual(["b-model"]);
    await syncModelCatalog(["a-model", "b-model"]);
    expect(await listCatalogModels()).toEqual(["a-model", "b-model"]);
  });

  test("empty sync is a no-op — the previous catalog survives a proxy outage", async () => {
    await syncModelCatalog(["survivor"]);
    await syncModelCatalog([]);
    expect(await listCatalogModels()).toEqual(["survivor"]);
  });

  test("duplicates and empty strings in the input are dropped", async () => {
    await syncModelCatalog(["m1", "m1", "", "m2"]);
    expect(await listCatalogModels()).toEqual(["m1", "m2"]);
  });

  test("closed store: sync no-ops and list returns [] (never throws)", async () => {
    await closeTestDatabase();
    await syncModelCatalog(["ghost"]);
    expect(await listCatalogModels()).toEqual([]);
    await openTestDatabase();
  });
});

describe("validateProjectModels + catalog (the widened vetted set)", () => {
  const ROSTER = { implementer: "env-model" };

  test("a catalog model passes where the env roster alone would drop it", () => {
    const rows = [{ role: "implementer", model: "gpt-5.6-terra", effort: null }];
    expect(validateProjectModels(rows, ROSTER)).toEqual([]);
    expect(validateProjectModels(rows, ROSTER, ["gpt-5.6-terra"])).toEqual(rows);
  });

  test("free text still drops — neither env nor catalog vouches for it", () => {
    const rows = [{ role: "implementer", model: "made-up-model", effort: null }];
    expect(validateProjectModels(rows, ROSTER, ["gpt-5.6-terra"])).toEqual([]);
  });

  test("unknown role still drops even when the model is in the catalog", () => {
    const rows = [{ role: "not-a-role", model: "gpt-5.6-terra", effort: null }];
    expect(validateProjectModels(rows, ROSTER, ["gpt-5.6-terra"])).toEqual([]);
  });
});
