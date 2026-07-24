import { Link } from "@tanstack/react-router";
import { ArrowLeft, CalendarDays, CheckCircle2, PackageOpen, Percent, TimerReset, TriangleAlert } from "lucide-react";

import { PageError, PageLoading } from "../components/states.js";
import { ConstraintBadge, HealthBadge, LifecycleBadge } from "../components/status.js";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EvidenceDialog, PageHeader, ProgressBar, Table, TableCell, TableHead } from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatDateTime, formatDay, formatInteger, formatPercent, truncateIdentifier } from "../lib/utils.js";

export function RunDetailPage({ runId }: { runId: string }) {
  const query = api.useRun(runId);
  if (query.isLoading) return <PageLoading />;
  if (query.error || !query.data) return <PageError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  const run = data.run;
  const skipped = run.skipped ?? Math.max(0, (run.planned ?? run.attempted) - run.attempted);
  const totalPlan = Math.max(1, run.planned ?? run.attempted + skipped);
  const okRatio = run.ok / totalPlan;
  const failedRatio = run.failed / totalPlan;
  const skippedRatio = skipped / totalPlan;
  const maximumFailure = Math.max(1, ...data.failureCategories.map(({ count }) => count));
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2"><Link to="/runs"><ArrowLeft className="size-4" /> Execuções</Link></Button>
      <PageHeader
        eyebrow={`${run.stage === "collect" ? "Coleta" : "Descoberta"} · ${formatDay(run.collectionDay)}`}
        title={run.retailerName}
        description={`Execução ${truncateIdentifier(run.id, 18, 8)} — evidência operacional sem mensagens, URLs ou conteúdo de replay.`}
        actions={<div className="flex flex-wrap gap-2"><LifecycleBadge value={run.lifecycle} /><HealthBadge value={run.health} /><ConstraintBadge value={run.constraint} /></div>}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Tentativas", value: formatInteger(run.attempted), icon: TimerReset, detail: `planejadas ${run.planned ?? "—"}` },
          { label: "Válidas", value: formatInteger(run.ok), icon: CheckCircle2, detail: formatPercent(run.successRate) },
          { label: "Falhas", value: formatInteger(run.failed), icon: TriangleAlert, detail: run.dominantFailureCategory ?? "sem categoria dominante" },
          { label: "Dia de coleta", value: formatDay(run.collectionDay), icon: CalendarDays, detail: formatDateTime(run.finishedAt) },
        ].map((item) => (
          <Card key={item.label}><CardContent className="pt-5"><div className="flex justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-muted">{item.label}</p><p className="mt-3 text-2xl font-semibold">{item.value}</p><p className="mt-1 text-xs text-muted">{item.detail}</p></div><item.icon className="size-5 text-accent" /></div></CardContent></Card>
        ))}
      </div>

      <Card className="mt-5">
        <CardHeader>
          <div><CardTitle>Composição do plano</CardTitle><CardDescription>Sucesso, falha e trabalho não tentado são mostrados separadamente.</CardDescription></div>
          <EvidenceDialog
            source="runs.metadata_json e contadores persistidos"
            rule="planned, attempted, ok, failed e skipped nunca são fundidos em uma única taxa."
            code="src/pipeline/collect.ts"
            cutoff={data.sourceCutoffAt}
          />
        </CardHeader>
        <CardContent>
          <div className="flex h-8 overflow-hidden rounded-lg bg-subtle" role="img" aria-label={`${run.ok} válidas, ${run.failed} falhas e ${skipped} ignoradas`}>
            {okRatio > 0 && <div className="grid min-w-1 place-items-center bg-good text-xs font-semibold text-white" style={{ width: `${okRatio * 100}%` }}>{okRatio > 0.12 ? formatInteger(run.ok) : ""}</div>}
            {failedRatio > 0 && <div className="grid min-w-1 place-items-center border-l-2 border-surface bg-critical text-xs font-semibold text-white" style={{ width: `${failedRatio * 100}%` }}>{failedRatio > 0.08 ? formatInteger(run.failed) : ""}</div>}
            {skippedRatio > 0 && <div className="grid min-w-1 place-items-center border-l-2 border-surface bg-muted text-xs font-semibold text-white" style={{ width: `${skippedRatio * 100}%` }}>{skippedRatio > 0.1 ? formatInteger(skipped) : ""}</div>}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-good" /> Válidas {formatInteger(run.ok)}</span>
            <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-critical" /> Falhas {formatInteger(run.failed)}</span>
            <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-muted" /> Não tentadas {formatInteger(skipped)}</span>
          </div>
        </CardContent>
      </Card>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
        <Card>
          <CardHeader>
            <div><CardTitle>Categorias de falha</CardTitle><CardDescription>Agregado seguro; mensagens e referências privadas não atravessam a API.</CardDescription></div>
          </CardHeader>
          <CardContent>
            {data.failureCategories.length === 0 ? <p className="py-10 text-center text-sm text-muted">Nenhuma falha persistida.</p> : (
              <div className="space-y-4">
                {data.failureCategories.map((failure) => (
                  <div key={`${failure.category}-${failure.responded}`}>
                    <div className="mb-1.5 flex items-center justify-between gap-3 text-sm"><span className="font-medium">{failure.category}</span><span className="font-mono text-muted">{formatInteger(failure.count)}</span></div>
                    <ProgressBar value={failure.count / maximumFailure} label={`${failure.category}: ${failure.count}`} tone="warning" />
                    <p className="mt-1 text-[11px] text-muted">{failure.responded ? "Houve resposta do varejista" : "Sem resposta utilizável"}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><PackageOpen className="size-4 text-accent" /> Observações</CardTitle><CardDescription>Somente contagens sanitizadas desta execução.</CardDescription></div></CardHeader>
          <CardContent>
            <dl className="space-y-3">
              <div className="flex justify-between rounded-xl bg-subtle/65 p-3"><dt className="text-sm text-muted">Persistidas</dt><dd className="font-mono font-semibold">{formatInteger(data.observations.total)}</dd></div>
              <div className="flex justify-between rounded-xl bg-subtle/65 p-3"><dt className="text-sm text-muted">Disponíveis</dt><dd className="font-mono font-semibold">{formatInteger(data.observations.available)}</dd></div>
              <div className="flex justify-between rounded-xl bg-subtle/65 p-3"><dt className="text-sm text-muted">Promocionais</dt><dd className="font-mono font-semibold">{formatInteger(data.observations.promotional)}</dd></div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              {run.reconciled && <Badge tone="info">Reconciliada após interrupção</Badge>}
              <Badge tone="neutral">Estratégia v{run.strategyVersion ?? "—"}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {data.catalogSnapshot && (
        <Card className="mt-5">
          <CardHeader><div><CardTitle>Snapshot de catálogo associado</CardTitle><CardDescription>Desaparecimento só é interpretado quando o snapshot é comprovadamente completo.</CardDescription></div></CardHeader>
          <CardContent className="px-2">
            <Table>
              <thead><tr><TableHead>Estado</TableHead><TableHead>Motivo</TableHead><TableHead>Descobertos</TableHead><TableHead>Em escopo</TableHead><TableHead>Fora</TableHead><TableHead>Desaparecidos</TableHead></tr></thead>
              <tbody><tr><TableCell><Badge tone={data.catalogSnapshot.complete ? "good" : "warning"}>{data.catalogSnapshot.complete ? "Completo" : "Incompleto"}</Badge></TableCell><TableCell>{data.catalogSnapshot.completionReason}</TableCell><TableCell>{formatInteger(data.catalogSnapshot.discovered)}</TableCell><TableCell>{formatInteger(data.catalogSnapshot.inScope)}</TableCell><TableCell>{formatInteger(data.catalogSnapshot.outOfScope)}</TableCell><TableCell>{data.catalogSnapshot.disappeared === null ? "Não avaliado" : formatInteger(data.catalogSnapshot.disappeared)}</TableCell></tr></tbody>
            </Table>
          </CardContent>
        </Card>
      )}
      <p className="mt-5 flex items-center justify-end gap-2 font-mono text-[11px] text-muted"><Percent className="size-3" /> ID {run.id}</p>
    </>
  );
}
