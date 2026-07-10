import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from "openai";
import { afterEach, describe, expect, it } from "vitest";

import { classifyNewProducts } from "../../src/classify/classify.js";
import {
  classificationModelFromEnv,
  OpenAIProductClassifier,
} from "../../src/classify/openai-provider.js";
import type {
  ClassificationBatchResult,
  ClassificationInput,
  ProductClassifier,
} from "../../src/classify/provider.js";
import { buildCli, type CliDependencies } from "../../src/cli.js";
import { openDatabase } from "../../src/db/database.js";
import { BudgetGuard, type ModelTokenUsage } from "../../src/ops/budget.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) =>
  rm(directory, { force: true, recursive: true }))));

function seed(database: ReturnType<typeof openDatabase>, count = 1): string[] {
  database.exec(`
    INSERT INTO retailers (id, name, base_url, cep, domains_json)
    VALUES ('retailer', 'Mercado', 'https://mercado.test', '01310-100', '["mercado.test"]');
    INSERT INTO ipca_items
      (id, code, name, weight, weight_period, source_url, citation)
    VALUES
      ('ipca-arroz', '1101002', 'Arroz', 0.4030, '2019-12', 'https://ibge.test', 'IBGE');
  `);
  const insert = database.prepare(`
    INSERT INTO products
      (id, retailer_id, canonical_url, title, brand, source_category, first_seen, last_seen)
    VALUES (?, 'retailer', ?, ?, 'Marca', 'Mercearia',
            '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `);
  return Array.from({ length: count }, (_, index) => {
    const id = `product-${index + 1}`;
    insert.run(id, `https://mercado.test/${id}`, `Arroz ${index + 1}`);
    return id;
  });
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resp-audited",
    status: "completed",
    model: "gpt-5.6-luna-2026-06-30",
    output: [],
    output_parsed: {
      results: [{
        productId: "product-1",
        ipcaItemId: "ipca-arroz",
        confidence: 0.95,
        rationaleCode: "exact_food_match",
      }],
    },
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    ...overrides,
  };
}

const providerInput: ClassificationInput = {
  productId: "product-1",
  title: "Arroz 1",
  brand: "Marca",
  sourceCategory: "Mercearia",
  allowedItems: [{ id: "ipca-arroz", code: "1101002", name: "Arroz" }],
};

class FixtureClassifier implements ProductClassifier {
  calls = 0;
  readonly model: string;
  readonly gate?: Promise<void>;

  constructor(model = "gpt-5.6-luna-2026-06-30", gate?: Promise<void>) {
    this.model = model;
    this.gate = gate;
  }

  async classify(inputs: readonly ClassificationInput[]): Promise<ClassificationBatchResult> {
    this.calls += 1;
    await this.gate;
    return {
      provider: "fixture",
      model: this.model,
      promptVersion: "fixture-v1",
      promptHash: "b".repeat(64),
      results: inputs.map((input) => ({
        productId: input.productId,
        ipcaItemId: "ipca-arroz",
        confidence: 0.95,
        rationaleCode: "exact_food_match",
      })),
      usage: { inputTokens: inputs.length * 10, outputTokens: inputs.length * 2 },
      failedAttempts: [],
    };
  }
}

