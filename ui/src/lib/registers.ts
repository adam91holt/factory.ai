import { isMockMode } from "./fixtures";

// Register client (issue #16 WP3) — mirrors the GET /registers payload and the
// /registers/* POST contracts from src/register-manager.ts. In ?mock=1 mode
// everything is served from in-memory fixtures so the catalog page renders
// (and "saves") with no daemon, exactly like every other view.

export type RegisterKind = "agent" | "skill";

export interface RegisterVersionInfo {
  version: number;
  createdAt: number;
  createdBy: string;
  active: boolean;
}

export interface NormalizedAttach {
  roles: string[];
  projects: string[];
  match: string[];
}

export interface AgentRegisterEntry {
  name: string;
  activeVersion: number | null;
  versions: RegisterVersionInfo[];
  content: string | null;
  frontmatter: Record<string, string>;
}

export interface SkillRegisterEntry {
  name: string;
  activeVersion: number | null;
  versions: RegisterVersionInfo[];
  content: string | null;
  description: string;
  attach: NormalizedAttach;
  enabled: boolean;
}

export interface RegistersPayload {
  agents: AgentRegisterEntry[];
  skills: SkillRegisterEntry[];
  roles: string[];
  matchTerms: string[];
  repos: string[];
}

export interface AttachPreview {
  carries: Array<{ role: string; repos: string[] }>;
  repos: string[];
  conditions: string[];
  contradictory: boolean;
  rejected: Array<{ skill: string; reason: string }>;
}

export type RegisterSaveResponse =
  | { ok: true; name: string; version: number; unchanged: boolean }
  | { error: string };

export type RollbackResponse = { ok: true; name: string; version: number } | { error: string };
export type AttachResponse = { ok: true; name: string; version: number; attach: NormalizedAttach } | { error: string };
export type EnabledResponse = { ok: true; name: string; version: number | null; enabled: boolean } | { error: string };

// ---------------------------------------------------------------------------
// Pure helpers (tested in tests/registers-view.test.tsx).
// ---------------------------------------------------------------------------

/** Parse a "name@version" pin. version 0 = file fallback. Returns null for
 *  anything that is not a well-formed pin (defensive: pins come from events). */
export function parsePin(pin: string): { name: string; version: number } | null {
  const at = pin.lastIndexOf("@");
  if (at <= 0 || at === pin.length - 1) return null;
  const version = Number(pin.slice(at + 1));
  if (!Number.isInteger(version) || version < 0) return null;
  return { name: pin.slice(0, at), version };
}

/** Display form of a pin: file-fallback (v0) renders as "name (file)" so a 0
 *  never reads like a register version. */
export function pinLabel(pin: string): string {
  const parsed = parsePin(pin);
  if (!parsed) return pin;
  return parsed.version === 0 ? `${parsed.name}·file` : `${parsed.name}@v${parsed.version}`;
}

/** Toggle one entry in a string-array selector (attach editor state helper). */
export function toggleEntry(list: string[], entry: string): string[] {
  return list.includes(entry) ? list.filter((x) => x !== entry) : [...list, entry];
}

/** Split a free-entry projects string into cleaned entries (comma/whitespace
 *  separated, deduped, order-preserving). Validation is the SERVER's job —
 *  this only normalises what the input field holds. */
