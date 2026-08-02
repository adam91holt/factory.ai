// Pure DAG scheduling primitives (Gap 1) — no Linear, no I/O, unit-testable in
// isolation. Two jobs: (1) decide which candidate children are on the
// topological frontier (all dependencies completed), and (2) enforce a
// file-level mutex so no two children whose `touches` globs overlap run
// concurrently, even when the DAG marks them independent.
//
// The overlap test is a CONSERVATIVE approximation — exact glob set-intersection
// is undecidable in general, so it deliberately biases toward "overlap".
// Over-serializing only costs parallelism; under-serializing reintroduces the
// exact sibling-race (duplicate lessons.ts, FAC-15/16/18) this module exists to
// kill. When unsure, serialize.

// Characters that begin a glob wildcard. Everything up to the first one is the
// literal prefix a path must share to have any chance of matching.
const WILDCARD = /[*?[{]/;

/** The literal substring of a glob up to its first wildcard char.
 *   "src/a/**"     → "src/a/"
 *   "src/lessons.ts" → "src/lessons.ts"  (no wildcard → whole string)
 *   "**\/x"        → ""                   (leading wildcard → empty prefix)
 */
export function staticPrefix(glob: string): string {
  const m = glob.match(WILDCARD);
  return m ? glob.slice(0, m.index) : glob;
}

/** Segment-aware prefix test: is `short` a path-prefix of `long`? True when they
 * are equal, or `long` continues `short` at a segment boundary ("/"). Prevents
 * "src/a" from spuriously prefix-matching "src/ab". An empty `short` (a glob
 * like "**" whose static prefix is "") prefixes everything — the deliberately
 * conservative case. */
function isPathPrefix(short: string, long: string): boolean {
  if (short === "") return true;
  if (!long.startsWith(short)) return false;
  if (short.length === long.length) return true;
  // Boundary either side of the split so "src/a/" vs "src/a/b" and "src/a" vs
  // "src/a/b" both count, but "src/a" vs "src/ab" does not.
  return short.endsWith("/") || long[short.length] === "/";
}

/** True if any glob in `a` could match a common path with any glob in `b`.
 * Conservative: a pair overlaps iff they are string-equal, OR one's static
 * prefix is a path-prefix of the other's. Errs toward "overlap". An empty list
 * on either side overlaps nothing (a child that declares no touches is
 * mutex-free — today's behavior). */
export function globsOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      const px = staticPrefix(x);
      const py = staticPrefix(y);
      if (isPathPrefix(px, py) || isPathPrefix(py, px)) return true;
    }
  }
  return false;
}

export interface Schedulable {
  identifier: string;
  dependsOn: string[];
  touches: string[];
}

// ---------------------------------------------------------------------------
// Implicit depends_on (issue #6 Part 2): when the decomposer declared which
// files two siblings touch but FORGOT the edge between them, the file mutex
// alone gives serialization without ORDERING — whichever sibling is claimed
// first wins, and the other builds against a base that is about to change.
// Derive the missing edge here, in code, from the same `touches` globs the
// mutex already trusts: the LATER child (by ticket number — the decomposer
// files children in dependency-ish order, and any deterministic order beats
// none) waits for the EARLIER one to complete. Purely additive:
//   - an explicit depends_on entry is NEVER removed or reordered — implicit
//     edges are unioned on top;
//   - a child with no `touches`, or no overlap, is returned UNCHANGED (same
//     object, same behavior as today);
//   - an implicit edge that would create a cycle with the existing graph is
//     skipped (fail-open to today's mutex-only behavior — a wedged DAG is
//     strictly worse than an unordered one);
//   - every addition is reported in `added` so the caller can log it loudly.
// ---------------------------------------------------------------------------

/** In-code cap (CLAUDE.md): more implicit edges than this per child means the
 *  decomposer emitted a hairball — extra edges add ordering constraints with
 *  rapidly diminishing value, and the mutex still serializes what they'd
 *  have covered. */
const MAX_IMPLICIT_DEPS_PER_CHILD = 8;

export interface ImplicitDepAddition {
  /** The child that gained the edge (waits). */
  identifier: string;
  /** The earlier sibling it now waits for. */
  dependsOn: string;
  /** The first overlapping glob pair, for the log line. */
  overlap: string;
}

/** TEAM-123 → 123; anything unparseable sorts last (never treated as early —
 *  a malformed identifier must not silently become everyone's prerequisite). */