async function invokeCli(
  arguments_: string[],
  dependencies: CliDependencies,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  const command = buildCli({
    ...dependencies,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  command.exitOverride();
  try {
    await command.parseAsync(["node", "precos", ...arguments_]);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return {
      stdout,
      stderr,
      exitCode: typeof error === "object" && error !== null && "exitCode" in error
        ? Number(error.exitCode)
        : 1,
    };
  }
}

describe("reviewed OpenAI provider evidence", () => {
  it("retains billed usage when strict parsing throws at the raw SDK response boundary", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const provider = new OpenAIProductClassifier({
        client: {
          responses: {
            create: async () => response({
              output: [{
                type: "message",
                content: [{ type: "output_text", text: "{not valid json" }],
              }],
            }),
          },
        },
        env: {},
      });

      await expect(classifyNewProducts({
        batchSize: 50,
        confidenceThreshold: 0.8,
        version: 1,
      }, { database, provider, budgetGuard: new BudgetGuard() })).rejects.toThrow();
      expect(database.prepare(`
        SELECT model, input_tokens, output_tokens,
               json_extract(details_json, '$.failureKind') AS failure_kind
        FROM cost_ledger WHERE category = 'classification_failure'
      `).get()).toEqual({
        model: "gpt-5.6-luna-2026-06-30",
        input_tokens: 100,
        output_tokens: 20,
        failure_kind: "schema_invalid",
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM classifications").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it.each([
    ["connection", new APIConnectionError({
      message: "connection reset",
      cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }),
    })],
    ["timeout", new APIConnectionTimeoutError({ message: "timeout" })],
    ["rate limit", new RateLimitError(429, { message: "limited" }, "limited", new Headers())],
    ["server", new InternalServerError(503, { message: "down" }, "down", new Headers())],
  ])("retries the real SDK %s error class", async (_label, transientError) => {
    let attempts = 0;
    const provider = new OpenAIProductClassifier({
      client: {
        responses: {
          parse: async () => {
            attempts += 1;
            if (attempts === 1) throw transientError;
            return response();
          },
        },
      },
      env: {},
      sleep: async () => {},
    });

    await expect(provider.classify([providerInput])).resolves.toMatchObject({
      model: "gpt-5.6-luna-2026-06-30",
    });
    expect(attempts).toBe(2);
  });

  it("does not retry a real SDK authentication error", async () => {
    let attempts = 0;
    const provider = new OpenAIProductClassifier({
      client: {
        responses: {
          parse: async () => {
            attempts += 1;
            throw new AuthenticationError(
              401,
              { message: "bad key" },
              "bad key",
              new Headers(),
            );
          },
        },
      },
      env: {},
      sleep: async () => {},
    });

    await expect(provider.classify([providerInput])).rejects.toThrow("bad key");
    expect(attempts).toBe(1);
  });

  it("carries actual snapshot and billed usage on an incomplete response", async () => {
    const provider = new OpenAIProductClassifier({
      client: {
        responses: {
          parse: async () => response({ status: "incomplete", output_parsed: null }),
        },
      },
      env: {},
    });

    const error = await provider.classify([providerInput]).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "ClassificationProviderError",
      attempts: [{
        actualModel: "gpt-5.6-luna-2026-06-30",
        failureKind: "incomplete",
        inputTokens: 100,
        outputTokens: 20,
        responseId: "resp-audited",
      }],
    });
  });
});

