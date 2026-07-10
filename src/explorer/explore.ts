import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";

import { executeExtraction } from "../collection/executor.js";
import {
  beginExplorationRun,
  commitExplorationSuccess,
  commitExplorationTerminal,
  findRetailerExplorationContext,
  finishExplorationRun,
  listStrategyValidationRefs,
  recordExplorationAttempt,
  type ExplorationAttemptEvidence,
} from "../db/repositories.js";
import { executeDiscovery } from "../discovery/executor.js";
import type { AlertSink } from "../ops/alerts.js";
import {
  MAX_EXPLORATION_EVENT_USD,
  MAX_MONTHLY_MODEL_USD,
  reserveExplorationBudget,
  settleExplorationBudget,
} from "../ops/budget.js";
import {
  DiscoveryStrategySchema,
  ExtractionStrategySchema,
  StrategySchema,
  type DiscoveryStrategy,
  type ExtractionStrategy,
  type Strategy,
} from "../strategies/schema.js";
import type { ExtractionResult, ProductRef } from "../strategies/types.js";
import { validateExtractionStrategy } from "../strategies/validate.js";
import { explorerModelFromEnv } from "./codex-provider.js";
import {
  createSandboxPackage,
  redactSandboxText,
  type SandboxFailureSample,
  type SandboxPackage,
  type SandboxPackageInput,
  type SandboxSample,
} from "./package.js";
import { buildExplorerPrompt } from "./prompt.js";
import type {
  GenerationResult,
  GenerationUsage,
  StrategyGenerator,
  StrategyPurpose,
} from "./provider.js";

const TRUSTED_SAMPLE_SIZE = 30;
const TRUSTED_ACTIVATION_SCORE = 0.9;
export const EXPLORER_PROMPT_VERSION = "strategy-explorer-v1";

export interface ExplorerRate {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: string;
  version: string;
}

// The Codex SDK exposes tokens, not billed USD. Until an exact model rate can
// be established, the explorer uses this intentionally conservative,
// configurable estimate and fails closed at the event cap.
export const DEFAULT_EXPLORER_RATE: Readonly<ExplorerRate> = {
  inputUsdPerMillion: 10,
  outputUsdPerMillion: 60,
  source: "conservative-configurable-fallback",
  version: "explorer-estimate-2026-07-10-v1",
};

export interface CandidateValidationReport {
  attempted: number;
  valid: number;
  score: number;
  activatable?: boolean;
}

export type CandidateValidator = (
  strategy: Strategy,
  refs: readonly ProductRef[],
) => Promise<CandidateValidationReport>;

export interface ExploreRetailerDependencies {
  database: Database.Database;
  generator?: StrategyGenerator;
  validateCandidate?: CandidateValidator;
  execute?: (
    strategy: ExtractionStrategy,
    ref: ProductRef,
  ) => Promise<ExtractionResult>;
  discover?: (
    strategy: DiscoveryStrategy,
  ) => AsyncIterable<ProductRef> | Promise<readonly ProductRef[]>;
  sandboxSamples?: readonly SandboxSample[];
  failureSamples?: readonly SandboxFailureSample[];
  trigger?: string;
  maxAttempts?: number;
  eventBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  rate?: ExplorerRate;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  healingEventId?: string;
  alertSink?: AlertSink;
  createSandbox?: (input: SandboxPackageInput) => Promise<SandboxPackage>;
}

export type ExplorationOutcomeName =
  | "activated"
  | "validation_failed"
  | "invalid_candidate"
  | "provider_unavailable"
  | "provider_failed"
  | "safety_failure"
  | "unauditable_spend"
  | "insufficient_samples"
  | "budget_paused"
  | "budget_exhausted";

export interface ExplorationOutcome {
  explorationRunId: string;
  activated: boolean;
  attempts: number;
  externalScore: number | null;
  outcome: ExplorationOutcomeName;
  costUsd: number;
  strategyId?: string;
  strategyVersion?: number;
  alerted?: boolean;
}

export class ExplorationEvidenceError extends Error {
  readonly outcome: ExplorationOutcome;
  readonly terminalCommitFailed: boolean;

