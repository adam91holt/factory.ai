// Skill carrying + version pinning (issue #16 WP2). What this file pins:
//
//   1. selectSkills — the PURE carried-set decision (table-driven): roles /
//      projects / match semantics, unknown-term REJECTION (fail-closed,
//      mirroring selectCard), malformed-attach rejection, disabled exclusion,
//      deterministic ordering and the in-code carry cap.
//   2. Size caps — per-skill and total prompt budgets, with loud truncation
//      notes for the caller to log.
//   3. buildSkillBlock — delimiting and ordering, and the ADDITIVE guarantee:
//      an empty selection leaves the assembled stage prompt byte-identical to
//      the pre-feature prompt (skill block below the card prompt, above the
//      untrusted spec).
//   4. Version pins — forwardStage's run_stage_started carries card@version +
//      skills for pinned stages and stays pre-pin-shaped for unpinned ones;
//      the factory report's stage lines render the pins (and only the pins)
//      differently; the "which runs used prompt version N" telemetry join
//      works over the real events table.
//   5. End to end over the register snapshot: an active skill_register row is
//      carried with its version pin, a NEW version is carried on the next
//      decision (no restart), disabling excludes it, rollback re-carries the
//      old version.

import { describe, expect, test } from "bun:test";
import {
  selectSkills, buildSkillBlock, skillPin,
  MAX_CARRIED_SKILLS, MAX_SKILL_CONTENT_CHARS, MAX_SKILLS_TOTAL_CHARS,
  SKILL_BLOCK_HEADER, SKILL_BLOCK_FOOTER,
  type CarriableSkill, type StagePin,
} from "../src/skills.ts";
import type { RepoFacts } from "../src/routing.ts";
import { cardPin, renderPrompt } from "../src/catalog.ts";
import { buildReport } from "../src/report.ts";
import { forwardStage } from "../src/loop.ts";
import { bus, type FactoryEvent } from "../src/events.ts";
import { pgliteStore } from "../src/store.ts";
import {
  closeTestDatabase, migrate, openTestDatabase,
  activeSkillRegisterSnapshot, insertAgentRegisterVersion, insertSkillRegisterVersion, setSkillRegisterEnabled,
} from "../src/db.ts";

const REPO = "acme/widgets";
const FACTS: RepoFacts = { ui: true, playwright: false, gates: ["typecheck", "test"] };

const skill = (over: Partial<CarriableSkill> = {}): CarriableSkill => ({
  name: "s1", version: 1, enabled: true,
  attach: { roles: ["implementer"] }, content: "SKILL CONTENT",
  ...over,
});

/** Snapshot rows → the structural shape selectSkills consumes. */
const snapshotSkills = (): CarriableSkill[] =>
  [...activeSkillRegisterSnapshot().values()].map((r) => ({
    name: r.name, version: r.version, enabled: r.enabled, attach: r.attach, content: r.content,
  }));

// ---------------------------------------------------------------------------
// 1. Attach matching — table-driven.
// ---------------------------------------------------------------------------

