import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  History,
  LoaderCircle,
  Play,
  SearchCheck,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ActionParameters, ActionPreview } from "../../shared/contracts.js";
import { PageError, PageLoading } from "../components/states.js";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, PageHeader, Select, Table, TableCell, TableHead } from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatDateTime, formatUsd, truncateIdentifier } from "../lib/utils.js";

const actionLabels = {
  collect: "Coletar um varejista",
  discover: "Descobrir catálogo",
  daily: "Pipeline diário manual",
  classify: "Classificar pendências",
  "index-export": "Publicar snapshot do índice",
} as const;

const statusTone = {
  confirmed: "info",
  started: "info",
  succeeded: "good",
  failed: "critical",
  blocked_by_lock: "warning",
  interrupted_unknown: "warning",
} as const;

export function JobsPage() {
  const meta = api.useMeta();
  const retailers = api.useRetailers();
  const jobs = api.useJobs();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ActionParameters["kind"]>("collect");
  const [retailerId, setRetailerId] = useState("");
  const [limit, setLimit] = useState(50);
  const [batchSize, setBatchSize] = useState(50);
  const [concurrency, setConcurrency] = useState(1);
  const [version, setVersion] = useState(1);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.8);
  const [throughDay, setThroughDay] = useState("");
  const [requireOfficial, setRequireOfficial] = useState(false);
  const [preview, setPreview] = useState<ActionPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [authorizedSpend, setAuthorizedSpend] = useState("");

  useEffect(() => {
    if (retailerId === "" && retailers.data?.retailers[0]) {
      setRetailerId(retailers.data.retailers[0].id);
    }
  }, [retailerId, retailers.data]);

  const activeJob = jobs.data?.jobs.find((job) => job.status === "confirmed" || job.status === "started");
  useEffect(() => {
    if (activeJob === undefined) return;
    const events = new EventSource(`/api/v1/jobs/${encodeURIComponent(activeJob.id)}/events`);
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    events.addEventListener("status", refresh);
    events.addEventListener("complete", () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      events.close();
    });
    return () => events.close();
  }, [activeJob?.id, queryClient]);

  const parameters = useMemo<ActionParameters | null>(() => {
    switch (kind) {
      case "collect":
        return retailerId === "" ? null : { kind, retailerId, limit: Math.min(2_000, Math.max(1, limit)) };
      case "discover":
        return retailerId === "" ? null : { kind, retailerId, limit: Math.min(3_000, Math.max(1, limit)) };
      case "daily":
        return { kind, limit: Math.min(2_000, Math.max(1, limit)) };
      case "classify":
        return {
          kind,
          batchSize: Math.min(2_000, Math.max(1, batchSize)),
          concurrency: Math.min(3, Math.max(1, concurrency)),
          version: Math.max(1, version),
          confidenceThreshold: Math.min(1, Math.max(0, confidenceThreshold)),
        };
      case "index-export":
        return {
          kind,
          classificationVersion: Math.max(1, version),
          throughDay: throughDay === "" ? null : throughDay,
          requireOfficial,
        };
    }
  }, [batchSize, concurrency, confidenceThreshold, kind, limit, requireOfficial, retailerId, throughDay, version]);

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (parameters === null) throw new Error("Selecione um varejista.");
      return api.previewAction(parameters);
    },
    onSuccess: (value) => {
      setPreview(value);
      setConfirmation("");
      setAuthorizedSpend(value.plan.estimatedCostUsd === null ? "" : String(value.plan.estimatedCostUsd));
    },
  });
  const executeMutation = useMutation({
    mutationFn: async () => {
      if (preview === null) throw new Error("Gere um preview primeiro.");
      return api.executeAction(preview.action, {
        previewId: preview.id,
        confirmationPhrase: confirmation,
        ...(preview.plan.estimatedCostUsd === null
          ? {}
          : { authorizedSpendUsd: Number(authorizedSpend) }),
      });
    },
    onSuccess: () => {
      setPreview(null);
      setConfirmation("");
      setAuthorizedSpend("");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  if (meta.isLoading || retailers.isLoading || jobs.isLoading) return <PageLoading />;
  if (meta.error || !meta.data) return <PageError error={meta.error} retry={() => void meta.refetch()} />;
  if (jobs.error || !jobs.data) return <PageError error={jobs.error} retry={() => void jobs.refetch()} />;
  const enabled = meta.data.application.actionsEnabled;

  return (
    <>
      <PageHeader
        eyebrow="Controle guardado"
        title="Ações"
        description="Toda execução nasce de um preview read-only, expira, exige confirmação textual e volta à CLI autoritativa para locks, admissões, orçamento e persistência."
      />

      <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
        <Card>
          <CardHeader>
            <div><CardTitle className="flex items-center gap-2"><TerminalSquare className="size-4 text-accent" /> Nova ação</CardTitle><CardDescription>Nenhum comando arbitrário é aceito; somente o catálogo abaixo.</CardDescription></div>
            <Badge tone={enabled ? "warning" : "info"}>{enabled ? "Execução habilitada" : "Modo observador"}</Badge>
          </CardHeader>
          <CardContent>
            {!enabled && (
              <div className="mb-5 rounded-xl border border-info/25 bg-info/5 p-4 text-sm leading-6 text-muted">
                Reinicie pelo terminal com <code className="rounded bg-subtle px-1.5 py-1 font-mono text-xs text-ink">npm run control-room:start -- --enable-actions</code>. Credenciais nunca são digitadas no navegador.
              </div>
            )}
            <div className="grid gap-4">
              <label className="grid gap-1.5 text-sm font-medium">Operação
                <Select
                  value={kind}
                  disabled={!enabled}
                  onChange={(event) => {
                    setKind(event.target.value as ActionParameters["kind"]);
                    setPreview(null);
                  }}
                >
                  {Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </Select>
              </label>

              {(kind === "collect" || kind === "discover") && (
                <label className="grid gap-1.5 text-sm font-medium">Varejista
                  <Select value={retailerId} disabled={!enabled} onChange={(event) => { setRetailerId(event.target.value); setPreview(null); }}>
                    {retailers.data?.retailers.map((retailer) => <option key={retailer.id} value={retailer.id}>{retailer.name}</option>)}
                  </Select>
                </label>
              )}

              {(kind === "collect" || kind === "discover" || kind === "daily") && (
                <label className="grid gap-1.5 text-sm font-medium">Limite {kind === "daily" ? "por varejista" : "da operação"}
                  <Input type="number" min={1} max={kind === "discover" ? 3_000 : 2_000} value={limit} disabled={!enabled} onChange={(event) => { setLimit(Number(event.target.value)); setPreview(null); }} />
                </label>
              )}

              {kind === "classify" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-sm font-medium">Batch size<Input type="number" min={1} max={2_000} value={batchSize} disabled={!enabled} onChange={(event) => { setBatchSize(Number(event.target.value)); setPreview(null); }} /></label>
                  <label className="grid gap-1.5 text-sm font-medium">Concorrência<Input type="number" min={1} max={3} value={concurrency} disabled={!enabled} onChange={(event) => { setConcurrency(Number(event.target.value)); setPreview(null); }} /></label>
                  <label className="grid gap-1.5 text-sm font-medium">Versão<Input type="number" min={1} value={version} disabled={!enabled} onChange={(event) => { setVersion(Number(event.target.value)); setPreview(null); }} /></label>
                  <label className="grid gap-1.5 text-sm font-medium">Confiança mínima<Input type="number" min={0} max={1} step={0.01} value={confidenceThreshold} disabled={!enabled} onChange={(event) => { setConfidenceThreshold(Number(event.target.value)); setPreview(null); }} /></label>
                </div>
              )}

              {kind === "index-export" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-sm font-medium">Versão de classificação<Input type="number" min={1} value={version} disabled={!enabled} onChange={(event) => { setVersion(Number(event.target.value)); setPreview(null); }} /></label>
                  <label className="grid gap-1.5 text-sm font-medium">Calcular até<Input type="date" value={throughDay} disabled={!enabled} onChange={(event) => { setThroughDay(event.target.value); setPreview(null); }} /></label>
                  <label className="col-span-full flex items-center gap-2 text-sm"><input type="checkbox" checked={requireOfficial} disabled={!enabled} onChange={(event) => { setRequireOfficial(event.target.checked); setPreview(null); }} className="size-4 accent-accent" /> Exigir fonte oficial disponível</label>
                </div>
              )}

              <Button
                variant="primary"
                disabled={!enabled || parameters === null || previewMutation.isPending}
                onClick={() => previewMutation.mutate()}
              >
                {previewMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <SearchCheck className="size-4" />}
                Gerar preview read-only
              </Button>
              {previewMutation.error && <p className="text-sm text-critical-strong">{previewMutation.error.message}</p>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div><CardTitle className="flex items-center gap-2"><ClipboardCheck className="size-4 text-accent" /> Preview e confirmação</CardTitle><CardDescription>O plano é invalidado se o banco, o runtime ou o lock mudar.</CardDescription></div>
          </CardHeader>
          <CardContent>
            {preview === null ? (
              <div className="flex min-h-80 flex-col items-center justify-center text-center"><ShieldCheck className="mb-3 size-8 text-accent" /><h3 className="font-semibold">Nenhum preview ativo</h3><p className="mt-2 max-w-md text-sm leading-6 text-muted">Gerar um preview não cria lock, não chama rede e não escreve na base de evidência.</p></div>
            ) : (
              <div>
                <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{preview.plan.title}</h3><p className="mt-1 text-sm text-muted">{preview.plan.scope}</p></div><Badge tone={preview.impact.lockState === "active" || preview.impact.lockState === "malformed" ? "critical" : "good"}>Lock: {preview.impact.lockState}</Badge></div>
                <dl className="mt-5 grid gap-2 sm:grid-cols-2">{preview.plan.metrics.map((metric) => <div key={metric.label} className="rounded-xl bg-subtle/65 p-3"><dt className="text-xs text-muted">{metric.label}</dt><dd className="mt-1 font-mono text-sm font-semibold">{metric.value}</dd></div>)}</dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge tone={preview.impact.network ? "warning" : "neutral"}>Rede {preview.impact.network ? "sim" : "não"}</Badge>
                  <Badge tone={preview.impact.primaryDatabaseWrites ? "warning" : "neutral"}>DB primário {preview.impact.primaryDatabaseWrites ? "escrita" : "read-only"}</Badge>
                  <Badge tone={preview.impact.filesystemWrites ? "warning" : "neutral"}>Arquivos {preview.impact.filesystemWrites ? "escrita" : "não"}</Badge>
                  <Badge tone={preview.impact.paidModel ? "critical" : "neutral"}>Modelo pago {preview.impact.paidModel ? "sim" : "não"}</Badge>
                </div>
                <ul className="mt-4 space-y-2">{preview.plan.warnings.map((warning) => <li key={warning} className="flex gap-2 rounded-lg bg-warning/5 p-3 text-xs leading-5 text-muted"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />{warning}</li>)}</ul>
                <div className="mt-5 rounded-xl border border-border p-4">
                  <p className="text-xs text-muted">Digite exatamente</p>
                  <code className="mt-2 block select-all rounded-lg bg-code p-3 font-mono text-sm font-semibold text-code-ink">{preview.confirmationPhrase}</code>
                  <Input className="mt-3 w-full" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Frase de confirmação" />
                  {preview.plan.estimatedCostUsd !== null && <label className="mt-3 grid gap-1.5 text-sm font-medium">Autorização exata em USD ({formatUsd(preview.plan.estimatedCostUsd)})<Input type="number" step="0.000001" value={authorizedSpend} onChange={(event) => setAuthorizedSpend(event.target.value)} /></label>}
                  <Button
                    variant="danger"
                    className="mt-4 w-full"
                    disabled={executeMutation.isPending || confirmation !== preview.confirmationPhrase || (preview.plan.estimatedCostUsd !== null && Number(authorizedSpend) !== preview.plan.estimatedCostUsd)}
                    onClick={() => executeMutation.mutate()}
                  >
                    {executeMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                    Confirmar e iniciar uma vez
                  </Button>
                  {executeMutation.error && <p className="mt-3 text-sm text-critical-strong">{executeMutation.error.message}</p>}
                </div>
                <p className="mt-3 font-mono text-[11px] text-muted">Expira {formatDateTime(preview.expiresAt)} · {truncateIdentifier(preview.fingerprint, 12, 8)}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader><div><CardTitle className="flex items-center gap-2"><History className="size-4 text-accent" /> Histórico local</CardTitle><CardDescription>Recibos sanitizados; stdout, stderr, ambiente e logs não são retidos.</CardDescription></div><Badge tone="neutral">{jobs.data.jobs.length} job(s)</Badge></CardHeader>
        <CardContent className="px-2">
          {jobs.data.jobs.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center text-center"><ShieldCheck className="mb-3 size-7 text-accent" /><p className="font-semibold">Nenhuma ação iniciada nesta instalação</p></div>
          ) : (
            <div className="overflow-x-auto"><Table><thead><tr><TableHead>Job</TableHead><TableHead>Ação</TableHead><TableHead>Estado</TableHead><TableHead>Criado</TableHead><TableHead>Resultado</TableHead><TableHead>Recibo</TableHead></tr></thead><tbody>{jobs.data.jobs.map((job) => <tr key={job.id}><TableCell className="font-mono text-xs">{truncateIdentifier(job.id)}</TableCell><TableCell>{actionLabels[job.action]}</TableCell><TableCell><Badge tone={statusTone[job.status]}>{job.status === "started" && <LoaderCircle className="size-3 animate-spin" />}{job.status === "succeeded" && <CheckCircle2 className="size-3" />}{job.status}</Badge></TableCell><TableCell className="text-xs text-muted">{formatDateTime(job.createdAt)}</TableCell><TableCell>{job.result ? <div><p className="text-sm font-medium">{job.result.title}</p><p className="mt-1 text-xs text-muted">{job.result.metrics.map((metric) => `${metric.label}: ${metric.value}`).join(" · ")}</p></div> : "—"}</TableCell><TableCell className="font-mono text-xs">{job.receiptSha256 ? truncateIdentifier(job.receiptSha256) : "—"}</TableCell></tr>)}</tbody></Table></div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
