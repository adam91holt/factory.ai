// Preloaded by bunfig.toml [test] before any test file imports src/*.
// src/config.ts calls required("LINEAR_API_KEY") at import time and throws
// when it is unset — and agents.ts / loop.ts / groundskeepers.ts import it
// transitively — so the suite must run with dummy env, never live secrets.
// Only fill values that are missing: a deliberately-exported test override
// (none today) would still win, but a developer's real shell env never leaks
// meaning into assertions because these dummies are what redaction tests use.
process.env.LINEAR_API_KEY = "lin_api_TESTDUMMY0000000000";
// Distinctive value that matches NO SECRET_PATTERN — exercises the
// exact-value redaction leg of redactSecrets (C18) in isolation.
process.env.PROXY_AUTH_TOKEN = "factory-test-proxy-token-a1b2c3";
// Keep the daemon fully inert if anything ever touches config-driven behavior.
// APPROVALS_NOTIFY defaults ON (config.ts), so a filing test that reaches the
// real notifier would pop a desktop notification on a darwin dev box.
process.env.APPROVALS_NOTIFY ??= "0";
process.env.GROUNDSKEEPERS_ENABLED ??= "";
process.env.MERGE_AUTO_REPOS ??= "";
// The suite must NEVER create git commits (issue #8 F8 — a subagent exercising
// POST /catalog/save once minted real commits on main). With this set,
// saveCatalogEntry writes its file but never touches git; the one test that
// exercises the commit GUARD itself deletes the var locally and injects
// porcelain text instead of spawning git.
process.env.FACTORY_CATALOG_NO_COMMIT ??= "1";
// Fail-CLOSED database guard. The suite runs entirely on db.ts's in-process
// PGlite (WASM Postgres) seam — openTestDatabase() — so `bun test` needs NO
// container, no port and no server. Blanking this means that even if some code
// path ever reached startEventStore(), it could not connect to a real Postgres
// and quietly read or write the owner's live factory store. The guard itself is
// pinned by tests/db-closed-store.test.ts, not just asserted here.
//
// How the seam behaves, so nobody has to read db.ts to use it:
//  - The WASM engine is a module-level SINGLETON. The first openTestDatabase()
//    boots it plus the real DDL (~1.4s, paid once for the whole suite); every
//    later call is one `TRUNCATE ... RESTART IDENTITY` (~2ms). RESTART IDENTITY
//    matters — several tests assert on returned row ids.
//  - closeTestDatabase() DETACHES the handle and quiesces any in-flight write;
//    it deliberately does not close the engine, which would re-pay the boot.
//  - No bus subscription by default: emitting events in a test costs nothing.
//    tests/event-queue.test.ts opts in with { subscribeBus: true } because the
//    write-behind queue is the thing it exists to pin.
//  - The SQL is byte-identical to production's; PGlite is real Postgres.
process.env.FACTORY_DATABASE_URL = "";
process.env.FACTORY_TRUSTED_ORIGINS = ""; // guard tests pin the loopback-only DEFAULT; the operator's real .env value must not leak in
