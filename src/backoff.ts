// Exponential backoff for the Linear tick loop (#2). A single transient
// 503/429 used to trigger a FLAT 300s backoff (index.ts) that froze ALL
// claiming for five minutes — this instead grows from a small base, doubling
// each CONSECUTIVE rate-limited tick, capped well below the old flat value,
// with jitter so a fleet of ticks (or the startup burst, #3) doesn't retry in
// lockstep. `reset()` on the next successful tick means one blip costs
// seconds, not minutes — only a SUSTAINED outage climbs toward the cap.
// Mirrors loop.ts's retryMutation: injectable `rng` so tests never depend on
// real randomness or a real timer (the caller still owns the actual sleep).

export interface LinearBackoffOptions {
  baseSeconds?: number;
  capSeconds?: number;
  jitterSeconds?: number;
  rng?: () => number; // [0, 1) — injectable for deterministic tests
}

const DEFAULT_BASE_SECONDS = 10;
const DEFAULT_CAP_SECONDS = 240;
const DEFAULT_JITTER_SECONDS = 5;

export class LinearBackoff {
  private failures = 0;
  private readonly baseSeconds: number;
  private readonly capSeconds: number;
  private readonly jitterSeconds: number;
  private readonly rng: () => number;

  constructor(opts: LinearBackoffOptions = {}) {
    this.baseSeconds = opts.baseSeconds ?? DEFAULT_BASE_SECONDS;
    this.capSeconds = opts.capSeconds ?? DEFAULT_CAP_SECONDS;
    this.jitterSeconds = opts.jitterSeconds ?? DEFAULT_JITTER_SECONDS;
    this.rng = opts.rng ?? Math.random;
  }

  /** Call once per rate-limited tick. Returns the seconds to wait before the
   * next attempt: base * 2^(consecutive failures - 1), capped, plus a small
   * random jitter (0..jitterSeconds) so simultaneous failures don't all retry
   * on the same clock tick. */
  next(): number {
    this.failures += 1;
    const grown = this.baseSeconds * 2 ** (this.failures - 1);
    return Math.min(grown, this.capSeconds) + this.rng() * this.jitterSeconds;
  }

  /** Call once per successful tick — the next blip starts small again. */
  reset(): void {
    this.failures = 0;
  }
}
