import { CircleDollarSign, Coins, Network, ReceiptText, ShieldCheck } from "lucide-react";

import { MetricCard } from "../components/metric-card.js";
import { PageError, PageLoading } from "../components/states.js";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EvidenceDialog, PageHeader, ProgressBar, Table, TableCell, TableHead } from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatInteger, formatPercent, formatUsd } from "../lib/utils.js";

export function LimitsPage() {
  const query = api.useLimits();
  if (query.isLoading) return <PageLoading />;
  if (query.error || !query.data) return <PageError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  const limit = data.model.configuredLimitUsd;
  const spentRatio = limit === null ? 0 : data.model.spentUsd / limit;
  const reservedRatio = limit === null ? 0 : data.model.reservedUsd / limit;
  const totalCommitted = data.model.spentUsd + data.model.reservedUsd;
  return (
    <>
      <PageHeader
        eyebrow="Guardrails duráveis"
        title="Limites e custos"
        description="Consumo de rede, referências, replay e modelo. Reservado não é confundido com gasto liquidado; parcial não é confundido com falha."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Gasto do mês" value={formatUsd(data.model.spentUsd)} detail={data.model.month ?? "sem mês de evidência"} icon={CircleDollarSign} />
        <MetricCard label="Reservado" value={formatUsd(data.model.reservedUsd)} detail="compromisso ainda não liquidado" icon={ShieldCheck} />
        <MetricCard label="Limite configurado" value={formatUsd(limit)} detail={limit === null ? "não inferido pelo painel" : `${formatPercent(totalCommitted / limit)} comprometido`} icon={Coins} />
        <MetricCard label="Saldo" value={formatUsd(data.model.remainingUsd)} detail="gasto + reserva são descontados" icon={ReceiptText} />
      </div>

      <Card className="mt-5">
        <CardHeader>
          <div><CardTitle>Compromisso mensal de modelo</CardTitle><CardDescription>Gasto, reserva e saldo ocupam segmentos distintos; valores são operacionais, não fatura do provedor.</CardDescription></div>
          <EvidenceDialog
            source="cost_ledger + model_budget_reservations + configuração local"
            rule="O guard reserva antes da chamada paga; crashes e retries não apagam o compromisso."
            code="src/ops/budget.ts"
            cutoff={data.sourceCutoffAt}
          />
        </CardHeader>
        <CardContent>
          {limit === null ? (
            <div className="rounded-xl border border-warning/25 bg-warning/5 p-4 text-sm text-muted">Nenhum limite mensal foi exposto à sessão do servidor. O painel mostra gasto e reserva sem inventar saldo.</div>
          ) : (
            <>
              <div className="flex h-9 overflow-hidden rounded-lg bg-subtle" role="img" aria-label={`Gasto ${formatUsd(data.model.spentUsd)}, reservado ${formatUsd(data.model.reservedUsd)}, limite ${formatUsd(limit)}`}>
                {spentRatio > 0 && <div className="grid min-w-1 place-items-center bg-accent text-xs font-semibold text-accent-contrast" style={{ width: `${Math.min(1, spentRatio) * 100}%` }}>{spentRatio > 0.12 ? "Gasto" : ""}</div>}
                {reservedRatio > 0 && <div className="grid min-w-1 place-items-center border-l-2 border-surface bg-warning text-xs font-semibold text-white" style={{ width: `${Math.min(1 - Math.min(1, spentRatio), reservedRatio) * 100}%` }}>{reservedRatio > 0.12 ? "Reserva" : ""}</div>}
              </div>
              <div className="mt-3 flex flex-wrap gap-5 text-xs text-muted"><span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-accent" /> Gasto {formatUsd(data.model.spentUsd)}</span><span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-warning" /> Reservado {formatUsd(data.model.reservedUsd)}</span><span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-subtle ring-1 ring-border" /> Saldo {formatUsd(data.model.remainingUsd)}</span></div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader><div><CardTitle className="flex items-center gap-2"><Network className="size-4 text-accent" /> Admissões por varejista</CardTitle><CardDescription>O dia exibido é descoberto do ledger de cada entidade, não fixado no frontend.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          {data.admissions.map((item) => (
            <div key={item.retailerId} className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between gap-3"><div><p className="font-semibold">{item.retailerName}</p><p className="mt-1 text-xs text-muted">{item.day ?? "sem admissões"}</p></div><Badge tone={item.network.remaining === 0 ? "warning" : "neutral"}>{item.network.remaining === 0 ? "Teto de rede atingido" : "Com capacidade"}</Badge></div>
              <div className="mt-5 space-y-4">
                {[
                  { label: "Rede", usage: item.network },
                  { label: "Referências", usage: item.discoveryReferences },
                  { label: "Replay", usage: item.replay },
                ].map(({ label, usage }) => {
                  const ratio = usage.used / usage.limit;
                  return (
                    <div key={label}>
                      <div className="mb-1.5 flex justify-between text-xs"><span className="text-muted">{label}</span><span className="font-mono">{formatInteger(usage.used)} / {formatInteger(usage.limit)}</span></div>
                      <ProgressBar value={ratio} label={`${label} de ${item.retailerName}`} tone={ratio >= 1 ? "warning" : "accent"} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader><div><CardTitle>Custos por categoria</CardTitle><CardDescription>Tokens e custo agregados sem payloads do provedor ou detalhes privados.</CardDescription></div></CardHeader>
        <CardContent className="px-2">
          <div className="overflow-x-auto">
            <Table>
              <thead><tr><TableHead>Categoria</TableHead><TableHead>Eventos</TableHead><TableHead>Input tokens</TableHead><TableHead>Output tokens</TableHead><TableHead className="text-right">Custo</TableHead></tr></thead>
              <tbody>{data.model.byCategory.map((category) => <tr key={category.category}><TableCell className="font-medium">{category.category}</TableCell><TableCell>{formatInteger(category.events)}</TableCell><TableCell>{formatInteger(category.inputTokens)}</TableCell><TableCell>{formatInteger(category.outputTokens)}</TableCell><TableCell className="text-right font-mono">{formatUsd(category.costUsd)}</TableCell></tr>)}</tbody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