  constructor(
    message: string,
    outcome: ExplorationOutcome,
    options?: ErrorOptions & { terminalCommitFailed?: boolean },
  ) {
    super(message, options);
    this.name = "ExplorationEvidenceError";
    this.outcome = outcome;
    this.terminalCommitFailed = options?.terminalCommitFailed === true;
  }
}

function positiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function boundedPositive(name: string, value: number, maximum: number): number {
  const checked = positiveFinite(name, value);
  if (checked > maximum) {
    throw new RangeError(`${name} must be at most USD ${maximum}`);
  }
  return checked;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function configuredRate(env: NodeJS.ProcessEnv): ExplorerRate {
  const input = env.OPENAI_EXPLORER_INPUT_USD_PER_MILLION;
  const output = env.OPENAI_EXPLORER_OUTPUT_USD_PER_MILLION;
  if (input === undefined && output === undefined) return DEFAULT_EXPLORER_RATE;
  if (input === undefined || output === undefined) {
    throw new Error("Both explorer estimate rates must be configured together");
  }
  return {
    inputUsdPerMillion: positiveFinite(
      "OPENAI_EXPLORER_INPUT_USD_PER_MILLION",
      Number(input),
    ),
    outputUsdPerMillion: positiveFinite(
      "OPENAI_EXPLORER_OUTPUT_USD_PER_MILLION",
      Number(output),
    ),
    source: "operator-configured-conservative-rate",
    version: env.OPENAI_EXPLORER_RATE_VERSION?.trim()
      || "operator-configured-unversioned",
  };
}

export function estimateExplorerCost(
  usage: GenerationUsage,
  rate: ExplorerRate = DEFAULT_EXPLORER_RATE,
): number {
  for (const [name, value] of [
    ["inputTokens", usage.inputTokens],
    ["outputTokens", usage.outputTokens],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  return new Decimal(usage.inputTokens)
    .mul(rate.inputUsdPerMillion)
    .plus(new Decimal(usage.outputTokens).mul(rate.outputUsdPerMillion))
    .div(1_000_000)
    .toDecimalPlaces(12)
    .toNumber();
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error) || "Unknown error";
  return redactSandboxText(message).slice(0, 2_000);
}

function zeroUsage(): GenerationUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function reportIsTrusted(report: CandidateValidationReport): boolean {
  return report.attempted === TRUSTED_SAMPLE_SIZE
    && Number.isSafeInteger(report.valid)
    && report.valid >= 0
    && report.valid <= TRUSTED_SAMPLE_SIZE
    && Number.isFinite(report.score)
    && report.score === report.valid / TRUSTED_SAMPLE_SIZE
    && report.score >= TRUSTED_ACTIVATION_SCORE;
}

function candidateForRetailer(
  value: unknown,
  purpose: StrategyPurpose,
  allowedDomains: readonly string[],
): Strategy | null {
  const parsed = StrategySchema.safeParse(value);
  if (!parsed.success || parsed.data.purpose !== purpose) return null;
  if (containsSensitiveMaterial(parsed.data)) return null;
  const allowed = new Set(allowedDomains.map((domain) => domain.toLowerCase()));
  if (parsed.data.allowedDomains.some((domain) => !allowed.has(domain.toLowerCase()))) {
    return null;
  }
  return parsed.data;
}

const SENSITIVE_KEY = /(?:^|[_-])(?:auth(?:orization|entication)?|cookie|credential|password|secret|token|api[_-]?key)(?:$|[_-])/iu;
const SENSITIVE_VALUE = /(?:\bbearer\s+|\bsk-[A-Za-z0-9_-]{12,}|\/(?:home|Users)\/|[A-Za-z]:\\Users\\|[?&](?:auth|key|secret|token)=)/iu;

function containsSensitiveMaterial(value: unknown): boolean {
  if (typeof value === "string") return SENSITIVE_VALUE.test(value);
  if (Array.isArray(value)) return value.some(containsSensitiveMaterial);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    SENSITIVE_KEY.test(key) || containsSensitiveMaterial(child));
}

function defaultValidator(
  purpose: StrategyPurpose,
  dependencies: ExploreRetailerDependencies,
): CandidateValidator {
  if (purpose === "extraction") {
    const execute = dependencies.execute ?? ((strategy, ref) =>
      executeExtraction(strategy, ref));
    return async (strategy, refs) => validateExtractionStrategy(
      ExtractionStrategySchema.parse(strategy),
      refs,
      execute,
    );
  }
  return async (strategy, refs) => {
    const discovery = DiscoveryStrategySchema.parse(strategy);
    const discovered = new Set<string>();
    if (dependencies.discover !== undefined) {
      const result = await dependencies.discover(discovery);
      if (Symbol.asyncIterator in Object(result)) {
        for await (const ref of result as AsyncIterable<ProductRef>) {
          discovered.add(ref.canonicalUrl);
        }
      } else {
        for (const ref of result as readonly ProductRef[]) discovered.add(ref.canonicalUrl);
      }
    } else {
      for await (const ref of executeDiscovery(discovery)) {
        discovered.add(ref.canonicalUrl);
      }
    }
    const valid = refs.filter((ref) => discovered.has(ref.canonicalUrl)).length;
    return {
      attempted: refs.length,
      valid,
      score: refs.length === 0 ? 0 : valid / refs.length,
    };
  };
}

export async function exploreRetailer(
  retailerId: string,
  purpose: StrategyPurpose,
  dependencies: ExploreRetailerDependencies,
): Promise<ExplorationOutcome> {
  const now = dependencies.now ?? (() => new Date());
  const maxAttempts = positiveInteger("maxAttempts", dependencies.maxAttempts ?? 3);
  const eventBudgetUsd = boundedPositive(
    "eventBudgetUsd",
    dependencies.eventBudgetUsd ?? 5,
    MAX_EXPLORATION_EVENT_USD,
  );
  const monthlyBudgetUsd = boundedPositive(
    "monthlyBudgetUsd",
    dependencies.monthlyBudgetUsd ?? 50,
    MAX_MONTHLY_MODEL_USD,
  );
  const rate = dependencies.rate ?? configuredRate(dependencies.env ?? process.env);
  const context = findRetailerExplorationContext(
    dependencies.database,
    retailerId,
    purpose,
  );
  const startedAt = now().toISOString();
  const explorationRunId = beginExplorationRun(dependencies.database, {
    retailerId,
    purpose,
    trigger: dependencies.trigger ?? "manual",
    ...(context.previousStrategy === null
      ? {}
      : { previousStrategyId: context.previousStrategy.id }),
    ...(dependencies.healingEventId === undefined
      ? {}
      : { healingEventId: dependencies.healingEventId }),
    maxAttempts,
    startedAt,
  });
  let attempts = 0;
  let totalCostUsd = 0;
  let externalScore: number | null = null;
  let outcome: ExplorationOutcomeName = "provider_failed";
  let activated: { id: string; version: number } | undefined;
  let finalError: string | undefined;
  let reservationActive = false;
  let explorationFinished = false;
  let specificAlertSent = false;
  const outcomeEvidence = (): ExplorationOutcome => ({
    explorationRunId,
    activated: activated !== undefined,
    attempts,
    externalScore,
    outcome,
    costUsd: totalCostUsd,
    ...(specificAlertSent ? { alerted: true } : {}),
    ...(activated === undefined
      ? {}
      : { strategyId: activated.id, strategyVersion: activated.version }),
  });

  const attemptEvidence = (
    attemptNumber: number,
    prompt: string,
    result: Pick<GenerationResult, "model" | "usage">,
    attemptOutcome: ExplorationOutcomeName,
    options: {
      report?: CandidateValidationReport;
      artifact?: unknown;
      errorMessage?: string;
      costUsd?: number;
      estimateSource?: string;
    } = {},
  ): ExplorationAttemptEvidence => {
    const usage = result.usage;
    const costUsd = options.costUsd ?? estimateExplorerCost(usage, rate);
    return {
      explorationRunId,
      attemptNumber,
      model: result.model,
      promptVersion: EXPLORER_PROMPT_VERSION,
      promptHash: promptHash(prompt),
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
      costUsd,
      costEstimated: true,
      estimateSource: options.estimateSource ?? rate.source,
      rateVersion: rate.version,
      ...(options.report === undefined
        ? {}
        : {
            externalSampleSize: options.report.attempted,
            externalSuccesses: options.report.valid,
            externalScore: options.report.score,
          }),
      outcome: attemptOutcome,
      ...(options.artifact === undefined ? {} : { artifact: options.artifact }),
      ...(options.errorMessage === undefined
        ? {}
        : { errorMessage: options.errorMessage }),
      createdAt: now().toISOString(),
    };
  };
  const record = (
    attemptNumber: number,
    prompt: string,
    result: Pick<GenerationResult, "model" | "usage">,
    attemptOutcome: ExplorationOutcomeName,
    options: {
      report?: CandidateValidationReport;
      artifact?: unknown;
      errorMessage?: string;
      costUsd?: number;
      estimateSource?: string;
    } = {},
  ): void => {
    recordExplorationAttempt(
      dependencies.database,
      attemptEvidence(attemptNumber, prompt, result, attemptOutcome, options),
    );
  };

  try {
    const unavailablePrompt = buildExplorerPrompt({
      purpose,
      allowedDomains: context.allowedDomains,
      eventBudgetUsd,
      attempt: 1,
      maxAttempts,
    });
    if (dependencies.generator === undefined) {
      attempts = 1;
      outcome = "provider_unavailable";
      finalError = "Explorer API credentials are not configured";
      record(1, unavailablePrompt, {
        model: explorerModelFromEnv(dependencies.env ?? process.env),
        usage: zeroUsage(),
      }, outcome, { errorMessage: finalError });
      return {
        explorationRunId,
        activated: false,
        attempts,
        externalScore,
        outcome,
        costUsd: totalCostUsd,
      };
    }

    const refs = listStrategyValidationRefs(
      dependencies.database,
      retailerId,
      TRUSTED_SAMPLE_SIZE,
    );
    if (refs.length !== TRUSTED_SAMPLE_SIZE) {
      attempts = 1;
      outcome = "insufficient_samples";
      finalError = `Trusted validation requires exactly ${TRUSTED_SAMPLE_SIZE} unique references`;
      record(1, unavailablePrompt, {
        model: explorerModelFromEnv(dependencies.env ?? process.env),
        usage: zeroUsage(),
      }, outcome, { errorMessage: finalError });
      return {
        explorationRunId,
        activated: false,
        attempts,
        externalScore,
        outcome,
        costUsd: totalCostUsd,
      };
    }

    const reservation = reserveExplorationBudget(dependencies.database, {
      explorationRunId,
      retailerId,
      eventAllowanceUsd: eventBudgetUsd,
      monthlyLimitUsd: monthlyBudgetUsd,
      now: now(),
    });
    if (!reservation.reserved) {
      attempts = 1;
      outcome = "budget_paused";
      finalError = "Monthly model budget cannot reserve this exploration event";
      record(1, unavailablePrompt, {
        model: explorerModelFromEnv(dependencies.env ?? process.env),
        usage: zeroUsage(),
      }, outcome, { errorMessage: finalError });
      return {
        explorationRunId,
        activated: false,
        attempts,
        externalScore,
        outcome,
        costUsd: totalCostUsd,
      };
    }
    reservationActive = true;

    const validateCandidate = dependencies.validateCandidate
      ?? defaultValidator(purpose, dependencies);
    const packagedSamples = dependencies.sandboxSamples ?? refs.map((ref) => ({
      canonicalUrl: ref.canonicalUrl,
    }));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      if (totalCostUsd >= eventBudgetUsd) {
        outcome = "budget_exhausted";
        break;
      }
      const prompt = buildExplorerPrompt({
        purpose,
        allowedDomains: context.allowedDomains,
        eventBudgetUsd,
        attempt,
        maxAttempts,
      });
      let sandbox: Awaited<ReturnType<typeof createSandboxPackage>> | undefined;
      let result: GenerationResult;
      let generatorInvoked = false;
      let cleanupError: string | undefined;
      try {
        sandbox = await (dependencies.createSandbox ?? createSandboxPackage)({
          retailerId,
          purpose,
          allowedDomains: context.allowedDomains,
          samples: packagedSamples,
          ...(context.previousStrategy === null
            ? {}
            : { oldStrategy: context.previousStrategy.strategy }),
          ...(dependencies.failureSamples === undefined
            ? {}
            : { failureSamples: dependencies.failureSamples }),
        });
        generatorInvoked = true;
        result = await dependencies.generator.generate({
          retailerId,
          purpose,
          allowedDomains: context.allowedDomains,
          workspacePath: sandbox.workspacePath,
          prompt,
        });
      } catch (error) {
        const message = safeError(error);
        result = {
          status: generatorInvoked ? "unauditable_spend" : "failed",
          model: explorerModelFromEnv(dependencies.env ?? process.env),
          usage: zeroUsage(),
          error: message,
        };
      } finally {
        try {
          await sandbox?.dispose();
        } catch (error) {
          cleanupError = safeError(error);
        }
      }
      if (cleanupError !== undefined) {
        result = result.status === "unauditable_spend"
          ? { ...result, error: `${result.error}; sandbox cleanup failed: ${cleanupError}` }
          : {
              status: "safety_failure",
              model: result.model,
              usage: result.usage,
              error: `Sandbox cleanup failed: ${cleanupError}`,
            };
      }

      const bookedCostBeforeAttempt = totalCostUsd;
      const attemptCost = estimateExplorerCost(result.usage, rate);
      if (result.status === "unauditable_spend") {
        const remainingAllowance = Decimal.max(
          0,
          new Decimal(eventBudgetUsd).minus(bookedCostBeforeAttempt),
        ).toNumber();
        totalCostUsd = new Decimal(bookedCostBeforeAttempt)
          .plus(remainingAllowance)
          .toNumber();
        outcome = "unauditable_spend";
        finalError = result.error;
        record(attempt, prompt, result, outcome, {
          errorMessage: finalError,
          costUsd: remainingAllowance,
          estimateSource: "unauditable-remaining-event-reservation",
        });
        try {
          await dependencies.alertSink?.send({
            severity: "error",
            title: "Strategy exploration spend is unauditable",
            message: "A potentially paid model turn returned no auditable usage; the remaining event reservation was charged and no retry was attempted",
            details: {
              retailerId,
              purpose,
              explorationRunId,
              eventBudgetUsd,
              previouslyBookedCostUsd: bookedCostBeforeAttempt,
              chargedCostUsd: remainingAllowance,
            },
          });
          specificAlertSent = true;
        } catch {
          // The durable remaining-reservation charge remains authoritative.
        }
        break;
      }
      totalCostUsd = new Decimal(totalCostUsd).plus(attemptCost).toNumber();
      if (
        totalCostUsd > eventBudgetUsd
      ) {
        outcome = "budget_exhausted";
        finalError = "Model usage reached the configured budget cap";
        record(attempt, prompt, result, outcome, { errorMessage: finalError });
        try {
          await dependencies.alertSink?.send({
            severity: "warning",
            title: "Strategy exploration budget overrun",
            message: "A completed model turn exceeded the reserved event allowance; evidence was retained and no candidate was activated",
            details: {
              retailerId,
              purpose,
              explorationRunId,
              eventBudgetUsd,
              actualCostUsd: totalCostUsd,
            },
          });
          specificAlertSent = true;
        } catch {
          // Budget evidence is authoritative even when the optional alert sink fails.
        }
        break;
      }

      if (result.status === "provider_unavailable") {
        outcome = "provider_unavailable";
        finalError = result.error ?? "Explorer provider is unavailable";
        record(attempt, prompt, result, outcome, { errorMessage: finalError });
        break;
      }
      if (result.status === "safety_failure") {
        outcome = "safety_failure";
        finalError = result.error;
        record(attempt, prompt, result, outcome, { errorMessage: finalError });
        try {
          await dependencies.alertSink?.send({
            severity: "error",
            title: "Strategy exploration cleanup safety failure",
            message: "A model result could not be activated safely after disposable-state cleanup failed; paid evidence was retained and no retry was attempted",
            details: { retailerId, purpose, explorationRunId, actualCostUsd: totalCostUsd },
          });
          specificAlertSent = true;
        } catch {
          // Durable spend evidence remains authoritative when alerting fails.
        }
        break;
      }
      if (result.status === "failed") {
        outcome = "provider_failed";
        finalError = result.error;
        record(attempt, prompt, result, outcome, { errorMessage: finalError });
        continue;
      }

      const strategy = candidateForRetailer(
        result.strategy,
        purpose,
        context.allowedDomains,
      );
      if (strategy === null) {
        outcome = "invalid_candidate";
        finalError = "Candidate failed the strict host schema or domain policy";
        record(attempt, prompt, result, outcome, { errorMessage: finalError });
        continue;
      }

      let report: CandidateValidationReport;
      try {
        report = await validateCandidate(strategy, refs);
      } catch (error) {
        outcome = "validation_failed";
        finalError = safeError(error);
        record(attempt, prompt, result, outcome, {
          artifact: { strategy },
          errorMessage: finalError,
        });
        continue;
      }
      externalScore = Number.isFinite(report.score) ? report.score : null;
      if (!reportIsTrusted(report)) {
        outcome = "validation_failed";
        finalError = "Candidate did not pass the exact trusted 30-sample gate";
        record(attempt, prompt, result, outcome, {
          report,
          artifact: { strategy },
          errorMessage: finalError,
        });
        continue;
      }

      outcome = "activated";
      finalError = undefined;
      const finishedAt = now().toISOString();
      try {
        activated = commitExplorationSuccess(dependencies.database, {
          attempt: attemptEvidence(attempt, prompt, result, outcome, {
            report,
            artifact: { strategy },
          }),
          activation: {
            explorationRunId,
            retailerId,
            purpose,
            ...(context.previousStrategy === null
              ? {}
              : { expectedPreviousStrategyId: context.previousStrategy.id }),
            strategy,
            model: result.model,
            promptVersion: EXPLORER_PROMPT_VERSION,
            validationSampleSize: report.attempted,
            validationSuccesses: report.valid,
            validationScore: report.score,
            activatedAt: finishedAt,
          },
          exploration: {
            outcome,
            finishedAt,
            artifact: {
              activated: true,
              attempts,
              externalScore,
              costEstimated: true,
              estimateSource: rate.source,
              rateVersion: rate.version,
            },
          },
          totalAttempts: attempts,
          totalCostUsd,
          ...(dependencies.healingEventId === undefined
            ? {}
            : { healingEventId: dependencies.healingEventId }),
        });
        explorationFinished = true;
        reservationActive = false;
      } catch (error) {
        outcome = "provider_failed";
        finalError = safeError(error);
        record(attempt, prompt, result, outcome, {
          report,
          artifact: { strategy },
          errorMessage: finalError,
        });
        throw error;
      }
      break;
    }

    return outcomeEvidence();
  } catch (error) {
    if (error instanceof ExplorationEvidenceError) throw error;
    throw new ExplorationEvidenceError(safeError(error), outcomeEvidence(), {
      cause: error,
    });
  } finally {
    const finishedAt = now().toISOString();
    const artifact = {
      activated: activated !== undefined,
      attempts,
      externalScore,
      costEstimated: true,
      estimateSource: rate.source,
      rateVersion: rate.version,
    };
    try {
      if (!explorationFinished) {
        if (dependencies.healingEventId === undefined) {
          finishExplorationRun(dependencies.database, {
            explorationRunId,
            outcome,
            finishedAt,
            artifact,
            ...(finalError === undefined ? {} : { errorMessage: finalError }),
          });
        } else {
          const healingStatus = outcome === "provider_unavailable"
            ? "provider_unavailable" as const
            : outcome === "budget_paused"
                || outcome === "budget_exhausted"
                || outcome === "insufficient_samples"
              ? "deferred" as const
              : "failed" as const;
          try {
            commitExplorationTerminal(dependencies.database, {
              explorationRunId,
              outcome,
              finishedAt,
              artifact,
              ...(finalError === undefined ? {} : { errorMessage: finalError }),
              totalAttempts: attempts,
              totalCostUsd,
              reservationActive,
              healingEventId: dependencies.healingEventId,
              healingStatus,
              healingDetails: {
                explorationRunId,
                explorationOutcome: outcome,
                externalScore,
                costUsd: totalCostUsd,
                alerted: specificAlertSent,
                ...(finalError === undefined ? {} : { error: finalError }),
              },
            });
            explorationFinished = true;
            reservationActive = false;
          } catch (error) {
            throw new ExplorationEvidenceError(safeError(error), outcomeEvidence(), {
              cause: error,
              terminalCommitFailed: true,
            });
          }
        }
      }
    } finally {
      if (reservationActive && dependencies.healingEventId === undefined) {
        settleExplorationBudget(dependencies.database, {
          explorationRunId,
          actualCostUsd: totalCostUsd,
          settledAt: finishedAt,
          release: totalCostUsd === 0,
        });
      }
    }
  }
}
