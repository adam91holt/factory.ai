// Store parity on the PRODUCTION driver — bunStore against the compose
// Postgres (issue #8 F4). OPT-IN and skipped by default: plain `bun test` must
// never need a running container (tests/setup.ts even blanks
// FACTORY_DATABASE_URL so nothing can reach a live store by accident). Run it
// deliberately, with the container up (`bun run db:up`):
//
//   FACTORY_PG_INTEGRATION=1 bun test store-parity
//
// Why it exists: tests/store-parity.test.ts exercises the Store contract only
// on PGlite, so bunStore — the ONLY production driver — was never exercised in
// CI at all. The exec() affected-row count it normalises from Bun's `.count`
// is what claimDeploy's exactly-once INSERT guard, claimApproval's
// double-click guard and restorePushbackFeedback's newer-directive-wins guard
// all key on (`changed > 0`) — a governance property, pinned here against the
// real server.
//
// The suite creates/drops only its own `parity` / `parity_pk` tables, so
// running it against the live compose database never touches factory rows.
// Connection: FACTORY_PG_INTEGRATION_URL wins; otherwise the compose defaults
// (docker-compose.yml — user/db `factory`, 127.0.0.1:5460, password from
// FACTORY_PG_PASSWORD or the checked-in local-dev default).

import { describe, expect, test } from "bun:test";
import { bunStore, type Store } from "../src/store.ts";
import { registerStoreParitySuite } from "./store-parity-suite.ts";

const RUN = process.env.FACTORY_PG_INTEGRATION === "1";

if (!RUN) {
  test.skip("store parity on the real Postgres driver (opt-in: FACTORY_PG_INTEGRATION=1 bun test store-parity)", () => {
    // Skipped by design — `bun test` must stay container-free.
  });
} else {
  const url = process.env.FACTORY_PG_INTEGRATION_URL
    ?? `postgres://factory:${process.env.FACTORY_PG_PASSWORD ?? "factory-local-dev"}@127.0.0.1:5460/factory`;

  registerStoreParitySuite("bunStore / compose Postgres", () => bunStore(url), (getStore: () => Store) => {
    describe("the divergence itself, measured on the production driver", () => {
      test("UNCAST BIGINT comes back as a STRING on Bun's client — the reason the casts exist", async () => {
        const s = getStore();
        await s.exec("TRUNCATE parity RESTART IDENTITY");
        await s.exec("INSERT INTO parity (at) VALUES ($1)", [1785628979286]);
        const rows = await s.query<{ id: unknown; at: unknown }>("SELECT id, at FROM parity");
        // The mirror of store-parity.test.ts's PGlite pin (number there). This
        // is the measured divergence from src/store.ts's header; if a Bun
        // upgrade ever changes it, this failing loudly is exactly the point.
        expect(typeof rows[0]?.id).toBe("string");
        expect(typeof rows[0]?.at).toBe("string");
        expect(rows[0]?.at).toBe("1785628979286");
      });
    });
  });
}
