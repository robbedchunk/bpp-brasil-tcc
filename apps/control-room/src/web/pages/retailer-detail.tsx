import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  BadgeCheck,
  Boxes,
  Network,
  PackageCheck,
  RadioTower,
  Store,
} from "lucide-react";

import { RunTable } from "../components/run-table.js";
import { PageError, PageLoading } from "../components/states.js";
import { HealthBadge } from "../components/status.js";
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
  Table,
  TableCell,
  TableHead,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatDateTime, formatInteger, formatPercent, truncateIdentifier } from "../lib/utils.js";

const admissionLabels = {
  network: "Requisições de rede",
  discovery_reference: "Referências de descoberta",
  replay: "Amostras privadas de replay",
} as const;

export function RetailerDetailPage({ retailerId }: { retailerId: string }) {
  const query = api.useRetailer(retailerId);
  if (query.isLoading) return <PageLoading />;
  if (query.error || !query.data) return <PageError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  const retailer = data.retailer;
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
        <Link to="/retailers"><ArrowLeft className="size-4" /> Varejistas</Link>
      </Button>
      <PageHeader
        eyebrow={retailer.id}
        title={retailer.name}
        description={`Operação no CEP ${retailer.cep}: catálogo, admissões, estratégias e histórico recente.`}
        actions={(
          <div className="flex gap-2">
            <Badge tone={retailer.active ? "good" : "neutral"}>{retailer.active ? "Ativo" : "Inativo"}</Badge>
            {retailer.degraded && <Badge tone="critical">Degradado</Badge>}
            {retailer.latestRun && <HealthBadge value={retailer.latestRun.health} />}
          </div>
        )}
      />

      <div className="grid gap-5 xl:grid-cols-[1fr_1.5fr]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2"><Store className="size-4 text-accent" /> Catálogo operacional</CardTitle>
              <CardDescription>Contagens atuais do varejista, não do último snapshot publicado.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3">
              {[
                ["Produtos", retailer.products.total],
                ["Ativos", retailer.products.active],
                ["Em escopo", retailer.products.inScope],
                ["Observados", retailer.products.observed],
                ["Classificados", retailer.products.classified],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-xl bg-subtle/65 p-3.5">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold">{formatInteger(Number(value))}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 rounded-xl border border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-ink">Último snapshot de catálogo</p>
                <Boxes className="size-4 text-muted" />
              </div>
              {retailer.latestCatalogSnapshot ? (
                <>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Badge tone={retailer.latestCatalogSnapshot.complete ? "good" : "warning"}>
                      {retailer.latestCatalogSnapshot.complete ? "Completo" : "Incompleto"}
                    </Badge>
                    <span className="text-xs text-muted">{retailer.latestCatalogSnapshot.completionReason}</span>
                  </div>
                  <p className="mt-3 text-xs leading-5 text-muted">
                    Desaparecidos: {retailer.latestCatalogSnapshot.disappeared === null
                      ? "não avaliados"
                      : formatInteger(retailer.latestCatalogSnapshot.disappeared)}
                  </p>
                  <p className="mt-1 text-xs text-muted">{formatDateTime(retailer.latestCatalogSnapshot.completedAt)}</p>
                </>
              ) : <p className="mt-3 text-sm text-muted">Nenhum snapshot registrado.</p>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2"><Network className="size-4 text-accent" /> Admissões do dia mais recente</CardTitle>
              <CardDescription>Contadores duráveis são cobrados antes da ação protegida e sobrevivem a retries.</CardDescription>
            </div>
            <EvidenceDialog
              source="request_admissions, discovery_reference_admissions e replay_slot_admissions"
              rule="Uso e saldo são calculados para o dia mais recente encontrado para este varejista."
              code="src/db/repositories.ts:267 · :450 · :542"
              cutoff={data.sourceCutoffAt}
            />
          </CardHeader>
          <CardContent className="space-y-5">
            {data.admissions.map((admission) => {
              const ratio = admission.limit === 0 ? 0 : admission.used / admission.limit;
              return (
                <div key={admission.kind}>
                  <div className="mb-2 flex items-end justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-ink">{admissionLabels[admission.kind]}</p>
                      <p className="mt-0.5 text-xs text-muted">Dia {admission.day ?? "sem uso"}</p>
                    </div>
                    <p className="font-mono text-sm"><strong>{formatInteger(admission.used)}</strong><span className="text-muted"> / {formatInteger(admission.limit)}</span></p>
                  </div>
                  <ProgressBar
                    value={ratio}
                    label={`${admissionLabels[admission.kind]} de ${retailer.name}`}
                    tone={ratio >= 1 ? "warning" : ratio >= 0.85 ? "warning" : "accent"}
                  />
                  <p className="mt-1.5 text-right text-xs text-muted">{formatInteger(admission.remaining)} restantes · {formatPercent(ratio)}</p>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2"><BadgeCheck className="size-4 text-accent" /> Estratégias e validação</CardTitle>
            <CardDescription>Proveniência do modelo/configuração, versão, tier e vínculo com evidência assinada.</CardDescription>
          </div>
          <EvidenceDialog
            source="strategies + strategy_validation_evidence"
            rule="Ativo não significa apenas um flag: a estratégia deve estar vinculada à evidência imutável exigida pelo banco."
            code="src/db/database.ts:188 · src/explorer/trusted-validator.ts"
            cutoff={data.sourceCutoffAt}
          />
        </CardHeader>
        <CardContent className="px-2">
          <div className="overflow-x-auto">
            <Table>
              <thead><tr><TableHead>Propósito</TableHead><TableHead>Versão</TableHead><TableHead>Tier</TableHead><TableHead>Proveniência</TableHead><TableHead>Validação</TableHead><TableHead>Estado</TableHead><TableHead>Ativada</TableHead></tr></thead>
              <tbody>
                {data.strategies.map((strategy) => (
                  <tr key={strategy.id} className="hover:bg-subtle/55">
                    <TableCell className="font-medium">{strategy.purpose === "extraction" ? "Extração" : "Descoberta"}</TableCell>
                    <TableCell className="font-mono">v{strategy.version}</TableCell>
                    <TableCell>Tier {strategy.tier}</TableCell>
                    <TableCell>
                      <p className="max-w-48 truncate">{strategy.provenance}</p>
                      {strategy.model && <p className="mt-1 text-xs text-muted">{strategy.model}</p>}
                    </TableCell>
                    <TableCell>
                      <p className="font-mono text-sm">{strategy.validation.valid}/{strategy.validation.attempted}</p>
                      <p className="mt-1 text-xs text-muted">{formatPercent(strategy.validation.score)}</p>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge tone={strategy.active ? "good" : "neutral"}>{strategy.active ? "Ativa" : "Histórica"}</Badge>
                        <Badge tone={strategy.validation.signedEvidence ? "info" : "warning"}>{strategy.validation.signedEvidence ? "Recibo assinado" : "Sem recibo"}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted">{formatDateTime(strategy.activatedAt)}</TableCell>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <div><CardTitle className="flex items-center gap-2"><RadioTower className="size-4 text-accent" /> Execuções recentes</CardTitle><CardDescription>Histórico filtrado para {retailer.name}.</CardDescription></div>
        </CardHeader>
        <CardContent className="px-2">
          {data.recentRuns.length > 0 ? <RunTable runs={data.recentRuns} /> : <p className="p-5 text-sm text-muted">Nenhuma execução registrada.</p>}
        </CardContent>
      </Card>

      {data.stateEvents.length > 0 && (
        <Card className="mt-5">
          <CardHeader><div><CardTitle className="flex items-center gap-2"><PackageCheck className="size-4 text-accent" /> Histórico de estado</CardTitle><CardDescription>Eventos append-only de ativação, degradação ou recuperação.</CardDescription></div></CardHeader>
          <CardContent>
            <ol className="space-y-3">
              {data.stateEvents.map((event, index) => (
                <li key={`${event.effectiveAt}-${index}`} className="flex gap-4 rounded-xl border border-border p-4">
                  <div className="mt-1 size-2.5 shrink-0 rounded-full bg-accent" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{event.state}</Badge>{event.purpose && <span className="text-xs text-muted">{event.purpose}</span>}</div>
                    <p className="mt-2 text-sm text-ink">{event.reason}</p>
                    <p className="mt-1 font-mono text-xs text-muted">{event.source} · {formatDateTime(event.effectiveAt)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
      <p className="mt-5 text-right font-mono text-[11px] text-muted">ID {truncateIdentifier(retailer.id, 24, 8)}</p>
    </>
  );
}
