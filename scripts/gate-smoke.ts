#!/usr/bin/env bun
/**
 * Smoke-test STRUCTURED GATE OUTPUT transports (issue #6 Part 1) against real
 * models — the proxied reviewer legs (CLIProxyAPI) and direct Anthropic — the
 * same way scripts/cliproxy-smoke.ts proves plain SDK viability.
 *
 *   bun --env-file=.env scripts/gate-smoke.ts deepseek-v4-flash-0731 qwen3.8-max-preview
 *   bun --env-file=.env scripts/gate-smoke.ts --direct sonnet
 *
 * Two mechanisms per model:
 *   sdk    — options.outputFormat { type:"json_schema", schema: GATE_OUTPUT_SCHEMA },
 *            verdict read from the result message's `structured_output`.
 *   fenced — prompt appends GATE_JSON_INSTRUCTION; verdict recovered by
 *            src/gate.ts resolveGateOutput from a fenced ```json block.
 *
 * PASS means: the REAL validator (validateGateOutput / resolveGateOutput — the
 * exact code the daemon will run) recovered a verdict, and the verdict is the
 * expected one for the planted vulnerability (fail). Cheap by construction:
 * tool-less, 4-turn cap, one small prompt per mechanism.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { GATE_OUTPUT_SCHEMA, GATE_JSON_INSTRUCTION, validateGateOutput, resolveGateOutput } from "../src/gate.ts";

const BASE = (process.env.PROXY_BASE_URL ?? "http://127.0.0.1:8317").replace(/\/+$/, "");
const TOKEN = process.env.PROXY_AUTH_TOKEN ?? "";

const args = process.argv.slice(2);
const direct = args.includes("--direct");
const models = args.filter((a) => !a.startsWith("-"));
if (models.length === 0) {
  console.error("usage: bun --env-file=.env scripts/gate-smoke.ts [--direct] <model> [model...]");
  process.exit(1);
}
if (!direct && !TOKEN) {
  console.error("error: PROXY_AUTH_TOKEN is not set (it lives in .env — run via `bun --env-file=.env`)");
  process.exit(1);
}

// Same review-shaped task as cliproxy-smoke.ts: a planted SQL injection the
// model must find, so the expected structured verdict is "fail".
const PROMPT = `You are a security reviewer in an automated pipeline. Review this diff for vulnerabilities it introduces. For each real issue: the exact scenario, the impact, the responsible hunk. End with exactly one line — "SECURITY: pass" or "SECURITY: fail".

\`\`\`diff
+app.get("/report/:id", async (req, res) => {
+  const row = await sql.unsafe(\`SELECT * FROM reports WHERE id = \${req.params.id}\`);
+  res.json(row);
+});
\`\`\``;

interface Outcome {
  model: string; mechanism: "sdk" | "fenced"; ok: boolean; verdict: string;
  source: string; findings: number; subtype: string; costUsd: number;
  wallSeconds: number; note: string;
}

async function run(model: string, mechanism: "sdk" | "fenced"): Promise<Outcome> {
  const t0 = Date.now();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SHELL: process.env.SHELL ?? "",
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ...(direct ? {} : { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: TOKEN }),
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("deadline")), 240_000);
  let text = "";
  let result: Record<string, unknown> | null = null;
  try {
    const q = sdkQuery({
      prompt: mechanism === "fenced" ? PROMPT + "\n" + GATE_JSON_INSTRUCTION : PROMPT,
      options: {
        model,
        allowedTools: [],
        permissionMode: "dontAsk",
        maxTurns: 4,
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        ...(mechanism === "sdk" ? { outputFormat: { type: "json_schema", schema: GATE_OUTPUT_SCHEMA } } : {}),
        env,
        abortController: abort,
      },
    });
    for await (const message of q) {
      const m = message as { type?: string; message?: { content?: unknown } };
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const block of m.message.content as Array<{ type?: string; text?: string }>) {
          if (block.type === "text" && block.text) text += block.text;
        }
      }
      if (m.type === "result") result = m as Record<string, unknown>;
    }
  } catch (error) {
    clearTimeout(timer);
    return { model, mechanism, ok: false, verdict: "-", source: "-", findings: 0, subtype: "throw",
      costUsd: 0, wallSeconds: Math.round((Date.now() - t0) / 1000),
      note: (error instanceof Error ? error.message : String(error)).slice(0, 120) };
  }
  clearTimeout(timer);

  const subtype = typeof result?.subtype === "string" ? result.subtype : "<none>";
  const costUsd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : 0;
  const structured = result && "structured_output" in result ? result.structured_output : undefined;
  const resultText = typeof result?.result === "string" ? result.result : "";

  // Exactly what the daemon will do: validate structured_output, then fall
  // back to fenced JSON in the text, then the legacy token.
  const resolved = resolveGateOutput(
    { text: text || resultText, ...(structured !== undefined ? { structured } : {}) },
    (t) => (/SECURITY:\s*fail\b/i.test(t) ? "fail" : /SECURITY:\s*pass\b/i.test(t) ? "pass" : null),
  );

  const notes: string[] = [];
  if (subtype !== "success") notes.push(`subtype=${subtype}`);
  if (mechanism === "sdk" && structured === undefined) notes.push("NO structured_output on result");
  if (mechanism === "sdk" && structured !== undefined && validateGateOutput(structured) === null) notes.push("structured_output FAILED validation");
  if (resolved && resolved.source === "token") notes.push("fell back to legacy token");
  if (resolved && resolved.verdict !== "fail") notes.push(`verdict=${resolved.verdict} (expected fail on planted SQLi)`);
  if (costUsd === 0) notes.push("cost=0");

  const ok = subtype === "success" && resolved !== null && resolved.verdict === "fail"
    && (mechanism === "sdk" ? resolved.source === "structured" : resolved.source === "fenced-json");
  return { model, mechanism, ok, verdict: resolved?.verdict ?? "NONE", source: resolved?.source ?? "-",
    findings: resolved?.findings.length ?? 0, subtype, costUsd,
    wallSeconds: Math.round((Date.now() - t0) / 1000), note: notes.join("; ") || "-" };
}

console.log(`${direct ? "DIRECT Anthropic" : `proxy ${BASE}`} — structured-gate smoke, ${models.length} model(s) x 2 mechanisms\n`);
const rows: Outcome[] = [];
for (const model of models) {
  for (const mechanism of ["sdk", "fenced"] as const) {
    process.stdout.write(`  ${model.padEnd(26)} ${mechanism.padEnd(7)} `);
    const r = await run(model, mechanism);
    rows.push(r);
    console.log(`${r.ok ? "PASS" : "FAIL"}  verdict=${r.verdict.padEnd(9)} src=${r.source.padEnd(12)} findings=${r.findings}  $${r.costUsd.toFixed(4)}  ${String(r.wallSeconds).padStart(3)}s  ${r.note}`);
  }
}
const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} mechanism-model combinations usable`);
process.exit(failed.length > 0 ? 1 : 0);
