import { Binary, CheckCircle2, Copy, Database, GitBranch, LockKeyhole, ServerCog, Shield, TerminalSquare } from "lucide-react";
import { useState } from "react";

import { PageError, PageLoading } from "../components/states.js";
import { DatabaseBadge } from "../components/status.js";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EvidenceDialog, PageHeader, Table, TableCell, TableHead } from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatDateTime, formatInteger, truncateIdentifier } from "../lib/utils.js";

function CopyCommand({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-code px-4 py-3 text-code-ink">
      <code className="overflow-x-auto whitespace-nowrap font-mono text-xs">{value}</code>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 text-code-muted hover:bg-white/10 hover:text-white"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        }}
        aria-label={`Copiar comando: ${value}`}
      >
        {copied ? <CheckCircle2 className="size-4 text-good-light" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

export function SystemPage() {
  const query = api.useSystem();
  if (query.isLoading) return <PageLoading />;
  if (query.error || !query.data) return <PageError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  return (
    <>
      <PageHeader
        eyebrow="Reprodução e runtime"
        title="Sistema"
        description="Identidade do banco, compatibilidade de schema, checkout, release agendado, capacidades e locks — sem expor valores de ambiente ou caminhos privados."
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <div><CardTitle className="flex items-center gap-2"><Database className="size-4 text-accent" /> Banco observado</CardTitle><CardDescription>A conexão do painel é literal read-only e não executa migrations.</CardDescription></div>
            <DatabaseBadge value={data.database.state} />
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted">Identificador</dt><dd className="font-mono text-xs">{data.database.label}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Schema atual</dt><dd className="font-mono">{data.database.schemaCapability?.currentVersion ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Schema esperado</dt><dd className="font-mono">{data.database.schemaCapability?.expectedVersion ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Ações seguras</dt><dd><Badge tone={data.database.schemaCapability?.actionsSafe ? "good" : "warning"}>{data.database.schemaCapability?.actionsSafe ? "Compatível" : "Bloqueadas"}</Badge></dd></div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div><CardTitle className="flex items-center gap-2"><Shield className="size-4 text-accent" /> Capacidades</CardTitle><CardDescription>O navegador recebe presença/ausência, nunca os segredos.</CardDescription></div>
            <EvidenceDialog source="precos control capabilities + configuração sanitizada" rule="Ações só são habilitadas por opt-in local, schema compatível e runtime conhecido." code="src/control/capabilities.ts" />
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted">Protocolo</dt><dd className="font-mono">v{data.capabilities.protocolVersion}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Modo de ação</dt><dd><Badge tone={data.capabilities.actionsEnabled ? "warning" : "info"}>{data.capabilities.actionsEnabled ? "Habilitado" : "Observador"}</Badge></dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Provedor de modelo</dt><dd><Badge tone={data.capabilities.openaiConfigured ? "good" : "neutral"}>{data.capabilities.openaiConfigured ? "Configurado" : "Ausente"}</Badge></dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Notificação</dt><dd><Badge tone={data.capabilities.notificationConfigured ? "good" : "neutral"}>{data.capabilities.notificationConfigured ? "Configurada" : "Ausente"}</Badge></dd></div>
            </dl>
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><GitBranch className="size-4 text-accent" /> Checkout atual</CardTitle><CardDescription>Fonte aberta no diretório de trabalho; pode diferir do release agendado.</CardDescription></div></CardHeader>
          <CardContent>
            <p className="font-mono text-sm font-semibold">{data.checkout.commit ? truncateIdentifier(data.checkout.commit, 12, 8) : "Não identificado"}</p>
            <div className="mt-3"><Badge tone={data.checkout.dirty === true ? "warning" : data.checkout.dirty === false ? "good" : "neutral"}>{data.checkout.dirty === true ? "Alterações locais" : data.checkout.dirty === false ? "Limpo" : "Estado desconhecido"}</Badge></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><Binary className="size-4 text-accent" /> Release agendado</CardTitle><CardDescription>Timers podem executar um commit congelado diferente do checkout.</CardDescription></div></CardHeader>
          <CardContent>
            {data.installedRelease.available ? (
              <dl className="space-y-3 text-sm"><div className="flex justify-between gap-3"><dt className="text-muted">Release</dt><dd className="font-mono text-xs">{truncateIdentifier(data.installedRelease.releaseId ?? "", 12, 8)}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">Commit</dt><dd className="font-mono text-xs">{truncateIdentifier(data.installedRelease.sourceCommit ?? "", 12, 8)}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">Deploy</dt><dd>{formatDateTime(data.installedRelease.deployedAt)}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted">Units</dt><dd>{formatInteger(data.installedRelease.unitCount)}</dd></div></dl>
            ) : <p className="text-sm text-muted">Nenhum recibo de instalação do systemd encontrado.</p>}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader><div><CardTitle className="flex items-center gap-2"><LockKeyhole className="size-4 text-accent" /> Locks operacionais</CardTitle><CardDescription>Inspeção não mutante; a aquisição real pela CLI continua autoritativa.</CardDescription></div></CardHeader>
        <CardContent className="px-2">
          <Table>
            <thead><tr><TableHead>Domínio</TableHead><TableHead>Estado</TableHead><TableHead>Bloqueia aquisição</TableHead><TableHead>Início</TableHead><TableHead>Idade</TableHead></tr></thead>
            <tbody>{data.locks.map((lock) => <tr key={lock.name}><TableCell className="font-medium">{lock.name}</TableCell><TableCell><Badge tone={lock.state === "active" ? "info" : lock.state === "malformed" ? "warning" : "neutral"}>{lock.state}</Badge></TableCell><TableCell>{lock.blocksAcquisition ? "Sim" : "Não"}</TableCell><TableCell>{formatDateTime(lock.startedAt)}</TableCell><TableCell className="font-mono text-xs">{lock.ageMs === null ? "—" : `${Math.round(lock.ageMs / 1_000)}s`}</TableCell></tr>)}</tbody>
          </Table>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader><div><CardTitle className="flex items-center gap-2"><TerminalSquare className="size-4 text-accent" /> Reprodução local</CardTitle><CardDescription>Fluxo sem Docker: mesmas versões, SQLite e Chromium do projeto.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3">
          <CopyCommand value="bash ops/setup.sh" />
          <CopyCommand value="bash ops/smoke.sh" />
          <CopyCommand value="npm run control-room:build" />
          <CopyCommand value="npm run control-room:start" />
          <p className="pt-2 text-xs leading-5 text-muted"><ServerCog className="mr-1 inline size-3.5" /> O modo padrão é observador. Ações exigem `-- --enable-actions` e continuam sujeitas aos locks e guardrails da CLI.</p>
        </CardContent>
      </Card>
    </>
  );
}
