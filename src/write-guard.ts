import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { HookCallbackMatcher, HookEvent, HookInput, PreToolUseHookSpecificOutput } from "@anthropic-ai/claude-agent-sdk";
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
//
// Ticket #7 adds a SECOND, optional scoping layer for the fixer/design-fixer
// stages: their writable set is the union of the files a review round's
// findings named and the files the implementer already touched
// (buildFixerWritableScope), so a round can no longer relitigate/restyle
// files nobody flagged (telemetry: FAC-78's src/style.css rewritten 56 times
// across 4 stages, index.html 28x — the old fixer prompt was unscoped prose).
// This scope check is ADDITIVE and code-owned like the guarded-path policy:
//  - It only ever narrows an EXISTING file's writability; a brand-new file
//    (e.g. a genuinely warranted new test) is never blocked by scope alone,
//    mirroring the existing "new file" exemption in writeGuardVerdict.
//  - When no scope is configured (every caller except the fixer/design-fixer
//    rounds), behavior is byte-identical to before this ticket.
//  - The guarded-path policy is checked FIRST and always wins — scope can
//    only take away access scope would otherwise grant, never restore access
//    the guarded-path policy denies.

/** Strip a leading "./" so "./src/a.ts" and "src/a.ts" compare equal — the
 *  set-merge below must not let a cosmetic path difference cause a false
 *  deny (a genuinely scoped file rejected because of formatting alone). */
function normalizeScopePath(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

/** Pure set-merge: the fixer/design-fixer's writable set for one round is
 *  everything the implementer already touched, unioned with everything this
 *  round's findings named. Blank entries are dropped. */
export function buildFixerWritableScope(
  implementerTouched: readonly string[],
  findingsFiles: readonly string[],
): Set<string> {
  const scope = new Set<string>();
  for (const p of [...implementerTouched, ...findingsFiles]) {
    const norm = normalizeScopePath(p.trim());
    if (norm !== "") scope.add(norm);
  }
  return scope;
}

/** Pure scope check for one candidate write. `scope === undefined` means no
 *  scoping is configured at all (every stage except a scoped fixer/design-
 *  fixer round) — always writable, identical to pre-ticket-#7 behavior. A
 *  file that does not yet exist is always writable regardless of scope: scope
 *  narrows what may be RE-WRITTEN, never blocks a genuinely new addition. */
export function withinFixerWriteScope(relPath: string, fileExists: boolean, scope: ReadonlySet<string> | undefined): boolean {
  if (scope === undefined) return true;
  if (!fileExists) return true;
  return scope.has(normalizeScopePath(relPath));
}

export interface WriteGuardOptions {
  /** When set, additionally denies writes to EXISTING files outside this
   *  scope (ticket #7 fixer/design-fixer write-scoping). Omit for the
   *  unscoped, pre-ticket-#7 behavior every other stage keeps. */
  writableScope?: ReadonlySet<string>;
}

/** This hook only ever emits the sync PreToolUse shape ({} or a
 *  hookSpecificOutput deny) — never any of the other event/async variants
 *  the SDK's wider HookJSONOutput union covers. Typing the guard's own
 *  return as this narrower shape (rather than the full union) lets callers,
 *  including tests, read `.hookSpecificOutput?.permissionDecision` directly
 *  without a cast. */
type WriteGuardOutput = { hookSpecificOutput?: PreToolUseHookSpecificOutput };

/** Build the hooks map for a WRITE-capable stage running in `cwd` (the issue
 * worktree). Attach via runStage's `hooks` opt; read-only stages get none.
 * Return type left for TS to infer (narrower than HookCallbackMatcher's own
 * declared shape — see WriteGuardOutput above) so callers see the guard's
 * actual output type without a cast. */
export function buildWriteGuardHooks(cwd: string, opts: WriteGuardOptions = {}) {
  const guard = async (input: HookInput, _toolUseId?: string, _hookOpts?: { signal: AbortSignal }): Promise<WriteGuardOutput> => {
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
      const exists = existsSync(abs);
      const denial = writeGuardVerdict(rel, exists);
      if (denial !== null) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: denial,
          },
        };
      }
      if (!withinFixerWriteScope(rel, exists, opts.writableScope)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `"${rel}" is outside this round's write scope — only files the findings named, or the implementer already touched, may be edited this round. Fix the named files; do not restyle or refactor "${rel}".`,
          },
        };
      }
      return {};
    } catch {
      // Fail OPEN: a hook crash must never block legitimate work — the
      // delivery-time park still enforces the policy.
      return {};
    }
  };
  return { PreToolUse: [{ matcher: "Write|Edit|NotebookEdit", hooks: [guard] }] } satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}
