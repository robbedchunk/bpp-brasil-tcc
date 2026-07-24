import { Filter, ListChecks, RotateCcw } from "lucide-react";

import { RunTable } from "../components/run-table.js";
import { EmptyState, PageError, PageLoading } from "../components/states.js";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EvidenceDialog, PageHeader, Select } from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatInteger } from "../lib/utils.js";

export interface RunsSearch {
  retailer?: string;
  stage?: "discover" | "collect";
  status?: string;
}

export function RunsPage({
  search,
  onSearch,
}: {
  search: RunsSearch;
  onSearch: (search: RunsSearch) => void;
}) {
  const query = api.useRuns(search);
  const retailers = api.useRetailers();
  if (query.isLoading) return <PageLoading />;
  if (query.error || !query.data) return <PageError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  const filtered = Object.values(search).some(Boolean);
  return (
    <>
      <PageHeader
        eyebrow="Evidência de execução"
        title="Execuções"
        description="Histórico operacional separado por ciclo, saúde e condição limitante — sem esconder falhas ou promover parcial a erro automaticamente."
      />
      <Card>
        <CardHeader className="flex-col md:flex-row md:items-center">
          <div>
            <CardTitle className="flex items-center gap-2"><Filter className="size-4 text-accent" /> Filtros</CardTitle>
            <CardDescription>As opções de varejista são carregadas do banco atual.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label="Filtrar por varejista"
              value={search.retailer ?? ""}
              onChange={(event) => {
                const { retailer: _retailer, ...rest } = search;
                onSearch(event.target.value === ""
                  ? rest
                  : { ...rest, retailer: event.target.value });
              }}
            >
              <option value="">Todos os varejistas</option>
              {retailers.data?.retailers.map((retailer) => <option key={retailer.id} value={retailer.id}>{retailer.name}</option>)}
            </Select>
            <Select
              aria-label="Filtrar por etapa"
              value={search.stage ?? ""}
              onChange={(event) => {
                const { stage: _stage, ...rest } = search;
                onSearch(event.target.value === "collect" || event.target.value === "discover"
                  ? { ...rest, stage: event.target.value }
                  : rest);
              }}
            >
              <option value="">Todas as etapas</option>
              <option value="collect">Coleta</option>
              <option value="discover">Descoberta</option>
            </Select>
            <Select
              aria-label="Filtrar por ciclo"
              value={search.status ?? ""}
              onChange={(event) => {
                const { status: _status, ...rest } = search;
                onSearch(event.target.value === ""
                  ? rest
                  : { ...rest, status: event.target.value });
              }}
            >
              <option value="">Todos os ciclos</option>
              <option value="running">Em execução</option>
              <option value="completed">Concluída</option>
              <option value="partial">Parcial</option>
              <option value="failed">Falhou</option>
            </Select>
            {filtered && <Button variant="ghost" onClick={() => onSearch({})}><RotateCcw className="size-4" /> Limpar</Button>}
          </div>
        </CardHeader>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2"><ListChecks className="size-4 text-accent" /> Histórico</CardTitle>
            <CardDescription>{formatInteger(data.pagination.total)} execução(ões) encontrada(s).</CardDescription>
          </div>
          <EvidenceDialog
            source="runs, run_failures e runtime_reconciliations"
            rule="Saúde usa o mesmo classificador do monitor; falhas são agrupadas por categoria e nunca expõem mensagem, URL ou replay."
            code="src/healing/classify-failure.ts:43"
            cutoff={data.sourceCutoffAt}
          />
        </CardHeader>
        <CardContent className="px-2">
          {data.runs.length === 0 ? (
            <EmptyState title="Nenhuma execução neste recorte" description="Altere os filtros ou aguarde a própria operação persistir novos runs." />
          ) : <RunTable runs={data.runs} />}
        </CardContent>
      </Card>
    </>
  );
}
