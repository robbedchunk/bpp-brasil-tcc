import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";

import { executeExtraction } from "../collection/executor.js";
import {
  activateGeneratedStrategy,
  beginExplorationRun,
  findRetailerExplorationContext,
  finishExplorationRun,
  listStrategyValidationRefs,
  recordExplorationAttempt,
} from "../db/repositories.js";
import { executeDiscovery } from "../discovery/executor.js";
import { classificationMonthlyCommittedUsd } from "../ops/budget.js";
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
}

export type ExplorationOutcomeName =
  | "activated"
  | "validation_failed"
  | "invalid_candidate"
  | "provider_unavailable"
  | "provider_failed"
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
}

function positiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
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
  const eventBudgetUsd = positiveFinite(
    "eventBudgetUsd",
    dependencies.eventBudgetUsd ?? 5,
  );
  const monthlyBudgetUsd = positiveFinite(
    "monthlyBudgetUsd",
    dependencies.monthlyBudgetUsd ?? 50,
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
    maxAttempts,
    startedAt,
  });
  let attempts = 0;
  let totalCostUsd = 0;
  let externalScore: number | null = null;
  let outcome: ExplorationOutcomeName = "provider_failed";
  let activated: { id: string; version: number } | undefined;
  let finalError: string | undefined;

  const record = (
    attemptNumber: number,
    prompt: string,
    result: Pick<GenerationResult, "model" | "usage">,
    attemptOutcome: ExplorationOutcomeName,
    options: {
      report?: CandidateValidationReport;
      artifact?: unknown;
      errorMessage?: string;
    } = {},
  ): void => {
    const usage = result.usage;
    const costUsd = estimateExplorerCost(usage, rate);
    recordExplorationAttempt(dependencies.database, {
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
      estimateSource: rate.source,
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
    });
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

    const monthlyCommittedBefore = classificationMonthlyCommittedUsd(
      dependencies.database,
      now(),
    );
    if (monthlyCommittedBefore + eventBudgetUsd > monthlyBudgetUsd) {
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
      try {
        sandbox = await createSandboxPackage({
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
          status: "failed",
          model: explorerModelFromEnv(dependencies.env ?? process.env),
          usage: zeroUsage(),
          error: message,
        };
      } finally {
        await sandbox?.dispose();
      }

      const attemptCost = estimateExplorerCost(result.usage, rate);
      totalCostUsd = new Decimal(totalCostUsd).plus(attemptCost).toNumber();
      if (
        totalCostUsd > eventBudgetUsd
        || monthlyCommittedBefore + totalCostUsd > monthlyBudgetUsd
      ) {
        outcome = "budget_exhausted";
        finalError = "Model usage reached the configured budget cap";
        record(attempt, prompt, result, outcome, { errorMessage: finalError });
        break;
      }

      if (result.status === "provider_unavailable") {
        outcome = "provider_unavailable";
        finalError = result.error ?? "Explorer provider is unavailable";
        record(attempt, prompt, result, outcome, { errorMessage: finalError });
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

      activated = activateGeneratedStrategy(dependencies.database, {
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
        activatedAt: now().toISOString(),
      });
      outcome = "activated";
      finalError = undefined;
      record(attempt, prompt, result, outcome, { report, artifact: { strategy } });
      break;
    }

    return {
      explorationRunId,
      activated: activated !== undefined,
      attempts,
      externalScore,
      outcome,
      costUsd: totalCostUsd,
      ...(activated === undefined
        ? {}
        : { strategyId: activated.id, strategyVersion: activated.version }),
    };
  } finally {
    finishExplorationRun(dependencies.database, {
      explorationRunId,
      outcome,
      finishedAt: now().toISOString(),
      artifact: {
        activated: activated !== undefined,
        attempts,
        externalScore,
        costEstimated: true,
        estimateSource: rate.source,
        rateVersion: rate.version,
      },
      ...(finalError === undefined ? {} : { errorMessage: finalError }),
    });
  }
}
