# ADR-0002: Factory runs standalone — never co-runs with the triage-agent

**Date:** 2026-07-20 · **Status:** Accepted

## Context

The adversarial review (C3) found that running the factory and the existing
`~/ProjectManagement/apps/triage-agent` daemon over the same issue population creates
claim collisions (the triage agent polls ALL workspace triage-state issues every 60s)
and two competing ticket contracts. Plan v0.2 originally proposed a
`Triage-Done → Ready-for-Factory` handshake for client teams.

## Decision (Adam, 2026-07-20)

The two systems will NOT run together. The factory:
- Uses the triage-agent's code as a **pattern reference only** (claiming, `dontAsk`
  + allowlist, sentinel comments, YAML meta, never-clobber checkouts).
- Watches only the teams in `FACTORY_TEAM_KEYS` (v1: `FAC`, which has triage disabled
  and is invisible to the triage-agent by construction).
- Owns its whole pipeline including intake conventions (ticket contract in
  `docs/ticket-contract.md`).

## Consequences

- No handshake states or cross-daemon coordination code exists in the factory.
- Client teams onboard by **adding their team key to config** — at which point the
  triage-agent's coverage of that team should be turned off (`ONLY_TEAM_KEY` filtering
  or retirement), never overlapped. Cutover criteria are an open decision (plan §10.6).
