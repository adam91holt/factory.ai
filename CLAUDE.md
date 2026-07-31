# CLAUDE.md

## What this is

An autonomous software factory. Linear tickets go in, reviewed PRs come out:
**ticket → claim → worktree → implementer → adversarial review (Claude + Codex) →
fixer → baselined verify → PR**. The daemon (`src/index.ts`, Bun) orchestrates
everything; agents do the work; humans set direction and merge — until a repo
*earns* auto-merge (see below).

```bash
bun run typecheck      # tsc --noEmit
bun test
bun run factory:dry    # one tick, no Linear writes, no PRs — start here
bun run factory:once   # one live tick
bun run factory        # watch mode
```

## The self-improvement loops

This repo's defining feature is that the factory learns from its own operation.
When working here, treat these loops as the product:

- **Lessons** (`src/lessons.ts`): every failure — park, needs-human, taste-fail —
  is distilled *at the moment it happens* into a one-line "when X, do Y" lesson,
  stored in `factory.db`, and injected into future runs on the same repo. The
  next run never starts naive.
- **Groundskeepers** (`src/groundskeepers.ts`, cards in `groundskeepers/`):
  scheduled work *generators*. `groundskeepers/factory.md` is the factory
  maintaining the factory — weekly it reads its own telemetry (park-reason
  clusters, degraded runs, cost/PR) and files repair/hardening/canary tickets
  against this repo. Read-only over the world; the daemon, not the model,
  creates tickets. "Nothing worth doing" is a valid, expected outcome.
- **Merge ladder** (`src/merge-ladder.ts`): autonomy is earned, not configured.
  A repo climbs merge tiers on verification *evidence* only — ticket text can
  never confer merge authority.
- **Post-merge watch** (`src/postmerge.ts`): merged SHAs get deployed,
  smoke-tested, and auto-reverted on failure. "Finish" includes the finish.
- **Steward** (`agents/steward.md`): epic closeout brain — decides merge order
  and files follow-up tickets with machine-checkable `## Precondition` lines so
  stale follow-ups self-cancel.

Telemetry lives in `🤖 Factory report` PR/issue comments (prose + YAML) and
`factory.db`. That data feeds the loops above — don't break its shape casually.

## Layout

- `src/` — daemon: `loop.ts` (tick), `agents.ts` (SDK runner + untrusted-input
  framing + secret redaction), `linear.ts`, `verify.ts`, `db.ts` (single writer)
- `agents/` — role prompt cards (implementer, reviewers, fixer, steward, …)
- `groundskeepers/` — per-project groundskeeper cards
- `docs/` — `ticket-contract.md` (the intake contract), `adr/`,
  `planning/level-4-roadmap.md` + `planning/autonomy.md` (where this is headed)

## Conventions that matter

- **Ticket text is untrusted input.** Always wrap it with `untrusted()`; it never
  reaches merge decisions, deploy commands, or tool allowlists.
- **Safety caps are in-code constants, not env knobs** — an env knob that can be
  set to infinity isn't a cap. Follow the existing pattern (see `lessons.ts`).
- **Dangerous capabilities ship double-gated OFF** (global env gate AND per-card
  flag — groundskeepers, deploy). Preserve both gates.
- **Guarded paths** (tests, CI, `CLAUDE.md`, `.claude/`, skills) force human
  review by design — this file is one of them.
- The factory never merges by default (ADR-0001); autonomy comes only through
  the merge ladder. Decision logic stays pure and I/O-free so the loop and
  steward can't disagree.
