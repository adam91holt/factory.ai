// Agent routing (WP4): which CARD runs a stage, and which TOOLS that stage is
// actually granted. Two mechanisms, one security posture.
//
// 1. TOOL SELECTION — card frontmatter `tools:` becomes LOAD-BEARING, but only
//    ever SUBTRACTIVELY. Every stage's tool grant is a code constant in this
//    file (the "ceiling"); a card may only *select* entries out of that
//    constant, never author a matcher. resolveTools() is literally
//    `ceiling.filter(...)`, so
//
//        resolveTools(ceiling, anything) ⊆ ceiling
//
//    holds BY CONSTRUCTION for every possible declaration string — including
//    one an attacker wrote. Because agents.ts's forbiddenToolViolations()
//    already passes on each production ceiling, and violations are computed
//    per-entry, a filtered ceiling can never introduce a violation the ceiling
//    itself did not have. That is the whole safety argument, and it is one
//    line of code rather than a validation pass someone can forget to run.
//    (Precedent: groundskeepers.ts has always intersected a card's `tools`
//    with its READONLY_TOOLS constant the same way.)
//
// 2. CARD SELECTION — a specialist card may declare `role:` + `match:` and be
//    chosen over the role's default card when the REPO's own facts match.
//    Facts come from the worktree (verify.ts repoFacts) — never from the
//    ticket. There is deliberately NO ticket-text selector: routing on
//    untrusted description text is the one thing this module must not do, so
//    nothing here accepts a description, and meta.ts defines no routing key.
//
// This file imports NOTHING (same rule as events.ts): it is pure, I/O-free and
// cycle-free, so the ceilings can be shared by loop.ts / steward.ts /
// catalog-manager.ts without an import cycle, and every decision here is unit
// testable without a filesystem, a network, or a store.
//
// NOT a merge input. Nothing in this file is read by merge-ladder.ts, and the
// routed card/tool set is never part of MergeEvidence — routing decides who
// does the work, never whether the work may land (ADR-0001).

// ---------------------------------------------------------------------------
// Code-defined tool ceilings. THE authority for what any stage may ever hold.
// ---------------------------------------------------------------------------

// Interim Bash scoping for write-capable roles (C19; full OS sandbox is backlog).
// Deliberately NO git push and NO gh of any kind: the daemon performs every
// remote mutation itself (repos.ts pushBranch / createPr), so workers need zero
// network-write capability. agents.ts's forbiddenToolViolations guard rejects
// any future grant that breaks this; tests/tool-allowlist.test.ts pins the
// shape (hence the exports).
export const WRITER_BASH = ["Bash(bun:*)", "Bash(bunx:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git rm:*)", "Bash(ls:*)", "Bash(cat:*)"];

// Read-only review surface (repo reviewer, reviewer-fallback, design reviewer):
// inspect the worktree and its git history, mutate nothing. One shared const so
// the review stages cannot drift apart tool-wise; exported for the shape test.
export const REVIEWER_TOOLS = ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git show:*)"];

// Steward: read-only gh investigation + a scratch dir it writes its output
// protocol into. Mutation (merge/comment/close) stays with the human.
export const STEWARD_TOOLS = ["Write", "Read", "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh pr checks:*)", "Bash(gh pr list:*)", "Bash(gh pr status:*)"];

// Subagent orchestration (owner decision 2026-08-02): the WORK-heavy roles may
// fan out via Task/Agent — spend rolls up into the parent's total_cost_usd so
// the USD caps bind, and agents.ts pins every subagent to INHERIT the parent's
// resolved backend (never a hardcoded vendor default) with an in-code turn cap
// and no recursion. Deliberately NOT granted to any reviewer, the security
// reviewer, the steward, or planners: those are judges/authors whose
// independence and fail-closed verdicts matter more than throughput, and the
// 42%-of-spend swarm incident (agents.ts) was a REVIEWER doing exactly this.
// (No `model` key appears in this file on purpose — routing decides tools and
// cards, never which backend serves a stage; tests/routing.test.ts pins that.)
export const ORCHESTRATION_TOOLS = ["Task", "Agent"];

