import { describe, expect, test } from "bun:test";
import { validateGroundskeeperContent } from "../src/groundskeepers.ts";

const card = (frontmatter: string, charter = "Keep the garden tidy."): string =>
  `---\n${frontmatter}\n---\n${charter}\n`;

const VALID_FM = [
  "name: tidy",
  "enabled: false",
  "schedule: 0 9 * * 1",
  "team: FAC",
  "repos: [acme/widgets]",
  "budget: { perRun: 3, weekly: 15 }",
  "maxTicketsPerRun: 2",
].join("\n");

describe("validateGroundskeeperContent", () => {
  test("accepts a fully-specified card and parses its fields", () => {
    const v = validateGroundskeeperContent(card(VALID_FM), "tidy");
    if (!v.ok) throw new Error(v.error);
    expect(v.card.name).toBe("tidy");
    expect(v.card.enabled).toBe(false);
    expect(v.card.schedule).toBe("0 9 * * 1");
    expect(v.card.team).toBe("FAC");
    expect(v.card.repos).toEqual(["acme/widgets"]);
    expect(v.card.budget).toEqual({ perRun: 3, weekly: 15 });
    expect(v.card.maxTicketsPerRun).toBe(2);
    expect(v.card.charter).toBe("Keep the garden tidy.");
  });

  test("rejects content without a frontmatter block", () => {
    const v = validateGroundskeeperContent("just prose, no fences", "tidy");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/no YAML frontmatter/);
  });

  test("rejects missing schedule / team", () => {
    const noSchedule = validateGroundskeeperContent(card("name: tidy\nteam: FAC"), "tidy");
    expect(noSchedule.ok).toBe(false);
    if (!noSchedule.ok) expect(noSchedule.error).toMatch(/missing schedule/);
    const noTeam = validateGroundskeeperContent(card("name: tidy\nschedule: 0 9 * * 1"), "tidy");
    expect(noTeam.ok).toBe(false);
    if (!noTeam.ok) expect(noTeam.error).toMatch(/missing team/);
  });

  test("rejects a name/file mismatch", () => {
    const v = validateGroundskeeperContent(card(VALID_FM), "other");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/must equal the file name/);
  });

  test("rejects traversal-shaped names via the charset lock", () => {
    // parseCard falls back to the expectedName when frontmatter name is empty,
    // so drive the bad name through the frontmatter itself.
    const fm = VALID_FM.replace("name: tidy", "name: ../../etc");
    const v = validateGroundskeeperContent(card(fm), "../../etc");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/invalid name/);
  });

  test("rejects an unschedulable cron loudly", () => {
    const fm = VALID_FM.replace("schedule: 0 9 * * 1", "schedule: 0 9 * * MON");
    const v = validateGroundskeeperContent(card(fm), "tidy");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/bad schedule/);
  });

  describe("enabled fail-closed: ONLY a bare true arms", () => {
    const withEnabled = (value: string): string =>
      card(VALID_FM.replace("enabled: false", `enabled: ${value}`));

    test("bare true arms", () => {
      const v = validateGroundskeeperContent(withEnabled("true"), "tidy");
      if (!v.ok) throw new Error(v.error);
      expect(v.card.enabled).toBe(true);
    });

    for (const value of ["yes", "1", "on", '"true"', "'true'", "TRUE ok", "enabled"]) {
      test(`${JSON.stringify(value)} stays disabled`, () => {
        const v = validateGroundskeeperContent(withEnabled(value), "tidy");
        if (!v.ok) throw new Error(v.error);
        expect(v.card.enabled).toBe(false);
      });
    }

    test("case-insensitive true/false spellings parse but arm too", () => {
      // "True"/"FALSE" pass the recognized-value check (case-insensitive) and
      // arm/disarm accordingly — documented tolerance, not a fail-open.
      const t = validateGroundskeeperContent(withEnabled("True"), "tidy");
      if (!t.ok) throw new Error(t.error);
      expect(t.card.enabled).toBe(true);
    });

    test("absent enabled defaults to disabled", () => {
      const fm = VALID_FM.split("\n").filter((l) => !l.startsWith("enabled:")).join("\n");
      const v = validateGroundskeeperContent(card(fm), "tidy");
      if (!v.ok) throw new Error(v.error);
      expect(v.card.enabled).toBe(false);
    });
  });

  test("budget falls back to perRun 3 / weekly 15 when malformed", () => {
    const fm = VALID_FM.replace("budget: { perRun: 3, weekly: 15 }", "budget: { perRun: lots }");
    const v = validateGroundskeeperContent(card(fm), "tidy");
    if (!v.ok) throw new Error(v.error);
    expect(v.card.budget).toEqual({ perRun: 3, weekly: 15 });
  });

  test("maxTicketsPerRun: non-integers and non-positives fall back to 1", () => {
    for (const raw of ["0", "-2", "2.5", "banana", ""]) {
      const fm = VALID_FM.replace("maxTicketsPerRun: 2", `maxTicketsPerRun: ${raw}`);
      const v = validateGroundskeeperContent(card(fm), "tidy");
      if (!v.ok) throw new Error(v.error);
      expect(v.card.maxTicketsPerRun).toBe(1);
    }
  });
});
