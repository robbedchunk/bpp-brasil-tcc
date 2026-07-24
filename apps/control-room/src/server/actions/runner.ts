import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { CONTROL_PROTOCOL_VERSION } from "../../../../../src/control/capabilities.js";
import type {
  ActionParameters,
  ActionPreview,
  Job,
} from "../../shared/contracts.js";

const execFileAsync = promisify(execFile);

const CapabilitiesSchema = z.object({
  protocolVersion: z.literal(CONTROL_PROTOCOL_VERSION),
  observation: z.object({ literalReadOnlyDatabase: z.literal(true) }),
  preview: z.object({ literalReadOnly: z.literal(true), actions: z.array(z.string()) }),
  execution: z.object({ guardedByCli: z.literal(true), actions: z.array(z.string()) }),
});

export interface SafeCliResult {
  value: unknown;
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
}

export class CliRunnerError extends Error {
  constructor(
    readonly code: "runtime_unavailable" | "runtime_incompatible" | "command_failed" | "invalid_output",
    message: string,
    readonly exitCode: number | null = null,
    readonly stdoutSha256: string | null = null,
    readonly stderrSha256: string | null = null,
  ) {
    super(message);
    this.name = "CliRunnerError";
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEnvironment(projectRoot: string, databasePath: string): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TZ",
    "OPENAI_API_KEY",
    "OPENAI_CLASSIFICATION_MODEL",
    "PRECOS_MONTHLY_MODEL_USD",
    "PAGE_CONCURRENCY",
    "DAILY_PAGE_CAP",
    "NTFY_TOPIC",
  ] as const;
  const env: NodeJS.ProcessEnv = {
    PROJECT_ROOT: projectRoot,
    DATABASE_PATH: databasePath,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function argumentsFor(parameters: ActionParameters, execute: boolean): string[] {
  switch (parameters.kind) {
    case "collect":
      return [
        "collect", "--retailer", parameters.retailerId,
        "--limit", String(parameters.limit),
        ...(execute ? [] : ["--dry-run"]),
        "--json",
      ];
    case "discover":
      return [
        "discover", "--retailer", parameters.retailerId,
        "--limit", String(parameters.limit),
        ...(execute ? [] : ["--dry-run"]),
        "--json",
      ];
    case "daily":
      return [
        "daily", "--limit", String(parameters.limit),
        ...(execute ? [] : ["--dry-run"]),
        "--json",
      ];
    case "classify":
      return [
        "classify",
        "--batch-size", String(parameters.batchSize),
        "--concurrency", String(parameters.concurrency),
        "--version", String(parameters.version),
        "--confidence-threshold", String(parameters.confidenceThreshold),
        ...(execute ? [] : ["--dry-run"]),
        "--json",
      ];
    case "index-export":
      return [
        "index",
        ...(execute ? ["--export"] : []),
        "--classification-version", String(parameters.classificationVersion),
        ...(parameters.throughDay === null ? [] : ["--through", parameters.throughDay]),
        ...(execute && parameters.requireOfficial ? ["--require-official"] : []),
        "--json",
      ];
  }
}

function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (text === "") throw new CliRunnerError("invalid_output", "A CLI não retornou um objeto JSON.");
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/u).filter(Boolean);
    const last = lines.at(-1);
    if (last !== undefined) {
      try {
        return JSON.parse(last);
      } catch {
        // Fall through to the safe error below.
      }
    }
    throw new CliRunnerError("invalid_output", "A CLI retornou um resultado incompatível.");
  }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function previewPlan(
  parameters: ActionParameters,
  raw: unknown,
): ActionPreview["plan"] {
  const value = object(raw);
  switch (parameters.kind) {
    case "collect":
    case "discover": {
      return {
        title: parameters.kind === "collect" ? "Coletar um varejista" : "Descobrir catálogo",
        scope: parameters.retailerId,
        metrics: [
          { label: "Limite solicitado", value: String(parameters.limit) },
          { label: "Itens planejados", value: String(number(value.planned)) },
          { label: "Etapa", value: parameters.kind === "collect" ? "coleta" : "descoberta" },
        ],
        estimatedCostUsd: null,
        warnings: [
          "A execução real consumirá admissões duráveis antes das requisições.",
          "O lock da pipeline continua autoritativo no instante da execução.",
        ],
      };
    }
    case "daily": {
      const runs = Array.isArray(value.runs) ? value.runs : [];
      return {
        title: "Executar pipeline diário manual",
        scope: `${number(value.retailers)} varejista(s) ativo(s)`,
        metrics: [
          { label: "Varejistas", value: String(number(value.retailers)) },
          { label: "Runs planejados", value: String(runs.length) },
          { label: "Limite por varejista", value: String(parameters.limit) },
        ],
        estimatedCostUsd: null,
        warnings: [
          "Esta execução é manual e não satisfará o heartbeat agendado.",
          "Falha em um varejista não impede a tentativa dos demais.",
        ],
      };
    }
    case "classify":
      return {
        title: "Classificar produtos pendentes",
        scope: `versão ${parameters.version}`,
        metrics: [
          { label: "Elegíveis", value: String(number(value.eligible)) },
          { label: "Batches planejados", value: String(number(value.plannedBatches)) },
          { label: "Batch size", value: String(parameters.batchSize) },
          { label: "Concorrência", value: String(parameters.concurrency) },
        ],
        estimatedCostUsd: number(value.estimatedCostUsd),
        warnings: [
          "A autorização de gasto deverá corresponder exatamente à estimativa deste preview.",
          "Reservas de custo são persistidas antes da chamada ao provedor.",
        ],
      };
    case "index-export":
      return {
        title: "Publicar snapshot do índice",
        scope: `classificação v${parameters.classificationVersion}`,
        metrics: [
          { label: "Estado ao vivo", value: string(value.status) ?? "desconhecido" },
          { label: "Pontos agregados", value: String(number(value.aggregatePoints)) },
          { label: "Relativos de produto", value: String(number(value.productRelatives)) },
        ],
        estimatedCostUsd: null,
        warnings: [
          "A execução gravará um novo snapshot imutável e atualizará latest.json atomicamente.",
          parameters.requireOfficial
            ? "A operação falhará se a fonte oficial não estiver disponível."
            : "A indisponibilidade oficial será registrada honestamente no manifesto.",
        ],
      };
  }
}

