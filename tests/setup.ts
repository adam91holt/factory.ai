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
process.env.GROUNDSKEEPERS_ENABLED ??= "";
process.env.MERGE_AUTO_REPOS ??= "";
