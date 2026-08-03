#!/usr/bin/env bun
/**
 * Interactive chat with any model behind CLIProxyAPI — see actual replies, not
 * a PASS line. Streams tokens as they arrive and keeps conversation history,
 * so it doubles as a by-hand check that a pooled credential really serves.
 *
 *   bun --env-file=.env scripts/cliproxy-chat.ts                    # claude-sonnet-5
 *   bun --env-file=.env scripts/cliproxy-chat.ts claude-fable-5    # any /v1/models id
 *
 * In-chat commands: /model <id> switch model · /clear reset history ·
 * /models list Claude-family ids · /quit exit (Ctrl-C/Ctrl-D also work).
 */
import readline from "node:readline/promises";

const BASE = (process.env.PROXY_BASE_URL ?? "http://127.0.0.1:8317").replace(/\/+$/, "");
const TOKEN = process.env.PROXY_AUTH_TOKEN ?? "";
if (!TOKEN) {
  console.error("error: PROXY_AUTH_TOKEN is not set — run via `bun --env-file=.env scripts/cliproxy-chat.ts`");
  process.exit(1);
}

let model = process.argv[2] ?? "claude-sonnet-5";
type Msg = { role: "user" | "assistant"; content: string };
const history: Msg[] = [];

async function listClaudeModels(): Promise<string[]> {
  const res = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`GET /v1/models -> HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id ?? "").filter((id) => /claude|opus|sonnet|haiku|fable/i.test(id)).sort();
}

/** One streamed turn. Prints tokens as they arrive; returns the full reply. */
async function chatTurn(): Promise<string> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: history, stream: true }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames: "data: {json}\n\n" — a frame may be split across reads, so
    // only consume up to the last complete line.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta) { process.stdout.write(delta); reply += delta; }
        if (chunk.usage) usage = chunk.usage;
      } catch { /* keep-alive / non-JSON frame — skip */ }
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const tok = usage ? ` · ${usage.prompt_tokens ?? "?"}in/${usage.completion_tokens ?? "?"}out tok` : "";
  process.stdout.write(`\n\x1b[2m[${model} · ${secs}s${tok}]\x1b[0m\n`);
  return reply;
}

console.log(`chat with ${model} via ${BASE} — /model <id>, /models, /clear, /quit`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("SIGINT", () => { rl.close(); process.exit(0); });

for (;;) {
  let line: string;
  try { line = (await rl.question("\x1b[1myou>\x1b[0m ")).trim(); }
  catch { break; } // Ctrl-D
  if (line === "") continue;
  if (line === "/quit" || line === "/exit") break;
  if (line === "/clear") { history.length = 0; console.log("(history cleared)"); continue; }
  if (line === "/models") {
    try { console.log((await listClaudeModels()).join("\n")); }
    catch (error) { console.error(`models: ${error instanceof Error ? error.message : error}`); }
    continue;
  }
  const switchTo = line.match(/^\/model\s+(\S+)$/);
  if (switchTo?.[1]) { model = switchTo[1]; console.log(`(model → ${model} — history kept)`); continue; }

  history.push({ role: "user", content: line });
  try {
    const reply = await chatTurn();
    history.push({ role: "assistant", content: reply });
  } catch (error) {
    history.pop(); // failed turn: drop the user msg so a retry resends cleanly
    console.error(`\nerror: ${error instanceof Error ? error.message : error}`);
  }
}
rl.close();
