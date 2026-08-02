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
- Lane semantics on FAC: `Todo` = queue · `Blocked` = paused, retryable (cap hit,
  failed deps/gates, failed plan/bootstrap, intake waiting on an answer) ·
  `Needs Human` = the factory STOPPED (guarded paths, taste/security/verification
  fail, test-count drop, merge-integrity refusal, broken contract) ·
  `In Progress` = claimed/executing · `In Review` = PR open, awaiting Adam ·
  `Done`/`Canceled` = human-set.
- `Blocked` and `Needs Human` are the same Linear TYPE as `Todo` (`unstarted`) on
  purpose: the **label**, never the column, is what holds an issue out of the
  queue, so requeueing stays one reversible edit — remove `Factory-Parked` /
  `Factory-Needs-Human` / `Factory-Awaiting-Answer` and the daemon picks it up
  again from wherever it sits. Each factory-owned column carries an immutable
  `[factory:<kind>]` tag in its Linear *description*; that tag, not the column
  name, is what `src/linear.ts` resolves against, so renaming a column is safe.
  `bun run board:setup` creates/tags the columns (dry-run by default).

## Epics (PLAN stage, v1.1)

Label a ticket `Factory-Epic` (only ## Goal + ## Repo required) and the planner
takes it instead of the pipeline: a scout researches the repo + web, a decomposer
files 2–6 contract-conforming child tickets under it (non-overlapping ## Area
each, all parallel-safe), the parent becomes tracking-only (`Factory-Planned`).
Children then flow through the normal pipeline, in parallel up to WIP.

## The bookends (Gap 5): idea → repo → deploy

Three entry/exit points make "project" literal. All ship private-by-default and
OFF-by-default; guarded paths and the registry card stay human-gated.

**Intake authoring** (`Factory-Intake` label, or a `type: idea` factory block).
A rough idea does not go straight to the planner: the intake author turns it into
a full epic contract, interviewing the human ONLY on genuine ambiguity. Two
outcomes — AUTHORED (rewrites the description with a `type: epic` block and
requeues; the planner takes over) or AWAITING (posts questions, labels
`Factory-Awaiting-Answer`, and waits — answer + remove the label to requeue).

**Bootstrap** (`Factory-Bootstrap` label, or a `type: bootstrap` block). idea →
`gh repo create --private` → a scaffolder seeds a repo whose typecheck+build+test
pass green on a clean baseline → the green scaffold is pushed → a build epic is
filed and the proposed `projects/<name>.md` registry card is posted for a human
to add via review (projects/ is a guarded path). Set `FACTORY_BOOTSTRAP_ORG` or
name `## Repo\norg/name`. Repos are ALWAYS private.

**Post-merge deploy/verify/revert** (`projects/<name>.md` cards). For a project
whose card has `deployEnabled: true` — AND the global `DEPLOY_ENABLED` kill-switch
is on — a newly-merged main SHA is deployed and smoke-tested; a smoke failure
AUTO-REVERTS (a direct revert on auto-merge repos, a revert PR + human escalation
on review repos). deploy/smoke commands are TRUSTED and come ONLY from the
human-reviewed card, never from ticket text. Exactly-once per merged SHA; a SHA
that is no longer main's head is skipped, never reverted.

### Project registry card (`projects/<name>.md`)

```yaml
---
name: my-project
team: FAC                 # Linear team KEY it files into
repos: [org/my-project]   # repos this project owns
merge: review             # review | shadow | auto — a bootstrapped repo STARTS at review
deployEnabled: false      # per-card deploy arm (fail-closed; a bare `true` arms it)
# deploy: <trusted deploy command>   # human-reviewed only; never from ticket text
# smoke: <trusted smoke command>
---
Freeform notes about the project.
```
