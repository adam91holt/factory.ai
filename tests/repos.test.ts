import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPaths, classifyStatusPaths, commitsBehindBase, fetchBase, ghRepoCreateArgs, guardedPathsTouched, headSha, isAdditiveTestExtension, isTransientMergeError, mergeBaseIntoBranch, mergePrArgs, mergeRefusedBecauseHeadMoved, parseNameStatus, redactRevertWhy, repoFromTicket, revertMerge, type Workspace } from "../src/repos.ts";

describe("isTransientMergeError — retry only flaky GitHub/network merge failures", () => {
  test("GitHub 5xx / gateway / network shapes are transient", () => {
    expect(isTransientMergeError('non-200 OK status code: 502 Bad Gateway body: "<html>..."')).toBe(true);
    expect(isTransientMergeError("503 Service Unavailable")).toBe(true);
    expect(isTransientMergeError("504 Gateway Time-out")).toBe(true);
    expect(isTransientMergeError("ECONNRESET")).toBe(true);
    expect(isTransientMergeError("request timed out")).toBe(true);
  });
  test("real refusals are NOT transient (a retry would just hit them again)", () => {
    expect(isTransientMergeError("Pull request is not mergeable: merge conflict")).toBe(false);
    expect(isTransientMergeError("Required status check 'ci' is expected")).toBe(false);
    expect(isTransientMergeError("Head branch was modified. Review and try the merge again.")).toBe(false);
    expect(isTransientMergeError("branch protection: review required")).toBe(false);
  });
});

describe("classifyPaths — guarded-path detection", () => {
  test("guards factory governance directories at root and nested", () => {
    expect(classifyPaths([".github/workflows/ci.yml"])).toEqual([".github/workflows/ci.yml"]);
    expect(classifyPaths(["sub/.github/x.yml"])).toEqual(["sub/.github/x.yml"]);
    expect(classifyPaths(["CLAUDE.md"])).toEqual(["CLAUDE.md"]);
    expect(classifyPaths(["packages/app/CLAUDE.md"])).toEqual(["packages/app/CLAUDE.md"]);
    expect(classifyPaths([".claude/settings.json"])).toEqual([".claude/settings.json"]);
    expect(classifyPaths(["skills/game-feel/SKILL.md"])).toEqual(["skills/game-feel/SKILL.md"]);
    expect(classifyPaths(["groundskeepers/factory.md"])).toEqual(["groundskeepers/factory.md"]);
    expect(classifyPaths(["agents/implementer.md"])).toEqual(["agents/implementer.md"]);
  });

  test("guards the project registry (projects/) at root and nested (Gap 5)", () => {
    expect(classifyPaths(["projects/kiwi.md"])).toEqual(["projects/kiwi.md"]);
    expect(classifyPaths(["some/projects/kiwi.md"])).toEqual(["some/projects/kiwi.md"]);
    expect(classifyPaths(["myprojects/x.md"])).toEqual([]); // needs a boundary
  });

  test("guards test files: tests?/ dirs, .test., .spec.", () => {
    expect(classifyPaths(["tests/cron.test.ts"])).toEqual(["tests/cron.test.ts"]);
    expect(classifyPaths(["test/helpers.ts"])).toEqual(["test/helpers.ts"]);
    expect(classifyPaths(["src/foo.test.ts"])).toEqual(["src/foo.test.ts"]);
    expect(classifyPaths(["src/foo.spec.tsx"])).toEqual(["src/foo.spec.tsx"]);
    expect(classifyPaths(["pkg/deep/tests/a.ts"])).toEqual(["pkg/deep/tests/a.ts"]);
  });

  test("does not over-match lookalike names", () => {
    expect(classifyPaths(["src/loop.ts"])).toEqual([]);
    expect(classifyPaths(["src/testutils.ts"])).toEqual([]);       // "test" prefix, not tests?/ dir
    expect(classifyPaths(["contest/entry.ts"])).toEqual([]);        // "test" inside a segment
    expect(classifyPaths(["docs/CLAUDE.md.bak"])).toEqual([]);      // CLAUDE.md must be terminal
    expect(classifyPaths(["myagents/card.md"])).toEqual([]);        // agents/ needs a boundary
    expect(classifyPaths(["reskills/x.md"])).toEqual([]);
    expect(classifyPaths(["src/attest.ts"])).toEqual([]);
  });

  test("filters a mixed change set down to the guarded subset, order preserved", () => {
    const files = [
      "src/verify.ts",
      "tests/setup.ts",
      "README.md",
      "agents/fixer.md",
      "ui/src/main.tsx",
      "src/loop.spec.ts",
    ];
    expect(classifyPaths(files)).toEqual(["tests/setup.ts", "agents/fixer.md", "src/loop.spec.ts"]);
  });

  test("empty input → empty output", () => {
    expect(classifyPaths([])).toEqual([]);
  });
});

