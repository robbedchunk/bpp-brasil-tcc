import { BarChart3, Table2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EvidenceDialog } from "./ui.js";

export function ChartFrame({
  title,
  description,
  source,
  rule,
  code,
  cutoff,
  renderChart,
  renderTable,
  empty = false,
}: {
  title: string;
  description: string;
  source: string;
  rule: string;
  code?: string;
  cutoff?: string | null;
  renderChart: () => ReactNode;
  renderTable: () => ReactNode;
  empty?: boolean;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <Card>
      <CardHeader className="flex-col sm:flex-row">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant={view === "chart" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("chart")}
            aria-pressed={view === "chart"}
          >
            <BarChart3 className="size-4" /> Gráfico
          </Button>
          <Button
            variant={view === "table" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("table")}
            aria-pressed={view === "table"}
          >
            <Table2 className="size-4" /> Tabela
          </Button>
          <EvidenceDialog
            source={source}
            rule={rule}
            {...(code === undefined ? {} : { code })}
            {...(cutoff === undefined ? {} : { cutoff })}
          />
        </div>
      </CardHeader>
      <CardContent>
        {empty ? (
          <div className="grid min-h-64 place-items-center rounded-xl border border-dashed border-border bg-subtle/40 px-4 text-center text-sm text-muted">
            Ainda não há pontos suficientes para esta visualização. Nenhum zero foi inventado.
          </div>
        ) : view === "chart" ? renderChart() : renderTable()}
      </CardContent>
    </Card>
  );
}
