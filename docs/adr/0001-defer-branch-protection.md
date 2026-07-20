# ADR-0001: Defer GitHub branch protection

**Date:** 2026-07-20 · **Status:** Accepted (deferred implementation)

## Context

The adversarial review of FACTORY-PLAN v0.1 (C1, R7) established that without branch
protection on the private write-path repos, merge-blocking is honor-system: even with
machine PATs, nothing at GitHub's layer prevents a push/merge to `main`. Branch
protection on private repos requires a paid GitHub tier.

## Decision

Defer. v1 mitigates by policy instead:
- Every PR is human-merged (plan v0.2 §3) — the factory never merges.
- Workers get a machine identity with fine-grained per-repo PATs (`contents:write`,
  no `workflow` scope) — no ambient access to Adam's `gh` login.
- Diffs touching tests/CI/workflows/`CLAUDE.md`/`.claude/**`/skills are flagged for
  categorical human review.

## Consequences

- The "rejected by GitHub" acceptance criterion for merge policy is unachievable until
  this is revisited.
- **Revisit trigger:** before re-introducing `shadow` or `auto` merge tiers (plan §8),
  or before onboarding the first client team with a deploy-wired repo. At that point,
  buy the tier (or migrate write-path repos to an org plan that includes rulesets) and
  make required-checks + restricted-push mechanical.
