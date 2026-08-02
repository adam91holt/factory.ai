# Graph Report - factory.ai  (2026-08-02)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1405 nodes · 3785 edges · 61 communities (58 shown, 3 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 73 edges (avg confidence: 0.7)
- Token cost: 39,761 input · 2,455 output

## Graph Freshness
- Built from commit: `db6dafa4`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Alerting and Stage Control
- Main Orchestration Loop
- Dashboard API Client
- App Shell and Pages
- Database Layer
- Queue and Spend UI
- Approvals UI
- Agent Card Routing
- Shared UI Event Types
- Git Workspace Management
- Catalog Browser UI
- Approval Actions
- Config and Ladder Tiers
- Catalog Manager
- Dashboard Server
- Gate Smoke Testing
- Agent Stage Runner
- Queue Label States
- Precondition Freshness Checks
- Verification and Reporting
- Groundskeeper Scheduling
- Run Outcome Panels
- Lessons Capture
- Factory Metadata Parsing
- Frontend Dependencies
- Daemon Lease and Backoff
- Linear Board Setup
- Agent Card Catalog
- UI Build Config
- Merge Ladder
- Event Store Backend
- Daemon Event Bus
- Linear API Integration
- Issue and History Tables
- Run Board UI
- TypeScript Config
- Project Bootstrap
- Shadcn Components Config
- Linear Transport Health
- DB Cast Discipline Tests
- Package Scripts
- Ticket Planning
- Dependency DAG Scheduling
- UI Build Dependencies
- Root Package Manifest
- Ticket Intake
- CLI Proxy Credential Import
- Dev Dependencies
- Board State Validation
- Agent Retry Tests
- CLI Proxy Smoke Test
- UI Package Manifest
- Structured Output Tests
- Queue Fetching
- Pre-Merge Integrity
- Subagent Cost Probe
- Tool Feed UI
- Event Stream Smoke Test
- Park Reason Smoke Test