export const IMPLEMENTER_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", ...WRITER_BASH, ...ORCHESTRATION_TOOLS];
export const FIXER_TOOLS = ["Read", "Glob", "Grep", "Edit", ...WRITER_BASH, ...ORCHESTRATION_TOOLS];
export const TESTER_TOOLS = ["Read", "Glob", "Grep", ...WRITER_BASH, ...ORCHESTRATION_TOOLS];
export const SCOUT_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", ...ORCHESTRATION_TOOLS];
export const PLANNER_TOOLS = ["Write", "Read"];
export const SCAFFOLDER_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash(bun:*)", "Bash(bunx:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(git status:*)", "Bash(ls:*)", "Bash(cat:*)"];

/** Ceiling per ROLE, where a role is named after its default card
 *  (agents/<role>.md). This map is the ONLY place a role gets a ceiling: a
 *  role absent from it resolves to `[]`, so a typo'd or unknown role name
 *  fails CLOSED (no tools) rather than inheriting someone else's grant.
 *  Tool-less roles are listed explicitly with `[]` so "absent" and
 *  "deliberately tool-less" are distinguishable in the source, not by accident. */
export const ROLE_CEILINGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  implementer: IMPLEMENTER_TOOLS,
  fixer: FIXER_TOOLS,
  tester: TESTER_TOOLS,
  "reviewer-repo": REVIEWER_TOOLS,
  "design-reviewer": REVIEWER_TOOLS,
  "reviewer-spec": [],          // diff-only, tool-less by design
  "security-reviewer": [],      // diff-only, tool-less by design
  steward: STEWARD_TOOLS,
  scout: SCOUT_TOOLS,
  decomposer: PLANNER_TOOLS,
  "intake-author": PLANNER_TOOLS,
  scaffolder: SCAFFOLDER_TOOLS,
});

/** The ceiling for `role`, or null when the role is not a wired stage. null is
 *  meaningfully different from `[]`: `[]` is a deliberately tool-less stage,
 *  null is "this card runs nothing, so a tools: line on it would be inert". */
export function ceilingForRole(role: string): readonly string[] | null {
  return Object.prototype.hasOwnProperty.call(ROLE_CEILINGS, role) ? ROLE_CEILINGS[role]! : null;
}

/** Roles that may be served by a repo-fact-matched SPECIALIST card. In-code
 *  constant, not an env knob and not derived from any card: a card declaring
 *  `role:` for anything outside this set is rejected outright, so adding a new
 *  routable stage is a reviewed code change. */
export const SPECIALIST_ROLES: ReadonlySet<string> = new Set(["implementer"]);

// Bounds on what a card may declare. In-code caps (CLAUDE.md: caps are
// constants, never env knobs) — a card is operator-authored and git-committed,
// but a 10k-entry `tools:` line is a bug either way and must not be able to
// bloat an event or a report.
const MAX_TOOL_ENTRIES = 64;
const MAX_TOOL_ENTRY_LENGTH = 120;
const MAX_MATCH_TERMS = 8;
const MAX_MATCH_TERM_LENGTH = 40;
const MAX_REJECTIONS = 16;

// ---------------------------------------------------------------------------
// Repo facts — the ONLY selector input. Derived from the worktree by
// verify.ts's repoFacts(); this module never sees a ticket description.
// ---------------------------------------------------------------------------

export interface RepoFacts {
  /** verify.ts hasUiSurface(ws) — the repo has a screen. */
  ui: boolean;
  /** verify.ts hasPlaywright(ws) — the repo can drive a browser. */
  playwright: boolean;
  /** verify.ts detectGates(ws) — runnable package.json gate scripts. */
  gates: readonly string[];
}

/** Gate names a `gate:<name>` / `no-gate:<name>` term may reference. Mirrors
 *  verify.ts's CANDIDATES (pinned equal by tests/routing.test.ts, so the two
 *  cannot drift); duplicated rather than imported to keep this module
 *  import-free. An unknown gate name makes the whole term unknown, which
 *  REJECTS the card — an unrecognized selector must never quietly match. */
export const KNOWN_GATE_NAMES: readonly string[] = [
  "typecheck", "check", "build", "lint", "test", "test:ci", "test:unit",
  "test:e2e", "e2e", "test:browser", "playwright",
];

/** Evaluate one match term against repo facts. Returns null for an UNKNOWN
 *  term — callers must treat null as "reject the card", never as false-but-ok:
 *  a selector nobody implemented has no defined meaning, and guessing either
 *  way is how a fail-open hole gets built. */
