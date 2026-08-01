import { describe, expect, test } from "bun:test";
import { ConnectionHealth, FRESH_CONNECTION_AFTER, LOUD_LOG_AFTER, LinearRateLimited, gqlWith } from "../src/linear.ts";
import type { LinearTransportDeps } from "../src/linear.ts";

// Connection hygiene (prod incident 2026-08-02): a long-running daemon's
// kept-alive pool went stale and EVERY Linear request 503/504'd for hours while
// a fresh curl succeeded — the backoff loop retried the same dead sockets
// forever. gqlWith must (a) send "Connection: close" once FRESH_CONNECTION_AFTER
// consecutive 5xx/network failures accrue so retries get a fresh socket,
// (b) reset on the first live response, and (c) fire ONE loud operator log at
// LOUD_LOG_AFTER — not one per request. All via the injectable transport deps.

const okBody = JSON.stringify({ data: { ok: true } });

/** Fake fetch that pops scripted results; records the headers of every call. */
function scriptedDeps(
  script: Array<number | "network-error">,
  log: (msg: string) => void = () => {},
): { deps: LinearTransportDeps; headersSeen: Array<Record<string, string>> } {
  const headersSeen: Array<Record<string, string>> = [];
  let i = 0;
  const deps: LinearTransportDeps = {
    health: new ConnectionHealth(log),
    fetchImpl: async (_url, init) => {
      headersSeen.push({ ...(init.headers as Record<string, string>) });
      const step = script[i] ?? 200;
      i += 1;
      if (step === "network-error") throw new Error("ECONNRESET: socket hang up");
      return new Response(step === 200 ? okBody : "upstream unavailable", { status: step });
    },
  };
  return { deps, headersSeen };
}

const attempt = (deps: LinearTransportDeps) => gqlWith<{ ok: boolean }>(deps, "query { ok }").then(
  () => "ok" as const,
  (e) => (e instanceof LinearRateLimited ? ("rate-limited" as const) : ("error" as const)),
);

describe("gqlWith connection hygiene", () => {
  test(`consecutive 5xx enter fresh-connection mode after ${FRESH_CONNECTION_AFTER} failures`, async () => {
    const { deps, headersSeen } = scriptedDeps([503, 503, 503, 503, 503]);
    for (let n = 0; n < 5; n++) expect(await attempt(deps)).toBe("rate-limited");
    // First FRESH_CONNECTION_AFTER attempts still use the pool (a blip must not
    // churn sockets); every attempt after the threshold refuses it.
    for (let n = 0; n < FRESH_CONNECTION_AFTER; n++) expect(headersSeen[n]!.Connection).toBeUndefined();
    for (let n = FRESH_CONNECTION_AFTER; n < 5; n++) expect(headersSeen[n]!.Connection).toBe("close");
  });

  test("network-level fetch failures count toward recycling like 5xx", async () => {
    const { deps, headersSeen } = scriptedDeps(["network-error", 504, "network-error", 504]);
    expect(await attempt(deps)).toBe("error");        // throw propagates unchanged
    expect(await attempt(deps)).toBe("rate-limited"); // 5xx stays LinearRateLimited
    expect(await attempt(deps)).toBe("error");
    expect(await attempt(deps)).toBe("rate-limited");
    expect(headersSeen[FRESH_CONNECTION_AFTER - 1]!.Connection).toBeUndefined();
    expect(headersSeen[FRESH_CONNECTION_AFTER]!.Connection).toBe("close");
    expect(deps.health.forceFresh).toBe(true);
  });

  test("a success resets the counter and leaves fresh-connection mode", async () => {
    const { deps, headersSeen } = scriptedDeps([503, 503, 503, 503, 200, 503, 503]);
    for (let n = 0; n < 4; n++) await attempt(deps);
    expect(deps.health.forceFresh).toBe(true);
    expect(await attempt(deps)).toBe("ok"); // the fresh socket worked
    expect(deps.health.consecutiveFailures).toBe(0);
    expect(deps.health.forceFresh).toBe(false);
    // Post-recovery blips start from zero: the next two 503s stay pooled.
    await attempt(deps);
    await attempt(deps);
    expect(headersSeen[5]!.Connection).toBeUndefined();
    expect(headersSeen[6]!.Connection).toBeUndefined();
  });

  test("429 (real rate limit) proves the socket is alive — resets, never recycles", async () => {
    const { deps } = scriptedDeps([503, 503, 429]);
    await attempt(deps);
    await attempt(deps);
    expect(deps.health.consecutiveFailures).toBe(2);
    expect(await attempt(deps)).toBe("rate-limited"); // existing 429 behavior unchanged
    expect(deps.health.consecutiveFailures).toBe(0);
  });

  test("sub-500 HTTP errors (e.g. 400) reset the counter too", async () => {
    const { deps } = scriptedDeps([503, 400]);
    await attempt(deps);
    expect(await attempt(deps)).toBe("error");
    expect(deps.health.consecutiveFailures).toBe(0);
  });

  test(`the loud log fires ONCE at ${LOUD_LOG_AFTER} consecutive failures, not per request`, async () => {
    const logs: string[] = [];
    const { deps } = scriptedDeps(Array(LOUD_LOG_AFTER + 5).fill(503), (m) => logs.push(m));
    for (let n = 0; n < LOUD_LOG_AFTER - 1; n++) await attempt(deps);
    expect(logs).toEqual([]); // below threshold: silent (the tick loop already logs per-failure)
    await attempt(deps);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`${LOUD_LOG_AFTER} consecutive 5xx/network failures`);
    expect(logs[0]).toContain("forcing fresh connections");
    for (let n = 0; n < 5; n++) await attempt(deps); // keep failing past threshold
    expect(logs).toHaveLength(1); // still exactly one — no spam
  });

  test("recovery then a second wedge fires the loud log again (one line per wedge)", async () => {
    const logs: string[] = [];
    const script = [...Array(LOUD_LOG_AFTER).fill(503), 200, ...Array(LOUD_LOG_AFTER).fill(503)];
    const { deps } = scriptedDeps(script, (m) => logs.push(m));
    for (let n = 0; n < script.length; n++) await attempt(deps);
    expect(logs).toHaveLength(2);
  });
});

describe("ConnectionHealth", () => {
  test("threshold constants are ordered sanely (fresh mode precedes the loud log)", () => {
    expect(FRESH_CONNECTION_AFTER).toBeLessThan(LOUD_LOG_AFTER);
  });

  test("forceFresh flips exactly at the threshold and stays until reset", () => {
    const h = new ConnectionHealth(() => {});
    for (let n = 0; n < FRESH_CONNECTION_AFTER - 1; n++) h.recordFailure();
    expect(h.forceFresh).toBe(false);
    h.recordFailure();
    expect(h.forceFresh).toBe(true);
    h.recordFailure();
    expect(h.forceFresh).toBe(true);
    h.recordSuccess();
    expect(h.forceFresh).toBe(false);
    expect(h.consecutiveFailures).toBe(0);
  });
});
