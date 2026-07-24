import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card, CardContent } from "./ui.js";

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  footer,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: LucideIcon;
  footer?: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-ink">{value}</p>
            {detail && <p className="mt-1.5 text-sm text-muted">{detail}</p>}
          </div>
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
            <Icon className="size-5" aria-hidden="true" />
          </div>
        </div>
        {footer && <div className="mt-4 border-t border-border pt-3 text-xs text-muted">{footer}</div>}
      </CardContent>
    </Card>
  );
}
