import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { writeGuardVerdict } from "./repos.ts";

// PreToolUse write guard (SDK-leverage item 2). Before this hook existed,
// guarded-path violations were discovered only at DELIVERY — after the entire
// pipeline's spend — as a needs-human park (telemetry: the top autonomy leak,
// ~$9-13 of paid work per stranded issue). The hook denies the Write/Edit at
// TOOL TIME with a reason the agent reads and adapts to, so the run reroutes
// immediately instead of finishing a doomed edit.
//
// SAFETY SHAPE:
//  - Deny-only, and the delivery-time classifyStatusPaths park REMAINS the
//    enforcement of record — the hook is early warning for the same in-code
//    policy (repos.ts writeGuardVerdict), never a second policy and never a
//    replacement. A hook bug therefore fails OPEN to today's behavior.
//  - The guarded set is code-owned (repos.ts constants). Nothing here reads
//    ticket text, so untrusted input cannot alter what is guarded.
//  - Callers skip attaching the hook entirely when the project's explicit
//    auto-grant bypasses guards (guardBypassAllowed — full-auto projects may
//    change any files), mirroring the delivery-time bypass exactly.

/** Build the hooks map for a WRITE-capable stage running in `cwd` (the issue
 * worktree). Attach via runStage's `hooks` opt; read-only stages get none. */
export function buildWriteGuardHooks(cwd: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const guard = async (input: HookInput): Promise<HookJSONOutput> => {
    try {
      if (input.hook_event_name !== "PreToolUse") return {};
      const ti = input.tool_input as { file_path?: unknown; notebook_path?: unknown } | undefined;
      const raw = typeof ti?.file_path === "string" ? ti.file_path
        : typeof ti?.notebook_path === "string" ? ti.notebook_path : "";
      if (raw === "") return {};
      const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
      const rel = relative(cwd, abs);
      // Outside the worktree: the SDK's own workspace boundary governs; the
      // guard only speaks for paths it can classify relative to the worktree.
      if (rel.startsWith("..")) return {};
      const denial = writeGuardVerdict(rel, existsSync(abs));
      if (denial === null) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: denial,
        },
      };
    } catch {
      // Fail OPEN: a hook crash must never block legitimate work — the
      // delivery-time park still enforces the policy.
      return {};
    }
  };
  return { PreToolUse: [{ matcher: "Write|Edit|NotebookEdit", hooks: [guard] }] };
}
