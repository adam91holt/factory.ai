// Smoke test (run with: bun scripts/smoke-park-reason.ts): open the in-process
// PGlite test seam, emit park / needs-human events through the bus, and assert
// lastParkReasonForIssue surfaces the recorded reason — the steward-closeout
// input contract (FAC-14 lesson: state without a WHY is a blind escalation).
// Then assert childStatusBlock (the steward's per-child closeout line) carries
// the reason, redacts secrets, and says "(no reason recorded)" for legacy rows.
// Exits 0 on pass, 1 on fail. No Linear calls.
//
// POSTGRES NOTE: this script MUST use openTestDatabase(), never
// startEventStore(). Under SQLite, pointing FACTORY_WORK_ROOT at a tmpdir
// isolated the store — the DB file lived under workRoot. With Postgres,
// startEventStore() connects to config.databaseUrl regardless of workRoot, so
// the old trick wrote SMOKE-* rows into the LIVE factory database
// (adversarial review 2026-08-02). subscribeBus wires the write-behind queue
// exactly as production does; flushEvents() drains it before each read.

process.env.LINEAR_API_KEY ??= "smoke-placeholder"; // config requires it; never used here

const { bus } = await import("../src/events.ts");
const { openTestDatabase, closeTestDatabase, flushEvents, lastParkReasonForIssue } = await import("../src/db.ts");
const { childStatusBlock } = await import("../src/steward.ts");
const { PARKED_LABEL, NEEDS_HUMAN_LABEL } = await import("../src/linear.ts");

await openTestDatabase({ subscribeBus: true });

const runFinishedBase = { prUrl: null, costUsd: 0, stages: [], gateStrength: "none" as const, guardedPaths: [], dryRun: false };
bus.emit({ type: "run_finished", issueKey: "SMOKE-1", outcome: "parked", reason: "dependency install failed", ...runFinishedBase });
bus.emit({ type: "run_finished", issueKey: "SMOKE-1", outcome: "parked", reason: "gates still failing after 3 repair rounds", ...runFinishedBase });
bus.emit({ type: "run_finished", issueKey: "SMOKE-2", outcome: "parked", ...runFinishedBase }); // legacy: no reason recorded
bus.emit({ type: "issue_needs_human", issueKey: "SMOKE-3", reason: "ticket is missing required sections" });
bus.emit({ type: "run_finished", issueKey: "SMOKE-4", outcome: "pr_open", ...runFinishedBase }); // success — no park reason
await flushEvents();

let failed = false;
const assert = (label: string, got: string | null, want: string | null): void => {
  if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failed = true; }
  else console.log(`ok ${label}: ${JSON.stringify(got)}`);
};
assert("latest of two parks wins", await lastParkReasonForIssue("SMOKE-1"), "gates still failing after 3 repair rounds");
assert("legacy no-reason row → null", await lastParkReasonForIssue("SMOKE-2"), null);
assert("issue_needs_human mark", await lastParkReasonForIssue("SMOKE-3"), "ticket is missing required sections");
assert("pr_open never counts as parked", await lastParkReasonForIssue("SMOKE-4"), null);
assert("unknown issue → null", await lastParkReasonForIssue("SMOKE-99"), null);

// --- childStatusBlock: the per-child line the steward actually reads at closeout.
const contains = (label: string, haystack: string, needle: string, want = true): void => {
  if (haystack.includes(needle) !== want) { console.error(`FAIL ${label}: ${want ? "missing" : "unexpectedly contains"} ${JSON.stringify(needle)} in:\n${haystack}`); failed = true; }
  else console.log(`ok ${label}`);
};
const parked = await childStatusBlock(
  { identifier: "SMOKE-1", title: "parked child", stateName: "Todo", labels: [PARKED_LABEL] },
  "(no PR found)");
contains("parked child block carries reason", parked, "reason: gates still failing after 3 repair rounds");
const needsHuman = await childStatusBlock(
  { identifier: "SMOKE-3", title: "needs-human child", stateName: "Todo", labels: [NEEDS_HUMAN_LABEL] },
  "(no PR found)");
contains("needs-human child block carries reason", needsHuman, "reason: ticket is missing required sections");
const legacy = await childStatusBlock(
  { identifier: "SMOKE-2", title: "legacy child", stateName: "Todo", labels: [PARKED_LABEL] },
  "(no PR found)");
contains("legacy row says (no reason recorded)", legacy, "reason: (no reason recorded)");
const done = await childStatusBlock(
  { identifier: "SMOKE-4", title: "done child", stateName: "Done", labels: [] },
  "(no PR found)");
contains("non-parked child has no reason line", done, "reason:", false);
const secretive = await childStatusBlock(
  { identifier: "SMOKE-5", title: "secret child", stateName: "Todo", labels: [PARKED_LABEL] },
  "(no PR found)",
  async () => "push failed: token ghp_abcdefghij0123456789 rejected");
contains("secret in reason is redacted", secretive, "[REDACTED-SECRET]");
contains("raw secret never reaches closeout", secretive, "ghp_abcdefghij0123456789", false);

await closeTestDatabase();
process.exit(failed ? 1 : 0);
