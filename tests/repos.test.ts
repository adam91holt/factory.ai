import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPaths, ghRepoCreateArgs, repoFromTicket, revertMerge } from "../src/repos.ts";

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
