import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitCommitHorizontal } from "lucide-react";
import {
  fetchCatalog,
  saveCatalog,
  type CatalogKind,
  type CatalogPayload,
  type UsageStat,
} from "../lib/catalog";
import {
  fetchRegisters, previewSkillAttach, rollbackRegister, saveRegister, saveSkillAttach, setSkillEnabled,
  type AgentRegisterEntry, type AttachPreview, type NormalizedAttach, type RegisterKind,
  type RegistersPayload, type SkillRegisterEntry,
} from "../lib/registers";
import { Card } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { CatalogList, type ListRow } from "../components/catalog/CatalogList";
import { CatalogDetail } from "../components/catalog/CatalogDetail";
import { VersionHistory } from "../components/catalog/VersionHistory";
import { AttachEditor } from "../components/catalog/AttachEditor";

type Tab = "agents" | "skills" | "groundskeepers";
const TABS: Tab[] = ["agents", "skills", "groundskeepers"];

const EMPTY_ATTACH: NormalizedAttach = { roles: [], projects: [], match: [] };

interface UnifiedItem {
  kind: CatalogKind;
  name: string;
  frontmatter: Record<string, unknown>;
  content: string; // loaded baseline: editor source + diff baseline
  subtitle: string;
  usage: UsageStat | null;
  enabled?: boolean;
  invalid?: string;
  /** Register overlay (issue #16 WP3) — undefined for file-only entries and
   *  for groundskeepers (which stay file+git). */
  register?: AgentRegisterEntry | SkillRegisterEntry;
  skillRegister?: SkillRegisterEntry;
}

/** Merge the file catalog with the PG register: the register's ACTIVE version
 *  wins as the editor baseline (it is what the daemon actually runs); files
 *  remain the fallback, and register-only names appear even before an export
 *  writes their file. */