export function factHolds(term: string, facts: RepoFacts): boolean | null {
  switch (term) {
    case "ui": return facts.ui === true;
    case "no-ui": return facts.ui !== true;
    case "playwright": return facts.playwright === true;
    case "no-playwright": return facts.playwright !== true;
    default: break;
  }
  const negated = term.startsWith("no-gate:");
  const gatePrefix = negated ? "no-gate:" : "gate:";
  if (term.startsWith(gatePrefix)) {
    const name = term.slice(gatePrefix.length);
    if (!KNOWN_GATE_NAMES.includes(name)) return null;
    const present = (facts.gates ?? []).includes(name);
    return negated ? !present : present;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Card shape (catalog.ts does the disk I/O and hands these in).
// ---------------------------------------------------------------------------

export interface RoutableCard {
  name: string;
  /** frontmatter `role:` — which stage slot this card can serve. */
  role?: string | undefined;
  /** frontmatter `match:` — repo-fact terms, ALL of which must hold. */
  match?: string | undefined;
  /** frontmatter `tools:` — a SELECTION over the role's ceiling. */
  tools?: string | undefined;
}

function stripBrackets(raw: string): string {
  return raw.trim().replace(/^\[/, "").replace(/\]$/, "");
}

/** Split a `match:` value. Terms never contain spaces, so whitespace OR commas
 *  separate them; `[a, b]` and `a b` both parse. */
function parseTermList(raw: string): string[] {
  return stripBrackets(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_MATCH_TERM_LENGTH)
    .slice(0, MAX_MATCH_TERMS);
}

/** Split a `tools:` value. COMMAS ONLY, and only at paren depth 0 — a tool
 *  matcher legitimately contains spaces (`Bash(git diff:*)`, `Bash(gh pr
 *  view:*)`), so a whitespace split would shred it into fragments that select
 *  nothing and SILENTLY NARROW the stage. (That is not hypothetical: it is
 *  exactly what the first draft of this parser did, and what
 *  tests/routing.test.ts now pins against.) */
function parseToolList(raw: string): string[] {
  const inner = stripBrackets(raw);
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of inner) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_TOOL_ENTRY_LENGTH)
    .slice(0, MAX_TOOL_ENTRIES);
}

// ---------------------------------------------------------------------------
// 1. Tool selection.
// ---------------------------------------------------------------------------

export interface ToolSelection {
  /** ALWAYS a subset of the ceiling, in ceiling order. */
  tools: string[];
  /** The card declared a `tools:` line at all. */
  declared: boolean;
  /** Fewer tools than the ceiling — the card gave something up. */
  narrowed: boolean;
  /** Declared entries that select nothing in the ceiling. They grant nothing
   *  (that is the fail-closed part) and are surfaced so a typo is visible
   *  rather than silently shrinking a stage. */
  unknown: string[];
}

/**
 * Resolve a card's `tools:` declaration against a code-defined ceiling.
 *
 * Selector grammar (deliberately tiny — a card SELECTS, it never AUTHORS):
 *   - an exact ceiling entry, e.g. `Bash(git diff:*)` → that entry
 *   - a bare base name, e.g. `Bash` → every ceiling entry whose base is `Bash`
 *     (`Bash` itself, or anything spelled `Bash(...)`)
 * Anything else selects nothing and is reported in `unknown`.
 *
 * `declared === undefined` (no card, or a card with no `tools:` key) returns
 * the ceiling verbatim — the pre-existing behaviour, so a card that declares
 * nothing changes nothing. An explicitly EMPTY declaration (`tools: []`)
 * returns `[]`: that is a real, honoured choice (reviewer-spec/security-reviewer
 * are tool-less on purpose), never a fallback to the ceiling.
 */