function executionResult(parameters: ActionParameters, raw: unknown): NonNullable<Job["result"]> {
  const value = object(raw);
  switch (parameters.kind) {
    case "collect":
    case "discover":
      return {
        title: parameters.kind === "collect" ? "Coleta concluída" : "Descoberta concluída",
        metrics: [
          { label: "Estado", value: string(value.status) ?? "desconhecido" },
          { label: "Tentativas", value: String(number(value.attempted)) },
          { label: "Válidas", value: String(number(value.ok)) },
          { label: "Falhas", value: String(number(value.failed)) },
        ],
        domainIds: string(value.id) === null ? [] : [string(value.id) as string],
      };
    case "daily": {
      const runs = Array.isArray(value.runs) ? value.runs : [];
      const ids = runs.map((item) => string(object(item).id)).filter((id): id is string => id !== null);
      return {
        title: "Pipeline diário concluído",
        metrics: [
          { label: "Estado", value: string(value.status) ?? "desconhecido" },
          { label: "Varejistas", value: String(number(value.retailers)) },
          { label: "Terminais", value: String(number(value.terminal)) },
        ],
        domainIds: ids,
      };
    }
    case "classify":
      return {
        title: "Classificação concluída",
        metrics: [
          { label: "Estado", value: string(value.status) ?? "desconhecido" },
          { label: "Classificados", value: String(number(value.classified)) },
          { label: "Não classificados", value: String(number(value.unclassified)) },
          { label: "Pendentes", value: String(number(value.pending)) },
          { label: "Custo estimado", value: number(value.estimatedCostUsd).toFixed(6) },
        ],
        domainIds: [],
      };
    case "index-export":
      return {
        title: "Snapshot publicado",
        metrics: [
          { label: "Estado", value: string(value.status) ?? "desconhecido" },
          { label: "Método", value: string(value.methodVersion) ?? "desconhecido" },
          { label: "Arquivos", value: String(Array.isArray(value.files) ? value.files.length : 0) },
        ],
        domainIds: string(value.snapshotId) === null ? [] : [string(value.snapshotId) as string],
      };
  }
}

