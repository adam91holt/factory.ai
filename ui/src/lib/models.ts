import { isMockMode } from "./fixtures";

// Models client — mirrors GET /models (src/project-config.ts modelsView). The
// catalog is the PG-synced list of every id the proxy serves; roster is the
// env defaults per role; projects carry per-project overrides (set via the
// existing POST /projects/model contract in lib/projects.ts).

export interface CatalogModel {
  model: string;
  source: string;
  available: boolean;
  firstSeen: number;
  lastSeen: number;
}

export interface ModelsPayload {
  catalog: CatalogModel[];
  roster: Array<{ role: string; model: string }>;
  proxyAll: boolean;
  projects: Array<{ name: string; models: Array<{ role: string; model: string; effort: string | null }> }>;
}

function mockModels(): ModelsPayload {
  const now = Date.now();
  const row = (model: string, available = true): CatalogModel => ({
    model, source: "proxy", available, firstSeen: now - 86_400_000, lastSeen: now,
  });
  return {
    catalog: [
      row("claude-fable-5"), row("claude-opus-5"), row("claude-sonnet-5"),
      row("claude-haiku-4-5-20251001"), row("gpt-5.6-sol"), row("gpt-5.6-terra"),
      row("gpt-5.6-luna"), row("deepseek-v4-flash-0731"), row("qwen3.8-max-preview"),
      row("gpt-5.3-codex-spark", false),
    ],
    roster: [
      { role: "implementer", model: "claude-sonnet-5" },
      { role: "reviewerClaude", model: "claude-opus-5" },
      { role: "reviewerCodex", model: "gpt-5.6-sol" },
      { role: "fixer", model: "claude-sonnet-5" },
      { role: "securityReviewer", model: "deepseek-v4-flash-0731" },
    ],
    proxyAll: true,
    projects: [
      { name: "eval-orbital-01", models: [{ role: "implementer", model: "gpt-5.6-terra", effort: "high" }] },
      { name: "factory", models: [] },
    ],
  };
}

export async function fetchModels(): Promise<ModelsPayload> {
  if (isMockMode()) return mockModels();
  const res = await fetch("/models", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /models → ${res.status}`);
  return (await res.json()) as ModelsPayload;
}
