import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { buildFixerWritableScope, buildWriteGuardHooks, withinFixerWriteScope } from "../src/write-guard.ts";

// Write-scope hook (ticket #7): the fixer/design-fixer's write access is
// scoped to exactly the files a review round's findings named, unioned with
// whatever the implementer already touched — so a fixer round can no longer
// relitigate/restyle files nobody flagged (telemetry: FAC-78's src/style.css
// rewritten 56 times across 4 stages). This layer sits ALONGSIDE the
// pre-existing guarded-path policy (repos.ts writeGuardVerdict), never
// instead of it, and only scopes EXISTING files — a brand-new file (e.g. a
// genuinely warranted new test) is never blocked by scope alone.

describe("buildFixerWritableScope — pure set-merge with path normalization", () => {
  test("unions implementer-touched files and findings files, deduped", () => {
    const scope = buildFixerWritableScope(["src/a.ts", "src/shared.ts"], ["src/b.ts", "src/shared.ts"]);
    expect([...scope].sort()).toEqual(["src/a.ts", "src/b.ts", "src/shared.ts"]);
  });

  test("strips a leading './' so a cosmetic path difference never causes a false deny", () => {
    const scope = buildFixerWritableScope(["./src/a.ts"], []);
    expect(scope.has("src/a.ts")).toBe(true);
  });

  test("drops blank entries and empty inputs yield an empty scope", () => {
    expect(buildFixerWritableScope([], [])).toEqual(new Set());
    expect(buildFixerWritableScope(["  ", ""], []).size).toBe(0);
  });
});

describe("withinFixerWriteScope — pure scope check", () => {
  test("undefined scope means no scoping at all — always writable (pre-ticket-#7 behavior)", () => {
    expect(withinFixerWriteScope("src/anything.ts", true, undefined)).toBe(true);
  });

  test("a brand-new file (does not yet exist) is always writable, even outside scope", () => {
    const scope = new Set(["src/a.ts"]);
    expect(withinFixerWriteScope("src/new-file.ts", false, scope)).toBe(true);
  });

  test("an EXISTING file inside the scope is writable", () => {
    const scope = new Set(["src/a.ts"]);
    expect(withinFixerWriteScope("src/a.ts", true, scope)).toBe(true);
  });

  test("an EXISTING file outside the scope is denied", () => {
    const scope = new Set(["src/a.ts"]);
    expect(withinFixerWriteScope("src/unrelated.ts", true, scope)).toBe(false);
  });

  test("normalizes a leading './' before comparing", () => {
    const scope = new Set(["src/a.ts"]);
    expect(withinFixerWriteScope("./src/a.ts", true, scope)).toBe(true);
  });
});

describe("buildWriteGuardHooks — end-to-end PreToolUse decisions", () => {
  function makeWorktree(): { dir: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "factory-writescope-"));
    const dir = join(root, "work");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "existing.ts"), "// pre-existing\n");
    writeFileSync(join(dir, "scoped.ts"), "// pre-existing, in scope\n");
    return { dir, root };
  }

  const invoke = async (hooks: ReturnType<typeof buildWriteGuardHooks>, filePath: string) => {
    const guard = hooks.PreToolUse![0]!.hooks[0]!;
    const input: PreToolUseHookInput = {
      hook_event_name: "PreToolUse", session_id: "s", transcript_path: "t", cwd: "",
      tool_name: "Edit", tool_input: { file_path: filePath }, tool_use_id: "u",
    };
    return guard(input, undefined, { signal: new AbortController().signal });
  };

  test("no writableScope configured: existing file outside any 'scope' still allowed (byte-identical to pre-ticket-#7)", async () => {
    const { dir, root } = makeWorktree();
    try {
      const hooks = buildWriteGuardHooks(dir);
      const out = await invoke(hooks, join(dir, "existing.ts"));
      expect(out.hookSpecificOutput).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("writableScope configured: an existing file NOT in scope is denied with a scope-specific reason", async () => {
    const { dir, root } = makeWorktree();
    try {
      const hooks = buildWriteGuardHooks(dir, { writableScope: new Set(["scoped.ts"]) });
      const out = await invoke(hooks, join(dir, "existing.ts"));
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("write scope");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("writableScope configured: an existing file IN scope is allowed", async () => {
    const { dir, root } = makeWorktree();
    try {
      const hooks = buildWriteGuardHooks(dir, { writableScope: new Set(["scoped.ts"]) });
      const out = await invoke(hooks, join(dir, "scoped.ts"));
      expect(out.hookSpecificOutput).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("writableScope configured: a brand-new file is still allowed (scope never blocks genuine additions)", async () => {
    const { dir, root } = makeWorktree();
    try {
      const hooks = buildWriteGuardHooks(dir, { writableScope: new Set(["scoped.ts"]) });
      const out = await invoke(hooks, join(dir, "brand-new.ts"));
      expect(out.hookSpecificOutput).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the guarded-path policy still wins even when the path happens to be in scope", async () => {
    const { dir, root } = makeWorktree();
    try {
      const hooks = buildWriteGuardHooks(dir, { writableScope: new Set(["CLAUDE.md"]) });
      const out = await invoke(hooks, join(dir, "CLAUDE.md"));
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("factory-guarded");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
