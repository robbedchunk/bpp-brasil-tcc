import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  PackageSearch,
  Store,
} from "lucide-react";

import { MetricCard } from "../components/metric-card.js";
import { PipelineMap } from "../components/pipeline-map.js";
import { RunTable } from "../components/run-table.js";
import { EmptyState, PageError, PageLoading } from "../components/states.js";
import { HealthBadge, LifecycleBadge } from "../components/status.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EvidenceDialog,
  PageHeader,
  ProgressBar,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatDateTime, formatInteger, formatPercent, relativeTime } from "../lib/utils.js";

const severityStyles = {
  critical: "border-critical/30 bg-critical/5 text-critical-strong",
  warning: "border-warning/30 bg-warning/5 text-warning-strong",
  info: "border-info/30 bg-info/5 text-info-strong",
} as const;

export function ControlRoomPage() {
  const query = api.useOverview();
  if (query.isLoading) return <PageLoading />;
  if (query.error || !query.data) return <PageError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;

  if (data.totals.retailers === 0) {
    return (
      <>
        <PageHeader
          eyebrow="Visão operacional"
          title="Control Room"
          description="O banco foi inicializado, mas ainda não contém varejistas. O painel não injeta dados de demonstração: ele será preenchido pela própria operação deste fork."
        />
        <EmptyState
          title="Operação ainda não registrada"
          description="Carregue a referência IPCA, registre configurações de varejistas e ative estratégias validadas. Assim que o banco receber evidência, esta tela muda automaticamente."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Visão operacional"
        title="Control Room"
        description="Estado ao vivo do pipeline de preços: o que está funcionando, o que requer atenção e qual evidência sustenta cada leitura."
        actions={(
          <Button asChild variant="primary">
            <Link to="/runs">Ver execuções <ArrowUpRight className="size-4" /></Link>
          </Button>
        )}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Varejistas ativos"
          value={formatInteger(data.totals.activeRetailers)}
          detail={`${data.totals.degradedRetailers} degradado(s)`}
          icon={Store}
          footer={`${formatInteger(data.totals.retailers)} registrado(s) no banco`}
        />
        <MetricCard
          label="Observações"
          value={formatInteger(data.totals.observations)}
          detail={`${formatInteger(data.totals.products)} produtos conhecidos`}
          icon={Database}
          footer={`Corte ${formatDateTime(data.sourceCutoffAt)}`}
        />
        <MetricCard
          label="Classificação pendente"
          value={formatInteger(data.totals.pendingClassification)}
          detail="produtos elegíveis sem decisão na versão atual"
          icon={PackageSearch}
          footer="A coleta continua determinística sem o provedor de modelo"
        />
        <MetricCard
          label="Healing aberto"
          value={formatInteger(data.totals.openHealingEvents)}
          detail="eventos ainda não recuperados ou encerrados"
          icon={Bot}
          footer="Ativação continua sujeita à validação assinada 27/30"
        />
      </div>

      <Card className="mt-5">
        <CardHeader>
          <div>
            <CardTitle>Mapa vivo do pipeline</CardTitle>
            <CardDescription>Cada etapa deriva seu estado do banco deste fork; a seta de feedback só abre após evidência de drift.</CardDescription>
          </div>
          <EvidenceDialog
            source="SQLite operacional, heartbeats e estados de estratégias"
            rule="A topologia é fixa; estados, contagens e alertas são consultados dinamicamente."
            code="src/pipeline · src/healing · src/index"
            cutoff={data.sourceCutoffAt}
          />
        </CardHeader>
        <CardContent><PipelineMap stages={data.pipeline} /></CardContent>
      </Card>

      <div className="mt-5 grid gap-5 xl:grid-cols-[0.85fr_1.65fr]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Fila de atenção</CardTitle>
              <CardDescription>Bloqueios e degradações aparecem antes de trabalho pendente.</CardDescription>
            </div>
            <Badge tone={data.attention.length > 0 ? "warning" : "good"}>
              {data.attention.length > 0 ? <AlertTriangle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
              {formatInteger(data.attention.length)} item(ns)
            </Badge>
          </CardHeader>
          <CardContent>
            {data.attention.length === 0 ? (
              <div className="rounded-xl border border-good/25 bg-good/5 p-5 text-sm text-good-strong">
                <div className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4" /> Nenhuma condição prioritária</div>
                <p className="mt-2 leading-6 text-muted">Isso não é um “score”: apenas significa que as regras conhecidas não abriram atenção agora.</p>
              </div>
            ) : (
              <ul className="space-y-3">
                {data.attention.map((item) => (
                  <li key={item.id}>
                    <Link
                      to={item.route}
                      className={`block rounded-xl border p-4 transition hover:-translate-y-0.5 hover:shadow-card ${severityStyles[item.severity]}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-ink">{item.title}</p>
                          <p className="mt-1.5 text-xs leading-5 text-muted">{item.detail}</p>
                        </div>
                        <ArrowUpRight className="mt-0.5 size-4 shrink-0" />
                      </div>
                      {item.occurredAt && <p className="mt-2 text-[11px] text-muted">{relativeTime(item.occurredAt)}</p>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Matriz de varejistas</CardTitle>
              <CardDescription>Última coleta, cobertura do catálogo e classificação por entidade descoberta no banco.</CardDescription>
            </div>
            <EvidenceDialog
              source="retailers, products, runs e catalog_snapshots"
              rule="Parcial descreve o ciclo; saúde é calculada separadamente pelo limiar e pelas categorias de falha."
              code="src/healing/classify-failure.ts:43"
              cutoff={data.sourceCutoffAt}
            />
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {data.retailers.map((retailer) => {
              const classificationRate = retailer.products.inScope === 0
                ? 0
                : retailer.products.classified / retailer.products.inScope;
              return (
                <Link
                  key={retailer.id}
                  to="/retailers/$retailerId"
                  params={{ retailerId: retailer.id }}
                  className="rounded-xl border border-border bg-canvas/45 p-4 transition hover:border-accent/35 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-ink">{retailer.name}</p>
                      <p className="mt-1 text-xs text-muted">{retailer.active ? "Ativo" : "Inativo"} · CEP {retailer.cep}</p>
                    </div>
                    {retailer.latestRun ? <HealthBadge value={retailer.latestRun.health} /> : <Badge tone="neutral">Sem coleta</Badge>}
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                    <div><p className="text-muted">Em escopo</p><p className="mt-1 font-mono font-semibold text-ink">{formatInteger(retailer.products.inScope)}</p></div>
                    <div><p className="text-muted">Observados</p><p className="mt-1 font-mono font-semibold text-ink">{formatInteger(retailer.products.observed)}</p></div>
                    <div><p className="text-muted">Classificados</p><p className="mt-1 font-mono font-semibold text-ink">{formatInteger(retailer.products.classified)}</p></div>
                  </div>
                  <div className="mt-4">
                    <div className="mb-1.5 flex justify-between text-[11px] text-muted">
                      <span>Cobertura de classificação</span><span>{formatPercent(classificationRate)}</span>
                    </div>
                    <ProgressBar value={classificationRate} label={`Classificação de ${retailer.name}`} />
                  </div>
                  {retailer.latestRun && (
                    <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                      <LifecycleBadge value={retailer.latestRun.lifecycle} />
                      <span className="text-xs tabular-nums text-muted">{formatInteger(retailer.latestRun.ok)}/{formatInteger(retailer.latestRun.attempted)} OK</span>
                    </div>
                  )}
                </Link>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.7fr_0.7fr]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Execuções recentes</CardTitle>
              <CardDescription>O ciclo, a saúde e o limitador permanecem dimensões independentes.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm"><Link to="/runs">Todas <ArrowUpRight className="size-4" /></Link></Button>
          </CardHeader>
          <CardContent className="px-2"><RunTable runs={data.recentRuns} compact /></CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Coleta agendada</CardTitle>
              <CardDescription>Somente provenance `systemd-timer` satisfaz esta leitura.</CardDescription>
            </div>
            <Clock3 className="size-5 text-muted" />
          </CardHeader>
          <CardContent>
            <Badge tone={data.scheduledHeartbeat.status === "fresh" ? "good" : data.scheduledHeartbeat.status === "stale" ? "warning" : "critical"}>
              {data.scheduledHeartbeat.status === "fresh" ? "Fresca" : data.scheduledHeartbeat.status === "stale" ? "Atrasada" : "Ausente"}
            </Badge>
            <p className="mt-4 text-2xl font-semibold text-ink">{relativeTime(data.scheduledHeartbeat.completedAt)}</p>
            <p className="mt-1 text-xs text-muted">{formatDateTime(data.scheduledHeartbeat.completedAt)}</p>
            <dl className="mt-5 grid gap-3 border-t border-border pt-4 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted">Varejistas</dt><dd className="font-mono text-ink">{data.scheduledHeartbeat.retailerCount ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Falhas de orquestração</dt><dd className="font-mono text-ink">{data.scheduledHeartbeat.failedRetailerCount ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Release</dt><dd className="max-w-36 truncate font-mono text-xs text-ink">{data.scheduledHeartbeat.releaseId ?? "—"}</dd></div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
