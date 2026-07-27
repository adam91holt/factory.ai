import { describe, expect, test } from "bun:test";
import { LinearBackoff } from "../src/backoff.ts";

// #2: a single transient Linear 503/429 used to park EVERY tick for a flat
// 300s. LinearBackoff replaces that with a schedule that grows, caps, and
// resets — these tests drive it with a deterministic `rng` (always 0, so
// jitter is a known, testable quantity) so nothing here depends on real
// randomness or a real timer (mirrors loop.ts's retryMutation tests, which
// inject `sleep` for the same reason).

describe("LinearBackoff", () => {
  test("grows exponentially from the base on consecutive failures", () => {
    const backoff = new LinearBackoff({ baseSeconds: 10, capSeconds: 1000, jitterSeconds: 0, rng: () => 0 });
    expect(backoff.next()).toBe(10);  // 10 * 2^0
    expect(backoff.next()).toBe(20);  // 10 * 2^1
    expect(backoff.next()).toBe(40);  // 10 * 2^2
    expect(backoff.next()).toBe(80);  // 10 * 2^3
  });

  test("caps at capSeconds instead of growing forever", () => {
    const backoff = new LinearBackoff({ baseSeconds: 10, capSeconds: 45, jitterSeconds: 0, rng: () => 0 });
    expect(backoff.next()).toBe(10);
    expect(backoff.next()).toBe(20);
    expect(backoff.next()).toBe(40);
    expect(backoff.next()).toBe(45); // would be 80 uncapped — clamped
    expect(backoff.next()).toBe(45); // stays at the cap on further failures
  });

  test("reset() returns the very next failure to the base — one blip costs seconds, not minutes", () => {
    const backoff = new LinearBackoff({ baseSeconds: 10, capSeconds: 1000, jitterSeconds: 0, rng: () => 0 });
    backoff.next(); // 10
    backoff.next(); // 20
    backoff.next(); // 40
    backoff.reset(); // a tick succeeded — a later blip must not resume where the last outage left off
    expect(backoff.next()).toBe(10);
  });

  test("adds jitter in [0, jitterSeconds) on top of the grown/capped value", () => {
    const backoff = new LinearBackoff({ baseSeconds: 10, capSeconds: 1000, jitterSeconds: 5, rng: () => 0.5 });
    expect(backoff.next()).toBe(12.5); // 10 + 0.5 * 5
  });

  test("defaults are sane: starts small, never a flat 300s", () => {
    const backoff = new LinearBackoff({ rng: () => 0 });
    const first = backoff.next();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(30); // the old flat backoff was 300s — this must be a fraction of that
  });

  test("never grows unboundedly across a long sustained outage", () => {
    const backoff = new LinearBackoff({ baseSeconds: 10, capSeconds: 240, jitterSeconds: 0, rng: () => 0 });
    let last = 0;
    for (let i = 0; i < 50; i++) last = backoff.next();
    expect(last).toBe(240);
  });
});
