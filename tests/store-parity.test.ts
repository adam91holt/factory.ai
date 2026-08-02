// Store parity on the UNIT driver — PGlite (real Postgres compiled to WASM,
// in-process, no container). The suite itself lives in tests/store-parity-suite.ts
// so the SAME assertions also run against the production driver via the opt-in
// tests/store-parity-pg.test.ts (FACTORY_PG_INTEGRATION=1); see the suite file's
// header for the full why. Plain `bun test` runs only this file's registration
// and needs no server.

import { describe, expect, test } from "bun:test";
import { pgliteStore, type Store } from "../src/store.ts";
import { registerStoreParitySuite } from "./store-parity-suite.ts";

registerStoreParitySuite("PGlite / unit", pgliteStore, (getStore: () => Store) => {
  describe("the divergence itself, recorded so nobody 'simplifies' the casts", () => {
    test("UNCAST BIGINT is where the two drivers part company — PGlite says number", async () => {
      const s = getStore();
      await s.exec("TRUNCATE parity RESTART IDENTITY");
      await s.exec("INSERT INTO parity (at) VALUES ($1)", [1785628979286]);
      const rows = await s.query<{ id: unknown; at: unknown }>("SELECT id, at FROM parity");
      // On PGlite (this engine) an uncast BIGINT is a number; on Bun's client
      // against a real server the SAME query returns "1" / "1785628979286" —
      // pinned from the other side by tests/store-parity-pg.test.ts. This pair
      // of assertions is the reason every numeric select in db.ts is cast and
      // every numeric column additionally passes through coerceNumeric().
      expect(typeof rows[0]?.id).toBe("number");
      expect(typeof rows[0]?.at).toBe("number");
    });
  });
});
