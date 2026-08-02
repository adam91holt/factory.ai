# CLIProxyAPI

The multi-vendor leg of the model roster. Claude roles run on direct SDK auth
(your local Claude Code login) and never touch this; the proxy carries **only**
the tool-less cross-vendor reviewer stages:

| Stage | Env var | Default |
|---|---|---|
| Codex reviewer | `REVIEWER_CODEX_MODEL` | `gpt-5.6-sol` |
| Security reviewer | `SECURITY_REVIEWER_MODEL` | `gpt-5.6-sol` |

The security reviewer is cross-vendor by design so a Claude author is never the
sole security judge of its own diff.

## Run it

```bash
docker compose -f docker-compose.cliproxy.yml up -d
docker compose -f docker-compose.cliproxy.yml logs -f    # follow
docker compose -f docker-compose.cliproxy.yml down       # stop
```

Config lives in `docker/cliproxy/config.yaml` (gitignored — it holds a live
api-key). `docker/cliproxy/config.example.yaml` is the committed template;
copy it and replace the placeholder key with a random token, then set the same
value as `PROXY_AUTH_TOKEN` in `.env`.

```bash
openssl rand -hex 24
```

## Providers

The container starts with **zero** providers. Until you add one, `/v1/models`
returns an empty list and a request for `gpt-5.6-sol` fails fast with
`502 unknown provider for model` — the *intended* degraded path, not a bug
(see "Degradation" below).

There are two ways to add one, and they can be mixed.

### A. API keys in `config.yaml` (declarative — no interactive login)

Preferred for this repo: the whole provider set is a file you can version
(via `config.example.yaml`), diff, and re-create on a new machine. **Config
changes hot-reload — the file watcher picks them up with no restart** (verified:
adding a provider block made the model appear in `/v1/models` within seconds,
and removing it took it away again).

Six provider blocks are supported. The full annotated reference ships inside the
image:

```bash
docker exec factory-cli-proxy-api \
  grep -nE "^#? ?(gemini|codex|xai|claude|vertex)-api-key:|^# ?openai-compatibility:" \
  /CLIProxyAPI/config.example.yaml
```

| Block | For |
|---|---|
| `codex-api-key` | OpenAI/Codex keys |
| `claude-api-key` | Anthropic keys |
| `gemini-api-key` | Google AI Studio keys |
| `xai-api-key` | xAI/Grok keys |
| `vertex-api-key` | Vertex-compatible endpoints |
| `openai-compatibility` | **Any** OpenAI-compatible endpoint (OpenRouter, Together, a local server…) |

The key mechanism for this repo is **`alias`** — it decouples the model name the
factory asks for from whatever actually serves it. `REVIEWER_CODEX_MODEL` and
`SECURITY_REVIEWER_MODEL` default to `gpt-5.6-sol`; aliasing satisfies that name
from any upstream, so you never have to keep `.env` and the proxy in sync:

```yaml
openai-compatibility:
  - name: "openrouter"
    base-url: "https://openrouter.ai/api/v1"
    api-key-entries:
      - api-key: "sk-or-v1-..."
    models:
      - name: "openai/gpt-5.6"      # what the upstream calls it
        alias: "gpt-5.6-sol"        # what the factory asks for
```

Repeating one `alias` across several `name`s builds a failover pool: requests
round-robin the upstreams, and if the chosen one fails before producing output
the request continues with the next. That is a second, independent layer of
resilience under the `FALLBACK_MODEL` retry logic in `src/agents.ts`.

Other per-credential options worth knowing: `weight` (weighted round-robin
across multiple keys), `prefix` (require `myprefix/model` to target a specific
credential), `proxy-url`, custom `headers`, and `excluded-models` (exact or
wildcard).

#### Configured provider: QwenCloud

The Token Plan endpoint is OpenAI-compatible and is wired up in
`docker/cliproxy/config.yaml` as provider `qwencloud`:

```
base-url: https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
```

