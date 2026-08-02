#!/usr/bin/env bun
/**
 * Prove a proxied model actually works through the Claude Agent SDK — not just
 * through a raw `curl` to /v1/messages.
 *
 *   bun scripts/cliproxy-smoke.ts                       # every model in /v1/models
 *   bun scripts/cliproxy-smoke.ts qwen3.8-max-preview   # just these
 *
 * A curl proves the endpoint answers. It does NOT prove the SDK path works —
 * the SDK sends a system prompt and tool schemas, streams partial messages, and
 * terminates on a `result` message whose `total_cost_usd` / `num_turns` the
 * factory reads to enforce its spend caps (src/agents.ts:432-433). A proxy that
 * answers curl but reports no cost would leave MAX_BUDGET_USD_PER_ISSUE and the
 * rolling daily cap silently seeing 0 — fail-OPEN on budget.
 *
 * This mirrors runOneAttempt in src/agents.ts: same whitelist-only env, same
 * tool-less reviewer-shaped options, same result parsing.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

const BASE = (process.env.PROXY_BASE_URL ?? "http://127.0.0.1:8317").replace(/\/+$/, "");
const TOKEN = process.env.PROXY_AUTH_TOKEN ?? "";
if (!TOKEN) {
  console.error("error: PROXY_AUTH_TOKEN is not set (it lives in .env — run via `bun --env-file=.env` or export it)");
  process.exit(1);
}

// A review-shaped task: the reviewer legs are tool-less and must return prose
// that names a specific defect. "Say OK" would pass on a model too weak to review.
const PROMPT = `Security-review this diff. Name the vulnerability, give the concrete failure scenario, and rate severity. Be concise.

\`\`\`diff
+app.get("/report/:id", async (req, res) => {
+  const row = await sql.unsafe(\`SELECT * FROM reports WHERE id = \${req.params.id}\`);
+  res.json(row);
+});
\`\`\``;

async function listModels(): Promise<string[]> {
  const res = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`GET /v1/models -> HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}

interface Outcome {
  model: string; ok: boolean; turns: number; costUsd: number; chars: number;
  streamed: boolean; wallSeconds: number; subtype: string; note: string;
}

async function smoke(model: string): Promise<Outcome> {
  const t0 = Date.now();
  // The SDK `env` option REPLACES the subprocess environment (C5 in agents.ts),
  // so this whitelist is exactly what the stage would get.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SHELL: process.env.SHELL ?? "",
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ANTHROPIC_BASE_URL: BASE,
    ANTHROPIC_AUTH_TOKEN: TOKEN,
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("deadline")), 180_000);
  let text = "";
  let streamed = false;
  let result: Record<string, unknown> | null = null;
  try {
    const q = sdkQuery({
      prompt: PROMPT,
      options: {
        model,
        allowedTools: [],           // reviewer legs are tool-less
        permissionMode: "dontAsk",
        maxTurns: 4,
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        includePartialMessages: true,
        env,
        abortController: abort,
      },
    });
    for await (const message of q) {
      const m = message as {
        type?: string; subtype?: string; message?: { content?: unknown };
        event?: { type?: string; delta?: { type?: string; text?: string } };
      };
      if (m.type === "stream_event" && m.event?.type === "content_block_delta"
        && m.event.delta?.type === "text_delta") { streamed = true; continue; }
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const block of m.message.content as Array<{ type?: string; text?: string }>) {
          if (block.type === "text" && block.text) text += block.text;
        }
        continue;
      }
      if (m.type === "result") result = m as Record<string, unknown>;
    }
  } catch (error) {
    clearTimeout(timer);
    return { model, ok: false, turns: 0, costUsd: 0, chars: 0, streamed, subtype: "throw",
      wallSeconds: Math.round((Date.now() - t0) / 1000),
      note: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120) };
  }
  clearTimeout(timer);

  const subtype = typeof result?.subtype === "string" ? result.subtype : "<none>";
  const costUsd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : 0;
  const turns = typeof result?.num_turns === "number" ? result.num_turns : 0;
  // agents.ts treats a non-"success" subtype as a stage error (C7).
  const ok = subtype === "success" && text.trim().length > 0;
  const notes: string[] = [];
  if (!result) notes.push("NO result message");
  if (ok && costUsd === 0) notes.push("cost=0 -> spend caps blind");
  if (ok && !streamed) notes.push("no stream deltas (UI shows no live activity)");
  if (subtype !== "success" && subtype !== "<none>") notes.push(`subtype=${subtype}`);
  if (ok && !/inject/i.test(text)) notes.push("did not identify SQL injection");

  return { model, ok, turns, costUsd, chars: text.trim().length, streamed, subtype,
    wallSeconds: Math.round((Date.now() - t0) / 1000), note: notes.join("; ") || "-" };
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const models = targets.length > 0 ? targets : await listModels();
if (models.length === 0) {
  console.error("no models on the proxy — nothing to smoke-test");
  process.exit(1);
}
console.log(`proxy ${BASE} — smoke-testing ${models.length} model(s) through the Agent SDK\n`);

const rows: Outcome[] = [];
for (const model of models) {
  process.stdout.write(`  ${model.padEnd(24)} `);
  const r = await smoke(model);
  rows.push(r);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${String(r.turns).padStart(2)}t ` +
    `$${r.costUsd.toFixed(4)}  ${String(r.chars).padStart(5)}ch  ${String(r.wallSeconds).padStart(3)}s  ${r.note}`);
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} usable through the SDK`);
if (failed.length > 0) console.log(`failed: ${failed.map((f) => f.model).join(", ")}`);
const blind = rows.filter((r) => r.ok && r.costUsd === 0);
if (blind.length > 0) {
  console.log(`\nWARNING: ${blind.length} model(s) report total_cost_usd = 0.`);
  console.log("src/agents.ts:432 feeds that into Budget.spent, so MAX_BUDGET_USD_PER_ISSUE");
  console.log("and MAX_BUDGET_USD_PER_DAY cannot see spend on them. Turns/wall-clock caps");
  console.log("still apply — they are the primary governor (plan v0.2 §7) — but the USD");
  console.log("backstop is not enforceable for these models.");
}
process.exit(failed.length > 0 ? 1 : 0);