export function parseProjectsInput(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[,\s]+/)) {
    const t = piece.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** True when two attach selectors are equivalent (order-insensitive). */
export function attachEqual(a: NormalizedAttach, b: NormalizedAttach): boolean {
  const same = (x: string[], y: string[]): boolean =>
    x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  return same(a.roles, b.roles) && same(a.projects, b.projects) && same(a.match, b.match);
}

// ---------------------------------------------------------------------------
// Fetchers.
// ---------------------------------------------------------------------------

export async function fetchRegisters(): Promise<RegistersPayload> {
  if (isMockMode()) return mockRegisters();
  const res = await fetch("/registers", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /registers → ${res.status}`);
  return (await res.json()) as RegistersPayload;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export async function saveRegister(input: { kind: RegisterKind; name: string; content: string }): Promise<RegisterSaveResponse> {
  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 250));
    return { ok: true, name: input.name, version: 3, unchanged: false };
  }
  return postJson("/registers/save", input);
}

export async function rollbackRegister(input: { kind: RegisterKind; name: string; version: number }): Promise<RollbackResponse> {
  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 250));
    return { ok: true, name: input.name, version: input.version };
  }
  return postJson("/registers/rollback", input);
}

export async function saveSkillAttach(input: { name: string; attach: NormalizedAttach }): Promise<AttachResponse> {
  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 250));
    return { ok: true, name: input.name, version: 3, attach: input.attach };
  }
  return postJson("/registers/skill/attach", input);
}

export async function setSkillEnabled(input: { name: string; enabled: boolean }): Promise<EnabledResponse> {
  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, name: input.name, version: input.enabled ? 2 : null, enabled: input.enabled };
  }
  return postJson("/registers/skill/enabled", input);
}

export async function previewSkillAttach(input: { name?: string; attach: NormalizedAttach }): Promise<AttachPreview | { error: string }> {
  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 200));
    return {
      carries: input.attach.roles.map((role) => ({ role, repos: ["adam91holt/factory.ai"] })),
      repos: ["adam91holt/factory.ai"],
      conditions: input.attach.match,
      contradictory: false,
      rejected: [],
    };
  }
  return postJson("/registers/skill/preview", input);
}

// ---------------------------------------------------------------------------
// Mock fixtures (?mock=1) — a believable slice of the registers.
// ---------------------------------------------------------------------------

function mockRegisters(): RegistersPayload {
  const now = Date.now();
  const days = (n: number): number => now - n * 86_400_000;
  return {
    agents: [
      {
        name: "implementer",
        activeVersion: 2,
        versions: [
          { version: 2, createdAt: days(1), createdBy: "dashboard", active: true },
          { version: 1, createdAt: days(6), createdBy: "import", active: false },
        ],
        content: "---\nmodel: implementer\nname: implementer\ntools: [Read, Glob, Grep, Write, Edit, Bash]\n---\n\nYou are the implementer. Deliver the ticket below as a real, verified change.\n",
        frontmatter: { name: "implementer", model: "implementer" },
      },
      {
        name: "scout",
        activeVersion: 1,
        versions: [{ version: 1, createdAt: days(6), createdBy: "import", active: true }],
        content: "---\nname: scout\n---\n\nYou are the research scout.\n",
        frontmatter: { name: "scout" },
      },
    ],
    skills: [
      {
        name: "factory-design",
        activeVersion: 3,
        versions: [
          { version: 3, createdAt: days(0), createdBy: "dashboard", active: true },
          { version: 2, createdAt: days(2), createdBy: "dashboard", active: false },
          { version: 1, createdAt: days(6), createdBy: "import", active: false },
        ],
        content: "---\nname: factory-design\ndescription: The house visual language.\n---\n# Factory design\n\nDensity with restraint. One accent.",
        description: "The house visual language.",
        attach: { roles: ["implementer", "design-reviewer"], projects: [], match: ["ui"] },
        enabled: true,
      },
      {
        name: "game-feel",
        activeVersion: null,
        versions: [{ version: 1, createdAt: days(6), createdBy: "import", active: false }],
        content: null,
        description: "Juice rubric for game-like UIs.",
        attach: { roles: [], projects: [], match: [] },
        enabled: false,
      },
    ],
    roles: ["implementer", "fixer", "tester", "reviewer-repo", "design-reviewer", "reviewer-spec", "security-reviewer", "steward", "scout", "decomposer", "intake-author", "scaffolder"],
    matchTerms: ["ui", "no-ui", "playwright", "no-playwright", "gate:typecheck", "gate:test", "gate:build", "gate:lint", "no-gate:test", "no-gate:playwright"],
    repos: ["adam91holt/factory.ai", "adam91holt/kiwi-quest"],
  };
}
