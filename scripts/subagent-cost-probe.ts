#!/usr/bin/env bun
/**
 * Does subagent spend roll up into the PARENT's total_cost_usd?
 *
 *   bun --env-file=.env scripts/subagent-cost-probe.ts [model]
 *
 * This decides whether enabling the orchestration tools is bounded or not.
 * src/agents.ts:432 reads `total_cost_usd` off the parent result and feeds it
 * into Budget.spent, which is what enforces MAX_BUDGET_USD_PER_ISSUE and the
 * rolling MAX_BUDGET_USD_PER_DAY. If a spawned subagent's tokens are NOT
 * included in that figure, then:
 *   - the per-issue USD cap cannot see swarm spend,
 *   - maxTurns does not help either (a subagent's turns do not count against
 *     the parent's turn budget — they are a separate loop),
 *   - so the only remaining bound is wall-clock.
 *
 * Runs the same task twice: once with orchestration DENIED (baseline), once
 * with it ALLOWED and a prompt that forces fan-out. Compares cost and tokens.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.argv.find((a) => !a.startsWith("-") && !a.includes("/") && a !== process.argv[0] && a !== process.argv[1]) ?? "sonnet";

// A scratch dir with three files, so a fan-out has something real to divide up.
const dir = mkdtempSync(join(tmpdir(), "subagent-probe-"));
for (const [name, body] of [
  ["alpha.ts", "export const a = 1;\n// TODO: alpha needs bounds checking\n"],
  ["beta.ts", "export const b = 2;\n// TODO: beta leaks a handle\n"],
  ["gamma.ts", "export const g = 3;\n// TODO: gamma has an off-by-one\n"],
] as const) writeFileSync(join(dir, name), body);

const PROMPT_FANOUT = `There are three files here: alpha.ts, beta.ts, gamma.ts.
Spawn a SEPARATE subagent for EACH file (use the Task/Agent tool, three of them, in parallel).
Each subagent must read its file and report the TODO it finds.
Then summarise all three findings. Do not read the files yourself.`;

const PROMPT_BASELINE = `There are three files here: alpha.ts, beta.ts, gamma.ts.
Read each one and report the TODO you find in each. Then summarise all three findings.`;

interface Run {
  label: string; costUsd: number; turns: number; inTok: number; outTok: number;
  models: string[]; toolCalls: string[]; wallSeconds: number; subtype: string;
}

// Mirror the routing rule in src/agents.ts runOneAttempt: anything that is not
// a Claude alias goes through CLIProxyAPI. The SDK `env` option REPLACES the
// subprocess environment, so a proxied model needs the full whitelist, and a
// Claude model needs `env` left undefined so direct SDK auth (~/.claude) works.
const CLAUDE_ALIASES = ["opus", "sonnet", "haiku", "fable"];
const viaProxy = !MODEL.startsWith("claude") && !CLAUDE_ALIASES.includes(MODEL);
const proxyEnv: Record<string, string> | undefined = viaProxy
  ? {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SHELL: process.env.SHELL ?? "",
      USER: process.env.USER ?? "",
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ANTHROPIC_BASE_URL: (process.env.PROXY_BASE_URL ?? "http://127.0.0.1:8317").replace(/\/+$/, ""),
      ANTHROPIC_AUTH_TOKEN: process.env.PROXY_AUTH_TOKEN ?? "",
    }
  : undefined;

async function run(label: string, prompt: string, allowOrchestration: boolean): Promise<Run> {
  const t0 = Date.now();
  const toolCalls: string[] = [];
  let result: Record<string, unknown> | null = null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("deadline")), 600_000);
  try {
    const q = sdkQuery({
      prompt,
      options: {
        model: MODEL,
        cwd: dir,
        allowedTools: allowOrchestration
          ? ["Read", "Glob", "Grep", "Task", "Agent"]
          : ["Read", "Glob", "Grep"],
        // Mirror agents.ts: it hard-denies orchestration on every worker.
        ...(allowOrchestration ? {} : { disallowedTools: ["Task", "Agent"] }),
        permissionMode: "dontAsk",
        maxTurns: 30,
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        ...(proxyEnv ? { env: proxyEnv } : {}),
        abortController: abort,
      },
    });
    for await (const message of q) {
      const m = message as { type?: string; message?: { content?: unknown } };
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const b of m.message.content as Array<{ type?: string; name?: string }>) {
          if (b.type === "tool_use" && b.name) toolCalls.push(b.name);
        }
      }
      if (m.type === "result") result = m as Record<string, unknown>;
    }
  } finally {
    clearTimeout(timer);
  }

  const usage = (result?.modelUsage ?? {}) as Record<string, { inputTokens?: number; outputTokens?: number }>;
  let inTok = 0; let outTok = 0;
  for (const u of Object.values(usage)) { inTok += u.inputTokens ?? 0; outTok += u.outputTokens ?? 0; }

  return {
    label,
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : 0,
    turns: typeof result?.num_turns === "number" ? result.num_turns : 0,
    inTok, outTok,
    models: Object.keys(usage),
    toolCalls,
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    subtype: typeof result?.subtype === "string" ? result.subtype : "<none>",
  };
}

function show(r: Run): void {
  const spawns = r.toolCalls.filter((t) => t === "Task" || t === "Agent").length;
  console.log(`\n${r.label}`);
  console.log(`  subtype     ${r.subtype}`);
  console.log(`  cost        $${r.costUsd.toFixed(4)}`);
  console.log(`  turns       ${r.turns}`);
  console.log(`  tokens      in ${r.inTok}  out ${r.outTok}`);
  console.log(`  models      ${r.models.join(", ") || "<none>"}`);
  console.log(`  tool calls  ${r.toolCalls.length} (${spawns} subagent spawn${spawns === 1 ? "" : "s"})`);
  console.log(`  wall        ${r.wallSeconds}s`);
}

console.log(`model: ${MODEL}   viaProxy: ${viaProxy}   scratch: ${dir}`);
const baseline = await run("BASELINE — orchestration denied, reads files itself", PROMPT_BASELINE, false);
show(baseline);
const fanout = await run("FAN-OUT — orchestration allowed, must spawn 3 subagents", PROMPT_FANOUT, true);
show(fanout);

const spawns = fanout.toolCalls.filter((t) => t === "Task" || t === "Agent").length;
console.log("\n" + "=".repeat(64));
if (spawns === 0) {
  console.log("INCONCLUSIVE: the model never spawned a subagent, so nothing was measured.");
  console.log("Re-run, or strengthen the prompt.");
  process.exit(2);
}
const ratio = baseline.outTok > 0 ? (fanout.outTok / baseline.outTok) : 0;
console.log(`spawned ${spawns} subagent(s).`);
console.log(`cost   baseline $${baseline.costUsd.toFixed(4)}  ->  fan-out $${fanout.costUsd.toFixed(4)}`);
console.log(`out tokens  baseline ${baseline.outTok}  ->  fan-out ${fanout.outTok}   (${ratio.toFixed(2)}x)`);
console.log("");
if (fanout.costUsd > baseline.costUsd * 1.3 || ratio > 1.3) {
  console.log("VERDICT: subagent spend DOES roll up into the parent's total_cost_usd.");
  console.log("=> MAX_BUDGET_USD_PER_ISSUE still binds. Enabling orchestration is bounded by USD.");
} else {
  console.log("VERDICT: subagent spend does NOT appear in the parent's total_cost_usd.");
  console.log("=> MAX_BUDGET_USD_PER_ISSUE is BLIND to swarm spend. Turns do not nest either.");
  console.log("=> Enabling orchestration would be bounded only by wall-clock. Needs its own cap.");
}
