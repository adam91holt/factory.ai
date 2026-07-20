# The Road to Level 4 — factory.ai planning
**2026-07-20 · Adam Holt · distilled from one day of research, adversarial review, and live operation**

## Where we are

Boris Cherny's "Steps of AI Adoption" ladder: 0 Gated → 1 Assisted → 2 Parallel → **3 Supervised autonomy** → 4 AI-native (~1000+ agents, "steer by intent, monitor by exception", quarter-long work as a kicked-off workflow). Adam started today at step 2. The factory as of tonight is a working 2→3 kit, with the first level-3 behaviors live: Claude files tickets for Claude (planner), Claude judges completed work and decides next steps (steward), work parks instead of failing, everything is auditable (Linear comments + SQLite events + mission control).

**Evidence base** (full docs in `~/LoopEngineering/`): FACTORY-PLAN.md v0.2 (post-adversarial-review), research/loop-orchestration-report.md, research/factory-stack-research-2026-07-20.md, research/rapido-operational-picture-2026-07-20.md, research/factory-plan-review-verdict + factory-code-review-verdict (40 confirmed findings applied).

## Principles that survived the day (with receipts)

1. **Verification is the product.** Loops close on independent checks, not "produced an answer." (Bun; PoC 21/22→22/22.)
2. **Maker ≠ checker; strip the maker's framing.** Redacting implementer reasoning raised reviewer findings 2.4–4.0 → 9.4/review (Orr). One reviewer diff-only (spec lens), one repo-reading (blast radius), design-reviewer for taste.
3. **Spec quality is the ceiling.** Kiwi Quest v1 shipped quiz-cards because the epic said "quiz" and never said "three.js / anti-goals / juice." The system amplified the spec faithfully. Anti-goals are the highest-leverage line in any ticket.
4. **Scaffolding depreciates (~10–20%, wiped by next model — Cherny); policy compounds.** Every component carries an absorber/deletion annotation (scheduler→Routines, CI watcher→Channels, memory curation→Dreaming).
5. **State on disk/Linear, never in conversations.** Worktrees survive parks; resume is file-level; tickets are the contract; SQLite remembers everything.
6. **Caps and failures park, never destroy.** Turn/wall/budget caps, rate-limit windows → labeled terminal states with resume notes.
7. **Every human intervention ends in a remediation** (skill/hub/convention/canary), or it recurs. Today's seven config-failures each owe a canary.
8. **Dry-round honesty.** "Nothing worth doing" is a valid loop output; loops that succeed at wasting effort are the real failure mode (Thariq's 12-hour trap).

## Architecture as built (2026-07-20)

Linear (FAC team) → daemon (Bun, Agent SDK, all stages via CLIProxyAPI multi-account) →
**PLAN** (Factory-Epic → scout research → Fable decomposer → parallel child tickets, foundation-child allowed) →
**EXECUTE** (rolling WIP semaphore, claim w/ re-read verify, worktrees in ~/FactoryWork, implementer → reviewer-spec + reviewer-repo → fixer → design-reviewer on UI diffs → tester where wired → baselined gates) →
**DELIVER** (PR; auto-merge on allowlisted greenfield repos, human gate default; guarded paths/test-deletion always stop) →
**STEWARD** (Fable reviews completed epics: merge order, follow-up tickets, closeout) →
observability: mission control :8787 (SSE) + per-stage Linear comments + SQLite event store (~/FactoryWork/factory.db) + factory-history.jsonl.
Catalog: `agents/*.md` cards + `skills/` packs (game-feel, factory-design) + `docs/design-language.md`.

## The missing rung: the Groundskeeper (self-improvement loop)

A scheduled Fable session — the work *generator*. Wakes on cadence (daemon tick gated on idle+budget; absorber: first-party Routines), reads:
1. **IMPROVE.md — the charter, Adam's steering wheel.** e.g. "Kiwi Quest: one new mode/week from unused NZ data skills; one juice pass/mode/fortnight, game-feel rubric is the bar. Factory: fix the top park-reason cluster. Rapido: (when onboarded) …"
2. The world: repos, skills catalog, open board.
3. Factory telemetry from SQLite: park clusters, degraded-review rate, cost/PR, interventions lacking remediations.

Output: files 1–2 contract-conforming epics/tickets (game modes, polish, or factory-repair tickets against adam91holt/factory.ai itself) **or explicitly logs "nothing worth doing" with reasoning**.

**Non-negotiable governance:** own budget envelope ($/week, spent→sleep); human tickets always outrank groundskeeper tickets; stops generating when Adam's pr_open review pile is full (attention cap); pauses self-improvement when parks spike (a struggling factory files repair tickets, not ambitions).

## Roadmap

**Now (running/landing tonight):** taste layer (design-reviewer, tester, design language, skills), Kiwi Quest v2 epic (3D r3f rebuild, anti-quiz clauses), boundary restart arming everything, steward's first closeout.
**Next:** Groundskeeper + IMPROVE.md (build as a FAC epic — the factory builds its own generator); canary tickets for today's seven config-failures; UI reads /run-events for historic feeds; machine GitHub identity + per-repo PATs before any unattended operation; pm2/launchd + keep-awake.
**Then (level 3 consolidation):** onboard HWS then first client team (triage-agent retired per-team, ADR-0002); hub standardization tickets; test-Accredo + dev-Shopify environments; browser-verify (tester+Playwright) as a blocking gate; effort-scaled caps from the first 20 runs' telemetry.
**Level 4 marker:** Rapido v2 as a campaign the factory runs — characterization-test campaign over fck.mongo as the spec, sharded rebuild, Adam steering by charter + merge policy + exception review only. When the quarter-long migration is "a workflow you kick off and check on," we're there.

## Stop conditions & review

This plan is scaffolding too. Re-read at each model generation; delete what the harness has absorbed; the charter file and merge policy are the only parts meant to be permanent.
