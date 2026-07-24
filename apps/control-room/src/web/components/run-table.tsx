import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";

import type { RunSummary } from "../../shared/contracts.js";
import { formatDay, formatInteger, formatPercent, truncateIdentifier } from "../lib/utils.js";
import { ConstraintBadge, HealthBadge, LifecycleBadge } from "./status.js";
import { Table, TableCell, TableHead } from "./ui.js";

export function RunTable({ runs, compact = false }: { runs: RunSummary[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <thead>
          <tr>
            <TableHead>Execução</TableHead>
            <TableHead>Varejista</TableHead>
            <TableHead>Etapa</TableHead>
            <TableHead>Dia</TableHead>
            <TableHead>Ciclo</TableHead>
            <TableHead>Saúde</TableHead>
            {!compact && <TableHead>Limitador</TableHead>}
            <TableHead className="text-right">OK / tentativas</TableHead>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="group hover:bg-subtle/55">
              <TableCell>
                <Link
                  to="/runs/$runId"
                  params={{ runId: run.id }}
                  className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-accent hover:underline"
                >
                  {truncateIdentifier(run.id)} <ArrowUpRight className="size-3" />
                </Link>
              </TableCell>
              <TableCell className="font-medium">{run.retailerName}</TableCell>
              <TableCell>{run.stage === "collect" ? "Coleta" : "Descoberta"}</TableCell>
              <TableCell>{formatDay(run.collectionDay)}</TableCell>
              <TableCell><LifecycleBadge value={run.lifecycle} /></TableCell>
              <TableCell><HealthBadge value={run.health} /></TableCell>
              {!compact && <TableCell><ConstraintBadge value={run.constraint} /></TableCell>}
              <TableCell className="text-right tabular-nums">
                <span className="font-semibold">{formatInteger(run.ok)}</span>
                <span className="text-muted"> / {formatInteger(run.attempted)}</span>
                <span className="ml-2 text-xs text-muted">({formatPercent(run.successRate)})</span>
              </TableCell>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
