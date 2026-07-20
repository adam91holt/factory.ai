import { isMockMode } from "./fixtures";

// Catalog manager client — mirrors the GET /catalog payload and POST
// /catalog/save contract from src/catalog-manager.ts. In ?mock=1 mode both are
// served from in-memory fixtures so the page renders (and "saves") with no
// daemon, exactly like every other view.

export type CatalogKind = "agent" | "skill" | "groundskeeper";

export interface UsageStat {
  runs: number;
  costUsd: number;
  avgTurns: number;
}

export interface AgentEntry {
  name: string;
  frontmatter: Record<string, string>;
  prompt: string;
  content: string;
  usage: UsageStat | null;
}
export interface SkillEntry {
  name: string;
  frontmatter: Record<string, string>;
  body: string;
  usage: null;
}
export interface GroundskeeperEntry {
  name: string;
  frontmatter: Record<string, string | number | boolean | string[]>;
  charter: string;
  content: string;
  usage: UsageStat | null;
  invalid?: string;
}
export interface CatalogPayload {
  agents: AgentEntry[];
  skills: SkillEntry[];
  groundskeepers: GroundskeeperEntry[];
}

export type SaveResponse =
  | { ok: true; commit: string | null; warning?: string }
  | { error: string };

export interface SaveInput {
  kind: CatalogKind;
  name: string;
  content: string;
}