function itemsForTab(data: CatalogPayload | undefined, registers: RegistersPayload | undefined, tab: Tab): UnifiedItem[] {
  if (!data) return [];
  if (tab === "agents") {
    const byName = new Map<string, UnifiedItem>();
    for (const a of data.agents) {
      byName.set(a.name, {
        kind: "agent", name: a.name, frontmatter: a.frontmatter, content: a.content,
        subtitle: a.frontmatter.when ?? "", usage: a.usage,
      });
    }
    for (const r of registers?.agents ?? []) {
      const existing = byName.get(r.name);
      byName.set(r.name, {
        kind: "agent",
        name: r.name,
        frontmatter: r.activeVersion !== null ? r.frontmatter : existing?.frontmatter ?? r.frontmatter,
        content: r.content ?? existing?.content ?? "",
        subtitle: existing?.subtitle ?? String(r.frontmatter.when ?? ""),
        usage: existing?.usage ?? null,
        register: r,
      });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (tab === "skills") {
    const byName = new Map<string, UnifiedItem>();
    for (const s of data.skills) {
      byName.set(s.name, {
        kind: "skill", name: s.name, frontmatter: s.frontmatter, content: s.body,
        subtitle: s.frontmatter.description ?? "", usage: null,
      });
    }
    for (const r of registers?.skills ?? []) {
      const existing = byName.get(r.name);
      byName.set(r.name, {
        kind: "skill",
        name: r.name,
        frontmatter: existing?.frontmatter ?? { name: r.name, description: r.description },
        content: r.content ?? existing?.content ?? "",
        subtitle: r.description || (existing?.subtitle ?? ""),
        usage: null,
        enabled: r.enabled,
        register: r,
        skillRegister: r,
      });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  return data.groundskeepers.map((g) => ({
    kind: "groundskeeper" as const,
    name: g.name,
    frontmatter: g.frontmatter,
    content: g.content,
    subtitle: `${String(g.frontmatter.schedule ?? "")} · ${String(g.frontmatter.team ?? "")}`.trim(),
    usage: g.usage,
    enabled: g.frontmatter.enabled === true,
    invalid: g.invalid,
  }));
}

const EMPTY_TEXT: Record<Tab, string> = {
  agents: "no agent cards in agents/ or the register — add a <name>.md card to see it here",
  skills: "no skill packs in skills/ or the register — add a <name>/SKILL.md to see it here",
  groundskeepers: "no groundskeeper cards in groundskeepers/ — add a <name>.md card to see it here",
};

export function CatalogPage() {
  const qc = useQueryClient();
  const { data, isPending, isError } = useQuery({
    queryKey: ["catalog"],
    queryFn: fetchCatalog,
    staleTime: 60_000,
  });
  const registersQuery = useQuery({
    queryKey: ["registers"],
    queryFn: fetchRegisters,
    staleTime: 60_000,
  });
  const registers = registersQuery.data;

  const [tab, setTab] = useState<Tab>("agents");
  const [selectedByTab, setSelectedByTab] = useState<Record<Tab, string | null>>({
    agents: null,
    skills: null,
    groundskeepers: null,
  });
  const [draft, setDraft] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ name: string; message: string; commit?: string | null; warning?: string } | null>(null);
  const [attachDraft, setAttachDraft] = useState<NormalizedAttach>(EMPTY_ATTACH);
  const [preview, setPreview] = useState<AttachPreview | null>(null);

  const items = useMemo(() => itemsForTab(data, registers, tab), [data, registers, tab]);
  const selectedName = selectedByTab[tab] ?? items[0]?.name ?? null;
  const selected = items.find((i) => i.name === selectedName);
  // Register mode: agents & skills save to the PG register; groundskeepers
  // stay file+git through /catalog/save.
  const registerMode = selected !== undefined && selected.kind !== "groundskeeper";
  const savedAttach = selected?.skillRegister?.attach ?? EMPTY_ATTACH;

  // Reset the editor whenever the selected card changes identity or its loaded
  // content changes (a save → refetch lands the committed text, clearing dirty).
  useEffect(() => {
    setDraft(selected?.content ?? "");
    setSaveError(null);
  }, [selected?.kind, selected?.name, selected?.content]);

  // Reset the attach editor + preview alongside (keyed to the ACTIVE attach so
  // a save → refetch lands the stored selector).
  useEffect(() => {
    setAttachDraft(savedAttach);
    setPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.name, JSON.stringify(savedAttach)]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ["catalog"] });
    void qc.invalidateQueries({ queryKey: ["registers"] });
  };

  // File + git — groundskeeper saves AND the export action for register entries.
  const fileMutation = useMutation({
    mutationFn: saveCatalog,
    onSuccess: (res, vars) => {
      if ("error" in res) {
        setSaveError(res.error);
        return;
      }
      setSaveError(null);
      setToast({ name: vars.name, message: `exported ${vars.name}`, commit: res.commit, warning: res.warning });
      invalidate();
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : "save request failed"),
  });

  const registerSave = useMutation({
    mutationFn: saveRegister,
    onSuccess: (res, vars) => {
      if ("error" in res) {
        setSaveError(res.error);
        return;
      }
      setSaveError(null);
      setToast({
        name: vars.name,
        message: res.unchanged ? `${vars.name} unchanged (still v${res.version})` : `saved ${vars.name} → v${res.version} in the register`,
      });
      invalidate();
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : "register save failed"),
  });

  const rollback = useMutation({
    mutationFn: rollbackRegister,
    onSuccess: (res, vars) => {
      if ("error" in res) {
        setSaveError(res.error);
        return;
      }
      setSaveError(null);
      setToast({ name: vars.name, message: `rolled ${vars.name} back to v${vars.version} — next stage uses it` });
      invalidate();
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : "rollback failed"),
  });

  const attachSave = useMutation({
    mutationFn: saveSkillAttach,
    onSuccess: (res, vars) => {
      if ("error" in res) {
        setSaveError(res.error);
        return;
      }
      setSaveError(null);
      setToast({ name: vars.name, message: `carry selector saved → v${res.version}` });
      invalidate();
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : "attach save failed"),
  });

  const enabledToggle = useMutation({
    mutationFn: setSkillEnabled,
    onSuccess: (res, vars) => {
      if ("error" in res) {
        setSaveError(res.error);
        return;
      }
      setSaveError(null);
      setToast({ name: vars.name, message: vars.enabled ? `${vars.name} enabled` : `${vars.name} disabled — carried nowhere` });
      invalidate();
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : "enable toggle failed"),
  });

  const previewMutation = useMutation({
    mutationFn: previewSkillAttach,
    onSuccess: (res) => {
      if ("error" in res) {
        setSaveError(res.error);
        return;
      }
      setSaveError(null);
      setPreview(res);
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : "preview failed"),
  });

  const dirty = selected ? draft !== selected.content : false;
  const saving = fileMutation.isPending || registerSave.isPending;

  const onSave = (): void => {
    if (!selected) return;
    if (registerMode) {
      registerSave.mutate({ kind: selected.kind as RegisterKind, name: selected.name, content: draft });
    } else {
      fileMutation.mutate({ kind: selected.kind, name: selected.name, content: draft });
    }
  };

  const onExport = (): void => {
    if (!selected?.register?.content) return;
    // Export writes the ACTIVE register version to its file and commits it —
    // the only path that still touches file + git for register entries.
    fileMutation.mutate({ kind: selected.kind, name: selected.name, content: selected.register.content });
  };

  const selectRow = (name: string): void => {
    setSelectedByTab((prev) => ({ ...prev, [tab]: name }));
  };

  const counts = {
    agents: itemsForTab(data, registers, "agents").length,
    skills: itemsForTab(data, registers, "skills").length,
    groundskeepers: data?.groundskeepers.length ?? 0,
  };

  const rows: ListRow[] = items.map((i) => ({
    name: i.name,
    subtitle: i.subtitle,
    usage: i.usage,
    enabled: i.enabled,
    invalid: i.invalid !== undefined,
  }));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-sm font-bold tracking-wide text-fg">Catalog</h1>
        <span className="font-mono text-[11px] text-fg-faint">
          agent &amp; skill saves version the Postgres register (file+git = export) — groundskeeper saves still git-commit
        </span>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {t} · {counts[t]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isError ? (
        <div className="rounded-lg border border-err/30 bg-err/5 p-5 text-center font-mono text-[11px] text-err">
          could not load /catalog — is the daemon running with DASHBOARD_PORT set?
        </div>
      ) : isPending ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[320px_1fr]">
          <div className="flex flex-col gap-1">
            {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
          <Skeleton className="hidden h-[30rem] w-full md:block" />
        </div>
      ) : (
        // MOBILE-FIRST: one column under md (the editor stacks below the list);
        // the fixed 320px+1fr split is a md+ layout only.
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-[320px_1fr]">
          <CatalogList
            rows={rows}
            selected={selectedName}
            dirtyName={dirty ? selectedName : null}
            onSelect={selectRow}
            emptyText={EMPTY_TEXT[tab]}
          />
          <Card className="p-4">
            {selected ? (
              <CatalogDetail
                kind={selected.kind}
                name={selected.name}
                frontmatter={selected.frontmatter}
                invalid={selected.invalid}
                usage={selected.usage}
                baseline={selected.content}
                draft={draft}
                dirty={dirty}
                saving={saving}
                saveError={saveError}
                showDiff={showDiff}
                activeVersion={registerMode && selected.register ? selected.register.activeVersion : undefined}
                saveLabel={registerMode ? "Save to register" : "Save & commit"}
                exporting={fileMutation.isPending}
                beforeEditor={
                  selected.kind === "skill" && selected.skillRegister && registers ? (
                    <AttachEditor
                      key={selected.name}
                      attach={attachDraft}
                      savedAttach={savedAttach}
                      enabled={selected.skillRegister.enabled}
                      roles={registers.roles}
                      matchTerms={registers.matchTerms}
                      saving={attachSave.isPending || enabledToggle.isPending}
                      preview={preview}
                      previewLoading={previewMutation.isPending}
                      onChange={setAttachDraft}
                      onSave={() => attachSave.mutate({ name: selected.name, attach: attachDraft })}
                      onToggleEnabled={() => enabledToggle.mutate({ name: selected.name, enabled: !(selected.skillRegister?.enabled ?? false) })}
                      onPreview={() => previewMutation.mutate({ name: selected.name, attach: attachDraft })}
                    />
                  ) : undefined
                }
                afterEditor={
                  registerMode && selected.register ? (
                    <VersionHistory
                      versions={selected.register.versions}
                      rollingBack={rollback.isPending ? rollback.variables?.version ?? null : null}
                      onRollback={(version) => rollback.mutate({ kind: selected.kind as RegisterKind, name: selected.name, version })}
                    />
                  ) : undefined
                }
                onDraftChange={setDraft}
                onToggleDiff={() => setShowDiff((v) => !v)}
                onSave={onSave}
                onReset={() => setDraft(selected.content)}
                onExport={registerMode && selected.register?.content ? onExport : undefined}
              />
            ) : (
              <div className="p-8 text-center font-mono text-[11px] text-fg-faint">
                select a card to view and edit it
              </div>
            )}
          </Card>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 flex items-start gap-2.5 rounded-lg border border-ok/40 bg-bg1 px-3 py-2.5 shadow-lg feed-in">
          <span className="mt-px flex size-4 items-center justify-center rounded-full bg-ok/15">
            <Check className="size-3 text-ok" strokeWidth={2.5} />
          </span>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[12px] text-fg">{toast.message}</span>
            {toast.commit && (
              <span className="flex items-center gap-1 font-mono text-[10.5px] text-fg-faint">
                <GitCommitHorizontal className="size-3" strokeWidth={1.75} />
                committed {toast.commit}
              </span>
            )}
            {toast.commit === null && (
              <span className="font-mono text-[10.5px] text-parked">
                {toast.warning ?? "written (no commit)"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
