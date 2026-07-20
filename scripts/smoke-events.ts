// Smoke test (run with: bun scripts/smoke-events.ts): start the dashboard on
// 8787, connect over SSE, emit a synthetic event through the bus, assert it
// arrives. Exits 0 on pass, 1 on fail. No Linear calls, loopback only.
process.env.LINEAR_API_KEY ??= "smoke-placeholder"; // config requires it; never used here
process.env.DASHBOARD_PORT = "8787";

const { bus } = await import("../src/events.ts");
const { startDashboard } = await import("../src/server.ts");

const dashboard = startDashboard();
if (!dashboard) throw new Error("dashboard did not start");
await new Promise((r) => setTimeout(r, 200)); // let listen() settle

const res = await fetch("http://127.0.0.1:8787/events", { headers: { accept: "text/event-stream" } });
if (!res.ok || !res.body) throw new Error(`GET /events failed: HTTP ${res.status}`);
const reader = res.body.getReader();

bus.emit({ type: "issue_needs_human", issueKey: "SMOKE-1", reason: "synthetic smoke event" });

let buffer = "";
const decoder = new TextDecoder();
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !buffer.includes('"issueKey":"SMOKE-1"')) {
  const chunk = await Promise.race([
    reader.read(),
    new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now())),
  ]);
  if (chunk.done) break;
  buffer += decoder.decode(chunk.value);
}

await reader.cancel().catch(() => {});
await dashboard.close();

if (!buffer.includes('"issueKey":"SMOKE-1"') || !buffer.includes("id: ")) {
  console.error("FAIL: synthetic event did not arrive over SSE");
  process.exit(1);
}
console.log("smoke-events OK: synthetic bus event received over SSE (id + data frame)");
process.exit(0);