export async function fetchCatalog(): Promise<CatalogPayload> {
  if (isMockMode()) return mockCatalog();
  const res = await fetch("/catalog", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /catalog → ${res.status}`);
  return (await res.json()) as CatalogPayload;
}

export async function saveCatalog(input: SaveInput): Promise<SaveResponse> {
  if (isMockMode()) {
    // No backend in mock mode — fake a fresh commit hash so the flow is exercised.
    await new Promise((r) => setTimeout(r, 250));
    return { ok: true, commit: Math.random().toString(16).slice(2, 9) };
  }
  const res = await fetch("/catalog/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await res.json()) as SaveResponse;
}

// ---------------------------------------------------------------------------
// Hand-rolled line diff (no libraries). LCS backtrace → same/add/del lines.
// Guarded on total line count: the editor caps content at 64KB, but a
// pathological all-distinct file would still be O(m·n) — beyond the guard we
// return null and the caller shows a plain notice instead.
// ---------------------------------------------------------------------------

export type DiffLine = { type: "same" | "add" | "del"; text: string };

export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length;
  const n = b.length;
  if (m + n > 6000) return null;

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: "del", text: a[i++] });
  while (j < n) out.push({ type: "add", text: b[j++] });
  return out;
}

export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// Mock fixtures (?mock=1). A believable slice of the real catalog.
// ---------------------------------------------------------------------------

function mockCatalog(): CatalogPayload {
  const scout = [
    "---",
    "name: scout",
    "model: scout",
    "tools: [Read, Glob, Grep, WebSearch, WebFetch]",
    "effort: high",
    "when: PLAN stage step 1 — read-only research over a Factory-Epic's repo and the web; no Bash, no writes.",
    "---",
    "You are the research scout in a software factory's planning stage. Investigate everything needed to break the epic below into parallel implementation tickets.",
    "",
    "{{spec}}",
  ].join("\n");
  const implementer = [
    "---",
    "name: implementer",
    "model: implementer",
    "tools: [Read, Glob, Grep, Edit, Write, Bash]",
    "effort: high",
    "when: EXECUTE stage — writes the change in a fresh worktree, runs the repo's own gates.",
    "---",
    "You are the implementer. Deliver the ticket below as a real, verified change. Read before you write; run the repo's checks; leave the tree green.",
    "",
    "{{spec}}",
  ].join("\n");
  const gameFeel = [
    "---",
    "name: game-feel",
    "description: Juice rubric and react-three-fiber patterns for building interactive, game-like UIs that feel alive. Use when a ticket asks for a game, a 3D scene, or anything where feel matters.",
    "---",
    "# Game feel",
    "",
    "You are building something a person will *play with*, not fill in. The bar is feel, not just function.",
    "",
    "## The one law",
    "If it could be a form, it fails.",
  ].join("\n");
  const kiwi = [
    "---",
    "name: kiwi-quest",
    "enabled: false",
    'schedule: "0 7 * * *"',
    "team: FAC",
    "repos: [adam91holt/kiwi-quest]",
    "model: claude-fable-5",
    "agents: [scout, design-reviewer]",
    "tools: [Read, Glob, Grep, WebSearch]",
    "budget: { perRun: 3, weekly: 15 }",
    "maxTicketsPerRun: 2",
    "---",
    "You are the groundskeeper for **Kiwi Quest** — a playful learning game built on New Zealand open data.",
    "",
    "## What \"worth doing\" means here",
    "- One new mode per week, maximum, from an unused NZ open-data skill.",
    "- Juice / game-feel passes are first-class work.",
    "",
    "If nothing clears the bar today, write decision.md and say so plainly.",
  ].join("\n");

  return {
    agents: [
      { name: "scout", frontmatter: { name: "scout", model: "scout", tools: "[Read, Glob, Grep, WebSearch, WebFetch]", effort: "high", when: "PLAN stage step 1 — read-only research over a Factory-Epic's repo and the web; no Bash, no writes." }, prompt: "You are the research scout…", content: scout, usage: { runs: 6, costUsd: 4.12, avgTurns: 3.2 } },
      { name: "implementer", frontmatter: { name: "implementer", model: "implementer", tools: "[Read, Glob, Grep, Edit, Write, Bash]", effort: "high", when: "EXECUTE stage — writes the change in a fresh worktree, runs the repo's own gates." }, prompt: "You are the implementer…", content: implementer, usage: { runs: 11, costUsd: 31.4, avgTurns: 24.4 } },
      { name: "design-reviewer", frontmatter: { name: "design-reviewer", model: "reviewer", tools: "[Read, Glob, Grep]", effort: "high", when: "EXECUTE — the taste gate on UI diffs." }, prompt: "You are the design reviewer…", content: "---\nname: design-reviewer\nmodel: reviewer\ntools: [Read, Glob, Grep]\neffort: high\nwhen: EXECUTE — the taste gate on UI diffs.\n---\nYou are the design reviewer — the taste gate.", usage: { runs: 3, costUsd: 0.9, avgTurns: 1 } },
    ],
    skills: [
      { name: "game-feel", frontmatter: { name: "game-feel", description: "Juice rubric and react-three-fiber patterns for building interactive, game-like UIs that feel alive." }, body: gameFeel, usage: null },
      { name: "factory-design", frontmatter: { name: "factory-design", description: "The house visual language: instrument-panel density, restraint, one accent." }, body: "---\nname: factory-design\ndescription: The house visual language.\n---\n# Factory design\n\nDensity with restraint. One accent. Numbers are tabular.", usage: null },
    ],
    groundskeepers: [
      { name: "kiwi-quest", frontmatter: { enabled: false, schedule: "0 7 * * *", team: "FAC", model: "claude-fable-5", repos: ["adam91holt/kiwi-quest"], agents: ["scout", "design-reviewer"], tools: ["Read", "Glob", "Grep", "WebSearch"], budget: "perRun $3 · weekly $15", maxTicketsPerRun: 2 }, charter: "You are the groundskeeper for Kiwi Quest…", content: kiwi, usage: null },
      { name: "factory", frontmatter: { enabled: false, schedule: "0 8 * * 1", team: "FAC", model: "claude-fable-5", repos: ["adam91holt/factory.ai"], agents: ["scout"], tools: ["Read", "Glob", "Grep", "WebSearch"], budget: "perRun $3 · weekly $10", maxTicketsPerRun: 2 }, charter: "You are the groundskeeper for the factory itself.", content: "---\nname: factory\nenabled: false\nschedule: \"0 8 * * 1\"\nteam: FAC\nrepos: [adam91holt/factory.ai]\nmodel: claude-fable-5\nagents: [scout]\ntools: [Read, Glob, Grep, WebSearch]\nbudget: { perRun: 3, weekly: 10 }\nmaxTicketsPerRun: 2\n---\nYou are the groundskeeper for the factory itself — the self-improvement loop.", usage: { runs: 2, costUsd: 3.4, avgTurns: 5.5 } },
    ],
  };
}