describe("parseNameStatus — git diff --name-status parsing", () => {
  test("parses simple add/modify/delete lines", () => {
    expect(parseNameStatus("A\tsrc/foo.test.ts")).toEqual([{ status: "A", file: "src/foo.test.ts" }]);
    expect(parseNameStatus("M\tsrc/foo.test.ts")).toEqual([{ status: "M", file: "src/foo.test.ts" }]);
    expect(parseNameStatus("D\tsrc/foo.test.ts")).toEqual([{ status: "D", file: "src/foo.test.ts" }]);
  });

  test("a rename keeps the NEW path (last tab-separated field)", () => {
    expect(parseNameStatus("R100\told/name.ts\tnew/name.ts")).toEqual([{ status: "R100", file: "new/name.ts" }]);
  });

  test("blank lines and trailing newline are dropped", () => {
    expect(parseNameStatus("A\ta.ts\n\nM\tb.ts\n")).toEqual([
      { status: "A", file: "a.ts" },
      { status: "M", file: "b.ts" },
    ]);
  });

  test("empty input → empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("classifyStatusPaths — added-vs-modified guarded-path policy (#1)", () => {
  test("a newly-ADDED test file is NOT guarded", () => {
    expect(classifyStatusPaths([{ status: "A", file: "tests/new-feature.test.ts" }])).toEqual([]);
    expect(classifyStatusPaths([{ status: "A", file: "src/new-feature.spec.ts" }])).toEqual([]);
  });

  test("a MODIFIED pre-existing test file IS guarded", () => {
    expect(classifyStatusPaths([{ status: "M", file: "tests/existing.test.ts" }])).toEqual(["tests/existing.test.ts"]);
  });

  test("a DELETED pre-existing test file IS guarded", () => {
    expect(classifyStatusPaths([{ status: "D", file: "tests/existing.test.ts" }])).toEqual(["tests/existing.test.ts"]);
  });

  test("a RENAMED test file IS guarded (not treated as a fresh add)", () => {
    expect(classifyStatusPaths([{ status: "R100", file: "tests/renamed.test.ts" }])).toEqual(["tests/renamed.test.ts"]);
  });

  test("non-test guarded paths stay guarded even when newly ADDED — self-mod dirs are never 'just adding tests'", () => {
    expect(classifyStatusPaths([{ status: "A", file: "agents/new-agent.md" }])).toEqual(["agents/new-agent.md"]);
    expect(classifyStatusPaths([{ status: "A", file: ".github/workflows/new.yml" }])).toEqual([".github/workflows/new.yml"]);
    expect(classifyStatusPaths([{ status: "A", file: "projects/new-project.md" }])).toEqual(["projects/new-project.md"]);
  });

  test("non-guarded paths pass through untouched regardless of status", () => {
    expect(classifyStatusPaths([{ status: "A", file: "src/loop.ts" }])).toEqual([]);
    expect(classifyStatusPaths([{ status: "M", file: "src/loop.ts" }])).toEqual([]);
  });

  test("mixed change set: only the guarded, non-added-test subset survives", () => {
    const entries = [
      { status: "A", file: "src/verify.ts" },
      { status: "A", file: "tests/new.test.ts" },       // added test — not guarded
      { status: "M", file: "tests/setup.ts" },           // modified pre-existing test — guarded
      { status: "D", file: "tests/old.test.ts" },        // deleted pre-existing test — guarded
      { status: "M", file: "agents/fixer.md" },          // self-mod dir — guarded
      { status: "A", file: "README.md" },
    ];
    expect(classifyStatusPaths(entries)).toEqual(["tests/setup.ts", "tests/old.test.ts", "agents/fixer.md"]);
  });
});

describe("isAdditiveTestExtension — pure add-vs-weaken diff classifier (test-add-vs-weaken)", () => {
  test("pure-additive modification (only + lines with new assertions) → extension, not guarded", () => {
    const diff = [
      "diff --git a/tests/foo.test.ts b/tests/foo.test.ts",
      "--- a/tests/foo.test.ts",
      "+++ b/tests/foo.test.ts",
      "@@ -1,3 +1,4 @@",
      ' describe("foo", () => {',
      '   it("does a", () => { expect(x).toBe(y); });',
      '+  it("does b", () => { expect(p).toBe(q); });',
      " });",
    ].join("\n");
    expect(isAdditiveTestExtension(diff)).toBe(true);
  });

  test("+15/-3 assertions — any removed pre-existing assertion line stays guarded, even with a large net add (no tolerance)", () => {
    const added = Array.from({ length: 15 }, (_, i) => `+  expect(state.field${i}).toBe(${i});`);
    const removed = Array.from({ length: 3 }, (_, i) => `-  expect(state.old${i}).toBe(${i});`);
    const diff = [
      "--- a/tests/foo.test.ts",
      "+++ b/tests/foo.test.ts",
      "@@ -1,5 +1,17 @@",
      ' it("tracks state", () => {',
      ...removed,
      ...added,
      " });",
    ].join("\n");
    // A purely-additive extension never removes an existing assertion line —
    // a rewritten/removed line is exactly the diff shape a value-edit or
    // matcher-loosening weakening produces, so there is no net-count
    // tolerance: any assertionsRemoved > 0 keeps the file guarded.
    expect(isAdditiveTestExtension(diff)).toBe(false);
  });

  test("removing 2 of 3 assertions with nothing added → WEAKENED, guarded", () => {
    const diff = [
      "--- a/tests/foo.test.ts",
      "+++ b/tests/foo.test.ts",
      "@@ -1,5 +1,3 @@",
      ' it("checks stuff", () => {',
      "-  expect(a).toBe(1);",
      "-  expect(b).toBe(2);",
      "   expect(c).toBe(3);",
      " });",
    ].join("\n");
    expect(isAdditiveTestExtension(diff)).toBe(false);
  });

  test("deleting a whole it() block → WEAKENED, guarded (even though the block's own assertion count is small)", () => {
    const diff = [
      "--- a/tests/foo.test.ts",
      "+++ b/tests/foo.test.ts",
      "@@ -1,7 +1,4 @@",
      ' describe("foo", () => {',
      '-  it("does a", () => {',
      "-    expect(x).toBe(y);",
      "-  });",
      '   it("does b", () => { expect(p).toBe(q); });',
      " });",
    ].join("\n");
    expect(isAdditiveTestExtension(diff)).toBe(false);
  });

  test("replacing expect(x).toBe(y) with expect(true).toBe(true) → assertion-gutting, WEAKENED, guarded", () => {
    const diff = [
      "--- a/tests/foo.test.ts",
      "+++ b/tests/foo.test.ts",
      "@@ -1,3 +1,3 @@",
      ' it("checks x", () => {',
      "-  expect(x).toBe(y);",
      "+  expect(true).toBe(true);",
      " });",
    ].join("\n");
    expect(isAdditiveTestExtension(diff)).toBe(false);
  });

  test("comment/formatting-only change (nothing assertion-shaped added) → ambiguous, stays guarded (conservative default)", () => {
    const diff = [
      "--- a/tests/existing.test.ts",
      "+++ b/tests/existing.test.ts",
      "@@ -1 +1 @@",
      "-// pre-existing test",
      "+// modified pre-existing test",
    ].join("\n");
    expect(isAdditiveTestExtension(diff)).toBe(false);
  });

  test("empty diff → not an extension, stays guarded", () => {
    expect(isAdditiveTestExtension("")).toBe(false);
  });

  // --- Adversarial: count-preserving weakenings the OLD net-count classifier
  // misclassified as additive (see FIX for test-add-vs-weaken). Every one of
  // these is a rewritten `-`/`+` pair, not a pure addition, so the strict
  // "zero removed assertion/block lines" rule below must reject all of them.

  test("value-edit: expect(order.total).toBe(42) rewritten to expect(order.total).toBe(order.total) → tautology-by-value-edit, WEAKENED, guarded", () => {
    const diff = [
      "--- a/tests/foo.test.ts",
      "+++ b/tests/foo.test.ts",
      "@@ -1,3 +1,3 @@",
      ' it("computes the total", () => {',
      "-  expect(order.total).toBe(42);",
      "+  expect(order.total).toBe(order.total);",
      " });",
    ].join("\n");
    expect(isAdditiveTestExtension(diff)).toBe(false);
  });

  test("matcher-loosening: toBe(42) rewritten to toBeDefined() → WEAKENED, guarded", () => {
    const diff = [
      "--- a/tests/foo.test.ts",
      "+++ b/tests/foo.test.ts",
      "@@ -1,3 +1,3 @@",
      ' it("computes the total", () => {',
      "-  expect(order.total).toBe(42);",
      "+  expect(order.total).toBeDefined();",
      " });",
    ].join("\n");
    expect(isAdditiveTestExtension(diff)).toBe(false);
  });

  test(".not inversion: expect(fn).toThrow() rewritten to expect(fn).not.toThrow() → WEAKENED, guarded", () => {
    const diff = [
      "--- a/tests/foo.test.ts",
      "+++ b/tests/foo.test.ts",
      "@@ -1,3 +1,3 @@",
      ' it("rejects bad input", () => {',
      "-  expect(fn).toThrow();",
      "+  expect(fn).not.toThrow();",
      " });",
    ].join("\n");
    expect(isAdditiveTestExtension(diff)).toBe(false);
  });

  test("block-swap: a real it()-block replaced by a vacuous one (counts preserved) → WEAKENED, guarded", () => {
    const diff = [
      "--- a/tests/foo.test.ts",
      "+++ b/tests/foo.test.ts",
      "@@ -1,3 +1,3 @@",
      ' describe("foo", () => {',
      '-  it("does the real check", () => { expect(criticalSecurityCheck()).toBe(true); });',
      '+  it("does the real check", () => { expect(true).toBeTruthy(); });',
      " });",
    ].join("\n");
    expect(isAdditiveTestExtension(diff)).toBe(false);
  });

  test("net-zero critical-assertion-for-fluff swap: expect(criticalSecurityCheck()).toBe(true) rewritten to expect(2+2).toBe(4) → WEAKENED, guarded", () => {
    const diff = [
      "--- a/tests/foo.test.ts",
      "+++ b/tests/foo.test.ts",
      "@@ -1,3 +1,3 @@",
      ' it("enforces the security check", () => {',
      "-  expect(criticalSecurityCheck()).toBe(true);",
      "+  expect(2+2).toBe(4);",
      " });",
    ].join("\n");
    expect(isAdditiveTestExtension(diff)).toBe(false);
  });
});

// Real git integration: guardedPathsTouched shells out to `git diff --name-status`
// against ws.baseRef, so these prove the added-vs-modified policy end-to-end
// through an actual worktree, not just the pure classifier above.
describe("guardedPathsTouched — real git worktree (#1: added tests don't halt the pipeline)", () => {
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

  function makeWorkspace(): { ws: Workspace; root: string } {
    const root = mkdtempSync(join(tmpdir(), "factory-guarded-"));
    const originDir = join(root, "origin.git");
    const workDir = join(root, "work");
    git(root, ["init", "--bare", "-b", "main", originDir]);
    git(root, ["clone", originDir, workDir]);
    git(workDir, ["config", "user.email", "t@t.t"]);
    git(workDir, ["config", "user.name", "t"]);
    mkdirSync(join(workDir, "tests"), { recursive: true });
    writeFileSync(join(workDir, "tests", "existing.test.ts"), "// pre-existing test\n");
    git(workDir, ["add", "-A"]);
    git(workDir, ["commit", "-m", "init"]);
    git(workDir, ["push", "origin", "main"]);
    git(workDir, ["checkout", "-b", "feature"]);
    const ws: Workspace = { repo: "acme/kiwi", dir: workDir, branch: "feature", baseRef: "refs/remotes/origin/main" };
    return { ws, root };
  }

  test("adding a brand-new *.test.ts is NOT guarded", () => {
    const { ws, root } = makeWorkspace();
    try {
      writeFileSync(join(ws.dir, "tests", "new-feature.test.ts"), "// new test\n");
      git(ws.dir, ["add", "-A"]);
      git(ws.dir, ["commit", "-m", "add new test"]);
      expect(guardedPathsTouched(ws)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("modifying a pre-existing test file IS guarded", () => {
    const { ws, root } = makeWorkspace();
    try {
      writeFileSync(join(ws.dir, "tests", "existing.test.ts"), "// modified pre-existing test\n");
      git(ws.dir, ["add", "-A"]);
      git(ws.dir, ["commit", "-m", "modify existing test"]);
      expect(guardedPathsTouched(ws)).toEqual(["tests/existing.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deleting a pre-existing test file IS guarded", () => {
    const { ws, root } = makeWorkspace();
    try {
      rmSync(join(ws.dir, "tests", "existing.test.ts"));
      git(ws.dir, ["add", "-A"]);
      git(ws.dir, ["commit", "-m", "delete existing test"]);
      expect(guardedPathsTouched(ws)).toEqual(["tests/existing.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adding a new test alongside an unrelated source change is still NOT guarded", () => {
    const { ws, root } = makeWorkspace();
    try {
      writeFileSync(join(ws.dir, "src-feature.ts"), "export const x = 1;\n");
      writeFileSync(join(ws.dir, "tests", "new-feature.test.ts"), "// new test\n");
      git(ws.dir, ["add", "-A"]);
      git(ws.dir, ["commit", "-m", "feature + test"]);
      expect(guardedPathsTouched(ws)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Real git integration for the add-vs-weaken diff classifier: guardedPathsTouched
// diffs a MODIFIED test-only file against ws.baseRef and exempts it only when
// isAdditiveTestExtension reads the change as additive. These prove the policy
// end-to-end through an actual worktree, not just the pure classifier above.
describe("guardedPathsTouched — MODIFIED test file add-vs-weaken (test-add-vs-weaken)", () => {
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

  function makeWorkspaceWithTestBody(initialBody: string): { ws: Workspace; root: string } {
    const root = mkdtempSync(join(tmpdir(), "factory-guarded-diffcls-"));
    const originDir = join(root, "origin.git");
    const workDir = join(root, "work");
    git(root, ["init", "--bare", "-b", "main", originDir]);
    git(root, ["clone", originDir, workDir]);
    git(workDir, ["config", "user.email", "t@t.t"]);
    git(workDir, ["config", "user.name", "t"]);
    mkdirSync(join(workDir, "tests"), { recursive: true });
    writeFileSync(join(workDir, "tests", "existing.test.ts"), initialBody);
    git(workDir, ["add", "-A"]);
    git(workDir, ["commit", "-m", "init"]);
    git(workDir, ["push", "origin", "main"]);
    git(workDir, ["checkout", "-b", "feature"]);
    const ws: Workspace = { repo: "acme/kiwi", dir: workDir, branch: "feature", baseRef: "refs/remotes/origin/main" };
    return { ws, root };
  }

  test("extending a pre-existing test with net-additive assertions is NOT guarded", () => {
    const { ws, root } = makeWorkspaceWithTestBody(
      'describe("foo", () => {\n  it("does a", () => { expect(x).toBe(y); });\n});\n',
    );
    try {
      writeFileSync(
        join(ws.dir, "tests", "existing.test.ts"),
        'describe("foo", () => {\n'
          + '  it("does a", () => { expect(x).toBe(y); });\n'
          + '  it("does b", () => { expect(p).toBe(q); });\n'
          + '  it("does c", () => { expect(r).toBe(s); });\n'
          + "});\n",
      );
      git(ws.dir, ["add", "-A"]);
      git(ws.dir, ["commit", "-m", "extend existing test"]);
      expect(guardedPathsTouched(ws)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removing 2 of 3 assertions from a pre-existing test STAYS guarded", () => {
    const { ws, root } = makeWorkspaceWithTestBody(
      'it("checks stuff", () => {\n'
        + "  expect(a).toBe(1);\n"
        + "  expect(b).toBe(2);\n"
        + "  expect(c).toBe(3);\n"
        + "});\n",
    );
    try {
      writeFileSync(join(ws.dir, "tests", "existing.test.ts"), 'it("checks stuff", () => {\n  expect(c).toBe(3);\n});\n');
      git(ws.dir, ["add", "-A"]);
      git(ws.dir, ["commit", "-m", "weaken existing test"]);
      expect(guardedPathsTouched(ws)).toEqual(["tests/existing.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deleting a whole it() block from a pre-existing test STAYS guarded", () => {
    const { ws, root } = makeWorkspaceWithTestBody(
      'describe("foo", () => {\n'
        + '  it("does a", () => { expect(x).toBe(y); });\n'
        + '  it("does b", () => { expect(p).toBe(q); });\n'
        + "});\n",
    );
    try {
      writeFileSync(
        join(ws.dir, "tests", "existing.test.ts"),
        'describe("foo", () => {\n  it("does b", () => { expect(p).toBe(q); });\n});\n',
      );
      git(ws.dir, ["add", "-A"]);
      git(ws.dir, ["commit", "-m", "delete a test block"]);
      expect(guardedPathsTouched(ws)).toEqual(["tests/existing.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gutting a real assertion into a no-op (expect(x).toBe(y) -> expect(true).toBe(true)) STAYS guarded", () => {
    const { ws, root } = makeWorkspaceWithTestBody('it("checks x", () => {\n  expect(x).toBe(y);\n});\n');
    try {
      writeFileSync(join(ws.dir, "tests", "existing.test.ts"), 'it("checks x", () => {\n  expect(true).toBe(true);\n});\n');
      git(ws.dir, ["add", "-A"]);
      git(ws.dir, ["commit", "-m", "gut the assertion"]);
      expect(guardedPathsTouched(ws)).toEqual(["tests/existing.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("value-edit weakening (expect(order.total).toBe(42) -> expect(order.total).toBe(order.total)) STAYS guarded end-to-end", () => {
    const { ws, root } = makeWorkspaceWithTestBody(
      'it("computes the total", () => {\n  expect(order.total).toBe(42);\n});\n',
    );
    try {
      writeFileSync(
        join(ws.dir, "tests", "existing.test.ts"),
        'it("computes the total", () => {\n  expect(order.total).toBe(order.total);\n});\n',
      );
      git(ws.dir, ["add", "-A"]);
      git(ws.dir, ["commit", "-m", "neuter the assertion via value edit"]);
      expect(guardedPathsTouched(ws)).toEqual(["tests/existing.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a non-test guarded path (agents/) modified with additive-looking content STILL stays guarded — the diff classifier only exempts test-only paths", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-guarded-diffcls-nontest-"));
    try {
      const originDir = join(root, "origin.git");
      const workDir = join(root, "work");
      git(root, ["init", "--bare", "-b", "main", originDir]);
      git(root, ["clone", originDir, workDir]);
      git(workDir, ["config", "user.email", "t@t.t"]);
      git(workDir, ["config", "user.name", "t"]);
      mkdirSync(join(workDir, "agents"), { recursive: true });
      writeFileSync(join(workDir, "agents", "fixer.md"), "# fixer\n");
      git(workDir, ["add", "-A"]);
      git(workDir, ["commit", "-m", "init"]);
      git(workDir, ["push", "origin", "main"]);
      git(workDir, ["checkout", "-b", "feature"]);
      const ws: Workspace = { repo: "acme/kiwi", dir: workDir, branch: "feature", baseRef: "refs/remotes/origin/main" };

      // Content that would read as a pure-additive extension if it were a test
      // file — proves the exemption never applies outside test-only paths.
      writeFileSync(join(workDir, "agents", "fixer.md"), "# fixer\n\nit(\"looks like a test\", () => { expect(1).toBe(1); });\n");
      git(ws.dir, ["add", "-A"]);
      git(ws.dir, ["commit", "-m", "modify agents card"]);
      expect(guardedPathsTouched(ws)).toEqual(["agents/fixer.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("repoFromTicket", () => {
  test("parses a bare org/name line under ## Repo", () => {
    expect(repoFromTicket("## Goal\nx\n\n## Repo\nadam91holt/factory.ai\n\n## Verifications\ny"))
      .toBe("adam91holt/factory.ai");
  });

  test("parses parens on the header line", () => {
    expect(repoFromTicket("## Repo (acme/widgets)\n\n## Area\nz")).toBe("acme/widgets");
  });

  test("parses backticked and linked forms", () => {
    expect(repoFromTicket("## Repo\n`acme/widgets`\n")).toBe("acme/widgets");
    expect(repoFromTicket("## Repo\n[acme/widgets](https://github.com/acme/widgets)\n")).toBe("acme/widgets");
  });

  test("only reads the ## Repo section — an org/name elsewhere does not count", () => {
    expect(repoFromTicket("## Goal\nport acme/widgets to bun\n\n## Verifications\nnone")).toBeNull();
  });

  test("stops at the next heading", () => {
    expect(repoFromTicket("## Repo\n(none decided)\n\n## Area\nsrc/x.ts of acme/widgets")).toBeNull();
  });

  test("no Repo section → null", () => {
    expect(repoFromTicket("just prose")).toBeNull();
    expect(repoFromTicket("")).toBeNull();
  });

  test("dots, dashes and underscores are allowed in both halves", () => {
    expect(repoFromTicket("## Repo\nmy-org_1/repo.name-x\n")).toBe("my-org_1/repo.name-x");
  });
});

describe("ghRepoCreateArgs — private-by-default (Gap 5, safety envelope a)", () => {
  test("argv contains --private and NEVER --public", () => {
    const args = ghRepoCreateArgs("acme/kiwi", { private: true });
    expect(args).toEqual(["repo", "create", "acme/kiwi", "--private"]);
    expect(args).toContain("--private");
    expect(args).not.toContain("--public");
  });

  test("throws when asked for a non-private repo (defence in depth)", () => {
    // The type makes { private: false } illegal at call sites; the runtime guard
    // catches any bypass. A leaked source repo is a categorical safety failure.
    expect(() => ghRepoCreateArgs("acme/kiwi", { private: false } as unknown as { private: true })).toThrow(/private/i);
  });
});

// Real git integration: a merge commit can ONLY be reverted with `-m 1`; a plain
// `git revert <sha>` errors "commit is a merge but no -m option was given". A
// passing revert here proves revertMerge builds `git revert -m 1 <sha>`.
describe("revertMerge — reverts a merge commit (git revert -m 1)", () => {
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

  test("reverts a first-parent merge and pushes to origin/main", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-revert-"));
    try {
      const originDir = join(root, "origin.git");
      const workDir = join(root, "work");
      git(root, ["init", "--bare", "-b", "main", originDir]);
      git(root, ["clone", originDir, workDir]);
      git(workDir, ["config", "user.email", "t@t.t"]);
      git(workDir, ["config", "user.name", "t"]);
      writeFileSync(join(workDir, "x.txt"), "1\n");
      git(workDir, ["add", "-A"]);
      git(workDir, ["commit", "-m", "init"]);
      git(workDir, ["push", "origin", "main"]);
      // feature branch changes x → 2
      git(workDir, ["checkout", "-b", "feature"]);
      writeFileSync(join(workDir, "x.txt"), "2\n");
      git(workDir, ["commit", "-am", "feature: x=2"]);
      // merge --no-ff into main → a real merge commit
      git(workDir, ["checkout", "main"]);
      git(workDir, ["merge", "--no-ff", "-m", "merge feature", "feature"]);
      git(workDir, ["push", "origin", "main"]);
      const mergeSha = git(workDir, ["rev-parse", "HEAD"]).stdout.trim();

      const result = revertMerge("acme/kiwi", workDir, mergeSha);
      expect(result.ok).toBe(true);
      // x is back to 1 — the merged change was undone.
      expect(spawnSync("cat", [join(workDir, "x.txt")], { encoding: "utf8" }).stdout).toBe("1\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A revert PR body carries the RAW smoke output, which runs with an unscrubbed
// env and routinely echoes credentials — so the body createRevertPr hands to
// `gh pr create --body` MUST pass redactSecrets before it lands in a durable
// GitHub PR body (the redactSecrets-at-every-outbound-seam invariant).
// redactRevertWhy IS that body-builder (createRevertPr: `body = redactRevertWhy(why)`).
describe("redactRevertWhy — scrubs secrets from the revert PR body (outbound seam)", () => {
  test("a token-shaped string in smoke output is redacted from the body", () => {
    const token = `ghp_${"A".repeat(30)}`; // gh personal-access-token shape
    const why = `Post-merge smoke failed for abcdef123456:\ncurl -H "Authorization: Bearer ${token}" https://api.example.com\n401 Unauthorized`;
    const body = redactRevertWhy(why);
    expect(body).not.toContain(token);
    expect(body).toContain("[REDACTED-SECRET]");
  });

  test("a token split across the 1500-char cut is still scrubbed (redact-before-slice)", () => {
    const token = `ghp_${"B".repeat(30)}`;
    // Position the token so a naive slice(0,1500) would bisect it: without
    // redact-before-slice the trailing half would leak into the body.
    const why = `${"x".repeat(1490)}${token}${"y".repeat(400)}`;
    const body = redactRevertWhy(why);
    expect(body).not.toContain(token);
    expect(body).not.toContain("B".repeat(30));
  });
});

// --- merge-integrity primitives (stream: merge-integrity) --------------------
// (1) MATCH-HEAD-COMMIT: the merge argv is pinned-by-construction — no code
// path can produce an unpinned `gh pr merge`, so the factory can never merge
// code its gates did not run against (GitHub refuses atomically if the branch
// moved). (2) The refusal classifier routes a moved branch to a human instead
// of a blind retry.
describe("mergePrArgs — pinned-by-construction (--match-head-commit always present)", () => {
  test("argv pins the merge to the gated SHA", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const args = mergePrArgs("acme/kiwi", "https://github.com/acme/kiwi/pull/1", sha);
    const i = args.indexOf("--match-head-commit");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(sha);
    expect(args.slice(0, 3)).toEqual(["pr", "merge", "https://github.com/acme/kiwi/pull/1"]);
  });

  test("a malformed/absent SHA throws — an unpinned merge argv is unrepresentable", () => {
    expect(() => mergePrArgs("acme/kiwi", "url", "")).toThrow(/unpinned/);
    expect(() => mergePrArgs("acme/kiwi", "url", "not-a-sha")).toThrow(/unpinned/);
    expect(() => mergePrArgs("acme/kiwi", "url", "HEAD")).toThrow(/unpinned/);
    // an injection attempt is rejected on shape alone
    expect(() => mergePrArgs("acme/kiwi", "url", "abc123 --admin")).toThrow(/unpinned/);
  });
});

describe("mergeRefusedBecauseHeadMoved — GitHub's pin-refusal classifier", () => {
  test("matches GitHub's head-moved refusal (plain and GraphQL-wrapped)", () => {
    expect(mergeRefusedBecauseHeadMoved("X Head branch was modified. Review and try the merge again. (HTTP 422)")).toBe(true);
    expect(mergeRefusedBecauseHeadMoved("GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)")).toBe(true);
    expect(mergeRefusedBecauseHeadMoved("head branch has been modified")).toBe(true);
    expect(mergeRefusedBecauseHeadMoved("expected head sha did not match current head ref")).toBe(true);
    expect(mergeRefusedBecauseHeadMoved("--match-head-commit mismatch")).toBe(true);
  });

  test("does NOT match unrelated merge failures (those keep the existing human-review fallback)", () => {
    expect(mergeRefusedBecauseHeadMoved("Pull request is not mergeable: branch protection rules not satisfied")).toBe(false);
    expect(mergeRefusedBecauseHeadMoved("connect: network is unreachable")).toBe(false);
    expect(mergeRefusedBecauseHeadMoved("")).toBe(false);
  });
});

// Real git integration for the stale-main primitives: a sibling clone advances
// origin's main under the feature branch's feet, exactly the two-green-siblings
// race the stale-main re-gate closes.
describe("merge-integrity git primitives — headSha / fetchBase / commitsBehindBase / mergeBaseIntoBranch", () => {
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

  function makeRace(conflicting: boolean): { ws: Workspace; root: string } {
    const root = mkdtempSync(join(tmpdir(), "factory-merge-integrity-"));
    const originDir = join(root, "origin.git");
    const workDir = join(root, "work");
    const sibDir = join(root, "sibling");
    git(root, ["init", "--bare", "-b", "main", originDir]);
    git(root, ["clone", originDir, workDir]);
    for (const d of [workDir]) { git(d, ["config", "user.email", "t@t.t"]); git(d, ["config", "user.name", "t"]); }
    writeFileSync(join(workDir, "shared.txt"), "line-a\n");
    git(workDir, ["add", "-A"]);
    git(workDir, ["commit", "-m", "init"]);
    git(workDir, ["push", "origin", "main"]);
    // feature branch commits its own change (conflicting or not with the sibling's)
    git(workDir, ["checkout", "-b", "feature"]);
    if (conflicting) writeFileSync(join(workDir, "shared.txt"), "feature-version\n");
    else writeFileSync(join(workDir, "feature.txt"), "feature\n");
    git(workDir, ["add", "-A"]);
    git(workDir, ["commit", "-m", "feature work"]);
    // a SIBLING merges to main while the feature run is in flight
    git(root, ["clone", originDir, sibDir]);
    git(sibDir, ["config", "user.email", "s@s.s"]);
    git(sibDir, ["config", "user.name", "s"]);
    if (conflicting) writeFileSync(join(sibDir, "shared.txt"), "sibling-version\n");
    else writeFileSync(join(sibDir, "sibling.txt"), "sibling\n");
    git(sibDir, ["add", "-A"]);
    git(sibDir, ["commit", "-m", "sibling landed on main"]);
    git(sibDir, ["push", "origin", "main"]);
    const ws: Workspace = { repo: "acme/kiwi", dir: workDir, branch: "feature", baseRef: "refs/remotes/origin/main" };
    return { ws, root };
  }

  test("headSha returns the worktree's exact HEAD; null shape never a garbage string", () => {
    const { ws, root } = makeRace(false);
    try {
      const sha = headSha(ws);
      expect(sha).toBe(git(ws.dir, ["rev-parse", "HEAD"]).stdout.trim());
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("behind-main is INVISIBLE without fetchBase and visible after it — why the pre-flight must refresh origin", () => {
    const { ws, root } = makeRace(false);
    try {
      // stale remote-tracking ref: the sibling's merge hasn't been fetched yet,
      // so the branch LOOKS current — merging on this answer is the exact bug.
      expect(commitsBehindBase(ws)).toBe(0);
      expect(fetchBase(ws).ok).toBe(true);
      expect(commitsBehindBase(ws)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mergeBaseIntoBranch (clean): updates the branch, behind drops to 0, HEAD advances to a new pinnable SHA", () => {
    const { ws, root } = makeRace(false);
    try {
      fetchBase(ws);
      const before = headSha(ws);
      const upd = mergeBaseIntoBranch(ws);
      expect(upd.ok).toBe(true);
      expect(commitsBehindBase(ws)).toBe(0);
      const after = headSha(ws);
      expect(after).toMatch(/^[0-9a-f]{40}$/);
      expect(after).not.toBe(before); // the merge commit is what gets re-gated and pinned
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mergeBaseIntoBranch (conflict): ok:false and the worktree is left CLEAN (merge aborted, HEAD unmoved)", () => {
    const { ws, root } = makeRace(true);
    try {
      fetchBase(ws);
      const before = headSha(ws);
      const upd = mergeBaseIntoBranch(ws);
      expect(upd.ok).toBe(false);
      expect(headSha(ws)).toBe(before);
      expect(git(ws.dir, ["status", "--porcelain"]).stdout.trim()).toBe(""); // no half-merge poisoning later git calls
      expect(existsSync(join(ws.dir, ".git", "MERGE_HEAD"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
