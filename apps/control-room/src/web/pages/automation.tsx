import { BadgeCheck, Bot, BrainCircuit, FlaskConical, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";

import { MetricCard } from "../components/metric-card.js";
import { PageError, PageLoading } from "../components/states.js";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EvidenceDialog, PageHeader, ProgressBar, Table, TableCell, TableHead } from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatDateTime, formatInteger, formatPercent, formatUsd, truncateIdentifier } from "../lib/utils.js";

export function AutomationPage() {
  const query = api.useAutomation();
  const [showHistoricalStrategies, setShowHistoricalStrategies] = useState(false);
  if (query.isLoading) return <PageLoading />;
  if (query.error || !query.data) return <PageError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  const classification = data.classification;
  const visibleStrategies = showHistoricalStrategies
    ? data.strategies
    : data.strategies.filter((strategy) => strategy.active);
  const completion = classification.eligible === 0
    ? 0
    : (classification.assigned + classification.excluded) / classification.eligible;
  return (
    <>
      <PageHeader
        eyebrow="LLM fora do hot path"
        title="Automação e validação"
        description="Classificação, exploração, healing e estratégias — com a fronteira entre proposta do modelo, validação externa e execução determinística visível."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Elegíveis" value={formatInteger(classification.eligible)} detail={`versão ${classification.latestVersion ?? "ainda ausente"}`} icon={BrainCircuit} />
        <MetricCard label="Atribuídos" value={formatInteger(classification.assigned)} detail={formatPercent(classification.eligible === 0 ? 0 : classification.assigned / classification.eligible)} icon={BadgeCheck} />
        <MetricCard label="Excluídos da medição" value={formatInteger(classification.excluded)} detail="decisões explícitas de escopo estreito" icon={ShieldCheck} />
        <MetricCard label="Quarentena" value={formatInteger(classification.quarantinedProducts)} detail={`${formatInteger(classification.shapeFailures)} falha(s) de shape registradas`} icon={FlaskConical} />
      </div>

      <Card className="mt-5">
        <CardHeader>
          <div><CardTitle>Cobertura de classificação por varejista</CardTitle><CardDescription>Atribuídos, excluídos e pendentes permanecem categorias diferentes.</CardDescription></div>
          <EvidenceDialog
            source="products, classifications e classification_scope_decisions"
            rule="Pendente significa elegível sem qualquer evidência na versão corrente; exclusão requer decisão append-only explícita."
            code="src/classify/classify.ts · src/classify/measurement-scope.ts"
            cutoff={data.sourceCutoffAt}
          />
        </CardHeader>
        <CardContent>
          <div className="mb-6">
            <div className="mb-2 flex items-center justify-between text-sm"><span className="font-semibold">Conclusão global da fila</span><span>{formatPercent(completion)}</span></div>
            <ProgressBar value={completion} label="Conclusão global da classificação" tone={completion >= 0.9 ? "good" : "accent"} className="h-3" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {classification.byRetailer.map((retailer) => {
              const done = retailer.eligible === 0 ? 0 : (retailer.assigned + retailer.excluded) / retailer.eligible;
              return (
                <div key={retailer.retailerId} className="rounded-xl border border-border p-4">
                  <div className="flex items-center justify-between gap-3"><p className="font-semibold">{retailer.retailerName}</p><span className="font-mono text-sm text-muted">{formatPercent(done)}</span></div>
                  <ProgressBar value={done} label={`Classificação de ${retailer.retailerName}`} className="mt-3" />
                  <dl className="mt-4 grid grid-cols-4 gap-2 text-center text-xs">
                    <div><dt className="text-muted">Elegíveis</dt><dd className="mt-1 font-mono font-semibold">{formatInteger(retailer.eligible)}</dd></div>
                    <div><dt className="text-muted">Atribuídos</dt><dd className="mt-1 font-mono font-semibold text-good-strong">{formatInteger(retailer.assigned)}</dd></div>
                    <div><dt className="text-muted">Excluídos</dt><dd className="mt-1 font-mono font-semibold text-info-strong">{formatInteger(retailer.excluded)}</dd></div>
                    <div><dt className="text-muted">Pendentes</dt><dd className="mt-1 font-mono font-semibold text-warning-strong">{formatInteger(retailer.pending)}</dd></div>
                  </dl>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <div><CardTitle className="flex items-center gap-2"><Sparkles className="size-4 text-accent" /> Estratégias</CardTitle><CardDescription>O modelo pode gerar; somente a validação confiável pode autorizar ativação.</CardDescription></div>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowHistoricalStrategies((value) => !value)}
              aria-pressed={showHistoricalStrategies}
            >
              {showHistoricalStrategies ? "Mostrar somente ativas" : `Incluir históricas (${data.strategies.length})`}
            </Button>
            <EvidenceDialog
              source="strategies + strategy_validation_evidence"
              rule="Uma estratégia ativa deve ter amostra 30, pelo menos 27 válidas, score ≥ 0,9 e recibo assinado vinculado ao registro exato."
              code="src/db/database.ts:188 · src/strategies/validation-evidence.ts"
              cutoff={data.sourceCutoffAt}
            />
          </div>
        </CardHeader>
        <CardContent className="px-2">
          <div className="overflow-x-auto">
            <Table>
              <thead><tr><TableHead>Varejista</TableHead><TableHead>Propósito</TableHead><TableHead>Versão / tier</TableHead><TableHead>Proveniência</TableHead><TableHead>Validação</TableHead><TableHead>Vínculo</TableHead><TableHead>Estado</TableHead></tr></thead>
              <tbody>
                {visibleStrategies.map((strategy) => {
                  const retailer = classification.byRetailer.find(({ retailerId }) => retailerId === strategy.retailerId);
                  return (
                    <tr key={strategy.id} className="hover:bg-subtle/55">
                      <TableCell className="font-medium">{retailer?.retailerName ?? strategy.retailerId}</TableCell>
                      <TableCell>{strategy.purpose === "extraction" ? "Extração" : "Descoberta"}</TableCell>
                      <TableCell className="font-mono">v{strategy.version} · T{strategy.tier}</TableCell>
                      <TableCell><p>{strategy.provenance}</p>{strategy.model && <p className="mt-1 text-xs text-muted">{strategy.model}</p>}</TableCell>
                      <TableCell><p className="font-mono">{strategy.validation.valid}/{strategy.validation.attempted}</p><p className="mt-1 text-xs text-muted">{formatPercent(strategy.validation.score)}</p></TableCell>
                      <TableCell><Badge tone={strategy.validation.signedEvidence ? "good" : "warning"}>{strategy.validation.signedEvidence ? "Assinado" : "Ausente"}</Badge></TableCell>
                      <TableCell><Badge tone={strategy.active ? "info" : "neutral"}>{strategy.active ? "Em produção" : "Histórica"}</Badge></TableCell>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><Bot className="size-4 text-accent" /> Eventos de healing</CardTitle><CardDescription>Falha e recuperação são preservadas com a mesma visibilidade.</CardDescription></div></CardHeader>
          <CardContent>
            {data.healingEvents.length === 0 ? <p className="py-12 text-center text-sm text-muted">Nenhum evento de healing registrado.</p> : (
              <ol className="space-y-3">
                {data.healingEvents.map((event) => (
                  <li key={event.id} className="rounded-xl border border-border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div><p className="font-semibold">{event.retailerName}</p><p className="mt-1 text-xs text-muted">{event.purpose} · {event.category}</p></div>
                      <Badge tone={event.status === "recovered" ? "good" : event.status === "failed" ? "critical" : "warning"}>{event.status}</Badge>
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                      <div><p className="text-muted">Tentativas</p><p className="mt-1 font-mono font-semibold">{event.attempts}</p></div>
                      <div><p className="text-muted">Tier</p><p className="mt-1 font-mono font-semibold">{event.tierFrom ?? "—"} → {event.tierTo ?? "—"}</p></div>
                      <div><p className="text-muted">Duração</p><p className="mt-1 font-mono font-semibold">{event.durationSeconds === null ? "—" : `${event.durationSeconds}s`}</p></div>
                    </div>
                    <p className="mt-3 text-[11px] text-muted">Detectado {formatDateTime(event.detectedAt)}</p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><Bot className="size-4 text-accent" /> Explorações</CardTitle><CardDescription>Tentativas, resultado e custo — inclusive quando nenhuma estratégia ativa.</CardDescription></div></CardHeader>
          <CardContent className="px-2">
            {data.explorations.length === 0 ? <p className="py-12 text-center text-sm text-muted">Nenhuma exploração registrada.</p> : (
              <div className="overflow-x-auto">
                <Table>
                  <thead><tr><TableHead>Execução</TableHead><TableHead>Varejista</TableHead><TableHead>Resultado</TableHead><TableHead>Eventos</TableHead><TableHead>Custo</TableHead><TableHead>Início</TableHead></tr></thead>
                  <tbody>{data.explorations.map((item) => <tr key={item.id}><TableCell className="font-mono text-xs">{truncateIdentifier(item.id)}</TableCell><TableCell>{item.retailerName}</TableCell><TableCell><Badge tone={item.status === "completed" && item.outcome === "activated" ? "good" : item.status === "failed" ? "critical" : "neutral"}>{item.outcome ?? item.status}</Badge></TableCell><TableCell>{formatInteger(item.eventsUsed)}</TableCell><TableCell>{formatUsd(item.costUsd)}</TableCell><TableCell className="text-xs text-muted">{formatDateTime(item.startedAt)}</TableCell></tr>)}</tbody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {(classification.reservations.length > 0 || classification.batchJobs.length > 0) && (
        <Card className="mt-5">
          <CardHeader><div><CardTitle>Trabalho de classificação</CardTitle><CardDescription>Reservas síncronas e jobs remotos mantêm custo projetado e realizado separados.</CardDescription></div></CardHeader>
          <CardContent className="grid gap-4 xl:grid-cols-2">
            <div><h3 className="mb-3 text-sm font-semibold">Reservas</h3>{classification.reservations.map((reservation) => <div key={reservation.id} className="mb-2 rounded-xl border border-border p-3 text-sm"><div className="flex justify-between gap-3"><span className="font-mono text-xs">{truncateIdentifier(reservation.id)}</span><Badge tone="neutral">{reservation.status}</Badge></div><p className="mt-2 text-xs text-muted">{reservation.model} · projetado {formatUsd(reservation.projectedCostUsd)} · real {formatUsd(reservation.actualCostUsd)}</p></div>)}</div>
            <div><h3 className="mb-3 text-sm font-semibold">Batch jobs</h3>{classification.batchJobs.length === 0 ? <p className="text-sm text-muted">Nenhum job remoto.</p> : classification.batchJobs.map((job) => <div key={job.id} className="mb-2 rounded-xl border border-border p-3 text-sm"><div className="flex justify-between gap-3"><span className="font-mono text-xs">{truncateIdentifier(job.id)}</span><Badge tone="neutral">{job.status}</Badge></div><p className="mt-2 text-xs text-muted">{job.completedItems}/{job.totalItems} completos · {job.failedItems} falhos</p></div>)}</div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