describe("selectSkills — attach matching", () => {
  const cases: Array<{
    label: string; attach: Record<string, unknown>; enabled?: boolean;
    carried: boolean; rejectReason?: RegExp;
  }> = [
    { label: "role listed → carried", attach: { roles: ["implementer", "fixer"] }, carried: true },
    { label: "role not listed → silently not carried (no rejection noise)", attach: { roles: ["fixer"] }, carried: false },
    { label: "no attach.roles key → REJECTED (an empty selector never means everywhere)", attach: {}, carried: false, rejectReason: /no attach\.roles/ },
    { label: "empty roles array → REJECTED", attach: { roles: [] }, carried: false, rejectReason: /no attach\.roles/ },
    { label: "malformed roles (string, not array) → REJECTED", attach: { roles: "implementer" }, carried: false, rejectReason: /malformed attach\.roles/ },
    { label: "malformed roles (non-string entry) → REJECTED", attach: { roles: ["implementer", 7] }, carried: false, rejectReason: /malformed attach\.roles/ },
    { label: "project pinned to the full org/name → carried", attach: { roles: ["implementer"], projects: [REPO] }, carried: true },
    { label: "project pinned to the bare repo name → carried", attach: { roles: ["implementer"], projects: ["widgets"] }, carried: true },
    { label: "project mismatch → silently not carried", attach: { roles: ["implementer"], projects: ["acme/other"] }, carried: false },
    { label: "empty projects → any project", attach: { roles: ["implementer"], projects: [] }, carried: true },
    { label: "malformed projects → REJECTED", attach: { roles: ["implementer"], projects: "acme/widgets" }, carried: false, rejectReason: /malformed attach\.projects/ },
    { label: "all match terms hold → carried", attach: { roles: ["implementer"], match: ["ui", "gate:test", "no-playwright"] }, carried: true },
    { label: "a match term fails → silently not carried", attach: { roles: ["implementer"], match: ["playwright"] }, carried: false },
    { label: "UNKNOWN match term → REJECTED (fail-closed, like selectCard)", attach: { roles: ["implementer"], match: ["has-lasers"] }, carried: false, rejectReason: /unknown match term/ },
    { label: "unknown gate name in a gate: term → REJECTED", attach: { roles: ["implementer"], match: ["gate:nonsense"] }, carried: false, rejectReason: /unknown match term/ },
    { label: "malformed match → REJECTED", attach: { roles: ["implementer"], match: "ui" }, carried: false, rejectReason: /malformed attach\.match/ },
    { label: "disabled skill → REJECTED, never carried", attach: { roles: ["implementer"] }, enabled: false, carried: false, rejectReason: /disabled/ },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const sel = selectSkills("implementer", REPO, FACTS, [skill({ attach: c.attach, ...(c.enabled === false ? { enabled: false } : {}) })]);
      expect(sel.carried.map((s) => s.name)).toEqual(c.carried ? ["s1"] : []);
      expect(sel.pins).toEqual(c.carried ? ["s1@1"] : []);
      if (c.rejectReason) {
        expect(sel.rejected).toHaveLength(1);
        expect(sel.rejected[0]?.skill).toBe("s1");
        expect(sel.rejected[0]?.reason).toMatch(c.rejectReason);
      } else {
        expect(sel.rejected).toEqual([]);
      }
    });
  }

  test("deterministic name order, and the carry cap rejects the overflow loudly", () => {
    const many = ["zeta", "alpha", "mid", "beta", "gamma", "delta"].map((name) =>
      skill({ name, content: `content of ${name}` }));
    const sel = selectSkills("implementer", REPO, FACTS, many);
    // name-sorted, first MAX_CARRIED_SKILLS survive — never insert order.
    expect(sel.carried.map((s) => s.name)).toEqual(["alpha", "beta", "delta", "gamma"].slice(0, MAX_CARRIED_SKILLS));
    expect(sel.carried).toHaveLength(MAX_CARRIED_SKILLS);
    const overflow = sel.rejected.filter((r) => /carry cap/.test(r.reason)).map((r) => r.skill);
    expect(overflow).toEqual(["mid", "zeta"]);
    expect(sel.truncated.some((n) => /carry cap/.test(n))).toBe(true);
  });

  test("selection is pure: same inputs, same output; inputs not mutated", () => {
    const input = [skill({ name: "b" }), skill({ name: "a" })];
    const a = selectSkills("implementer", REPO, FACTS, input);
    const b = selectSkills("implementer", REPO, FACTS, input);
    expect(a).toEqual(b);
    expect(input.map((s) => s.name)).toEqual(["b", "a"]); // sort did not mutate
  });
});

// ---------------------------------------------------------------------------
// 2. Size caps.
// ---------------------------------------------------------------------------

