import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Boxes, CheckCircle2, Store, Tags } from "lucide-react";

import { EmptyState, PageError, PageLoading } from "../components/states.js";
import { HealthBadge, LifecycleBadge } from "../components/status.js";
import {
  Badge,
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
import { formatDateTime, formatInteger, formatPercent } from "../lib/utils.js";

export function RetailersPage() {
  const query = api.useRetailers();
  if (query.isLoading) return <PageLoading />;
  if (query.error || !query.data) return <PageError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  return (
    <>
      <PageHeader
        eyebrow="Painel de entidades"
        title="Varejistas"
        description="Registro operacional, catálogo, estratégia e última evidência de coleta para cada varejista encontrado no banco."
      />
      {data.retailers.length === 0 ? (
        <EmptyState
          title="Nenhum varejista registrado"
          description="Esta instância não usa uma lista compilada no frontend. Registre os varejistas do fork e eles aparecerão automaticamente."
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
          {data.retailers.map((retailer) => {
            const observedRate = retailer.products.inScope === 0 ? 0 : retailer.products.observed / retailer.products.inScope;
            const classifiedRate = retailer.products.inScope === 0 ? 0 : retailer.products.classified / retailer.products.inScope;
            return (
              <Card key={retailer.id} className="transition hover:border-accent/30 hover:shadow-card">
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <div className="grid size-10 place-items-center rounded-xl bg-accent/10 text-accent"><Store className="size-5" /></div>
                    <div>
                      <CardTitle className="text-base">{retailer.name}</CardTitle>
                      <CardDescription>{retailer.id} · CEP {retailer.cep}</CardDescription>
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Badge tone={retailer.active ? "good" : "neutral"}>{retailer.active ? "Ativo" : "Inativo"}</Badge>
                    {retailer.degraded && <Badge tone="critical">Degradado</Badge>}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-xl bg-subtle/65 p-3"><p className="text-[11px] text-muted">Produtos</p><p className="mt-1 font-mono text-lg font-semibold">{formatInteger(retailer.products.total)}</p></div>
                    <div className="rounded-xl bg-subtle/65 p-3"><p className="text-[11px] text-muted">Em escopo</p><p className="mt-1 font-mono text-lg font-semibold">{formatInteger(retailer.products.inScope)}</p></div>
                    <div className="rounded-xl bg-subtle/65 p-3"><p className="text-[11px] text-muted">Observados</p><p className="mt-1 font-mono text-lg font-semibold">{formatInteger(retailer.products.observed)}</p></div>
                    <div className="rounded-xl bg-subtle/65 p-3"><p className="text-[11px] text-muted">Classificados</p><p className="mt-1 font-mono text-lg font-semibold">{formatInteger(retailer.products.classified)}</p></div>
                  </div>

                  <div className="mt-5 space-y-4">
                    <div>
                      <div className="mb-1.5 flex justify-between text-xs"><span className="text-muted">Observação do escopo</span><span>{formatPercent(observedRate)}</span></div>
                      <ProgressBar value={observedRate} label={`Observação de ${retailer.name}`} tone="good" />
                    </div>
                    <div>
                      <div className="mb-1.5 flex justify-between text-xs"><span className="text-muted">Classificação do escopo</span><span>{formatPercent(classifiedRate)}</span></div>
                      <ProgressBar value={classifiedRate} label={`Classificação de ${retailer.name}`} />
                    </div>
                  </div>

                  <div className="mt-5 rounded-xl border border-border p-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Última coleta</p>
                      {retailer.latestRun && <HealthBadge value={retailer.latestRun.health} />}
                    </div>
                    {retailer.latestRun ? (
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="font-mono text-sm font-semibold">{formatInteger(retailer.latestRun.ok)} / {formatInteger(retailer.latestRun.attempted)} OK</p>
                          <p className="mt-1 text-xs text-muted">{formatDateTime(retailer.latestRun.finishedAt)}</p>
                        </div>
                        <LifecycleBadge value={retailer.latestRun.lifecycle} />
                      </div>
                    ) : <p className="mt-3 text-sm text-muted">Ainda não existe evidência de coleta.</p>}
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      {retailer.latestCatalogSnapshot?.complete
                        ? <CheckCircle2 className="size-4 text-good" />
                        : <Boxes className="size-4 text-warning" />}
                      {retailer.latestCatalogSnapshot === null
                        ? "Sem snapshot de catálogo"
                        : retailer.latestCatalogSnapshot.complete
                          ? "Catálogo completo"
                          : "Catálogo incompleto"}
                    </span>
                    <Link
                      to="/retailers/$retailerId"
                      params={{ retailerId: retailer.id }}
                      className="inline-flex items-center gap-1 font-semibold text-accent hover:underline"
                    >
                      Abrir <ArrowUpRight className="size-3.5" />
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <Card className="mt-5">
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2"><Tags className="size-4 text-accent" /> Sem cadastro no frontend</CardTitle>
            <CardDescription>Nome, estado, CEP e métricas vêm das tabelas operacionais. Adicionar um varejista não exige alterar esta aplicação.</CardDescription>
          </div>
          <EvidenceDialog
            source="retailers, products, runs e catalog_snapshots"
            rule="Varejistas são enumerados por consulta e ordenados por nome; nenhum ID conhecido é compilado no bundle."
            code="apps/control-room/src/server/read-model/queries.ts"
            cutoff={data.sourceCutoffAt}
          />
        </CardHeader>
      </Card>
    </>
  );
}
