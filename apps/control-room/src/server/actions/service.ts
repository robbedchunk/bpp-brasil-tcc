import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  ActionParametersSchema,
  ActionPreviewSchema,
  JobSchema,
  type ActionParameters,
  type ActionPreview,
  type Job,
} from "../../shared/contracts.js";
import type { ControlRoomConfig } from "../config.js";
import type { ReadModelService } from "../read-model/database.js";
import { inspectProcessLock } from "../../../../../src/ops/lock.js";
import { evidenceValueSha256 } from "../../../../../src/strategies/validation-evidence.js";
import { JobStore } from "./job-store.js";
import { CliRunner, CliRunnerError } from "./runner.js";

const PREVIEW_TTL_MS = 5 * 60 * 1_000;

export class ActionServiceError extends Error {
  constructor(
    readonly code:
      | "actions_disabled"
      | "schema_unavailable"
      | "preview_not_found"
      | "preview_expired"
      | "preview_consumed"
      | "confirmation_mismatch"
      | "spend_mismatch"
      | "state_changed"
      | "lock_active"
      | "runtime_unavailable",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ActionServiceError";
  }
}

function lockDefinition(parameters: ActionParameters): {
  name: ActionPreview["impact"]["lock"];
  path: string;
} {
  switch (parameters.kind) {
    case "collect":
    case "discover":
    case "daily":
      return { name: "pipeline", path: "var/precos-pipeline.lock" };
    case "classify":
      return { name: "classification", path: "var/precos-classification.lock" };
    case "index-export":
      return { name: "index", path: "var/precos-index.lock" };
  }
}

function impact(
  parameters: ActionParameters,
  lockState: ActionPreview["impact"]["lockState"],
): ActionPreview["impact"] {
  const lock = lockDefinition(parameters).name;
  switch (parameters.kind) {
    case "collect":
    case "discover":
    case "daily":
      return {
        network: true,
        primaryDatabaseWrites: true,
        filesystemWrites: true,
        paidModel: false,
        lock,
        lockState,
      };
    case "classify":
      return {
        network: true,
        primaryDatabaseWrites: true,
        filesystemWrites: false,
        paidModel: true,
        lock,
        lockState,
      };
    case "index-export":
      return {
        network: true,
        primaryDatabaseWrites: false,
        filesystemWrites: true,
        paidModel: false,
        lock,
        lockState,
      };
  }
}

