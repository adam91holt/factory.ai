import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPaths, classifyStatusPaths, ghRepoCreateArgs, guardedPathsTouched, isAdditiveTestExtension, parseNameStatus, redactRevertWhy, repoFromTicket, revertMerge, type Workspace } from "../src/repos.ts";

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
