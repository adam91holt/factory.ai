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
import { Card } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { CatalogList, type ListRow } from "../components/catalog/CatalogList";
import { CatalogDetail } from "../components/catalog/CatalogDetail";

type Tab = "agents" | "skills" | "groundskeepers";
const TABS: Tab[] = ["agents", "skills", "groundskeepers"];

interface UnifiedItem {
  kind: CatalogKind;
  name: string;
  frontmatter: Record<string, unknown>;
  content: string; // loaded baseline: editor source + diff baseline
  subtitle: string;
  usage: UsageStat | null;
  enabled?: boolean;
  invalid?: string;
}

function itemsForTab(data: CatalogPayload | undefined, tab: Tab): UnifiedItem[] {
  if (!data) return [];
  if (tab === "agents") {
    return data.agents.map((a) => ({
      kind: "agent",
      name: a.name,
      frontmatter: a.frontmatter,
      content: a.content,
      subtitle: a.frontmatter.when ?? "",
      usage: a.usage,
    }));
  }
  if (tab === "skills") {
    return data.skills.map((s) => ({
      kind: "skill",
      name: s.name,
      frontmatter: s.frontmatter,
      content: s.body,
      subtitle: s.frontmatter.description ?? "",
      usage: null,
    }));
  }
  return data.groundskeepers.map((g) => ({
    kind: "groundskeeper",
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
  agents: "no agent cards in agents/ — add a <name>.md card to see it here",
  skills: "no skill packs in skills/ — add a <name>/SKILL.md to see it here",
  groundskeepers: "no groundskeeper cards in groundskeepers/ — add a <name>.md card to see it here",
};

export function CatalogPage() {
  const qc = useQueryClient();
  const { data, isPending, isError } = useQuery({
    queryKey: ["catalog"],
    queryFn: fetchCatalog,
    staleTime: 60_000,
  });

  const [tab, setTab] = useState<Tab>("agents");
  const [selectedByTab, setSelectedByTab] = useState<Record<Tab, string | null>>({
    agents: null,
    skills: null,
    groundskeepers: null,
  });
  const [draft, setDraft] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ name: string; commit: string | null; warning?: string } | null>(null);

  const items = useMemo(() => itemsForTab(data, tab), [data, tab]);
  const selectedName = selectedByTab[tab] ?? items[0]?.name ?? null;
  const selected = items.find((i) => i.name === selectedName);

  // Reset the editor whenever the selected card changes identity or its loaded
  // content changes (a save → refetch lands the committed text, clearing dirty).
  useEffect(() => {
    setDraft(selected?.content ?? "");
    setSaveError(null);
  }, [selected?.kind, selected?.name, selected?.content]);

  // Auto-dismiss the commit toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const mutation = useMutation({
    mutationFn: saveCatalog,
    onSuccess: (res, vars) => {
      if ("error" in res) {
        setSaveError(res.error);
        return;
      }
      setSaveError(null);
      setToast({ name: vars.name, commit: res.commit, warning: res.warning });
      void qc.invalidateQueries({ queryKey: ["catalog"] });
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : "save request failed"),
  });

  const dirty = selected ? draft !== selected.content : false;

  const selectRow = (name: string): void => {
    setSelectedByTab((prev) => ({ ...prev, [tab]: name }));
  };

  const counts = {
    agents: data?.agents.length ?? 0,
    skills: data?.skills.length ?? 0,
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
          manage agent cards, skills &amp; groundskeepers — every save is a git commit
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
        <div className="grid grid-cols-[320px_1fr] gap-3">
          <div className="flex flex-col gap-1">
            {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
          <Skeleton className="h-[30rem] w-full" />
        </div>
      ) : (
        <div className="grid grid-cols-[320px_1fr] items-start gap-3">
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
                saving={mutation.isPending}
                saveError={saveError}
                showDiff={showDiff}
                onDraftChange={setDraft}
                onToggleDiff={() => setShowDiff((v) => !v)}
                onSave={() => mutation.mutate({ kind: selected.kind, name: selected.name, content: draft })}
                onReset={() => setDraft(selected.content)}
              />
            ) : (
              <div className="p-8 text-center font-mono text-[11px] text-fg-faint">
                select a card on the left to view and edit it
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
            <span className="font-mono text-[12px] text-fg">saved {toast.name}</span>
            {toast.commit ? (
              <span className="flex items-center gap-1 font-mono text-[10.5px] text-fg-faint">
                <GitCommitHorizontal className="size-3" strokeWidth={1.75} />
                committed {toast.commit}
              </span>
            ) : (
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
