#!/usr/bin/env bun
/**
 * Import an existing Claude Code OAuth login into CLIProxyAPI's auth store,
 * so you don't have to repeat the `-claude-login` browser flow.
 *
 *   bun scripts/cliproxy-import-claude.ts            # dry run (default)
 *   bun scripts/cliproxy-import-claude.ts --apply    # write the auth file
 *
 * Reads  ~/.claude/.credentials.json  (claudeAiOauth) + ~/.claude.json (email)
 * Writes docker/cliproxy/auths/claude-<email>.json
 *
 * The output shape is CLIProxyAPI's ClaudeTokenStorage
 * (internal/auth/claude/token.go): id_token, access_token, refresh_token,
 * last_refresh, email, type, expired — where the two timestamps are RFC3339
 * strings, NOT epoch millis (internal/auth/claude/anthropic_auth.go:307).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BEFORE YOU RUN THIS, TWO THINGS ARE WORTH KNOWING:
 *
 * 1. The factory does not need this. Claude roles authenticate directly
 *    through the Agent SDK using your local Claude Code login (README
 *    "Stack"). The proxy exists for the CROSS-VENDOR reviewer leg. Importing
 *    Claude here only buys you multi-account pooling, and only takes effect
 *    if you also set PROXY_ALL=1.
 *
 * 2. A Claude subscription (Pro/Max) OAuth token is issued for first-party
 *    use. Serving it through a third-party proxy is a different thing from
 *    what it was issued for, and carries a real risk of rate-limiting or
 *    account action. A metered Anthropic API key in `claude-api-key:` has no
 *    such ambiguity. Your call — this script just does the mechanical part.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AUTHS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docker", "cliproxy", "auths");
const CREDS = join(homedir(), ".claude", ".credentials.json");
const CONFIG = join(homedir(), ".claude.json");

const apply = process.argv.includes("--apply");

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

if (!existsSync(CREDS)) fail(`no Claude Code credentials at ${CREDS} — run \`claude\` and log in first`);

let oauth: Record<string, unknown>;
try {
  oauth = (JSON.parse(readFileSync(CREDS, "utf8")) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth ?? {};
} catch (error) {
  fail(`could not parse ${CREDS}: ${error instanceof Error ? error.message : error}`);
}

const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
const refreshToken = typeof oauth.refreshToken === "string" ? oauth.refreshToken : "";
const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
if (!accessToken || !refreshToken) fail("credentials file has no claudeAiOauth access/refresh token");

let email = "";
try {
  email = String((JSON.parse(readFileSync(CONFIG, "utf8")) as { oauthAccount?: { emailAddress?: string } })
    .oauthAccount?.emailAddress ?? "");
} catch { /* optional — fall back below */ }
if (!email) fail(`could not read oauthAccount.emailAddress from ${CONFIG}; pass the account email another way`);

// CLIProxyAPI names OAuth auth files claude-<email>.json
// (internal/api/handlers/management/auth_files_provider_oauth.go:156).
const outFile = join(AUTHS_DIR, `claude-${email}.json`);

const record = {
  id_token: "",
  access_token: accessToken,
  refresh_token: refreshToken,
  last_refresh: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  email,
  type: "claude",
  expired: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
};

const expired = expiresAt > 0 && expiresAt < Date.now();
const redact = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} chars)` : "<short>");

console.log(`${apply ? "WRITING" : "DRY RUN — would write"}: ${outFile}`);
console.log(JSON.stringify({ ...record, access_token: redact(accessToken), refresh_token: redact(refreshToken) }, null, 2));
if (expired) {
  console.log(`\nNOTE: the access token expired at ${record.expired}. CLIProxyAPI will refresh it`);
  console.log("      from the refresh token on load, so this is usually fine.");
}

if (!apply) {
  console.log("\nNothing written. Re-run with --apply to write it.");
  console.log("CLIProxyAPI watches the auth dir, so it picks the file up live — no restart needed.");
  process.exit(0);
}

mkdirSync(AUTHS_DIR, { recursive: true });
// CLIProxyAPI runs as root and REWRITES these files on token refresh, leaving
// them root-owned (verified). A plain overwrite from the host then fails with
// EACCES — but unlinking works, because the containing directory is ours.
// So always unlink first rather than writing over the top.
if (existsSync(outFile)) {
  try {
    unlinkSync(outFile);
  } catch (error) {
    fail(`could not replace ${outFile} (owned by root after a proxy refresh?): ${error instanceof Error ? error.message : error}\n` +
      `try: sudo rm ${JSON.stringify(outFile)}`);
  }
}
writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
console.log(`\nWrote ${outFile} (mode 0600). The auth dir is gitignored.`);
console.log("Verify with:  curl -s -H \"Authorization: Bearer $PROXY_AUTH_TOKEN\" http://127.0.0.1:8317/v1/models");
