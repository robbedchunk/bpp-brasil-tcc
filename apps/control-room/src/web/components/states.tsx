import { AlertTriangle, DatabaseZap, LoaderCircle, RefreshCw } from "lucide-react";

import { ApiRequestError } from "../lib/api.js";
import { Button, Card, CardContent } from "./ui.js";

export function PageLoading({ label = "Lendo evidência operacional…" }: { label?: string }) {
  return (
    <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-border bg-surface/60">
      <div className="text-center text-muted">
        <LoaderCircle className="mx-auto mb-3 size-6 animate-spin text-accent" aria-hidden="true" />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}

export function PageError({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof ApiRequestError || error instanceof Error
    ? error.message
    : "Não foi possível ler a evidência operacional.";
  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="flex min-h-52 flex-col items-center justify-center text-center">
        <AlertTriangle className="mb-3 size-7 text-warning" aria-hidden="true" />
        <h2 className="font-semibold text-ink">Leitura indisponível</h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{message}</p>
        {retry && (
          <Button className="mt-5" onClick={retry}>
            <RefreshCw className="size-4" /> Tentar novamente
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-56 flex-col items-center justify-center text-center">
        <DatabaseZap className="mb-3 size-8 text-accent" aria-hidden="true" />
        <h2 className="font-semibold text-ink">{title}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{description}</p>
      </CardContent>
    </Card>
  );
}
