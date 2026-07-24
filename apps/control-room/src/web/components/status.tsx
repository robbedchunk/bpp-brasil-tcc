import {
  AlertOctagon,
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Info,
  PauseCircle,
  ShieldAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { z } from "zod";

import type {
  DatabaseStateSchema,
  RunConstraintSchema,
  RunHealthSchema,
  RunLifecycleSchema,
} from "../../shared/contracts.js";
import { Badge } from "./ui.js";

type Tone = "neutral" | "info" | "good" | "warning" | "critical";

interface StatusDefinition {
  tone: Tone;
  label: string;
  icon: LucideIcon;
  iconClassName?: string;
}

const healthValues = {
  healthy: { tone: "good", label: "Saudável", icon: CheckCircle2 },
  drift: { tone: "warning", label: "Drift", icon: AlertTriangle },
  blocking: { tone: "critical", label: "Bloqueio", icon: Ban },
  mixed: { tone: "warning", label: "Misto", icon: ShieldAlert },
  unknown: { tone: "neutral", label: "Sem leitura", icon: CircleDashed },
} as const satisfies Record<z.infer<typeof RunHealthSchema>, StatusDefinition>;

const lifecycleValues = {
  running: { tone: "info", label: "Em execução", icon: Clock3, iconClassName: "animate-pulse" },
  completed: { tone: "good", label: "Concluída", icon: CheckCircle2 },
  partial: { tone: "warning", label: "Parcial", icon: PauseCircle },
  failed: { tone: "critical", label: "Falhou", icon: XCircle },
  unknown: { tone: "neutral", label: "Desconhecida", icon: CircleDashed },
} as const satisfies Record<z.infer<typeof RunLifecycleSchema>, StatusDefinition>;

const constraintValues = {
  none: { tone: "neutral", label: "Sem limitador", icon: Info },
  bounded: { tone: "info", label: "Limitada por plano", icon: PauseCircle },
  blocking_stop: { tone: "critical", label: "Parada por bloqueio", icon: AlertOctagon },
  incomplete_evidence: { tone: "warning", label: "Evidência incompleta", icon: AlertTriangle },
  unknown: { tone: "neutral", label: "Limitador desconhecido", icon: CircleDashed },
} as const satisfies Record<z.infer<typeof RunConstraintSchema>, StatusDefinition>;

const databaseValues = {
  ready: { tone: "good", label: "Banco ao vivo", icon: CheckCircle2 },
  ready_empty: { tone: "info", label: "Banco vazio", icon: CircleDashed },
  missing: { tone: "warning", label: "Não inicializado", icon: AlertTriangle },
  unrecognized: { tone: "critical", label: "Banco não reconhecido", icon: XCircle },
  older: { tone: "warning", label: "Migração necessária", icon: AlertTriangle },
  newer: { tone: "warning", label: "Schema mais novo", icon: AlertTriangle },
  incompatible: { tone: "critical", label: "Schema incompatível", icon: XCircle },
} as const satisfies Record<z.infer<typeof DatabaseStateSchema>, StatusDefinition>;

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Badge tone={tone}>{children}</Badge>;
}

function DefinitionBadge({ definition }: { definition: StatusDefinition }) {
  const Icon = definition.icon;
  return (
    <Status tone={definition.tone}>
      <Icon className={`size-3.5${definition.iconClassName ? ` ${definition.iconClassName}` : ""}`} />
      {definition.label}
    </Status>
  );
}

export function HealthBadge({ value }: { value: z.infer<typeof RunHealthSchema> }) {
  return <DefinitionBadge definition={healthValues[value]} />;
}

export function LifecycleBadge({ value }: { value: z.infer<typeof RunLifecycleSchema> }) {
  return <DefinitionBadge definition={lifecycleValues[value]} />;
}

export function ConstraintBadge({ value }: { value: z.infer<typeof RunConstraintSchema> }) {
  return <DefinitionBadge definition={constraintValues[value]} />;
}

export function DatabaseBadge({ value }: { value: z.infer<typeof DatabaseStateSchema> }) {
  return <DefinitionBadge definition={databaseValues[value]} />;
}
