import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import {
  decidePolicy,
  fetchProjects,
  saveProjectFields,
  setProjectGroundskeeper,
  setProjectModel,
} from "../lib/projects";
import { fetchCatalog } from "../lib/catalog";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EditableField } from "../components/projects/EditableField";
import { AuthorityPanel } from "../components/projects/AuthorityPanel";
import { ModelsPanel } from "../components/projects/ModelsPanel";
import { GroundskeepersPanel } from "../components/projects/GroundskeepersPanel";
import { AuditTrail } from "../components/projects/AuditTrail";
import { EpicDagPanel } from "../components/projects/EpicDagPanel";
import { PROJECTS_REFETCH_MS } from "./ProjectsPage";
import { useNow } from "../lib/useNow";

const STATUSES = ["active", "paused", "archived"] as const;

export function ProjectDetailPage({ name }: { name: string }) {
  const qc = useQueryClient();
  const now = useNow(30_000);
  const { data, isPending, isError } = useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
    staleTime: 10_000,
    refetchInterval: PROJECTS_REFETCH_MS,
  });
  // Catalog supplies the known groundskeeper card names so a project can arm a
  // card it has no row for yet. Optional — an errored catalog just means the
  // panel lists only the stored rows.
  const { data: catalog } = useQuery({ queryKey: ["catalog"], queryFn: fetchCatalog, staleTime: 60_000, retry: false });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [modelSaving, setModelSaving] = useState<string | null>(null);
  const [gkSaving, setGkSaving] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<number | null>(null);

  const setError = (scope: string, message: string | null): void =>
    setErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[scope];
      else next[scope] = message;
      return next;
    });
  const settle = (scope: string, res: { ok: true } | { error: string }): void => {
    setError(scope, "error" in res ? res.error : null);
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };

  const save = useMutation({
    mutationFn: (fields: Partial<Record<"goal" | "description" | "status" | "team", string>>) =>
      saveProjectFields(name, fields),
    onSuccess: (res) => settle("save", res),
    onError: (e) => setError("save", e instanceof Error ? e.message : "save failed"),
  });
  const model = useMutation({
    mutationFn: ({ role, m, effort }: { role: string; m: string | null; effort: string | null }) =>
      setProjectModel(name, role, m, effort),
    onMutate: ({ role }) => setModelSaving(role),
    onSuccess: (res) => settle("model", res),
    onError: (e) => setError("model", e instanceof Error ? e.message : "model save failed"),
    onSettled: () => setModelSaving(null),
  });
  const groundskeeper = useMutation({
    mutationFn: ({ card, enabled, cadence }: { card: string; enabled: boolean; cadence: string | null }) =>
      setProjectGroundskeeper(name, card, enabled, cadence),
    onMutate: ({ card }) => setGkSaving(card),
    onSuccess: (res) => settle("gk", res),
    onError: (e) => setError("gk", e instanceof Error ? e.message : "groundskeeper save failed"),
    onSettled: () => setGkSaving(null),
  });
  const decide = useMutation({
    mutationFn: ({ policyId, action }: { policyId: number; action: "approve" | "reject" }) =>
      decidePolicy(policyId, action),
    onMutate: ({ policyId }) => setDeciding(policyId),
    onSuccess: (res) => settle("policy", res),
    onError: (e) => setError("policy", e instanceof Error ? e.message : "decision failed"),
    onSettled: () => setDeciding(null),
  });

  const project = data?.projects.find((p) => p.name === name);

  if (isPending) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <Skeleton className="h-16 w-full" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="mx-auto max-w-6xl rounded-lg border border-err/30 bg-err/5 p-5 text-center font-mono text-[11px] text-err">
        could not load /projects — is the daemon running with the project routes deployed?
      </div>
    );
  }
  if (!project) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-3">
        <Link to="/projects" className="flex items-center gap-1.5 font-mono text-[11px] text-fg-dim hover:text-fg">
          <ArrowLeft className="size-3.5" strokeWidth={1.75} /> all projects
        </Link>
        <div className="w-full rounded-lg border border-dashed border-line px-6 py-10 text-center font-mono text-[11.5px] text-fg-dim">
          no project named “{name}” — it may have been removed from projects/
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Link to="/projects" className="flex items-center gap-1.5 font-mono text-[11px] text-fg-dim transition-colors duration-100 hover:text-fg">
          <ArrowLeft className="size-3.5" strokeWidth={1.75} /> all projects
        </Link>
        <h1 className="text-sm font-bold tracking-wide text-fg">{project.name}</h1>
        <Badge variant={project.status === "active" ? "ok" : project.status === "paused" ? "parked" : "outline"}>
          {project.status}
        </Badge>
        <select
          className="rounded-md border border-line bg-bg0 px-1.5 py-0.5 font-mono text-[10.5px] text-fg-dim outline-none transition-colors duration-100 hover:border-line2"
          value={project.status}
          onChange={(e) => save.mutate({ status: e.target.value })}
          title="project status (descriptive — applies immediately)"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {errors.save && <span className="font-mono text-[10.5px] text-err">{errors.save}</span>}
      </div>

      <Card>
        <CardHeader className="pb-1.5">
          <CardTitle>About — edits apply immediately</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_12rem]">
          <EditableField
            label="goal"
            value={project.goal}
            placeholder="what done looks like for this project"
            multiline
            saving={save.isPending}
            onSave={(v) => save.mutate({ goal: v })}
          />
          <EditableField
            label="description"
            value={project.description}
            placeholder="context the factory should know"
            multiline
            saving={save.isPending}
            onSave={(v) => save.mutate({ description: v })}
          />
          <EditableField
            label="team"
            value={project.team}
            placeholder="Linear team key"
            saving={save.isPending}
            onSave={(v) => save.mutate({ team: v })}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        <AuthorityPanel
          project={project}
          now={now}
          deciding={deciding}
          onDecide={(policyId, action) => decide.mutate({ policyId, action })}
          decisionError={errors.policy ?? null}
        />
        <div className="flex flex-col gap-3">
          <ModelsPanel
            models={project.models}
            roster={data.roster}
            saving={modelSaving}
            error={errors.model ?? null}
            onSet={(role, m, effort) => model.mutate({ role, m, effort })}
          />
          <GroundskeepersPanel
            rows={project.groundskeepers}
            cards={catalog?.groundskeepers.map((g) => g.name) ?? []}
            globallyEnabled={data.groundskeepersEnabled}
            saving={gkSaving}
            error={errors.gk ?? null}
            onToggle={(card, enabled, cadence) => groundskeeper.mutate({ card, enabled, cadence })}
          />
        </div>
      </div>

      <EpicDagPanel drain={data.drain} />

      <AuditTrail audit={project.audit} now={now} />
    </div>
  );
}
