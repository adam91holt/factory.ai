import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Check } from "lucide-react";
import { fetchModels } from "../lib/models";
import { setProjectModel } from "../lib/projects";
import { relTime } from "../lib/format";
import { useNow } from "../lib/useNow";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";

// The Models area: what the proxy serves (PG model catalog), what each role
// runs by default (env roster), and per-project overrides — configured here
// through the same audited POST /projects/model contract the Projects page
// uses. The catalog is the allowlist; there is no free-text model input.

const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"] as const;

/** Vendor accent for a model id — same colour language as stage spines. */
function vendorAccent(model: string): string {
  if (/claude|opus|sonnet|haiku|fable/i.test(model)) return "bg-claude/70";
  if (/gpt|codex|o[0-9]/i.test(model)) return "bg-codex/70";
  return "bg-fg-dim/60";
}

function OverrideEditor({
  projects,
  roles,
  availableModels,
  onDone,
}: {
  projects: Array<{ name: string }>;
  roles: string[];
  availableModels: string[];
  onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [project, setProject] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => setProjectModel(project, role, model === "__clear__" ? null : model, effort === "" ? null : effort),
    onSuccess: (res) => {
      if ("error" in res) { setError(res.error); return; }
      setError(null);
      onDone(model === "__clear__" ? `${project}/${role} override cleared` : `${project}/${role} → ${model}${effort ? ` (${effort})` : ""}`);
      void qc.invalidateQueries({ queryKey: ["models"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "request failed"),
  });

  const ready = project !== "" && role !== "" && model !== "";
  const selectCls = "h-8 rounded-md border border-line bg-bg1 px-2 font-mono text-[11.5px] text-fg";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg1 px-3.5 py-3">
      <div className="section-label">Set a per-project override</div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">project…</option>
          {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <select className={selectCls} value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">role…</option>
          {roles.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">model…</option>
          <option value="__clear__">(clear override)</option>
          {availableModels.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select className={selectCls} value={effort} onChange={(e) => setEffort(e.target.value)} title="reasoning effort (optional)">
          {EFFORTS.map((ef) => <option key={ef} value={ef}>{ef === "" ? "effort (default)" : ef}</option>)}
        </select>
        <button
          type="button"
          disabled={!ready || mutation.isPending}
          onClick={() => mutation.mutate()}
          className={cn(
            "h-8 rounded-md border px-3 font-mono text-[11.5px] transition-colors duration-100",
            ready ? "border-live/40 bg-live/10 text-live hover:bg-live/20" : "border-line text-fg-faint",
            mutation.isPending && "cursor-wait opacity-50",
          )}
        >
          {mutation.isPending ? "applying…" : "apply"}
        </button>
      </div>
      {error && <div className="font-mono text-[11px] text-err">failed: {error}</div>}
    </div>
  );
}

export function ModelsPage() {
  const now = useNow(30_000);
  const [toast, setToast] = useState<string | null>(null);
  const { data, isPending, isError } = useQuery({
    queryKey: ["models"],
    queryFn: fetchModels,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const catalog = data?.catalog ?? [];
  const available = catalog.filter((m) => m.available);
  const overridden = (data?.projects ?? []).filter((p) => p.models.length > 0);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-sm font-bold tracking-wide text-fg">Models</h1>
        <span className="font-mono text-[11px] text-fg-faint">
          {available.length} servable via the proxy · catalog synced from /v1/models at daemon boot
        </span>
        {data && (
          <Badge variant="outline" className="ml-auto">
            {data.proxyAll ? "PROXY_ALL=1 — every stage pooled via proxy" : "PROXY_ALL=0 — Claude direct, rest proxied"}
          </Badge>
        )}
      </div>

      {isPending ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-err/30 bg-err/5 p-5 text-center font-mono text-[11px] text-err">
          could not load /models — is the daemon running with DASHBOARD_PORT set?
        </div>
      ) : (
        <>
          <section className="flex flex-col gap-1.5">
            <div className="section-label">Role defaults (env roster — the daemon's .env, restart to change)</div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {(data?.roster ?? []).map(({ role, model }) => (
                <div key={role} className="flex items-center gap-2.5 rounded-lg border border-line bg-bg1 px-3 py-2">
                  <span className={cn("h-4 w-0.5 shrink-0 rounded-full", vendorAccent(model))} />
                  <span className="font-mono text-[11.5px] text-fg-dim">{role}</span>
                  <span className="ml-auto font-mono text-[11.5px] text-fg">{model}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-1.5">
            <div className="section-label">
              Per-project overrides{overridden.length > 0 ? ` · ${overridden.length} project(s)` : " — none set"}
            </div>
            {overridden.map((p) => (
              <div key={p.name} className="flex flex-col gap-1 rounded-lg border border-line bg-bg1 px-3.5 py-2.5">
                <span className="font-mono text-[11.5px] font-bold text-fg">{p.name}</span>
                {p.models.map((m) => (
                  <div key={m.role} className="flex items-center gap-2.5">
                    <span className={cn("h-3.5 w-0.5 shrink-0 rounded-full", vendorAccent(m.model))} />
                    <span className="font-mono text-[11px] text-fg-dim">{m.role}</span>
                    <span className="ml-auto font-mono text-[11px] text-fg">
                      {m.model}
                      {m.effort && <span className="text-fg-faint"> · {m.effort}</span>}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            <OverrideEditor
              projects={data?.projects ?? []}
              roles={(data?.roster ?? []).map((r) => r.role)}
              availableModels={available.map((m) => m.model)}
              onDone={(msg) => {
                setToast(msg);
                setTimeout(() => setToast(null), 5000);
              }}
            />
          </section>

          <section className="flex flex-col gap-1.5">
            <div className="section-label">Catalog · {catalog.length} known</div>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-left font-mono text-[11px]">
                <thead>
                  <tr className="border-b border-line text-fg-faint">
                    <th className="px-3 py-2 font-medium">model</th>
                    <th className="px-3 py-2 font-medium">source</th>
                    <th className="px-3 py-2 font-medium">status</th>
                    <th className="px-3 py-2 font-medium">last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.map((m) => (
                    <tr key={m.model} className={cn("border-b border-line/50 last:border-0", !m.available && "opacity-45")}>
                      <td className="flex items-center gap-2 px-3 py-1.5 text-fg">
                        <span className={cn("h-3.5 w-0.5 shrink-0 rounded-full", vendorAccent(m.model))} />
                        {m.model}
                      </td>
                      <td className="px-3 py-1.5 text-fg-dim">{m.source}</td>
                      <td className="px-3 py-1.5">
                        {m.available
                          ? <span className="text-ok">available</span>
                          : <span className="text-fg-faint">gone from proxy</span>}
                      </td>
                      <td className="px-3 py-1.5 text-fg-faint" title={new Date(m.lastSeen).toISOString()}>
                        {relTime(m.lastSeen, now)}
                      </td>
                    </tr>
                  ))}
                  {catalog.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-fg-faint">
                        <Cpu className="mx-auto mb-1.5 size-4" strokeWidth={1.5} />
                        catalog is empty — it fills from the proxy&apos;s /v1/models on the next daemon boot
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2.5 rounded-lg border border-ok/40 bg-bg1 px-3 py-2.5 shadow-lg feed-in">
          <span className="flex size-4 items-center justify-center rounded-full bg-ok/15">
            <Check className="size-3 text-ok" strokeWidth={2.5} />
          </span>
          <span className="font-mono text-[12px] text-fg">{toast}</span>
        </div>
      )}
    </div>
  );
}