function confirmationPhrase(parameters: ActionParameters): string {
  const prefix = {
    collect: "COLETAR",
    discover: "DESCOBRIR",
    daily: "EXECUTAR-DIARIO",
    classify: "AUTORIZAR-MODELO",
    "index-export": "PUBLICAR-INDICE",
  }[parameters.kind];
  return `${prefix}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export interface ActionServiceDependencies {
  store?: JobStore;
  runner?: Pick<CliRunner, "runtime" | "preview" | "execute">;
}

export class ActionService {
  readonly store: JobStore;
  private readonly runner: Pick<CliRunner, "runtime" | "preview" | "execute">;

  constructor(
    private readonly config: ControlRoomConfig,
    private readonly readModel: ReadModelService,
    private readonly now: () => Date = () => new Date(),
    dependencies: ActionServiceDependencies = {},
  ) {
    this.store = dependencies.store ?? new JobStore(
      resolve(config.projectRoot, "var/control-room/control.sqlite"),
      config.actionsEnabled,
      now,
    );
    this.runner = dependencies.runner ?? new CliRunner(config.projectRoot, config.databasePath);
  }

  async preview(input: unknown): Promise<ActionPreview> {
    this.ensureEnabled();
    const parameters = ActionParametersSchema.parse(input);
    const generated = await this.generate(parameters);
    const createdAt = this.now();
    const preview = ActionPreviewSchema.parse({
      id: randomUUID(),
      action: parameters.kind,
      parameters,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + PREVIEW_TTL_MS).toISOString(),
      confirmationPhrase: confirmationPhrase(parameters),
      fingerprint: generated.fingerprint,
      runtime: generated.runtime,
      impact: generated.impact,
      plan: generated.plan,
    });
    this.store.savePreview(preview);
    return preview;
  }

  async execute(input: {
    previewId: string;
    confirmationPhrase: string;
    authorizedSpendUsd?: number | null;
  }): Promise<Job> {
    this.ensureEnabled();
    const stored = this.store.preview(input.previewId);
    if (stored === null) {
      throw new ActionServiceError("preview_not_found", "Preview não encontrado.", 404);
    }
    if (stored.consumedAt !== null) {
      throw new ActionServiceError("preview_consumed", "Este preview já foi consumido.", 409);
    }
    const now = this.now();
    if (Date.parse(stored.expiresAt) < now.getTime()) {
      throw new ActionServiceError("preview_expired", "O preview expirou; gere outro.", 409);
    }
    if (input.confirmationPhrase !== stored.preview.confirmationPhrase) {
      throw new ActionServiceError(
        "confirmation_mismatch",
        "A frase de confirmação não corresponde ao preview.",
        400,
      );
    }
    const estimatedCost = stored.preview.plan.estimatedCostUsd;
    if (
      estimatedCost !== null
      && (
        input.authorizedSpendUsd === undefined
        || input.authorizedSpendUsd === null
        || Math.abs(input.authorizedSpendUsd - estimatedCost) > 0.000000001
      )
    ) {
      throw new ActionServiceError(
        "spend_mismatch",
        "A autorização de gasto deve corresponder exatamente ao preview.",
        400,
      );
    }

    const current = await this.generate(stored.preview.parameters);
    if (current.impact.lockState === "active" || current.impact.lockState === "malformed") {
      throw new ActionServiceError(
        "lock_active",
        "O lock autoritativo impede uma nova execução agora.",
        409,
      );
    }
    if (current.fingerprint !== stored.preview.fingerprint) {
      throw new ActionServiceError(
        "state_changed",
        "O estado operacional mudou desde o preview; revise um novo plano.",
        409,
      );
    }
    if (!this.store.consumePreview(stored.preview.id, now.toISOString())) {
      throw new ActionServiceError(
        "preview_consumed",
        "O preview não está mais disponível para execução.",
        409,
      );
    }

    const job = JobSchema.parse({
      id: randomUUID(),
      previewId: stored.preview.id,
      action: stored.preview.action,
      parameters: stored.preview.parameters,
      status: "confirmed",
      runtime: {
        kind: stored.preview.runtime.kind,
        artifactSha256: stored.preview.runtime.artifactSha256,
      },
      createdAt: now.toISOString(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      result: null,
      stdoutSha256: null,
      stderrSha256: null,
      receiptSha256: null,
    });
    this.store.createJob(job);
    void this.run(job.id, stored.preview.parameters);
    return job;
  }

  close(): void {
    this.store.close();
  }

  private ensureEnabled(): void {
    if (!this.config.actionsEnabled) {
      throw new ActionServiceError(
        "actions_disabled",
        "Reinicie localmente com `-- --enable-actions` para usar controles.",
        403,
      );
    }
  }

  private async generate(parameters: ActionParameters) {
    const inspection = this.readModel.inspect();
    if (inspection.state !== "ready" && inspection.state !== "ready_empty") {
      throw new ActionServiceError(
        "schema_unavailable",
        "O banco operacional não está pronto para ações.",
        409,
      );
    }
    const lock = lockDefinition(parameters);
    const lockInspection = await inspectProcessLock(resolve(this.config.projectRoot, lock.path));
    try {
      const [runtime, preview] = await Promise.all([
        this.runner.runtime(),
        this.runner.preview(parameters),
      ]);
      const actionImpact = impact(parameters, lockInspection.state);
      const fingerprint = evidenceValueSha256({
        parameters,
        plan: preview.plan,
        dataVersion: inspection.dataVersion,
        schemaVersion: inspection.schemaCapability?.currentVersion ?? null,
        runtime,
        lockState: lockInspection.state,
      });
      return {
        runtime,
        plan: preview.plan,
        impact: actionImpact,
        fingerprint,
      };
    } catch (error) {
      if (error instanceof CliRunnerError) {
        throw new ActionServiceError(
          "runtime_unavailable",
          error.message,
          error.code === "command_failed" ? 409 : 503,
        );
      }
      throw error;
    }
  }

  private async run(jobId: string, parameters: ActionParameters): Promise<void> {
    const startedAt = this.now().toISOString();
    this.store.updateJob(jobId, (job) => ({
      ...job,
      status: "started",
      startedAt,
    }), startedAt);
    try {
      const output = await this.runner.execute(parameters);
      const finishedAt = this.now().toISOString();
      this.store.updateJob(jobId, (job) => {
        const receipt = {
          id: job.id,
          previewId: job.previewId,
          action: job.action,
          parameters: job.parameters,
          runtime: job.runtime,
          startedAt: job.startedAt,
          finishedAt,
          exitCode: output.exitCode,
          result: output.safeResult,
          stdoutSha256: output.stdoutSha256,
          stderrSha256: output.stderrSha256,
        };
        return {
          ...job,
          status: "succeeded",
          finishedAt,
          exitCode: output.exitCode,
          result: output.safeResult,
          stdoutSha256: output.stdoutSha256,
          stderrSha256: output.stderrSha256,
          receiptSha256: evidenceValueSha256(receipt),
        };
      }, finishedAt);
    } catch (error) {
      const finishedAt = this.now().toISOString();
      this.store.updateJob(jobId, (job) => {
        const cliError = error instanceof CliRunnerError ? error : null;
        const status = cliError?.exitCode === 75 ? "blocked_by_lock" as const : "failed" as const;
        const receipt = {
          id: job.id,
          previewId: job.previewId,
          action: job.action,
          parameters: job.parameters,
          runtime: job.runtime,
          startedAt: job.startedAt,
          finishedAt,
          exitCode: cliError?.exitCode ?? null,
          status,
          stdoutSha256: cliError?.stdoutSha256 ?? null,
          stderrSha256: cliError?.stderrSha256 ?? null,
        };
        return {
          ...job,
          status,
          finishedAt,
          exitCode: cliError?.exitCode ?? null,
          stdoutSha256: cliError?.stdoutSha256 ?? null,
          stderrSha256: cliError?.stderrSha256 ?? null,
          receiptSha256: evidenceValueSha256(receipt),
        };
      }, finishedAt);
    }
  }
}
