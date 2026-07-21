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

## Groundskeeper spec v2 (Adam, 2026-07-20 late — supersedes the single-loop sketch above)

**Per-project loop masters, config-defined:** `groundskeepers/<name>.md` — one card per project/venture, same pattern as agent cards:
```yaml
---
name: kiwi-quest
enabled: false            # ships disabled; flipping this is a deliberate act
schedule: "0 7 * * *"     # cron, per-groundskeeper
team: FAC                 # Linear team it files into
repos: [adam91holt/kiwi-quest]
model: claude-fable-5     # the loop master's own mind
agents: [scout, design-reviewer]   # cards it may consult during its review
tools: [Read, Glob, Grep, WebSearch]
budget: { perRun: 3, weekly: 15 }  # its own envelope, USD-notional
maxTicketsPerRun: 2
---
<charter body: goals, taste bar, what "worth doing" means for THIS project,
what to monitor (telemetry queries, repo health), anti-goals>
```
**Daemon**: a cron evaluator tick reads the registry; due + enabled groundskeepers run as a stage (Fable-class by default): review the project (repos, board, SQLite telemetry, past closeouts) → file 0..maxTickets contract-conforming tickets into its team → log "nothing worth doing" with reasoning as a first-class outcome. Governance unchanged and non-negotiable: envelope exhausted → sleep; human tickets outrank; skip run when the team's pr_open/needs_human pile exceeds the attention cap; skip + file repair tickets instead when parks spike. Absorber note: schedule layer → first-party Routines when mature; the cards and charters are the durable part.

## Queued build: catalog manager UI (after telemetry + groundskeeper)
Mission-control page for managing the org: list/edit agent cards (`agents/*.md`), skills (`skills/*/SKILL.md`), and groundskeeper cards — frontmatter as a form (model, tools, effort, schedule, enabled, budget), prompt/charter as an editor, diff preview before save. Server: read/write endpoints restricted to those directories (path-traversal guarded), every save = a git commit (audit trail; the factory's own guarded-path rule applies — catalog edits via UI are human acts, so direct commit is correct). Show per-card usage stats from telemetry (runs, cost, findings) so pruning weak cards is evidence-based.

## Next epic (after FAC-14 lands — same subsystem, must not run concurrently): Worker pool — specialists with bundled capabilities

**Adam, 2026-07-21:** the factory should call on specific worker agents for particular purposes, each given its own skills, MCP servers, and tools. This is the deferred "crews" concept made concrete, and it's what lets the factory work beyond code.

Today the catalog has flat role cards (implementer/reviewer/…) with `model/tools/effort/skills`. Extend cards into **capability-bundled worker specialists**:
- **MCP servers per card** — a card declares which MCP servers it gets (SDK `mcpServers` per query). e.g. a `data-analyst` worker gets a read-only Mongo MCP; a `researcher` gets web/search; a `support-triage` worker gets ZohoDesk; a Rapido worker gets Linear + client Mongo. This connects the factory to Adam's real ventures, not just repos.
- **Richer tools** — built-in tools + custom in-process SDK MCP tools (the `proxy_models` pattern from codexProxyTest).
- **Skills** (already on cards) — grow the skills library, attach per worker.
- **Purpose-routing** — the planner/decomposer (or a ticket label / classifier) picks the right worker for each child by matching work-type to the card's `when-to-use`, so a child gets a specialist with exactly the tools/MCP/skills it needs. This is classify-and-act from the dynamic-workflows templates.

Result: a **dispatchable worker pool** — the factory selects the right specialist (own model, tools, MCP, skills) per job, code or non-code. Governance carries over: MCP servers per card are an allowlist (no ambient MCP), read-only where possible, secrets never in worker env, cards editable only via the catalog manager's git-committed, validated saves.

Decompose (foundation-first): (1) extend the card schema + loader for `mcpServers` + validate against an allowlist; (2) thread per-card MCP/tool/skill config through `runStage`; (3) worker-selection in plan/loop (label wins, else classify by when-to-use); (4) 1–2 real specialist cards proving a non-code MCP path (e.g. a read-only data-analyst); (5) catalog-manager UI support for MCP fields. Anti-goals: no ambient/unrestricted MCP; no write-capable MCP without human-review gating; don't let a card grant itself Bash/bypass via save (the catalog manager's immutable-armed-fields rule already guards this — extend it to MCP).

### Worker-pool addition: per-epic (and per-ticket) model override
**Adam, 2026-07-21:** model choice is a global env var today — an epic can only run on a premium model by flipping the global switch, which affects all other work and is fragile. Add epic-scoped model routing as part of the worker-pool epic:
- An epic carries a model directive (a `Factory-Model:<id>` label, or a `## Model` line the decomposer reads).
- The **decomposer propagates it to every child** it files (stamps the same label / a frontmatter field).
- The **pipeline reads the per-ticket override** and applies it to that ticket's stages (implementer/fixer/reviewers), falling back to the global default when absent.
- Generalizes to per-ticket: any ticket can request a specific model/worker; the override is a ceiling the governance still bounds (budget caps unchanged).
This is what lets the global default stay cheap (sonnet/opus routing) while high-stakes epics (like FAC-14 self-improvement) opt into Fable end-to-end without a global flip. Until it exists, premium epics require a temporary global change + revert.

## Epic (after worker-pool): Projects — multi-repo registry + new-project bootstrap
**Adam, 2026-07-21:** how the factory works across many projects and spins up new ones.

**Already works (execution layer):** repo is per-ticket (`## Repo`), so the same daemon builds any repo named in a ticket (proven: kiwi-quest + factory.ai same session). Teams are `FACTORY_TEAM_KEYS` config; merge trust is the per-repo allowlist; groundskeepers already name their repos+team. A "project" is already a bundle of {team, repos, merge tier, groundskeeper, workers} — just scattered.

**Build:**
1. **Project registry** — `projects/<name>.md` cards (like groundskeeper cards) bundling: Linear team, repo(s), merge policy tier, groundskeeper, which worker specialists + MCP servers + secrets that project's work gets. Onboarding a venture/client = one card. The factory reads the registry to know which teams to watch and how to treat each repo (replaces scattered env: FACTORY_TEAM_KEYS, MERGE_AUTO_REPOS all move into cards). Model on the triage-agent's @rapido/clients pattern.
2. **New-project bootstrap** — a capability (worker or epic type) that goes idea → running repo: `gh repo create`, scaffold the chosen stack with GREEN gates (typecheck/build/test), seed a CLAUDE.md + ticket-contract, push initial commit, register the project card. Then normal epics build into it. Closes the day-one "idea in → complete system out" loop.
3. **Existing-complex-project resolution** — for repos that are docs hubs routing to real code (the Rapido hub → fck.mongo/service.* pattern, see rapido-operational-picture): the factory clones the hub, reads its CLAUDE.md router, and worktrees the named sibling code repos. Multi-repo tickets get an ordered PR list (the deferred changeset contract) rather than auto-merge-across-repos.

Anti-goals: bootstrap must not auto-create public repos or push secrets; new repos default to private + human-gated merge until trust is earned per the merge-policy ramp; the registry never grants a project's workers ambient MCP/secrets — allowlisted per card.