Seven text models are exposed under their **real names** — deliberately not
aliased to `gpt-5.6-sol`, because the factory's telemetry, factory reports and
dashboard record which model reviewed each diff, and the point of a
cross-vendor reviewer is knowing which vendor actually looked at it:

`qwen3.8-max-preview` · `qwen3.7-max` · `qwen3.7-plus` · `qwen3.6-flash` ·
`glm-5.2` · `deepseek-v4-pro` · `deepseek-v4-flash-0731`

The image and audio models on the plan (`wan2.7-image`, `wan2.7-image-pro`,
`qwen-audio-3.0-tts-plus`) are omitted — the factory has no use for them.

**The DeepSeek models are reasoning models.** They spend completion tokens on
`reasoning_content` before emitting any `content`, so a tight `max_tokens`
returns an empty string rather than an error: 24 tokens returned `''`, 600
returned `'OK'` plus 24 reasoning tokens. Give them headroom.

These now serve the cross-vendor reviewer legs in `.env`:

```
REVIEWER_CODEX_MODEL=qwen3.8-max-preview
SECURITY_REVIEWER_MODEL=deepseek-v4-flash-0731
```

Two different model families on purpose, so the code review and the security
review are genuinely independent judgments. `qwen3.8-max-preview` is a
*preview* model — `qwen3.7-max` is the stable fallback.

### B. OAuth login (subscription accounts)

Use this when you're authenticating a **ChatGPT/Claude subscription** rather
than a metered API key — there is no API key to paste for those.

```bash
# Device-code flow — best when you aren't at the machine running the container.
docker compose -f docker-compose.cliproxy.yml exec cli-proxy-api \
  /CLIProxyAPI/CLIProxyAPI -codex-device-login

# Browser OAuth flow — the callback ports are already mapped to 127.0.0.1.
docker compose -f docker-compose.cliproxy.yml exec cli-proxy-api \
  /CLIProxyAPI/CLIProxyAPI -no-browser -codex-login
```

Other providers use the same shape: `-claude-login`, `-xai-login`,
`-kimi-login`, `-antigravity-login`, `-vertex-import <key.json>`.

OAuth credentials land as JSON files in `docker/cliproxy/auths/` (gitignored),
which the same file watcher picks up live. That directory is itself portable —
copying an existing auth file in from another machine registers the account
without repeating the OAuth dance. Verify a provider landed:

```bash
curl -s -H "Authorization: Bearer $PROXY_AUTH_TOKEN" \
  http://127.0.0.1:8317/v1/models | head -c 400
```

## Multiple Claude accounts (pooling)

Each account is **one auth file** in `docker/cliproxy/auths/`, named
`claude-<email>.json`. Drop in several and the proxy pools them automatically —
this is the "multi-account pooling" the `PROXY_ALL` comment in `src/config.ts`
refers to.

Three ways to get an account in there:

```bash
# 1. Reuse the Claude Code login already on this machine.
bun scripts/cliproxy-import-claude.ts            # dry run
bun scripts/cliproxy-import-claude.ts --apply

# 2. OAuth each additional account (writes claude-<email>.json per account).
docker compose -f docker-compose.cliproxy.yml exec cli-proxy-api \
  /CLIProxyAPI/CLIProxyAPI -no-browser -claude-login

# 3. Copy an auth file in from another machine — the watcher picks it up live.
```

The file shape is CLIProxyAPI's `ClaudeTokenStorage`
(`internal/auth/claude/token.go`). Both timestamps are **RFC3339 strings**, not
epoch millis:

```json
{
  "id_token": "",
  "access_token": "sk-ant-...",
  "refresh_token": "sk-ant-...",
  "last_refresh": "2026-08-02T00:23:45Z",
  "email": "you@example.com",
  "type": "claude",
  "expired": "2026-08-02T04:25:34Z"
}
```

An expired `access_token` is fine — the proxy refreshes it from the
`refresh_token` on load, and runs an auto-refresh worker every 15 minutes.

### Persistence

