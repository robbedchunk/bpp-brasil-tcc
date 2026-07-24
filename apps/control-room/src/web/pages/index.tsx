import { AlertTriangle, Archive, ChartNoAxesCombined, FileCheck2, Scale } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { ChartFrame } from "../components/chart-frame.js";
import { MetricCard } from "../components/metric-card.js";
import { PageError, PageLoading } from "../components/states.js";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EvidenceDialog, PageHeader, Table, TableCell, TableHead } from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatDateTime, formatDay, formatInteger, formatPercent } from "../lib/utils.js";

function decimal(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function IndexPage() {
  const index = api.useIndex();
  const artifacts = api.useArtifacts();
  if (index.isLoading) return <PageLoading label="Calculando a série experimental sobre uma fotografia read-only…" />;
  if (index.error || !index.data) return <PageError error={index.error} retry={() => void index.refetch()} />;
  const data = index.data;
  const segments = [...new Set(data.aggregate.map(({ chainSegment }) => chainSegment))];
  const indexChart = data.aggregate.map((point) => ({
    day: point.day,
    [`segment-${point.chainSegment}`]: decimal(point.indexLevel),
  }));
  const coverageChart = data.coverage.map((point) => {
    const coverage = decimal(point.coverageFraction);
    return { day: point.day, coverage: coverage === null ? null : coverage * 100 };
  });
  const latest = data.aggregate.at(-1);
  return (
    <>
      <PageHeader
        eyebrow="Artefato experimental"
        title="Índice e evidência"
        description="Cálculo ao vivo sobre SQLite e metadados do último snapshot imutável permanecem visões separadas. Lacunas e quebras de cadeia nunca são interpoladas."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Estado ao vivo" value={data.status === "complete" ? "Com movimento" : "Sem movimento"} detail={data.methodVersion} icon={ChartNoAxesCombined} />
        <MetricCard label="Pontos de movimento" value={formatInteger(data.movementPoints)} detail={`${formatInteger(data.aggregate.length)} dias agregados`} icon={Scale} />
        <MetricCard label="Nível mais recente" value={latest?.indexLevel ?? "—"} detail={latest ? formatDay(latest.day) : "sem dia calculável"} icon={ChartNoAxesCombined} />
        <MetricCard label="Cobertura mais recente" value={latest ? formatPercent(Number(latest.coverageFraction)) : "—"} detail={latest ? `${formatInteger(latest.coveredSubitemCount)} subitens` : "sem cobertura"} icon={FileCheck2} />
      </div>

      <div className="mt-5 grid gap-5">
        <ChartFrame
          title="Nível do índice experimental"
          description="Uma linha por segmento de cadeia, usando a mesma identidade visual. Nenhuma linha atravessa uma lacuna."
          source="buildDailyIndex() sobre a fotografia read-only do SQLite"
          rule="Preço promocional positivo é preferido; relativos são agregados por Jevons, média igual entre varejistas e pesos cobertos."
          code="src/index/aggregate.ts · src/index/relatives.ts"
          cutoff={data.sourceCutoffAt}
          empty={data.aggregate.length === 0 || data.movementPoints === 0}
          renderChart={() => (
            <div className="h-[360px] w-full" role="img" aria-label="Série do nível do índice experimental por dia e segmento">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={indexChart} margin={{ top: 12, right: 18, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} minTickGap={28} />
                  <YAxis tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={54} domain={["auto", "auto"]} />
                  <Tooltip
                    contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--ink)" }}
                    labelFormatter={(label) => formatDay(String(label))}
                    formatter={(value) => [Number(value).toFixed(4), "Índice"]}
                  />
                  {segments.map((segment) => (
                    <Line
                      key={segment}
                      type="linear"
                      dataKey={`segment-${segment}`}
                      name="Índice"
                      stroke="var(--chart-primary)"
                      strokeWidth={2.25}
                      dot={{ r: 3.5, fill: "var(--chart-primary)", stroke: "var(--surface)", strokeWidth: 2 }}
                      activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          renderTable={() => (
            <div className="max-h-[420px] overflow-auto"><Table><thead><tr><TableHead>Dia</TableHead><TableHead>Segmento</TableHead><TableHead>Relativo diário</TableHead><TableHead>Nível</TableHead><TableHead>Cobertura</TableHead><TableHead>Pares</TableHead></tr></thead><tbody>{data.aggregate.map((point) => <tr key={point.day}><TableCell>{formatDay(point.day)}</TableCell><TableCell>{point.chainSegment}</TableCell><TableCell className="font-mono">{point.dailyRelative ?? "lacuna"}</TableCell><TableCell className="font-mono">{point.indexLevel ?? "lacuna"}</TableCell><TableCell>{formatPercent(Number(point.coverageFraction))}</TableCell><TableCell>{formatInteger(point.productPairCount)}</TableCell></tr>)}</tbody></Table></div>
          )}
        />

        <ChartFrame
          title="Cobertura do painel"
          description="A cobertura tem escala própria e fica em um gráfico separado — nunca em eixo duplo com o índice."
          source="coverage retornada pelo mesmo buildDailyIndex()"
          rule="Peso coberto é renormalizado somente sobre subitens com evidência válida; exclusões permanecem contadas."
          code="src/index/aggregate.ts"
          cutoff={data.sourceCutoffAt}
          empty={data.coverage.length === 0}
          renderChart={() => (
            <div className="h-[300px] w-full" role="img" aria-label="Cobertura percentual do painel por dia">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={coverageChart} margin={{ top: 12, right: 18, bottom: 8, left: 0 }}>
                  <defs><linearGradient id="coverage-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-primary)" stopOpacity={0.28} /><stop offset="100%" stopColor="var(--chart-primary)" stopOpacity={0.03} /></linearGradient></defs>
                  <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} minTickGap={28} />
                  <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
                  <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--ink)" }} formatter={(value) => [formatPercent(Number(value) / 100), "Cobertura"]} labelFormatter={(label) => formatDay(String(label))} />
                  <Area type="linear" dataKey="coverage" stroke="var(--chart-primary)" strokeWidth={2.25} fill="url(#coverage-fill)" dot={{ r: 3.5, fill: "var(--chart-primary)", stroke: "var(--surface)", strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          renderTable={() => (
            <div className="max-h-[420px] overflow-auto"><Table><thead><tr><TableHead>Dia</TableHead><TableHead>Cobertura</TableHead><TableHead>Subitens</TableHead><TableHead>Varejistas</TableHead><TableHead>Pares</TableHead><TableHead>Sem classificação</TableHead><TableHead>Sem run saudável</TableHead></tr></thead><tbody>{data.coverage.map((point) => <tr key={point.day}><TableCell>{formatDay(point.day)}</TableCell><TableCell>{formatPercent(Number(point.coverageFraction))}</TableCell><TableCell>{formatInteger(point.coveredSubitemCount)}</TableCell><TableCell>{formatInteger(point.retailerCount)}</TableCell><TableCell>{formatInteger(point.productPairCount)}</TableCell><TableCell>{formatInteger(point.unclassifiedCount)}</TableCell><TableCell>{formatInteger(point.noHealthyRunCount)}</TableCell></tr>)}</tbody></Table></div>
          )}
        />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><AlertTriangle className="size-4 text-warning" /> Limitações obrigatórias</CardTitle><CardDescription>Estas afirmações fazem parte da interpretação correta do artefato.</CardDescription></div></CardHeader>
          <CardContent><ul className="space-y-3">{data.caveats.map((caveat) => <li key={caveat} className="flex gap-3 rounded-xl bg-subtle/60 p-3 text-sm leading-6 text-muted"><AlertTriangle className="mt-1 size-4 shrink-0 text-warning" />{caveat}</li>)}</ul></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div><CardTitle className="flex items-center gap-2"><Archive className="size-4 text-accent" /> Último corte publicado</CardTitle><CardDescription>Metadados verificados do snapshot; os PNGs gerados não alimentam esta interface.</CardDescription></div>
            <EvidenceDialog source="data/exports/latest.json e manifest.json" rule="O pointer é resolvido em runtime, contido no diretório e validado por SHA-256 antes de qualquer metadado ser exibido." code="apps/control-room/src/server/artifacts.ts" />
          </CardHeader>
          <CardContent>
            {artifacts.isLoading ? <p className="text-sm text-muted">Verificando manifestos…</p> : artifacts.data ? (
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-muted">Disponível</dt><dd><Badge tone={artifacts.data.export.verified ? "good" : artifacts.data.export.available ? "warning" : "neutral"}>{artifacts.data.export.verified ? "Verificado" : artifacts.data.export.available ? "Inválido" : "Ausente"}</Badge></dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Snapshot</dt><dd className="max-w-64 truncate font-mono text-xs">{artifacts.data.export.snapshotId ?? "—"}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Gerado</dt><dd>{formatDateTime(artifacts.data.export.generatedAt)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Estado</dt><dd>{artifacts.data.export.status ?? "—"}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Arquivos / linhas</dt><dd className="font-mono">{formatInteger(artifacts.data.export.files)} / {formatInteger(artifacts.data.export.rows)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Análise derivada</dt><dd><Badge tone={artifacts.data.analysis.verified ? "good" : "neutral"}>{artifacts.data.analysis.verified ? "Manifesto verificado" : "Indisponível"}</Badge></dd></div>
              </dl>
            ) : <p className="text-sm text-muted">Manifestos indisponíveis.</p>}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