describe("billed failure and retry accounting", () => {
  it("records billed usage when host validation rejects a custom provider result", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const invalidProvider: ProductClassifier = {
        classify: async () => ({
          provider: "custom",
          model: "custom-snapshot",
          promptVersion: "custom-v1",
          promptHash: "c".repeat(64),
          results: [],
          usage: { inputTokens: 70, outputTokens: 7 },
        }),
      };

      await expect(classifyNewProducts({
        batchSize: 50,
        confidenceThreshold: 0.8,
        version: 1,
      }, { database, provider: invalidProvider, budgetGuard: new BudgetGuard() }))
        .rejects.toThrow(/exactly one/iu);
      expect(database.prepare(`
        SELECT category, provider, model, input_tokens, output_tokens,
               json_extract(details_json, '$.failureKind') AS failure_kind
        FROM cost_ledger
      `).get()).toEqual({
        category: "classification_failure",
        provider: "custom",
        model: "custom-snapshot",
        input_tokens: 70,
        output_tokens: 7,
        failure_kind: "validation_failed",
      });
    } finally {
      database.close();
    }
  });

  it.each([
    ["incomplete", { status: "incomplete", output_parsed: null }],
    ["refusal", {
      output_parsed: null,
      output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot classify" }] }],
    }],
    ["schema_invalid", {
      output_parsed: { results: [{ productId: "product-1", unexpected: true }] },
    }],
  ])("persists %s response usage without a classification", async (failureKind, overrides) => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const provider = new OpenAIProductClassifier({
        client: { responses: { parse: async () => response(overrides) } },
        env: {},
      });

      await expect(classifyNewProducts({
        batchSize: 50,
        confidenceThreshold: 0.8,
        version: 1,
      }, {
        database,
        provider,
        budgetGuard: new BudgetGuard(),
        now: () => new Date("2026-07-10T12:00:00.000Z"),
      })).rejects.toThrow();

      expect(database.prepare("SELECT COUNT(*) AS count FROM classifications").get())
        .toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT category, classification_id, model, input_tokens, output_tokens,
               cost_usd, json_extract(details_json, '$.failureKind') AS failure_kind
        FROM cost_ledger
      `).get()).toMatchObject({
        category: "classification_failure",
        classification_id: null,
        model: "gpt-5.6-luna-2026-06-30",
        input_tokens: 100,
        output_tokens: 20,
        cost_usd: expect.any(Number),
        failure_kind: failureKind,
      });
    } finally {
      database.close();
    }
  });

  it("persists a billed transient retry as well as the successful classification", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      let attempts = 0;
      const transient = Object.assign(new APIConnectionError({ message: "retry" }), {
        classificationAttempt: {
          actualModel: "gpt-5.6-luna-2026-06-30",
          failureKind: "transient_response_error",
          inputTokens: 40,
          outputTokens: 4,
          responseId: "resp-retry",
        },
      });
      const provider = new OpenAIProductClassifier({
        client: {
          responses: {
            parse: async () => {
              attempts += 1;
              if (attempts === 1) throw transient;
              return response();
            },
          },
        },
        env: {},
        sleep: async () => {},
      });

      await classifyNewProducts({ batchSize: 50, confidenceThreshold: 0.8, version: 1 }, {
        database,
        provider,
        budgetGuard: new BudgetGuard(),
      });

      expect(database.prepare("SELECT COUNT(*) AS count FROM classifications").get())
        .toEqual({ count: 1 });
      expect(database.prepare(`
        SELECT category, classification_id IS NULL AS without_classification,
               input_tokens, output_tokens
        FROM cost_ledger ORDER BY category
      `).all()).toEqual([
        {
          category: "classification",
          without_classification: 0,
          input_tokens: 100,
          output_tokens: 20,
        },
        {
          category: "classification_failure",
          without_classification: 1,
          input_tokens: 40,
          output_tokens: 4,
        },
      ]);
    } finally {
      database.close();
    }
  });
});

describe("classification auditability and serialization", () => {
  it.each([
    "preparing",
    "submitted",
    "validating",
    "in_progress",
    "finalizing",
    "cancelling",
    "completed",
    "failed",
    "expired",
    "cancelled",
    "finalize_retryable",
  ])("does not synchronously bill a product/version claimed by a %s Batch job", async (status) => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      database.prepare(`
        INSERT INTO classification_batch_jobs
          (id, provider, version, confidence_threshold, requested_model,
           prompt_version, prompt_hash, input_sha256, status, total_items,
           created_at, updated_at)
        VALUES
          ('job-active', 'openai', 1, 0.8, 'gpt-5.6-luna', 'prompt-v1',
           '${"d".repeat(64)}', '${"e".repeat(64)}', ?, 1,
           '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z')
      `).run(status);
      database.exec(`
        INSERT INTO classification_batch_items
          (id, job_id, custom_id, product_id, input_json, created_at)
        VALUES
          ('item-active', 'job-active', 'custom-active', 'product-1', '{}',
           '2026-07-10T12:00:00.000Z');
      `);
      const provider = new FixtureClassifier();

      await expect(classifyNewProducts({
        batchSize: 50,
        confidenceThreshold: 0.8,
        version: 1,
      }, { database, provider, budgetGuard: new BudgetGuard() })).resolves.toMatchObject({
        eligible: 0,
        status: "completed",
      });
      expect(provider.calls).toBe(0);
    } finally {
      database.close();
    }
  });

  it.each([
    ["projected", 50, null],
    ["actual", 0, 50],
  ])("adds an active Batch %s commitment to synchronous monthly budget", async (
    _kind,
    projectedCost,
    actualCost,
  ) => {
    const database = openDatabase(":memory:");
    try {
      seed(database, 2);
      database.prepare(`
        INSERT INTO classification_batch_jobs
          (id, provider, version, confidence_threshold, requested_model,
           prompt_version, prompt_hash, input_sha256, status, total_items,
           projected_cost_usd, actual_cost_usd, created_at, updated_at)
        VALUES
          ('job-budget', 'openai', 1, 0.8, 'gpt-5.6-luna', 'prompt-v1',
           ?, ?, 'in_progress', 1, ?, ?,
           '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z')
      `).run("d".repeat(64), "e".repeat(64), projectedCost, actualCost);
      database.exec(`
        INSERT INTO classification_batch_items
          (id, job_id, custom_id, product_id, input_json, created_at)
        VALUES
          ('item-budget', 'job-budget', 'custom-budget', 'product-1', '{}',
           '2026-07-10T12:00:00.000Z')
      `);
      const provider = new FixtureClassifier();

      await expect(classifyNewProducts({
        batchSize: 50,
        confidenceThreshold: 0.8,
        version: 1,
      }, {
        database,
        provider,
        budgetGuard: new BudgetGuard(50),
        now: () => new Date("2026-07-10T12:00:00.000Z"),
      })).resolves.toMatchObject({ status: "budget_denied", pending: 1 });
      expect(provider.calls).toBe(0);
    } finally {
      database.close();
    }
  });

  it("returns completed before requiring a provider when no work is eligible", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      await classifyNewProducts({ batchSize: 50, confidenceThreshold: 0.8, version: 1 }, {
        database,
        provider: new FixtureClassifier(),
        budgetGuard: new BudgetGuard(),
      });

      await expect(classifyNewProducts({
        batchSize: 50,
        confidenceThreshold: 0.8,
        version: 1,
      }, { database, budgetGuard: new BudgetGuard() })).resolves.toMatchObject({
        eligible: 0,
        pending: 0,
        status: "completed",
      });
    } finally {
      database.close();
    }
  });

  it("uses one shared environment model for provider creation and budget preflight", async () => {
    expect(classificationModelFromEnv({ OPENAI_CLASSIFICATION_MODEL: "  shared-model  " }))
      .toBe("shared-model");
    expect(classificationModelFromEnv({})).toBe("gpt-5.6-luna");

    const database = openDatabase(":memory:");
    try {
      seed(database);
      const factoryModels: string[] = [];
      class CapturingBudgetGuard extends BudgetGuard {
        readonly models: string[] = [];
        override estimateModelCost(usage: ModelTokenUsage): number {
          this.models.push(usage.model);
          return super.estimateModelCost(usage);
        }
      }
      const budgetGuard = new CapturingBudgetGuard();
      const result = await invokeCli(["classify", "--json"], {
        database,
        env: {
          PROJECT_ROOT: process.cwd(),
          OPENAI_API_KEY: "fixture-key",
          OPENAI_CLASSIFICATION_MODEL: " shared-model ",
        },
        budgetGuard,
        productClassifierFactory: (model) => {
          factoryModels.push(model);
          return new FixtureClassifier("shared-model-snapshot");
        },
      });

      expect(result.exitCode).toBe(0);
      expect(factoryModels).toEqual(["shared-model"]);
      expect(budgetGuard.models[0]).toBe("shared-model");
    } finally {
      database.close();
    }
  });

  it("holds the process lock across provider billing so a contender cannot duplicate work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-classify-lock-"));
    directories.push(directory);
    const lockPath = join(directory, "classify.lock");
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const gate = Promise.withResolvers<void>();
      const provider = new FixtureClassifier("gpt-5.6-luna-snapshot", gate.promise);
      const dependencies: CliDependencies = {
        database,
        env: { PROJECT_ROOT: process.cwd() },
        lockPath,
        productClassifier: provider,
      };

      const first = invokeCli(["classify", "--json"], dependencies);
      while (provider.calls === 0) await new Promise((resolve) => setImmediate(resolve));
      const second = invokeCli(["classify", "--json"], dependencies);
      await new Promise((resolve) => setImmediate(resolve));

      expect(provider.calls).toBe(1);
      gate.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.exitCode).toBe(0);
      expect([0, 1]).toContain(secondResult.exitCode);
      expect(database.prepare("SELECT COUNT(*) AS count FROM classifications").get())
        .toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM cost_ledger").get())
        .toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});