function ticketNumber(identifier: string): number {
  const m = identifier.match(/-(\d+)$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export function deriveImplicitDeps(candidates: Schedulable[]): { augmented: Schedulable[]; added: ImplicitDepAddition[] } {
  // Working dependency graph: explicit edges plus implicit edges as they are
  // accepted, so the cycle check sees the REAL graph being built, not just the
  // explicit slice of it (implicit edges alone cannot cycle — they always
  // point later→earlier — but mixed with explicit edges they could).
  const deps = new Map<string, Set<string>>(candidates.map((c) => [c.identifier, new Set(c.dependsOn)]));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of deps.get(cur) ?? []) stack.push(d);
    }
    return false;
  };

  const order = [...candidates].sort((a, b) => ticketNumber(a.identifier) - ticketNumber(b.identifier) || a.identifier.localeCompare(b.identifier));
  const added: ImplicitDepAddition[] = [];
  for (let j = 1; j < order.length; j++) {
    const later = order[j]!;
    if (later.touches.length === 0) continue;
    let addedForChild = 0;
    for (let i = 0; i < j && addedForChild < MAX_IMPLICIT_DEPS_PER_CHILD; i++) {
      const earlier = order[i]!;
      if (earlier.touches.length === 0) continue;
      if (!globsOverlap(later.touches, earlier.touches)) continue;
      if (deps.get(later.identifier)!.has(earlier.identifier)) continue; // explicit (or already added) — nothing to derive
      if (reaches(earlier.identifier, later.identifier)) continue;       // earlier already (transitively) waits on later — adding the reverse edge would wedge both forever
      deps.get(later.identifier)!.add(earlier.identifier);
      const pair = later.touches.flatMap((x) => earlier.touches.map((y) => [x, y] as const)).find(([x, y]) => globsOverlap([x], [y]));
      added.push({ identifier: later.identifier, dependsOn: earlier.identifier, overlap: pair ? `${pair[0]} ∩ ${pair[1]}` : "" });
      addedForChild += 1;
    }
  }

  // Original array order and object identity preserved for untouched children —
  // selectRunnable admits FIFO in candidate order, and the additive guarantee
  // is easiest to see when "no overlap" means "the same object out".
  const augmented = candidates.map((c) => {
    const set = deps.get(c.identifier)!;
    if (set.size === c.dependsOn.length) return c;
    return { ...c, dependsOn: [...c.dependsOn, ...[...set].filter((d) => !c.dependsOn.includes(d))] };
  });
  return { augmented, added };
}

/** Split candidates into run / blocked / deferred for one scheduler tick.
 *
 *   blocked  — has a dependency whose live Linear state TYPE is neither
 *              "completed" nor "canceled" (or is unknown/undefined) → not on the
 *              frontier yet. Both are terminal (steward.ts / reconcile.ts treat
 *              them alike); a canceled dep is "resolved, won't land" and must
 *              satisfy the edge, else its dependents wedge forever. Fail-closed:
 *              an unresolvable (non-terminal/unknown) dep blocks rather than
 *              silently releasing.
 *   deferred — frontier-ready but its `touches` overlap a currently in-flight
 *              sibling (busyTouches) OR a candidate already admitted this tick.
 *   run      — admitted greedily in the candidates' (FIFO) order up to capacity,
 *              accumulating each admitted child's touches into the mutex set so
 *              later candidates this tick see it as busy.
 *
 * A candidate with dependsOn:[] and touches:[] is never blocked and never
 * deferred → identical to today's slice()-based selection. */
export function selectRunnable(
  candidates: Schedulable[],
  depStateType: (id: string) => string | undefined,
  busyTouches: string[][],
  capacity: number,
): { run: string[]; blocked: string[]; deferred: string[] } {
  const run: string[] = [];
  const blocked: string[] = [];
  const deferred: string[] = [];
  // Mutex set grows as we admit candidates so two frontier-ready siblings with
  // overlapping touches never both run in the same tick.
  const admittedTouches: string[][] = [...busyTouches];
  for (const c of candidates) {
    // Both terminal state types satisfy a dependency: "completed" (the work
    // landed) and "canceled" (resolved, won't land — a human/steward dropped it
    // as redundant). Blocking on canceled would wedge every dependent forever.
    const onFrontier = c.dependsOn.every((dep) => {
      const t = depStateType(dep);
      return t === "completed" || t === "canceled";
    });
    if (!onFrontier) { blocked.push(c.identifier); continue; }
    if (run.length >= Math.max(0, capacity)) { deferred.push(c.identifier); continue; }
    if (c.touches.length > 0 && admittedTouches.some((t) => globsOverlap(c.touches, t))) {
      deferred.push(c.identifier);
      continue;
    }
    run.push(c.identifier);
    admittedTouches.push(c.touches);
  }
  return { run, blocked, deferred };
}