export class CliRunner {
  private readonly cliPath: string;
  private runtimeCache: ActionPreview["runtime"] | null = null;
  private runtimePromise: Promise<ActionPreview["runtime"]> | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly databasePath: string,
  ) {
    this.cliPath = resolve(projectRoot, "dist/cli.js");
  }

  async runtime(): Promise<ActionPreview["runtime"]> {
    if (this.runtimeCache !== null) return this.runtimeCache;
    this.runtimePromise ??= this.loadRuntime();
    try {
      return await this.runtimePromise;
    } finally {
      this.runtimePromise = null;
    }
  }

  private async loadRuntime(): Promise<ActionPreview["runtime"]> {
    let artifact: Buffer;
    try {
      artifact = await readFile(this.cliPath);
    } catch {
      throw new CliRunnerError(
        "runtime_unavailable",
        "Compile o runtime principal com `npm run build` antes de habilitar ações.",
      );
    }
    const output = await this.run(["control", "capabilities", "--json"], 20_000);
    let capabilities;
    try {
      capabilities = CapabilitiesSchema.parse(output.value);
    } catch {
      throw new CliRunnerError(
        "runtime_incompatible",
        "O runtime principal não implementa o protocolo de controle exigido.",
      );
    }
    this.runtimeCache = {
      kind: "checkout-build",
      artifactSha256: sha256(artifact),
      protocolVersion: capabilities.protocolVersion,
    };
    return this.runtimeCache;
  }

  async preview(parameters: ActionParameters): Promise<{
    plan: ActionPreview["plan"];
    raw: unknown;
  }> {
    await this.runtime();
    const output = await this.run(argumentsFor(parameters, false), 120_000);
    return { plan: previewPlan(parameters, output.value), raw: output.value };
  }

  async execute(parameters: ActionParameters): Promise<{
    safeResult: NonNullable<Job["result"]>;
    exitCode: number;
    stdoutSha256: string;
    stderrSha256: string;
  }> {
    await this.runtime();
    const output = await this.run(argumentsFor(parameters, true), 30 * 60_000);
    return {
      safeResult: executionResult(parameters, output.value),
      exitCode: output.exitCode,
      stdoutSha256: output.stdoutSha256,
      stderrSha256: output.stderrSha256,
    };
  }

  private async run(arguments_: string[], timeout: number): Promise<SafeCliResult> {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [this.cliPath, ...arguments_],
        {
          cwd: this.projectRoot,
          env: safeEnvironment(this.projectRoot, this.databasePath),
          encoding: "utf8",
          timeout,
          maxBuffer: 8 * 1_024 * 1_024,
          windowsHide: true,
        },
      );
      return {
        value: parseJsonOutput(stdout),
        exitCode: 0,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
      };
    } catch (error) {
      const output = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      const stdout = typeof output.stdout === "string" ? output.stdout : "";
      const stderr = typeof output.stderr === "string" ? output.stderr : "";
      const exitCode = typeof output.code === "number" ? output.code : null;
      throw new CliRunnerError(
        "command_failed",
        exitCode === 75
          ? "A operação foi bloqueada por um lock autoritativo."
          : output.killed === true
            ? "A operação excedeu o tempo limite local."
            : "A CLI encerrou a operação sem sucesso.",
        exitCode,
        sha256(stdout),
        sha256(stderr),
      );
    }
  }
}
