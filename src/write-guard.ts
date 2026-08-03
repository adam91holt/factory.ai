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
//
// KNOWN LIMITATION: this hook, like the pre-existing guarded-path hook it is
// modeled on, only fires for the Write/Edit/NotebookEdit tool matcher below —
// a fixer round's Bash access (bun/node/npm/git etc.) is not intercepted, so
// a fixer could in principle mutate a file outside scope via Bash instead of
// Edit. The guarded-path policy tolerates the same gap because it has a
// delivery-time backstop (classifyStatusPaths re-checks the final diff); the
// write-SCOPE added by ticket #7 has no equivalent backstop today. Closing
// that gap needs a genuine second enforcement layer (e.g. a post-stage diff
// check against the computed scope) — out of scope for this ticket, which is
// about prompt construction and PreToolUse scoping, not a full mutation-
// boundary system. Recorded here rather than silently left implicit.

/** Normalize a candidate/scope path so cosmetic and origin differences never
 *  cause a false deny: strips a leading "./", a git-diff "a/"/"b/" prefix,
 *  and any leading "/" (an absolute-looking path, e.g. one a reviewer might
 *  copy verbatim from a ticket's own Area listing). */
function normalizeScopePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/^[ab]\//, "").replace(/^\/+/, "");
}

/** Path-boundary match: exact after normalization, or one path is a "/"-
 *  bounded suffix of the other. Suffix matching (rather than requiring an
 *  exact relative-path match) lets a finding's `file` be recognized even
 *  when it arrived as a full absolute path or with different leading
 *  segments than this worktree's own relative path — without ever matching
 *  an unrelated file that merely shares a trailing filename fragment. */
function scopeContains(scope: ReadonlySet<string>, relPath: string): boolean {
  const norm = normalizeScopePath(relPath);
  if (scope.has(norm)) return true;
  for (const entry of scope) {
    if (norm === entry || norm.endsWith(`/${entry}`) || entry.endsWith(`/${norm}`)) return true;
  }
  return false;
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

/** Pure scope check for one candidate write. `scope === undefined` OR an
 *  EMPTY scope both mean "no usable scoping information" — always writable,
 *  identical to pre-ticket-#7 behavior. An empty scope is not "nothing is
 *  writable": it means the implementer touched nothing and no finding named
 *  a file (e.g. the diff was unavailable), so there is nothing trustworthy to
 *  restrict to — the guard's documented shape is fail-OPEN, never a silent
 *  full lockout manufactured from an absence of information. A file that
 *  does not yet exist is always writable regardless of scope: scope narrows
 *  what may be RE-WRITTEN, never blocks a genuinely new addition. */
export function withinFixerWriteScope(relPath: string, fileExists: boolean, scope: ReadonlySet<string> | undefined): boolean {
  if (scope === undefined || scope.size === 0) return true;
  if (!fileExists) return true;
  return scopeContains(scope, relPath);
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
