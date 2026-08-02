import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  openTestDatabase, closeTestDatabase,
  ensureProjectRow, replaceProjectRepos, getProjectRowByName, listProjectRepos,
  projectOwningRepo, updateProjectDescriptive,
  insertPendingPolicy, approveProjectPolicy, activeMergePolicyForRepo,
} from "../src/db.ts";
import { createProject } from "../src/project-config.ts";

// The PG-driven work gate (loop.ts/plan.ts): a repo is only workable when an
// ACTIVE projects row owns it in project_repos. Pinned invariants:
//   1. Fail closed — zero rows / unknown repo → "unregistered" (never worked).
//   2. Outage ≠ non-membership — a closed store → "unavailable", a DISTINCT
//      state, so the gate defers instead of needs-humaning the queue.
//   3. A non-active project (paused/archived) does not confer membership.
//   4. /projects/create is the audited write path: charset-locked repo slugs,
//      duplicate names refused, no deploy/smoke surface in the body.

beforeEach(async () => {
  await openTestDatabase();
});
afterEach(async () => {
  await closeTestDatabase();
});

describe("projectOwningRepo (the gate reader)", () => {
  test("unknown repo fails closed as unregistered — including the zero-rows case", async () => {
    expect(await projectOwningRepo("acme/never-registered")).toEqual({ status: "unregistered" });
  });

  test("a registered repo resolves to its owning project", async () => {
    const id = await ensureProjectRow("orbital", "FAC", "test");
    expect(id).not.toBeNull();
    await replaceProjectRepos(id!, ["adam91holt/eval-orbital-01"], "test");
    expect(await projectOwningRepo("adam91holt/eval-orbital-01")).toEqual({ status: "registered", project: "orbital" });
  });

  test("a paused/archived project does not confer membership", async () => {
    const id = await ensureProjectRow("mothballed", "FAC", "test");
    await replaceProjectRepos(id!, ["acme/old"], "test");
    await updateProjectDescriptive(id!, "status", "archived", "test");
    expect(await projectOwningRepo("acme/old")).toEqual({ status: "unregistered" });
  });

  test("closed store is unavailable — NOT unregistered (outage must not relabel the queue)", async () => {
    await closeTestDatabase();
    expect(await projectOwningRepo("acme/anything")).toEqual({ status: "unavailable" });
    await openTestDatabase(); // leave the seam usable for afterEach
  });
});

describe("activeMergePolicyForRepo (the per-project auto-merge grant)", () => {
  test("no policy / pending-only policy → null (a proposal confers nothing until approved)", async () => {
    const id = await ensureProjectRow("orbital", "FAC", "test");
    await replaceProjectRepos(id!, ["adam91holt/eval-orbital-01"], "test");
    expect(await activeMergePolicyForRepo("adam91holt/eval-orbital-01")).toBeNull();
    await insertPendingPolicy(id!, "merge", JSON.stringify("auto"), "test");
    expect(await activeMergePolicyForRepo("adam91holt/eval-orbital-01")).toBeNull();
  });

  test("approved merge:auto policy resolves for the project's repos", async () => {
    const id = await ensureProjectRow("orbital", "FAC", "test");
    await replaceProjectRepos(id!, ["adam91holt/eval-orbital-01"], "test");
    const policyId = await insertPendingPolicy(id!, "merge", JSON.stringify("auto"), "test");
    expect(await approveProjectPolicy(policyId!, "test")).not.toBeNull();
    expect(await activeMergePolicyForRepo("adam91holt/eval-orbital-01")).toBe("auto");
    // scoped: a repo outside the project sees nothing
    expect(await activeMergePolicyForRepo("acme/other")).toBeNull();
  });

  test("an archived project's policy stops governing (active-project join)", async () => {
    const id = await ensureProjectRow("orbital", "FAC", "test");
    await replaceProjectRepos(id!, ["adam91holt/eval-orbital-01"], "test");
    const policyId = await insertPendingPolicy(id!, "merge", JSON.stringify("auto"), "test");
    await approveProjectPolicy(policyId!, "test");
    await updateProjectDescriptive(id!, "status", "archived", "test");
    expect(await activeMergePolicyForRepo("adam91holt/eval-orbital-01")).toBeNull();
  });

  test("closed store → null (fail-safe: less authority, never more)", async () => {
    await closeTestDatabase();
    expect(await activeMergePolicyForRepo("adam91holt/eval-orbital-01")).toBeNull();
    await openTestDatabase();
  });
});

describe("POST /projects/create (the audited registration path)", () => {
  test("registers a project whose repos immediately pass the gate", async () => {
    const res = await createProject({ name: "todo", team: "FAC", repos: ["adam91holt/factory-todo"] });
    expect(res.status).toBe(200);
    const row = await getProjectRowByName("todo");
    expect(row).not.toBeNull();
    expect(await listProjectRepos(row!.id)).toEqual(["adam91holt/factory-todo"]);
    expect(await projectOwningRepo("adam91holt/factory-todo")).toEqual({ status: "registered", project: "todo" });
  });

  test("refuses malformed names, teams, and repo slugs", async () => {
    expect((await createProject({ name: "../evil", team: "FAC", repos: ["a/b"] })).status).toBe(400);
    expect((await createProject({ name: "ok", team: "", repos: ["a/b"] })).status).toBe(400);
    expect((await createProject({ name: "ok", team: "FAC", repos: [] })).status).toBe(400);
    expect((await createProject({ name: "ok", team: "FAC", repos: ["not-a-slug"] })).status).toBe(400);
    expect((await createProject({ name: "ok", team: "FAC", repos: ["a/b; rm -rf /"] })).status).toBe(400);
  });

  test("duplicate names 409 instead of clobbering", async () => {
    expect((await createProject({ name: "dup", team: "FAC", repos: ["a/b"] })).status).toBe(200);
    const second = await createProject({ name: "dup", team: "FAC", repos: ["c/d"] });
    expect(second.status).toBe(409);
    // the original registration is untouched
    expect(await projectOwningRepo("a/b")).toEqual({ status: "registered", project: "dup" });
    expect(await projectOwningRepo("c/d")).toEqual({ status: "unregistered" });
  });
});
