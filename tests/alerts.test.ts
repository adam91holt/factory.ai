import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../src/config.ts";
import { bus, type FactoryEvent } from "../src/events.ts";
import { deliverAlert, startAlerts, toAlertPayload, type AlertDeps } from "../src/alerts.ts";

// Prerequisite-0 alerting (T5, docs/planning/autonomy.md "Build order" item 0).
// toAlertPayload is pure (no network); deliverAlert/startAlerts take an
// injectable AlertDeps so the suite never touches the network — same pattern
// as postmerge.test.ts's DeployDeps.

const originalWebhook = config.alertWebhookUrl;
afterEach(() => { config.alertWebhookUrl = originalWebhook; });

/** Stamp seq/at like bus.emit does, without touching the shared ring buffer or
 *  its subscribers — for tests that only need a well-formed FactoryEvent. */
function stamp(body: Parameters<typeof bus.emit>[0]): FactoryEvent {
  return { ...body, seq: 1, at: 1_700_000_000_000 } as FactoryEvent;
}

describe("toAlertPayload — which events alert", () => {
  test("issue_needs_human always alerts", () => {
    const e = stamp({ type: "issue_needs_human", issueKey: "FAC-1", reason: "bad ticket" });
    expect(toAlertPayload(e)).toEqual({ event: "issue_needs_human", message: "FAC-1 needs human: bad ticket", at: e.at });
  });

  test("run_finished alerts only when outcome is parked", () => {
    const parked = stamp({ type: "run_finished", issueKey: "FAC-2", outcome: "parked", reason: "flaky test",
      prUrl: null, costUsd: 1, stages: [], gateStrength: "none", guardedPaths: [], dryRun: false });
    expect(toAlertPayload(parked)?.message).toBe("FAC-2 parked: flaky test");

    const prOpen = stamp({ type: "run_finished", issueKey: "FAC-3", outcome: "pr_open",
      prUrl: "https://example.invalid/pr/1", costUsd: 1, stages: [], gateStrength: "none", guardedPaths: [], dryRun: false });
    expect(toAlertPayload(prOpen)).toBeNull();
  });

  test("deploy_finished alerts only when reverted", () => {
    const sha = "a".repeat(40);
    const reverted = stamp({ type: "deploy_finished", repo: "acme/kiwi", sha, ok: false, stage: "smoke", reverted: true, detail: "smoke failed" });
    expect(toAlertPayload(reverted)?.message).toBe(`acme/kiwi@${sha.slice(0, 12)} deploy reverted: smoke failed`);

    const ok = stamp({ type: "deploy_finished", repo: "acme/kiwi", sha, ok: true, stage: "smoke", reverted: false, detail: "green" });
    expect(toAlertPayload(ok)).toBeNull();
  });

  test("tick_finished alerts only when it carries an error", () => {
    const errored = stamp({ type: "tick_finished", queued: 1, eligible: 1, markedNeedsHuman: 0, processed: 0, error: "linear 500" });
    expect(toAlertPayload(errored)?.message).toBe("tick error: linear 500");

    const clean = stamp({ type: "tick_finished", queued: 1, eligible: 1, markedNeedsHuman: 0, processed: 1 });
    expect(toAlertPayload(clean)).toBeNull();
  });

  test("drain_entered always alerts, for both triggers", () => {
    const killSwitch = stamp({ type: "drain_entered", trigger: "kill_switch", reason: "panic button" });
    expect(toAlertPayload(killSwitch)?.message).toBe("drain mode entered (kill_switch): panic button");

    const budgetCap = stamp({ type: "drain_entered", trigger: "budget_cap", reason: "over cap" });
    expect(toAlertPayload(budgetCap)?.message).toBe("drain mode entered (budget_cap): over cap");
  });

  test("events with no alert mapping return null", () => {
    expect(toAlertPayload(stamp({ type: "tick_started" }))).toBeNull();
    expect(toAlertPayload(stamp({ type: "run_stage_finished", issueKey: "FAC-1", stage: "implementer",
      costUsd: 1, turns: 1, wallSeconds: 1, resultText: "" }))).toBeNull();
  });
});

describe("deliverAlert", () => {
  test("no-ops when ALERT_WEBHOOK_URL is unset — never calls postJson", async () => {
    config.alertWebhookUrl = "";
    let calls = 0;
    const deps: AlertDeps = { postJson: async () => { calls += 1; } };
    await deliverAlert(stamp({ type: "issue_needs_human", issueKey: "FAC-1", reason: "x" }), deps);
    expect(calls).toBe(0);
  });

  test("no-ops for events that don't alert, even with a webhook configured", async () => {
    config.alertWebhookUrl = "https://example.invalid/hook";
    let calls = 0;
    const deps: AlertDeps = { postJson: async () => { calls += 1; } };
    await deliverAlert(stamp({ type: "tick_started" }), deps);
    expect(calls).toBe(0);
  });

  test("posts the JSON payload when configured and the event alerts", async () => {
    config.alertWebhookUrl = "https://example.invalid/hook";
    const posted: Array<{ url: string; body: string }> = [];
    const deps: AlertDeps = { postJson: async (url, body) => { posted.push({ url, body }); } };
    await deliverAlert(stamp({ type: "issue_needs_human", issueKey: "FAC-9", reason: "missing repo" }), deps);
    expect(posted.length).toBe(1);
    expect(posted[0]?.url).toBe("https://example.invalid/hook");
    const parsed = JSON.parse(posted[0]!.body) as { event: string; message: string; at: number };
    expect(parsed).toEqual({ event: "issue_needs_human", message: "FAC-9 needs human: missing repo", at: 1_700_000_000_000 });
  });

  test("a postJson rejection is swallowed — never throws into the caller", async () => {
    config.alertWebhookUrl = "https://example.invalid/hook";
    const deps: AlertDeps = { postJson: async () => { throw new Error("network down"); } };
    await expect(deliverAlert(stamp({ type: "issue_needs_human", issueKey: "FAC-1", reason: "x" }), deps))
      .resolves.toBeUndefined();
  });
});

describe("startAlerts — wires deliverAlert onto the bus", () => {
  test("an alert-worthy event on the bus triggers postJson exactly once", async () => {
    config.alertWebhookUrl = "https://example.invalid/hook";
    const posted: string[] = [];
    const deps: AlertDeps = { postJson: async (_url, body) => { posted.push(body); } };
    const unsubscribe = startAlerts(deps);
    try {
      bus.emit({ type: "issue_needs_human", issueKey: "FAC-5", reason: "ambiguous ticket" });
      // deliverAlert is fired with `void` inside the subscriber — let it settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(posted.length).toBe(1);
      expect(posted[0]).toContain("FAC-5");
    } finally {
      unsubscribe();
    }
  });

  test("a non-alerting event on the bus never calls postJson", async () => {
    config.alertWebhookUrl = "https://example.invalid/hook";
    let calls = 0;
    const deps: AlertDeps = { postJson: async () => { calls += 1; } };
    const unsubscribe = startAlerts(deps);
    try {
      bus.emit({ type: "tick_started" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});
