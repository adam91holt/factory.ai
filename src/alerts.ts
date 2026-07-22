import { config } from "./config.ts";
import { bus, type FactoryEvent } from "./events.ts";

// Prerequisite-0 alerting (T5, docs/planning/autonomy.md "Build order" item 0
// — "the #1 leverage item"). No notification channel existed before this: a
// stuck factory silently piled up needs-human tickets and parked runs until a
// human happened to open the dashboard. This is a bus subscriber that POSTs a
// small JSON payload to the optional ALERT_WEBHOOK_URL (ntfy/Slack-style — any
// endpoint that accepts a JSON POST body works) on the handful of events that
// mean "a human should look at this now": issue_needs_human, run_finished
// {outcome: parked}, deploy_finished{reverted: true}, tick_finished{error},
// and drain_entered (kill switch or spend cap).
//
// Every field this module sends is either a fixed label or an event field that
// was ALREADY redacted at emit time (loop.ts / postmerge.ts / index.ts /
// control.ts all pass their strings through redactSecrets() before emitting —
// see agents.ts §"redactSecrets"). This module adds NO new raw fields, reads
// nothing from disk, and never touches config.linearApiKey / proxyAuthToken.
// No-op cleanly when ALERT_WEBHOOK_URL is unset (the default) — most installs
// run without one.

export interface AlertPayload {
  event: FactoryEvent["type"];
  message: string;
  at: number;
}

/** Pure event → payload mapping (or null for events that don't alert). Kept
 *  separate from delivery so it's testable without a network — and so a bad
 *  webhook target can never affect which events WOULD have alerted. */
export function toAlertPayload(e: FactoryEvent): AlertPayload | null {
  switch (e.type) {
    case "issue_needs_human":
      return { event: e.type, message: `${e.issueKey} needs human: ${e.reason}`, at: e.at };
    case "run_finished":
      if (e.outcome !== "parked") return null;
      return { event: e.type, message: `${e.issueKey} parked${e.reason ? `: ${e.reason}` : ""}`, at: e.at };
    case "deploy_finished":
      if (!e.reverted) return null;
      return { event: e.type, message: `${e.repo}@${e.sha.slice(0, 12)} deploy reverted: ${e.detail}`, at: e.at };
    case "tick_finished":
      if (!e.error) return null;
      return { event: e.type, message: `tick error: ${e.error}`, at: e.at };
    case "drain_entered":
      return { event: e.type, message: `drain mode entered (${e.trigger}): ${e.reason}`, at: e.at };
    default:
      return null;
  }
}

/** The one network call this module makes, extracted for injection — tests
 *  supply a fake so the suite never touches the network (same pattern as
 *  postmerge.test.ts's DeployDeps). */
export interface AlertDeps {
  postJson: (url: string, body: string) => Promise<void>;
}

const defaultDeps: AlertDeps = {
  async postJson(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000); // hung endpoint must not pile up requests
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  },
};

/** Deliver one alert for `e`, or no-op when it doesn't alert / no webhook is
 *  configured. Fire-and-forget by design (callers `void` it): a webhook outage
 *  must never affect the pipeline it's reporting on. */
export async function deliverAlert(e: FactoryEvent, deps: AlertDeps = defaultDeps): Promise<void> {
  const url = config.alertWebhookUrl;
  if (!url) return; // unset — no-op cleanly (task requirement)
  const payload = toAlertPayload(e);
  if (!payload) return;
  try {
    await deps.postJson(url, JSON.stringify(payload));
  } catch (error) {
    console.error(`[alerts] webhook delivery failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** Wire the alert subscriber onto the bus. Call once at daemon startup
 *  (index.ts main()). Returns the unsubscribe fn (bus.subscribe's contract). */
export function startAlerts(deps: AlertDeps = defaultDeps): () => void {
  return bus.subscribe((e) => { void deliverAlert(e, deps); });
}
