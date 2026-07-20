# Ticket contract (v1)

The ticket is the contract between Adam and the factory. A FAC issue is **eligible**
when its description contains these sections (checked by the daemon before claiming):

```markdown
## Goal
One paragraph: the outcome, not the implementation.

## Why
Why this matters / what it unblocks.

## Outcomes
- [ ] Observable result 1
- [ ] Observable result 2

## Repo
org/name (e.g. RapidoNZ/service.haydn.shopify-inventory-sync) — the repo the change
lands in. One repo per ticket in v1; multi-repo work becomes sibling tickets.

## Verifications
- Automated: what the verify gate should run/confirm (tests, tsc, build)
- Manual: what Adam checks at PR review
- Visual: screenshots/UI checks, if any

## Implementation approach   <!-- optional -->
Only where Adam has real steer; otherwise leave implementation to the implementer.
```

Rules:
- **Ineligible tickets are not guessed at.** Missing sections → the daemon posts a
  "needs human" comment listing what's missing and skips the issue.
- **Closing is gated on Outcomes checkboxes.** The factory never closes a ticket with
  unchecked boxes; the human merges the PR and ticks what they verified.
- Ticket-origin text is untrusted input: it is delimited before reaching any agent,
  and no agent's instructions can be overridden by it (see loop.ts).
- Lane semantics on FAC: `Todo` = queue · `In Progress` = claimed/executing ·
  `In Review` = PR open, awaiting Adam · `Done`/`Canceled` = human-set.

## Epics (PLAN stage, v1.1)

Label a ticket `Factory-Epic` (only ## Goal + ## Repo required) and the planner
takes it instead of the pipeline: a scout researches the repo + web, a decomposer
files 2–6 contract-conforming child tickets under it (non-overlapping ## Area
each, all parallel-safe), the parent becomes tracking-only (`Factory-Planned`).
Children then flow through the normal pipeline, in parallel up to WIP.