Credentials live on the **host**, not inside the container. `auth-dir` is a bind
mount:

```
bind  ./docker/cliproxy/auths  ->  /root/.cli-proxy-api
```

Verified by writing a file inside the container, running a full
`docker compose down` (container destroyed, not just stopped), and bringing it
back: the file was still on the host throughout and visible to the new
container. So logins survive restart, recreate, and image upgrade. The only
thing that loses them is deleting `docker/cliproxy/auths/` yourself.

Two consequences of the container running as **root**:

- It **rewrites** auth files in place on token refresh, leaving them
  `root:root` mode 0644. A later host-side overwrite then fails with `EACCES`.
  Deleting works (the directory is yours), so `scripts/cliproxy-import-claude.ts`
  unlinks before writing. If you hit this by hand: `sudo rm` the file, then
  re-import.
- Because the refresh drops files back to 0644, the **directory** is set to
  `0700` rather than relying on file modes — OAuth tokens shouldn't be
  world-readable. The container still writes fine (root ignores the mode).

### Routing across the pool

```yaml
routing:
  strategy: "round-robin"   # round-robin (default) | weighted-round-robin | fill-first
  session-affinity: false   # true = pin a conversation to one account
  session-affinity-ttl: "1h"
```

- `round-robin` spreads load evenly — the sane default for several equal accounts.
- `weighted-round-robin` honours a top-level numeric `weight` field you add to
  each auth JSON (default 1). Use it when one account has a bigger quota.
- `fill-first` exhausts one account before moving to the next.

Failover is always on: when a bound credential becomes unavailable the request
moves to another. Cooldown behaviour is tunable via `disable-cooling` and
`transient-error-cooldown-seconds`.

### Turning pooling on

Pooling only takes effect when the daemon actually routes Claude through the
proxy, which means **`PROXY_ALL=1`** in `.env`. Order matters:

1. Load the accounts, then confirm they show up:
   `curl -s -H "Authorization: Bearer $PROXY_AUTH_TOKEN" http://127.0.0.1:8317/v1/models`
2. Only then set `PROXY_ALL=1`.

Doing it the other way round routes every Claude stage into a proxy with no
Claude provider, and every stage fails. Note `src/config.ts` defaults
`proxyAll` to **true** when `PROXY_ALL` is unset, and no call site ever sets
`opts.viaProxy` — so "unset" is not a safe middle ground, it is the same as 1.

### A caveat worth weighing

Subscription (Pro/Max) OAuth tokens are issued for first-party use. Serving
them through a third-party proxy — and pooling several accounts to raise
throughput — is a different use from what they were issued for, and carries a
real risk of rate-limiting or account action. Metered API keys in
`claude-api-key:` carry no such ambiguity. Worth deciding deliberately before
wiring several personal accounts into an autonomous factory.

## Security

- **Every port binds to `127.0.0.1` only.** This is an authenticated proxy in
  front of your real LLM accounts; it must never be reachable from the network.
  `src/config.ts` enforces the matching constraint and throws on a non-loopback
  `PROXY_BASE_URL`.
- `api-keys` in `config.yaml` gates every request. The daemon sends it as
  `ANTHROPIC_AUTH_TOKEN` (`src/agents.ts` `runOneAttempt`); it must equal
  `PROXY_AUTH_TOKEN` in `.env`. Requests with a missing or wrong key get a 401.
- `remote-management.allow-remote` is `false` and the secret key is empty — the
  factory never uses the management API.
- `PROXY_AUTH_TOKEN` is in the secret-redaction set, so it is scrubbed from
  every outbound comment and PR body (`tests/redact.test.ts`).

## Degradation

If the proxy is down, unauthenticated, or has no account for the requested
model, `src/agents.ts` catches the failure, falls back to a Claude reviewer,
and tags the run `degraded`. The pipeline still completes and still opens a PR
— it just loses cross-vendor independence on that leg. The failure is a fast
502, not a hang, so a dead proxy costs a retry rather than a stage deadline.
