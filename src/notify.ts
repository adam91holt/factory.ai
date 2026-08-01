import { spawnSync } from "node:child_process";
import { config } from "./config.ts";

// Approvals-inbox owner notification (macOS only). When a run files an
// approval item the owner should find out in minutes, not at the next
// dashboard glance — one `osascript display notification` per item.
//
// Safety/behavior contract:
//   - THROTTLED: at most ONE notification per approval item id, enforced here
//     (module-level seen-set) rather than trusted to callers — a retried
//     creation path can never re-ping.
//   - INJECTABLE/NO-OP: `deps.run` is the only side effect and platform is a
//     dep, so tests never spawn osascript and non-darwin hosts no-op cleanly
//     (postmerge.ts DeployDeps pattern).
//   - DISABLEABLE: APPROVALS_NOTIFY=0 (config.approvalsNotify) turns it off.
//   - INJECTION-SAFE: title/reasons come from Linear ticket text and hold
//     reasons — untrusted. They are embedded in an AppleScript string literal,
//     so backslashes and double quotes (the only escapes AppleScript honors
//     inside "…") are stripped, newlines flattened, and length capped BEFORE
//     interpolation; the argv form (osascript -e <script>) never touches a
//     shell, so there is no shell-metacharacter surface at all.

export interface ApprovalNotice {
  id: number;
  issueKey: string;
  title: string;
  holdReasons: string;
}

export interface NotifyDeps {
  platform: string;
  enabled: boolean;
  run: (script: string) => void;
}

const notifiedIds = new Set<number>();

/** Test seam — mirrors control.ts resetDrainForTest: module state must not
 *  leak the throttle across unrelated test files. */
export function resetNotifyThrottleForTest(): void {
  notifiedIds.clear();
}

/** Flatten untrusted text into something safe to interpolate inside an
 *  AppleScript double-quoted string: kill the two characters AppleScript
 *  escapes ( \ and " ), collapse whitespace/newlines, drop control chars,
 *  cap length. Exported so the neutralization is pinned by a test. */
export function sanitizeNotificationText(text: string): string {
  return text
    .replace(/[\\"]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 160);
}

/** Where the notification points the owner. DASHBOARD_PORT mirrors server.ts's
 *  resolvePort default (8787); "0"/invalid falls back to the default too —
 *  a slightly-wrong URL in a toast is better than crashing the notifier. */
export function approvalsUrl(): string {
  const raw = (process.env.DASHBOARD_PORT ?? "").trim();
  const port = /^\d+$/.test(raw) && raw !== "0" ? raw : "8787";
  return `http://127.0.0.1:${port}/approvals`;
}

const defaultDeps: NotifyDeps = {
  platform: process.platform,
  enabled: config.approvalsNotify,
  run: (script) => { spawnSync("osascript", ["-e", script], { timeout: 10_000 }); },
};

/** Fire the one-per-item macOS notification. Returns whether a notification
 *  was actually attempted (false = disabled / wrong platform / already sent).
 *  The throttle marks BEFORE running so even a throwing `run` can never
 *  double-ping; never throws into the caller (best-effort UX, not a gate). */
export function notifyApproval(notice: ApprovalNotice, deps: NotifyDeps = defaultDeps): boolean {
  if (!deps.enabled || deps.platform !== "darwin") return false;
  if (notifiedIds.has(notice.id)) return false;
  notifiedIds.add(notice.id);
  const title = sanitizeNotificationText(`Factory needs you: ${notice.issueKey} — ${notice.title}`);
  const body = sanitizeNotificationText(`${notice.holdReasons} · ${approvalsUrl()}`);
  try {
    deps.run(`display notification "${body}" with title "${title}"`);
  } catch (error) {
    console.error(`[notify] osascript failed: ${error instanceof Error ? error.message : error}`);
  }
  return true;
}
