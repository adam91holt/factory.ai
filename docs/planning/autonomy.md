# Complete Autonomy: taking a project start-to-finish unattended

_Written 2026-07-21, after landing FAC-14 (self-improvement) and living through the
FAC-20/21/22 obsolescence incident. This is the "exactly how" answer._

## The thesis

Autonomy is not a feature you bolt on. It is the **removal of each human gate**, and
a gate can only be removed when the automated check that replaces the human's
judgment is trustworthy. So the roadmap to autonomy is not more orchestration —
that part is largely done — it is **coordination, verification, and correctly-placed
authority**. Everything below follows from that one idea.

"Complete autonomy" does not mean zero human. It means the human's input **compresses
to three things**: direction/taste (the charter), risk tolerance (merge policy per
repo), and exception review (the digest). It never goes to zero; it goes to _intent +
exceptions_. That is the target.

## Where we actually are

Genuinely autonomous today, for a **well-specified ticket**:

- INTAKE → PLAN (scout → decomposer) → EXECUTE (implementer → cross-vendor review →
  fixer → taste gate → verify gates) → DELIVER (PR / policy auto-merge) → STEWARD →
  reconcile.
- Cross-vendor adversarial review (Opus + Codex), taste gate, baselined verify gates.
- Self-healing: orphan-claim recovery, session-resume for interrupted runs, reconcile
  tick, park-not-destroy.
- Self-improvement substrate: the lessons flywheel (capture → store → inject → prune).
- Observability: SQLite telemetry, mission control SSE, Linear as system-of-record.

A restart mid-build now recovers the claim and resumes the agent's actual session.
That is real Level-2/3 autonomy _within a build_. What's missing is what turns an
autonomous **builder** into an autonomous **project owner**.

## The gaps — grounded in what we saw today

### Gap 1 — No dependency graph. Siblings fight. (highest leverage)

The decomposer emits children; the WIP semaphore runs them **in parallel with no
ordering**. Siblings that touch the same files race, produce conflicting PRs, and the
steward untangles merge order after the fact. FAC-15/16/18 each rebuilt a duplicate
`lessons.ts` — this exact failure. Uncoordinated parallelism is the single biggest
reason an unattended run produces garbage.

**Fix.** The decomposer must emit a **DAG**, not a list. Each child declares
`depends_on: [ids]` and `touches: [path globs]`. The scheduler runs only the
topological frontier; any two children whose `touches` overlap are **serialized even
if the DAG says they're independent** — a file-level mutex at the _planning_ layer,
above the git layer. "Parallel where safe, sequential where they'd collide."

### Gap 2 — Verification isn't yet strong enough to replace human merge judgment

`factory.ai` is human-merge by policy (correct — self-modifying code). For full
autonomy on _other_ projects, auto-merge has to be **safe**, which means gates that
mean "correct," not just "typecheck passed." Gate strength today maxes at `real` =
"tests exist." Missing: browser/e2e that drives the actual app (the tester +
Playwright is scaffolded — `hasPlaywright()` exists — but not enforced), a security
review stage, and a post-merge smoke.

**Fix.** A per-repo, **evidence-gated merge ladder**: `shadow` (compute the
would-merge decision, record it, don't act) → `auto low-risk` → `auto with strong
gates`. A repo _earns_ auto-merge after N consecutive clean shadow decisions.
Verification strength is the gate, not a config flag someone flips.

### Gap 3 — The steward needs authority, not just investigation

Today the steward is advisory: it writes `summary.md` and files follow-up tickets;
the human merges, the loop reconciles. We just gave it read-only `gh`. But an
autonomous closeout brain should, **within policy**, _act_: order and execute merges
for auto-merge repos, open the integration ticket _with_ deps and model assigned,
escalate only genuine judgment calls. The constraint was never "the steward can't
merge" — it's "the steward can't merge **what policy says needs a human**" (self-mods,
guarded paths).

**Fix.** Give the steward a **policy-scoped mutation surface** (merge in auto-repos,
transition children, file wired-up follow-ups) while the human gate stays exactly where
the risk is. The difference between a steward that _recommends_ and one that _closes
the loop_.

### Gap 4 — No freshness / idempotency. Agents execute stale plans. (we lived this)

The steward filed FAC-20 "make PR #4 mergeable." I merged PR #4 by hand. The ticket
kept grinding against a **closed PR**. Agents act on a world-snapshot that has since
changed.

**Fix.** Every stage **re-validates its premise at start** — the `stillOurs()` pattern,
generalized. An implementer checks the branch/PR still needs the work; a steward
follow-up carries a machine-checkable **precondition** it re-checks before running.
"Is this still true?" before "do it." Without this, an unattended factory doggedly
executes plans the world has already invalidated.

### Gap 5 — The bookends: idea→repo and merge→deploy ("start to finish" literally)

- **Bootstrap:** idea → `gh repo create` → scaffold with green gates → build in.
  (Drafted: the Projects epic.)
- **Intake authoring:** rough idea → full epic contract, interviewing the human only
  on genuine ambiguity (garbage-in is the dominant failure of an autonomous system —
  the interview is the defense).
- **Post-merge:** deploy → smoke → **auto-revert on failure**. "Finish" includes the
  finish.

### Gap 6 — Big issues as deterministic workflows

Some issues aren't "one implementer in a loop" — they're multi-agent orchestrations
(fan-out research → N parallel transforms → adversarial verify → synthesize). The
Agent-SDK / workflow pattern (deterministic control flow over subagents) fits these.

**Fix.** A ticket may declare `workflow: <name>`; the loop dispatches to a scripted
orchestration instead of the linear pipeline. Gap 1's DAG is the _intra-epic_ version;
workflows are the _intra-ticket_ version. Two scales of structured parallelism, both
coordinated.

## The safety envelope (non-negotiable at every level)

- **Budget + kill.** Per-project and daily hard caps; a real kill switch. Today I had
  to `pkill` a runaway obsolete loop by hand — that must be a system primitive.
- **Blast radius.** Private repos by default; guarded paths always human; no prod
  deploy without post-merge watch + auto-revert.
- **Reversibility.** Everything is a PR/commit; auto-revert; the factory is always
  rollback-able.
- **Un-gameable gates.** An autonomous factory optimizing to "green" _will_ game weak
  gates. Test-file protection, cross-vendor review, and the hacker-fixer discipline
  must hold, or autonomy amplifies reward-hacking.

## The honest bottom line

The path to autonomy is **coordination** (DAG + freshness — parallel work stops
fighting, stale work stops running), **verification** strong enough to replace human
judgment (so auto-merge is safe), and **authority placed correctly** (steward acts
within policy; human gates only real risk). Do those three and the factory takes a
well-specified project start-to-finish unattended, human steering by charter and
reviewing by exception. The bookends make "project" literal.

## Build order (highest leverage first)

0. **Prerequisite, under everything:** per-project budget cap + kill switch as system
   primitives.
1. **Dependency DAG + file-mutex scheduling** (Gap 1) — stops the fighting; required
   before _any_ unattended multi-child run.
2. **Freshness / idempotency preconditions** (Gap 4) — cheap; stops stale execution.
3. **Steward authority within policy** (Gap 3) — closes the loop.
4. **Verification depth** (Gap 2): enforce browser/e2e where UI exists + security
   stage → then unlock the shadow→auto merge ladder.
5. **Bookends** (Gap 5): post-merge deploy/verify/revert, then bootstrap + intake
   authoring.
6. **Big-issue workflows** (Gap 6) — as issue complexity demands.

Autonomy level rises with each step; the human's job shrinks toward _charter +
exceptions_ but never disappears.
