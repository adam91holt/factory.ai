# The Software Factory

Linear-driven agent pipeline: **ticket → claim → worktree → implementer → framing-stripped
adversarial review (Claude + Codex) → fixer → baselined verify → PR → human merge**.

Built per `../FACTORY-PLAN.md` (v0.2, post-adversarial-review). Scope v1: the **FAC**
Linear team only; future teams are a `FACTORY_TEAM_KEYS` config change (ADR-0002:
never co-runs with the ProjectManagement triage-agent).

## Stack

- **Claude Agent SDK** (≥0.3.215) — Claude roles run on direct SDK auth (your local
  Claude Code login). No API key needed.
- **CLIProxyAPI** (loopback, ≥v7.2.91) — carries ONLY the tool-less Codex reviewer leg
  (`gpt-5.6-sol`); try/catch fallback to a Claude reviewer with a `degraded` tag.
- **Linear GraphQL** — polling, no webhooks. Personal API key stays in the daemon;
  workers get a scrubbed env and never see it.
- **git worktrees** under `~/FactoryWork` (never `~/RapidoCoding`), branches
  `factory/<issue-key>`, PRs via `gh`.

## Run

```bash
cp .env.example .env   # fill LINEAR_API_KEY + PROXY_AUTH_TOKEN
npm install
npm run typecheck
npm run factory:dry    # one tick, no Linear writes, no PRs
npm run factory:once   # one live tick
npm run factory        # watch mode (60s serial ticks)
```

## How an issue flows

1. Create a FAC issue in **Todo** following `docs/ticket-contract.md`
   (Goal / Why / Outcomes / Repo / Verifications). Missing sections → "needs human"
   comment, never a guess.
2. The daemon claims it (label `Factory-Executing` + state **In Progress**, verified
   by re-read; re-checked before every mutating step).
3. Pipeline runs in a fresh worktree; gates are **baselined** on the untouched repo
   first — a gate that fails on clean `origin/main` is classified no-gate rather than
   burning repair iterations.
4. PR opens, factory report lands as a `🤖 Factory report` comment (human prose +
   YAML meta — this is the telemetry store), issue moves to **In Review**.
5. **You merge.** The factory never merges (ADR-0001). Caps/failures park the issue
   back to Todo with the worktree kept and the report saying exactly where it stopped.

## Guardrails wired in

Scrubbed worker env (no Linear key, no Mongo string) · untrusted-input delimiters
around all ticket text · secret-regex scan on every outbound comment/PR body ·
guarded-path detection (tests/CI/`CLAUDE.md`/`.claude/`/skills → flagged in the
report for categorical human review) · `dontAsk` + explicit tool allowlists ·
turns/wall-clock/iteration caps with `maxBudgetUsd` as backstop · single-instance
lease + claim re-verification.

## Not yet built (deliberately — see plan §8 backlog + verdict)

Machine GitHub identity + per-repo PATs (uses your `gh` login until then — plan §6.1
guardrail 1 is the FIRST backlog item before any unattended operation), sandbox
settings for write roles, heartbeat/TTL watcher, post-merge watch, Routines
scheduler, Channels CI watcher, intake authoring agent, campaign mode (Milestone B).

## ADRs

- `docs/adr/0001-defer-branch-protection.md`
- `docs/adr/0002-standalone-not-coupled-to-triage-agent.md`