describe("selectSkills — in-code size caps", () => {
  test("per-skill content is truncated at MAX_SKILL_CONTENT_CHARS with a loud note", () => {
    const big = skill({ name: "big", content: "x".repeat(MAX_SKILL_CONTENT_CHARS + 500) });
    const sel = selectSkills("implementer", REPO, FACTS, [big]);
    expect(sel.carried).toHaveLength(1);
    expect(sel.carried[0]?.content).toHaveLength(MAX_SKILL_CONTENT_CHARS);
    expect(sel.carried[0]?.truncated).toBe(true);
    expect(sel.truncated.some((n) => n.includes("big@1") && /TRUNCATED/.test(n))).toBe(true);
  });

  test("total budget: later skills are cut to fit MAX_SKILLS_TOTAL_CHARS, then dropped", () => {
    // Three 15k skills against the 32k total: a full, b full, c cut to 2k.
    const mk = (name: string): CarriableSkill => skill({ name, content: "y".repeat(15_000) });
    const sel = selectSkills("implementer", REPO, FACTS, [mk("a"), mk("b"), mk("c")]);
    expect(sel.carried.map((s) => [s.name, s.content.length, s.truncated])).toEqual([
      ["a", 15_000, false], ["b", 15_000, false], ["c", MAX_SKILLS_TOTAL_CHARS - 30_000, true],
    ]);
    expect(sel.truncated.some((n) => n.includes("c@1") && n.includes(`${MAX_SKILLS_TOTAL_CHARS}`))).toBe(true);

    // Two max-size skills exhaust the budget exactly; the third is DROPPED.
    const full = (name: string): CarriableSkill => skill({ name, content: "z".repeat(MAX_SKILL_CONTENT_CHARS) });
    const sel2 = selectSkills("implementer", REPO, FACTS, [full("a"), full("b"), full("c")]);
    expect(sel2.carried.map((s) => s.name)).toEqual(["a", "b"]);
    expect(sel2.pins).toEqual(["a@1", "b@1"]);
    expect(sel2.rejected.some((r) => r.skill === "c" && /budget/.test(r.reason))).toBe(true);
    expect(sel2.truncated.some((n) => n.includes("c@1") && /DROPPED/.test(n))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Prompt assembly — delimiting, ordering, additive byte-identity.
// ---------------------------------------------------------------------------

describe("buildSkillBlock + stage prompt assembly", () => {
  test("no carried skills → empty block → the prompt is BYTE-IDENTICAL to today", () => {
    expect(buildSkillBlock([])).toBe("");
    const spec = "# Ticket\n\nUNTRUSTED SPEC SENTINEL";
    expect(renderPrompt("implementer", { repo: REPO, spec: buildSkillBlock([]) + spec }, "fb"))
      .toBe(renderPrompt("implementer", { repo: REPO, spec }, "fb"));
  });

  test("block is clearly delimited: header, per-skill fences with name@version, footer", () => {
    const block = buildSkillBlock([
      { name: "aaa", version: 2, content: "AAA GUIDANCE", truncated: false },
      { name: "bbb", version: 7, content: "BBB GUIDANCE", truncated: true },
    ]);
    const iHeader = block.indexOf(SKILL_BLOCK_HEADER);
    const iA = block.indexOf("--- skill aaa@2 ---");
    const iAContent = block.indexOf("AAA GUIDANCE");
    const iAEnd = block.indexOf("--- end skill aaa@2 ---");
    const iB = block.indexOf("--- skill bbb@7 (TRUNCATED at an in-code cap) ---");
    const iFooter = block.indexOf(SKILL_BLOCK_FOOTER);
    expect(iHeader).toBe(0);
    for (const [lo, hi] of [[iHeader, iA], [iA, iAContent], [iAContent, iAEnd], [iAEnd, iB], [iB, iFooter]] as const) {
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeGreaterThan(lo);
    }
    expect(block.endsWith(`${SKILL_BLOCK_FOOTER}\n\n`)).toBe(true); // crisp boundary to the spec
  });

  test("assembled prompt order: card prompt ABOVE the trusted skill block ABOVE the untrusted spec", () => {
    const spec = "UNTRUSTED SPEC SENTINEL";
    const block = buildSkillBlock([{ name: "guide", version: 3, content: "SKILL GUIDANCE SENTINEL", truncated: false }]);
    const assembled = renderPrompt("implementer", { repo: REPO, spec: block + spec }, "fb");
    const iCard = assembled.indexOf("You are the implementer");
    const iBlock = assembled.indexOf(SKILL_BLOCK_HEADER);
    const iGuidance = assembled.indexOf("SKILL GUIDANCE SENTINEL");
    const iSpec = assembled.indexOf(spec);
    expect(iCard).toBe(0);
    expect(iBlock).toBeGreaterThan(iCard);
    expect(iGuidance).toBeGreaterThan(iBlock);
    expect(iSpec).toBeGreaterThan(iGuidance);
  });
});

// ---------------------------------------------------------------------------
// 4. Version pins — events, report, telemetry join.
// ---------------------------------------------------------------------------

type StageStartedEvent = Extract<FactoryEvent, { type: "run_stage_started" }>;

describe("version pins", () => {
  test("forwardStage: a pinned stage's run_stage_started carries card + skills; an unpinned stage emits the pre-pin shape", () => {
    const pins = new Map<string, StagePin>([
      ["implementer", { card: "implementer@2", skills: ["factory-design@1", "game-feel@3"] }],
      ["tester", { card: "tester@0", skills: [] }],
    ]);
    const fwd = forwardStage("FAC-PIN", pins);
    const seen: StageStartedEvent[] = [];
    const unsub = bus.subscribe((e) => {
      if (e.type === "run_stage_started" && e.issueKey === "FAC-PIN") seen.push(e);
    });
    try {
      fwd({ kind: "stage_started", stage: "implementer", model: "m1", viaProxy: false });
      fwd({ kind: "stage_started", stage: "tester", model: "m2", viaProxy: false });
      fwd({ kind: "stage_started", stage: "verify-repair-1", model: "m1", viaProxy: false });
    } finally { unsub(); }
    expect(seen).toHaveLength(3);
    expect(seen[0]?.card).toBe("implementer@2");
    expect(seen[0]?.skills).toEqual(["factory-design@1", "game-feel@3"]);
    expect(seen[1]?.card).toBe("tester@0");
    expect(seen[1]?.skills).toEqual([]);
    // Unpinned stage: the fields are ABSENT, not null — byte-identical event
    // body to before pinning existed.
    expect("card" in (seen[2] ?? {})).toBe(false);
    expect("skills" in (seen[2] ?? {})).toBe(false);
  });

  test("cardPin: version 0 = file-fallback; an active register version pins to it", async () => {
    await openTestDatabase();
    try {
      expect(cardPin("implementer")).toBe("implementer@0"); // empty register → file
      const ins = await insertAgentRegisterVersion({
        name: "pin-probe", frontmatter: { name: "pin-probe" }, prompt: "p", contentHash: "h", createdBy: "test" });
      expect(ins?.version).toBe(1);
      expect(cardPin("pin-probe")).toBe("pin-probe@1");
      expect(cardPin("no-such-card")).toBe("no-such-card@0");
    } finally { await closeTestDatabase(); }
    expect(cardPin("pin-probe")).toBe("pin-probe@0"); // closed store → file-fallback again
  });

  test("factory report stage lines carry the pins — and ONLY the pins differ from a pin-less report", () => {
    const stage = { label: "implementer", text: "", costUsd: 0.1234, turns: 3, wallSeconds: 5 };
    const base = { issueKey: "FAC-9", prUrl: null, outcome: "parked" as const, reason: "r",
      gates: [], gateStrength: "none" as const, guardedPaths: [] };
    const without = buildReport({ ...base, stages: [{ ...stage }] });
    const withPins = buildReport({ ...base, stages: [{ ...stage, card: "implementer@4", skills: ["factory-design@2", "game-feel@1"] }] });
    expect(withPins).toContain("      card: implementer@4");
    expect(withPins).toContain(`      skills: ${JSON.stringify("factory-design@2 game-feel@1")}`);
    expect(without).not.toContain("      card:");
    expect(without).not.toContain("      skills:");
    // Strip exactly the two pin lines → byte-identical to the pin-less report
    // (the additive guarantee, at the report surface).
    const stripped = withPins.split("\n")
      .filter((l) => !l.startsWith("      card:") && !l.startsWith("      skills:"))
      .join("\n");
    expect(stripped).toBe(without);
    // A pinned stage with NO carried skills renders the card line only.
    const noSkills = buildReport({ ...base, stages: [{ ...stage, card: "implementer@4", skills: [] }] });
    expect(noSkills).toContain("      card: implementer@4");
    expect(noSkills).not.toContain("      skills:");
  });

  test('telemetry join: "which runs used prompt version N" over the real events table', async () => {
    const s = await pgliteStore();
    try {
      await migrate(s);
      let seq = 0;
      const insert = async (issueKey: string, card: string, skills: string[]): Promise<void> => {
        seq += 1;
        await s.exec("INSERT INTO events (seq, at, type, issue_key, json) VALUES ($1, $2, 'run_stage_started', $3, $4)",
          [seq, 1000 + seq, issueKey, JSON.stringify({ type: "run_stage_started", issueKey, stage: "implementer", model: "m", viaProxy: false, card, skills })]);
      };
      await insert("FAC-1", "implementer@3", ["factory-design@1"]);
      await insert("FAC-2", "implementer@4", []);
      await insert("FAC-3", "implementer@3", []);
      // pre-pin event (no card field at all) must simply not match — additive.
      seq += 1;
      await s.exec("INSERT INTO events (seq, at, type, issue_key, json) VALUES ($1, $2, 'run_stage_started', 'FAC-0', $3)",
        [seq, 1000 + seq, JSON.stringify({ type: "run_stage_started", issueKey: "FAC-0", stage: "implementer", model: "m", viaProxy: false })]);

      const v3 = await s.query<{ issue_key: string }>(
        "SELECT issue_key FROM events WHERE type = 'run_stage_started' AND (json::jsonb)->>'card' = $1 ORDER BY issue_key",
        ["implementer@3"]);
      expect(v3.map((r) => r.issue_key)).toEqual(["FAC-1", "FAC-3"]);

      const carriedDesign = await s.query<{ issue_key: string }>(
        `SELECT issue_key FROM events WHERE type = 'run_stage_started' AND (json::jsonb)->'skills' @> '"factory-design@1"'::jsonb ORDER BY issue_key`,
        []);
      expect(carriedDesign.map((r) => r.issue_key)).toEqual(["FAC-1"]);
    } finally { await s.close(); }
  });
});

// ---------------------------------------------------------------------------
// 5. End to end over the register snapshot.
// ---------------------------------------------------------------------------

describe("skill register → carry decision (snapshot end to end)", () => {
  test("active row carried with its pin; new version next decision; disable excludes; rollback re-carries", async () => {
    await openTestDatabase();
    try {
      expect(selectSkills("implementer", REPO, FACTS, snapshotSkills()).carried).toEqual([]); // empty register carries nothing

      const v1 = await insertSkillRegisterVersion({
        name: "carry-me", description: "d", content: "GUIDE v1",
        attach: { roles: ["implementer"], projects: [REPO], match: ["ui"] },
        contentHash: "h1", createdBy: "test" });
      expect(v1?.version).toBe(1);
      let sel = selectSkills("implementer", REPO, FACTS, snapshotSkills());
      expect(sel.pins).toEqual(["carry-me@1"]);
      expect(sel.carried[0]?.content).toBe("GUIDE v1");
      expect(buildSkillBlock(sel.carried)).toContain("--- skill carry-me@1 ---");

      // Fixer stage: the attach names implementer only → not carried there.
      expect(selectSkills("fixer", REPO, FACTS, snapshotSkills()).carried).toEqual([]);
      // Another repo: project-pinned → not carried there.
      expect(selectSkills("implementer", "acme/other", FACTS, snapshotSkills()).carried).toEqual([]);

      // A NEW version is what the next decision carries — no restart, no cache.
      const v2 = await insertSkillRegisterVersion({
        name: "carry-me", description: "d", content: "GUIDE v2",
        attach: { roles: ["implementer"] }, contentHash: "h2", createdBy: "test" });
      expect(v2?.version).toBe(2);
      sel = selectSkills("implementer", REPO, FACTS, snapshotSkills());
      expect(sel.pins).toEqual(["carry-me@2"]);
      expect(sel.carried[0]?.content).toBe("GUIDE v2");

      // Disable the active version → the skill is NOT carried at all.
      expect(await setSkillRegisterEnabled("carry-me", 2, false)).toBe(true);
      expect(selectSkills("implementer", REPO, FACTS, snapshotSkills()).carried).toEqual([]);

      // Rollback: re-enable v1 → the next decision carries the OLD version.
      expect(await setSkillRegisterEnabled("carry-me", 1, true)).toBe(true);
      sel = selectSkills("implementer", REPO, FACTS, snapshotSkills());
      expect(sel.pins).toEqual(["carry-me@1"]);
      expect(sel.carried[0]?.content).toBe("GUIDE v1");
    } finally { await closeTestDatabase(); }
  });

  test("skillPin formats name@version", () => {
    expect(skillPin({ name: "factory-design", version: 12 })).toBe("factory-design@12");
  });
});