export function resolveTools(ceiling: readonly string[], declared: string | undefined): ToolSelection {
  if (declared === undefined) {
    return { tools: [...ceiling], declared: false, narrowed: false, unknown: [] };
  }
  const entries = parseToolList(declared);
  const selected = new Set<string>();
  const unknown: string[] = [];
  for (const entry of entries) {
    const base = entry.replace(/\(.*$/, "");
    const hits = ceiling.filter((c) => c === entry || (entry === base && (c === base || c.startsWith(`${base}(`))));
    if (hits.length === 0) { unknown.push(entry); continue; }
    for (const h of hits) selected.add(h);
  }
  // The security theorem, in one expression: the result is a FILTER of the
  // ceiling, so it is a subset of the ceiling for every possible input.
  const tools = ceiling.filter((c) => selected.has(c));
  return { tools, declared: true, narrowed: tools.length < ceiling.length, unknown };
}

// ---------------------------------------------------------------------------
// 2. Card selection.
// ---------------------------------------------------------------------------

export interface CardRejection { card: string; reason: string }

export interface CardSelection {
  card: string;
  specialist: boolean;
  /** The fact terms that selected the specialist ([] for the default card). */
  matched: string[];
  /** Candidates that declared this role but were not usable, and why. */
  rejected: CardRejection[];
}

/**
 * Pick the card that serves `role`. Pure and total: it always names a card,
 * and that card is `role`'s default (agents/<role>.md) unless a specialist
 * both declares this role and matches every one of its repo-fact terms.
 *
 * Fail-closed rules, in order of how badly they could go wrong:
 *   - the role is not in SPECIALIST_ROLES → NO specialist is ever considered;
 *   - a card whose `match:` contains an unknown term is REJECTED outright
 *     (an unrecognized selector must not degrade into "matches anything");
 *   - a card with `role:` but no `match:` is rejected — an unconditional
 *     specialist would silently replace the default for every repo;
 *   - a specialist may not be named after the default card.
 * Ties break on term count (more specific wins) then name, so selection is
 * deterministic regardless of directory-listing order.
 */
export function selectCard(role: string, candidates: readonly RoutableCard[], facts: RepoFacts): CardSelection {
  const rejected: CardRejection[] = [];
  const reject = (card: string, reason: string): void => {
    if (rejected.length < MAX_REJECTIONS) rejected.push({ card, reason });
  };
  const fallback: CardSelection = { card: role, specialist: false, matched: [], rejected };

  const declaring = candidates.filter((c) => (c.role ?? "").trim() === role && role !== "");
  if (declaring.length === 0) return fallback;
  if (!SPECIALIST_ROLES.has(role)) {
    for (const c of declaring) reject(c.name, `role "${role}" is not routable (SPECIALIST_ROLES)`);
    return fallback;
  }

  const viable: Array<{ name: string; terms: string[] }> = [];
  for (const card of declaring) {
    if (card.name === role) { reject(card.name, "the default card may not declare a role/match selector"); continue; }
    const terms = parseTermList(card.match ?? "");
    if (terms.length === 0) { reject(card.name, "declares a role but no match: terms (an unconditional specialist would replace the default everywhere)"); continue; }
    const unknownTerm = terms.find((t) => factHolds(t, facts) === null);
    if (unknownTerm !== undefined) { reject(card.name, `unknown match term "${unknownTerm}"`); continue; }
    if (!terms.every((t) => factHolds(t, facts) === true)) continue; // simply does not apply here
    viable.push({ name: card.name, terms });
  }
  if (viable.length === 0) return fallback;
  viable.sort((a, b) => (b.terms.length - a.terms.length) || a.name.localeCompare(b.name));
  const winner = viable[0]!;
  return { card: winner.name, specialist: true, matched: winner.terms, rejected };
}

// ---------------------------------------------------------------------------
// Combined: what a call site actually asks for.
// ---------------------------------------------------------------------------

export interface StageRoute {
  /** The runStage label this route is for (may differ from the role, e.g. the
   *  "reviewer-fallback" stage runs the "reviewer-repo" role). */
  stage: string;
  role: string;
  card: string;
  specialist: boolean;
  matched: string[];
  /** The allowlist to hand runStage. Always ⊆ ROLE_CEILINGS[role]. */
  tools: string[];
  declaredTools: boolean;
  narrowed: boolean;
  unknownTools: string[];
  rejected: CardRejection[];
  /** Nothing here differs from the pre-routing behaviour: the default card,
   *  the full ceiling, nothing dropped, nothing rejected. Call sites use this
   *  to stay byte-identical (no event, no report section) on the ordinary
   *  path, so a repo that declares nothing produces the same output it did
   *  before this feature existed. */
  notable: boolean;
}

/**
 * Route one stage: pick the card, then resolve its tools against the role's
 * ceiling. `cards` is every card on disk (catalog.ts listRoutableCards()).
 *
 * An unknown role has no ceiling and therefore gets NO tools — a typo in a
 * call site loses capability rather than borrowing another stage's.
 */
export function routeStage(stage: string, role: string, cards: readonly RoutableCard[], facts: RepoFacts): StageRoute {
  const ceiling = ceilingForRole(role) ?? [];
  const selection = selectCard(role, cards, facts);
  const declaredTools = cards.find((c) => c.name === selection.card)?.tools;
  const tools = resolveTools(ceiling, declaredTools);
  return {
    stage,
    role,
    card: selection.card,
    specialist: selection.specialist,
    matched: selection.matched,
    tools: tools.tools,
    declaredTools: tools.declared,
    narrowed: tools.narrowed,
    unknownTools: tools.unknown,
    rejected: selection.rejected,
    notable: selection.specialist || tools.narrowed || tools.unknown.length > 0 || selection.rejected.length > 0,
  };
}

/** Tool resolution ONLY, for stages that run outside a repo worktree (steward,
 *  planner, intake, bootstrap) — there are no repo facts there, and none of
 *  those roles is in SPECIALIST_ROLES, so card SELECTION would be a no-op.
 *  Same subtractive guarantee: the result is a filter of ROLE_CEILINGS[role],
 *  and an unknown role yields no tools. */
export function roleTools(role: string, cards: readonly RoutableCard[]): ToolSelection {
  return resolveTools(ceilingForRole(role) ?? [], cards.find((c) => c.name === role)?.tools);
}

/** Repo facts as stable display/telemetry terms (sorted, bounded). Used by the
 *  routing event and the factory report so a routing decision can be audited
 *  against the facts that produced it. */
export function factTerms(facts: RepoFacts): string[] {
  const terms = [facts.ui ? "ui" : "no-ui", facts.playwright ? "playwright" : "no-playwright"];
  for (const g of (facts.gates ?? []).slice(0, MAX_MATCH_TERMS)) {
    if (KNOWN_GATE_NAMES.includes(g)) terms.push(`gate:${g}`);
  }
  return terms;
}
