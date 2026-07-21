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

/** Split candidates into run / blocked / deferred for one scheduler tick.
 *
 *   blocked  — has a dependency whose live Linear state TYPE is not "completed"
 *              (or is unknown/undefined) → not on the frontier yet. Fail-closed:
 *              an unresolvable dep blocks rather than silently releasing.
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
    const onFrontier = c.dependsOn.every((dep) => depStateType(dep) === "completed");
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
