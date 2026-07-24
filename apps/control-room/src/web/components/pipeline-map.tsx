import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowRight,
  Bot,
  Boxes,
  BrainCircuit,
  ChartNoAxesCombined,
  Database,
  Radar,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";

import type { OverviewResponse } from "../../shared/contracts.js";
import { cn, formatInteger } from "../lib/utils.js";

const icons = {
  registry: ShieldCheck,
  discovery: ScanSearch,
  catalog: Boxes,
  collection: Database,
  monitor: Radar,
  healing: Bot,
  classification: BrainCircuit,
  index: ChartNoAxesCombined,
} as const;

const stateStyles = {
  ready: "border-good/30 bg-good/5 text-good-strong",
  running: "border-info/40 bg-info/8 text-info-strong",
  attention: "border-warning/40 bg-warning/8 text-warning-strong",
  waiting: "border-border bg-subtle/60 text-muted-strong",
  unavailable: "border-critical/30 bg-critical/5 text-critical-strong",
  empty: "border-dashed border-border bg-surface text-muted",
} as const;

export function PipelineMap({ stages }: { stages: OverviewResponse["pipeline"] }) {
  const primaryIds = ["registry", "discovery", "catalog", "collection", "classification", "index"];
  const primary = primaryIds.map((id) => stages.find((stage) => stage.id === id)).filter(
    (stage): stage is OverviewResponse["pipeline"][number] => stage !== undefined,
  );
  const monitor = stages.find(({ id }) => id === "monitor");
  const healing = stages.find(({ id }) => id === "healing");
  return (
    <div className="overflow-x-auto pb-2">
      <div className="min-w-[940px]">
        <ol className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] items-stretch gap-2">
          {primary.map((stage, index) => {
            const Icon = icons[stage.id];
            return (
              <li key={stage.id} className="contents">
                <Link
                  to={stage.route}
                  className={cn(
                    "group rounded-xl border p-3.5 transition hover:-translate-y-0.5 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    stateStyles[stage.state],
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <Icon className={cn("size-5", stage.state === "running" && "animate-pulse")} aria-hidden="true" />
                    {stage.count !== null && <span className="font-mono text-xs">{formatInteger(stage.count)}</span>}
                  </div>
                  <p className="mt-3 text-sm font-semibold text-ink">{stage.label}</p>
                  <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted">{stage.detail}</p>
                </Link>
                {index < primary.length - 1 && (
                  <div className="grid place-items-center text-muted" aria-hidden="true">
                    <ArrowRight className="size-4" />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {monitor && healing && (
          <div className="mx-auto mt-3 grid w-[42%] grid-cols-[1fr_auto_1fr] items-center gap-3">
            {[monitor, healing].map((stage, index) => {
              const Icon = icons[stage.id];
              return (
                <div key={stage.id} className="contents">
                  <Link
                    to={stage.route}
                    className={cn(
                      "rounded-xl border px-4 py-3 transition hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      stateStyles[stage.state],
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="size-4" aria-hidden="true" />
                      <span className="text-xs font-semibold text-ink">{stage.label}</span>
                      {stage.count !== null && <span className="ml-auto font-mono text-xs">{formatInteger(stage.count)}</span>}
                    </div>
                  </Link>
                  {index === 0 && <ArrowRight className="size-4 text-muted" aria-hidden="true" />}
                </div>
              );
            })}
            <div className="col-span-3 flex items-center justify-center gap-2 text-[11px] font-medium text-muted">
              <ArrowDown className="size-3 rotate-90" aria-hidden="true" />
              feedback somente após evidência de drift
              <ArrowDown className="size-3 -rotate-90" aria-hidden="true" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