## God Nodes (most connected - your core abstractions)
1. `cn()` - 89 edges
2. `processIssue()` - 83 edges
3. `redactSecrets()` - 41 edges
4. `usd()` - 37 edges
5. `config` - 34 edges
6. `runStage()` - 26 edges
7. `bus` - 26 edges
8. `bootstrapProject()` - 25 edges
9. `startDashboard()` - 23 edges
10. `planIssue()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `planBoard()` --indirect_call--> `s()`  [INFERRED]
  scripts/board-setup.ts → tests/dag.test.ts
- `tick()` --indirect_call--> `issue()`  [INFERRED]
  src/index.ts → ui/src/lib/fixtures.ts
- `lessonsForRepo()` --indirect_call--> `row()`  [INFERRED]
  src/lessons.ts → tests/precondition.test.ts
- `recoverOrphanedClaims()` --indirect_call--> `issue()`  [INFERRED]
  src/linear.ts → ui/src/lib/fixtures.ts
- `reconcileTick()` --indirect_call--> `issue()`  [INFERRED]
  src/reconcile.ts → ui/src/lib/fixtures.ts

## Import Cycles
- None detected.

## Communities (61 total, 3 thin omitted)

### Community 0 - "Alerting and Stage Control"
Cohesion: 0.06
Nodes (42): abortAllStages(), activeStageCount(), AlertDeps, AlertPayload, defaultDeps, deliverAlert(), startAlerts(), toAlertPayload() (+34 more)

### Community 1 - "Main Orchestration Loop"
Cohesion: 0.09
Nodes (50): shouldFileApproval(), toStageMeta(), GATE_OUTPUT_SCHEMA, GateOutput, buildLessonsBlock(), lessonsForRepo(), abortExternal(), browserEvidenceFromGate() (+42 more)

### Community 2 - "Dashboard API Client"
Cohesion: 0.08
Nodes (47): fetchRunEvents(), fetchRuns(), fetchState(), fetchTelemetry(), FactoryEvent, FactoryEventBody, MissionState, board() (+39 more)

### Community 3 - "App Shell and Pages"
Cohesion: 0.10
Nodes (22): AppShell(), ConnectionDot(), LABEL, MODE_LABEL, Topbar(), useFactory(), QueuePage(), RunsPage() (+14 more)

### Community 4 - "Database Layer"
Cohesion: 0.11
Nodes (41): activeLessonRowsForRepo(), allLessonRows(), catalogUsage(), clearStageSession(), closeTestDatabase(), computeTelemetry(), dayKey(), DDL (+33 more)

### Community 5 - "Queue and Spend UI"
Cohesion: 0.09
Nodes (29): QueueTable(), IssueDetail, Lineage, TicketPanel(), DailySpend(), Day, parts(), WEEKDAY (+21 more)

### Community 6 - "Approvals UI"
Cohesion: 0.10
Nodes (38): item(), ApprovalCard(), ApproveButton(), EvidenceChip(), EvidenceStrip(), PushbackForm(), verdictTone(), currentModel() (+30 more)

### Community 7 - "Agent Card Routing"
Cohesion: 0.09
Nodes (35): CardRejection, CardSelection, factHolds(), FIXER_TOOLS, IMPLEMENTER_TOOLS, KNOWN_GATE_NAMES, ORCHESTRATION_TOOLS, parseTermList() (+27 more)

### Community 8 - "Shared UI Event Types"
Cohesion: 0.12
Nodes (31): NOTE: like every test that imports ui/src, this file needs BOTH installs:, BrowserEvidence, DaemonMode, GateMeta, GateStrength, MergeTier, NOTE: issue descriptions are deliberately NOT included in any event., RunOutcome (+23 more)

### Community 9 - "Git Workspace Management"
Cohesion: 0.11
Nodes (38): buildWorkspace(), classifyPaths(), classifyStatusPaths(), commitsBehindBase(), countMatches(), createRevertPr(), DIFF_FAILED, diffAgainstBase() (+30 more)

### Community 10 - "Catalog Browser UI"
Cohesion: 0.08
Nodes (36): CatalogDetail(), KIND_LABEL, SOURCE_LABEL, CatalogList(), ListRow, DiffView(), FrontmatterHeader(), FindingsPanel() (+28 more)

### Community 11 - "Approval Actions"
Cohesion: 0.11
Nodes (39): redactSecrets(), ApprovalActionResult, approvalEvidenceMatches(), ApprovalInput, ApproveDeps, approveItem(), defaultApproveDeps, defaultPushbackDeps (+31 more)

### Community 12 - "Config and Ladder Tiers"
Cohesion: 0.09
Nodes (31): ADR-0003, EFFORT_VALUES, EffortLevel, LADDER_TIERS, parsePairs(), serverOnly, tierModel(), tierPair() (+23 more)

### Community 13 - "Catalog Manager"
Cohesion: 0.09
Nodes (31): invalidateCard(), AgentEntry, AGENTS_DIR, bad(), cardRouting(), CatalogKind, CatalogPayload, commitBlockers() (+23 more)

### Community 14 - "Dashboard Server"
Cohesion: 0.13
Nodes (26): approvalsView(), FactoryEventBody, MissionState, listLessons(), getIssueDetail(), IssueDetail, applyEvent(), contentType() (+18 more)

### Community 15 - "Gate Smoke Testing"
Cohesion: 0.11
Nodes (25): args, BASE, direct, failed, models, Outcome, rows, run() (+17 more)

### Community 16 - "Agent Stage Runner"
Cohesion: 0.10
Nodes (27): activeStages, backoffMs(), compactModelUsage(), defaultDeps, DENY_ORCHESTRATION, DENY_SIDE_CHANNELS, FORBIDDEN_GIT_SUBCOMMANDS, forbiddenToolViolations() (+19 more)

### Community 17 - "Queue Label States"
Cohesion: 0.18
Nodes (8): AWAITING_ANSWER_LABEL, EXECUTING_LABEL, HOLD_LABELS, NEEDS_HUMAN_LABEL, PARKED_LABEL, PLANNED_LABEL, STALE_LABEL, RawNode

### Community 18 - "Precondition Freshness Checks"
Cohesion: 0.13
Nodes (23): checkFreshness(), decideFreshness(), defaultProbes, describe(), evaluateOne(), FreshnessAction, isSafeRelPath(), KNOWN_KINDS (+15 more)

### Community 19 - "Verification and Reporting"
Cohesion: 0.12
Nodes (29): StageResult, SENTINEL, buildReport(), GateVerdictEntry, ReportInput, RoutingEntry, baseline(), BaselineRun (+21 more)

### Community 20 - "Groundskeeper Scheduling"
Cohesion: 0.14
Nodes (23): CRON_FIELD_RANGES, cronMatches(), fieldMatches(), forwardStage(), GkState, GROUNDSKEEPERS_DIR, groundskeeperTick(), loadGroundskeepers() (+15 more)

### Community 21 - "Run Outcome Panels"
Cohesion: 0.16
Nodes (17): OutcomeBadge(), Status, OutcomeClassBadge(), DeployPanel(), gateBadge(), GatePanel(), Gate(), gateBadge() (+9 more)

### Community 22 - "Lessons Capture"
Cohesion: 0.12
Nodes (23): archiveLessonRow(), insertLessonRow(), LessonRow, lessonRowCountSince(), archiveLesson(), capGate, captureLesson(), distillerCallsToday() (+15 more)

### Community 23 - "Factory Metadata Parsing"
Cohesion: 0.24
Nodes (16): EFFORT_VALUES, FactoryMeta, GATE_STAGES, isKnownEffort(), isKnownModel(), metaPinsModel(), parseFactoryMeta(), renderFactoryMeta() (+8 more)

### Community 24 - "Frontend Dependencies"
Cohesion: 0.09
Nodes (23): class-variance-authority, clsx, @fontsource/ibm-plex-mono, @fontsource/space-grotesk, @formkit/auto-animate, lucide-react, react, react-dom (+15 more)

### Community 25 - "Daemon Lease and Backoff"
Cohesion: 0.13
Nodes (18): LinearBackoff, LinearBackoffOptions, acquireLease(), inFlight, LEASE, pace(), runBackgroundPasses(), tick() (+10 more)

### Community 26 - "Linear Board Setup"
Cohesion: 0.17
Nodes (21): applyChange(), BOARD, Change, deps, describe(), fetchTeam(), gql(), KindSpec (+13 more)

### Community 27 - "Agent Card Catalog"
Cohesion: 0.15
Nodes (22): AGENTS_DIR, cache, Card, cardEffort(), cardTools(), getCard(), listCards(), listRoutableCards() (+14 more)

### Community 28 - "UI Build Config"
Cohesion: 0.10
Nodes (20): DOM, DOM.Iterable, ES2022, src, vite.config.ts, compilerOptions, forceConsistentCasingInFileNames, isolatedModules (+12 more)

### Community 29 - "Merge Ladder"
Cohesion: 0.20
Nodes (19): getLadderState(), recordShadowDecision(), BrowserEvidence, MergeTier, advanceLadder(), ceilingFor(), ceilingForRepo(), effectiveMergeTier() (+11 more)

### Community 30 - "Event Store Backend"
Cohesion: 0.20
Nodes (11): drain(), enqueue(), migrate(), openTestDatabase(), safeStoreTarget(), startEventStore(), writeBatch(), bunStore() (+3 more)

### Community 31 - "Daemon Event Bus"
Cohesion: 0.10
Nodes (17): bus, DaemonMode, GateMeta, GateStrength, Lane, QueueIssue, NOTE: issue descriptions are deliberately NOT included in any event., ring (+9 more)

### Community 32 - "Linear API Integration"
Cohesion: 0.12
Nodes (27): sweepOrphanedClaims(), addLabel(), boardStatesForIssue(), claim(), createIssue(), createSubIssue(), defaultDeps, fetchByLabel() (+19 more)

### Community 33 - "Issue and History Tables"
Cohesion: 0.14
Nodes (28): isFactoryLabel(), IssueCard(), LANE_KEY_COLOR, CostSparkbar(), duration(), HistoryTable(), ModelDots(), modelFamily() (+20 more)

### Community 34 - "Run Board UI"
Cohesion: 0.18
Nodes (17): BoardLane(), CostMeter(), RunCard(), segClass(), isCodex(), StageDetail(), isCodex(), segmentClass() (+9 more)

### Community 35 - "TypeScript Config"
Cohesion: 0.12
Nodes (16): bun, node, src/**/*.ts, tests/**/*.ts, compilerOptions, allowImportingTsExtensions, module, moduleResolution (+8 more)

### Community 36 - "Project Bootstrap"
Cohesion: 0.24
Nodes (14): untrusted(), BootstrapPlan, bootstrapProject(), buildBootstrapEpic(), buildProjectCard(), extractStack(), forwardStage(), parseBootstrapPlan() (+6 more)

### Community 37 - "Shadcn Components Config"
Cohesion: 0.12
Nodes (16): aliases, components, lib, ui, utils, iconLibrary, rsc, $schema (+8 more)

### Community 38 - "Linear Transport Health"
Cohesion: 0.15
Nodes (8): ConnectionHealth, FRESH_CONNECTION_AFTER, gqlWith(), LinearRateLimited, LinearTransportDeps, LOUD_LOG_AFTER, attempt(), okBody

### Community 39 - "DB Cast Discipline Tests"
Cohesion: 0.15
Nodes (8): AGGREGATES, CLEAN, INTERPOLATED, needsCast(), NUMERIC_COLUMNS, Projection, SOURCE, SQL_LITERALS

### Community 40 - "Package Scripts"
Cohesion: 0.14
Nodes (14): scripts, board:setup, db:down, db:psql, db:up, factory, factory:dry, factory:once (+6 more)

### Community 41 - "Ticket Planning"
Cohesion: 0.29
Nodes (10): ChildSpec, createChildren(), escapeRegExp(), extractSection(), findUndeclaredGlueTouches(), forwardStage(), KNOWN_GLUE_BASENAMES, planIssue() (+2 more)

### Community 42 - "Dependency DAG Scheduling"
Cohesion: 0.28
Nodes (10): deriveImplicitDeps(), globsOverlap(), ImplicitDepAddition, isPathPrefix(), Schedulable, selectRunnable(), staticPrefix(), ticketNumber() (+2 more)

### Community 43 - "UI Build Dependencies"
Cohesion: 0.15
Nodes (13): tailwindcss, @tailwindcss/vite, @types/react, @types/react-dom, devDependencies, tailwindcss, @tailwindcss/vite, @types/react (+5 more)

### Community 44 - "Root Package Manifest"
Cohesion: 0.17
Nodes (11): @anthropic-ai/claude-agent-sdk, dependencies, @anthropic-ai/claude-agent-sdk, description, engines, bun, node, name (+3 more)

### Community 45 - "Ticket Intake"
Cohesion: 0.38
Nodes (9): buildEpicUpgrade(), decideIntake(), extractContract(), extractQuestions(), forwardStage(), IntakeDecision, runIntake(), ensureWorkspace() (+1 more)

### Community 46 - "CLI Proxy Credential Import"
Cohesion: 0.20
Nodes (7): RFC-3339, apply, AUTHS_DIR, CONFIG, CREDS, outFile, record

### Community 47 - "Dev Dependencies"
Cohesion: 0.20
Nodes (10): @electric-sql/pglite, devDependencies, @electric-sql/pglite, @types/bun, @types/node, typescript, typescript, @types/bun (+2 more)

### Community 48 - "Board State Validation"
Cohesion: 0.24
Nodes (8): OPTIONAL_STATE_KINDS, REQUIRED_STATE_KINDS, STATE_NAME, STATE_TAG, STATE_TYPE, legacy(), st(), tagged()

### Community 50 - "CLI Proxy Smoke Test"
Cohesion: 0.22
Nodes (6): BASE, blind, failed, Outcome, rows, targets

### Community 51 - "UI Package Manifest"
Cohesion: 0.22
Nodes (8): name, private, scripts, build, dev, preview, typecheck, type

### Community 53 - "Queue Fetching"
Cohesion: 0.29
Nodes (7): fetchIssuesByStateType(), fetchQueue(), fetchTeamInReview(), fetchTeamQueue(), isReviewLane(), queueLane(), toIssue()

### Community 54 - "Pre-Merge Integrity"
Cohesion: 0.47
Nodes (4): MergeIntegrityDeps, OwnerFeedbackHandoff, preMergeIntegrity(), Workspace

### Community 55 - "Subagent Cost Probe"
Cohesion: 0.40
Nodes (3): CLAUDE_ALIASES, dir, Run

### Community 56 - "Tool Feed UI"
Cohesion: 0.36
Nodes (5): Row(), stageChipClass(), ToolFeed(), Lane, clockTime()

### Community 57 - "Event Stream Smoke Test"
Cohesion: 0.50
Nodes (3): dashboard, decoder, reader

## Knowledge Gaps
- **335 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+330 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `issue()` connect `Dashboard API Client` to `Linear API Integration`, `Daemon Lease and Backoff`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `cn()` connect `Issue and History Tables` to `Run Board UI`, `App Shell and Pages`, `Queue and Spend UI`, `Approvals UI`, `Shared UI Event Types`, `Catalog Browser UI`, `Run Outcome Panels`, `Tool Feed UI`?**
  _High betweenness centrality (0.071) - this node is a cross-community bridge._
- **Why does `tick()` connect `Daemon Lease and Backoff` to `Alerting and Stage Control`, `Linear API Integration`, `Main Orchestration Loop`, `Dashboard API Client`, `Project Bootstrap`, `Ticket Planning`, `Dependency DAG Scheduling`, `Approval Actions`, `Ticket Intake`, `Queue Fetching`, `Factory Metadata Parsing`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Are the 11 inferred relationships involving `processIssue()` (e.g. with `toStageMeta()` and `reviewerTokenVerdict()`) actually correct?**
  _`processIssue()` has 11 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _335 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Alerting and Stage Control` be split into smaller, more focused modules?**
  _Cohesion score 0.061507936507936505 - nodes in this community are weakly interconnected._
- **Should `Main Orchestration Loop` be split into smaller, more focused modules?**
  _Cohesion score 0.08735150244584207 - nodes in this community are weakly interconnected._