# The Software Factory

Linear-driven agent pipeline: **ticket → claim → worktree → implementer → framing-stripped
adversarial review (Claude + Codex) → fixer → baselined verify → PR**. Humans set
direction and merge — until a repo *earns* auto-merge through the evidence-gated
merge ladder.

Tickets route by kind: **task** → pipeline, **epic** → planner (decompose into a
DAG of child tickets, steward closes out), **idea** → intake authoring (rough idea
becomes a contract-conforming ticket), **bootstrap** → new-project scaffolding.
Planning docs live in `docs/planning/` (`level-4-roadmap.md`, `autonomy.md`).

## Stack

- **Claude Agent SDK** (≥0.3.215) — Claude roles run on direct SDK auth (your local
  Claude Code login). No API key needed.
- **CLIProxyAPI** (loopback, ≥v7.2.91) — carries ONLY the tool-less Codex reviewer leg
  (`gpt-5.6-sol`); try/catch fallback to a Claude reviewer with a `degraded` tag.
- **Linear GraphQL** — polling, no webhooks. Personal API key stays in the daemon;
  workers get a scrubbed env and never see it.
- **git worktrees** under `~/FactoryWork`, branches `factory/<issue-key>`, PRs via `gh`.
- **Postgres** (loopback, `docker-compose.yml` → 127.0.0.1:5460) — durable event
  log, telemetry, lessons, merge ladder, approvals. The ONLY production store;
  the daemon talks to it through Bun's built-in client, so there is still no
  runtime dependency to install. `bun test` needs no container — the unit suite
  runs on an in-process PGlite (WASM Postgres) seam.

## Run

```bash
cp .env.example .env   # fill LINEAR_API_KEY + PROXY_AUTH_TOKEN
bun install
bun run db:up          # Postgres on 127.0.0.1:5460 (docker compose up -d)
bun run typecheck
bun run factory:dry    # one tick, no Linear writes, no PRs
bun run factory:once   # one live tick
bun run factory        # watch mode (60s serial ticks)
```

Mission control (live runs, telemetry, lessons, agent catalog) is served on
`127.0.0.1:$DASHBOARD_PORT` in watch mode; `bun run ui:dev` for UI development.

## How an issue flows

0. One-time per team: `bun run board:setup` (dry-run; `-- --apply` to mutate) adds
   the **Blocked** and **Needs Human** columns and stamps every factory-owned
   column with an immutable `[factory:<kind>]` tag in its Linear description.
   `src/linear.ts` resolves columns by state TYPE first and that tag second, so
   renaming a column is safe and an un-migrated board still works unchanged.
1. Create an issue in **Todo** following `docs/ticket-contract.md`
   (Goal / Why / Outcomes / Repo / Verifications). Missing sections → "needs human"
   comment, never a guess.
2. The daemon claims it (label `Factory-Executing` + state **In Progress**, verified
   by re-read; re-checked before every mutating step).
3. Pipeline runs in a fresh worktree; gates are **baselined** on the untouched repo
   first — a gate that fails on clean `origin/main` is classified no-gate rather than
   burning repair iterations. UI changes get an adversarial design-review taste gate.
4. PR opens, factory report lands as a `🤖 Factory report` comment (human prose +
   YAML meta — this is the telemetry store), issue moves to **In Review**.
5. **Merge**: human by default (ADR-0001). The merge ladder
   (`src/merge-ladder.ts`) lets a repo earn `human → shadow → auto-low-risk → auto`
   on verification evidence only — ticket text can never confer merge authority.
6. **Where it stops is visible on the board.** Caps and failures move the issue to
   **Blocked** (paused, retryable — worktree kept, report says exactly where it
   stopped); guarded paths, a failed taste/security/verification gate, a drop in
   passing tests, or a merge-integrity refusal move it to **Needs Human**. Both
   columns are the same Linear type as Todo (`unstarted`) on purpose: the
   `Factory-*` **label**, never the column, is what holds an issue out of the
   queue, so requeueing is one reversible edit — remove the label and the daemon
   picks it up again from wherever it sits.

## The self-improvement loops

- **Lessons** (`src/lessons.ts`): every park / needs-human / taste-fail is distilled
  at the moment it happens into a one-line "when X, do Y" lesson and injected into
  future runs on the same repo (hard-capped, treated as untrusted data).
- **Groundskeepers** (`groundskeepers/`): scheduled read-only work *generators* that
  review a project's repo, board, and telemetry, then file 0..N contract-conforming
  tickets — including `factory.md`, the factory maintaining the factory. Ship
  double-gated OFF (global env gate AND per-card flag).
- **Post-merge watch** (`src/postmerge.ts`): deploy → smoke-test → auto-revert on
  failure, commands only from human-reviewed registry cards. Ships double-gated OFF.
- **Reconcile + spend cap**: board drift self-heals each tick; a trailing-24h
  factory-wide USD cap enters drain mode (finish in-flight, claim nothing new).

## Guardrails wired in

Scrubbed worker env (no Linear key, no connection strings) · untrusted-input
delimiters around all ticket text · secret-regex scan on every outbound
comment/PR body · guarded-path detection (tests/CI/`CLAUDE.md`/`.claude/`/skills →
flagged for categorical human review) · `dontAsk` + explicit tool allowlists ·
turns/wall-clock/iteration caps with per-issue and per-day USD backstops ·
single-instance lease + claim re-verification · kill switch + drain mode.

## Not yet built (deliberately)

Machine GitHub identity + per-repo PATs (uses your `gh` login until then — the
first backlog item before any unattended operation), sandbox settings for write
roles, heartbeat/TTL watcher, CI-watcher channel. The live roadmap is
`docs/planning/autonomy.md`.

## ADRs

- `docs/adr/0001-defer-branch-protection.md`
- `docs/adr/0002-standalone-not-coupled-to-triage-agent.md`
