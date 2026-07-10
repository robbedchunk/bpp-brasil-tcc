import { describe, expect, it } from "vitest";

import {
  finalizeClassificationBatch,
  pollClassificationBatch,
  submitClassificationBatch,
  type OpenAIBatchClient,
} from "../../src/classify/batch.js";
import { buildCli, type CliDependencies } from "../../src/cli.js";
import { openDatabase } from "../../src/db/database.js";
import { BudgetGuard } from "../../src/ops/budget.js";

interface JsonLine {
  custom_id: string;
  method: string;
  url: string;
  body: Record<string, any>;
}

function seed(database: ReturnType<typeof openDatabase>, count = 2): void {
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
  for (let index = 1; index <= count; index += 1) {
    insert.run(`product-${index}`, `https://mercado.test/product-${index}`, `Arroz ${index}`);
  }
}

function successBody(productId: string): Record<string, unknown> {
  return {
    id: `resp-${productId}`,
    status: "completed",
    model: "gpt-5.6-luna-2026-06-30",
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          results: [{
            productId,
            ipcaItemId: "ipca-arroz",
            confidence: 0.96,
            rationaleCode: "exact_food_match",
          }],
        }),
      }],
    }],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  };
}

class FakeBatchClient implements OpenAIBatchClient {
  uploadedJsonl = "";
  createdBody: Record<string, unknown> | null = null;
  downloaded: string[] = [];
  state: Record<string, any> = {
    id: "batch-1",
    object: "batch",
    endpoint: "/v1/responses",
    input_file_id: "file-input",
    completion_window: "24h",
    created_at: 1_784_000_000,
    status: "in_progress",
    request_counts: { total: 2, completed: 0, failed: 0 },
  };
  outputText = "";
  errorText = "";

  readonly files: OpenAIBatchClient["files"] = {
    create: async (body) => {
      expect(body.purpose).toBe("batch");
      this.uploadedJsonl = await body.file.text();
      return { id: "file-input" };
    },
    content: async (fileId) => {
      this.downloaded.push(fileId);
      return new Response(fileId === "file-output" ? this.outputText : this.errorText);
    },
  };

  readonly batches: OpenAIBatchClient["batches"] = {
    create: async (body) => {
      this.createdBody = body;
      return this.state;
    },
    retrieve: async () => this.state,
  };
}

function options(version = 2) {
  return { confidenceThreshold: 0.8, version };
}

function dependencies(
  database: ReturnType<typeof openDatabase>,
  client?: OpenAIBatchClient,
) {
  return {
    database,
    ...(client === undefined ? {} : { client }),
    budgetGuard: new BudgetGuard(),
    model: "gpt-5.6-luna",
    now: () => new Date("2026-07-10T12:00:00.000Z"),
  };
}

async function invokeCli(
  arguments_: string[],
  dependencies_: CliDependencies,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  const command = buildCli({
    ...dependencies_,
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

describe("asynchronous OpenAI classification batches", () => {
  it("exposes a locked operator CLI for asynchronous submission", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const client = new FakeBatchClient();
      const result = await invokeCli([
        "classify-batch",
        "submit",
        "--version",
        "2",
        "--json",
      ], {
        database,
        env: {
          PROJECT_ROOT: process.cwd(),
          OPENAI_API_KEY: "fixture-key",
          OPENAI_CLASSIFICATION_MODEL: "gpt-5.6-luna",
        },
        classificationBatchClient: client,
      });

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "submitted", submitted: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM classification_batch_jobs").get())
        .toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("persists JSONL upload and /v1/responses batch submission lifecycle", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const client = new FakeBatchClient();

      const submitted = await submitClassificationBatch(options(), dependencies(database, client));

      expect(submitted).toMatchObject({
        providerBatchId: "batch-1",
        status: "submitted",
        submitted: 2,
      });
      expect(client.createdBody).toMatchObject({
        completion_window: "24h",
        endpoint: "/v1/responses",
        input_file_id: "file-input",
      });
      const lines = client.uploadedJsonl.trim().split("\n").map((line) => JSON.parse(line) as JsonLine);
      expect(lines).toHaveLength(2);
      expect(new Set(lines.map((line) => line.custom_id)).size).toBe(2);
      expect(lines[0]).toMatchObject({
        method: "POST",
        url: "/v1/responses",
        body: {
          model: "gpt-5.6-luna",
          store: false,
          text: { format: { type: "json_schema", strict: true } },
        },
      });
      expect(database.prepare("SELECT status, total_items FROM classification_batch_jobs").get())
        .toEqual({ status: "submitted", total_items: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM classification_batch_items").get())
        .toEqual({ count: 2 });
      expect(database.prepare("SELECT status FROM classification_batch_events ORDER BY occurred_at, id").all())
        .toEqual([{ status: "preparing" }, { status: "submitted" }]);
    } finally {
      database.close();
    }
  });

  it("polls, downloads output and error JSONL, reconciles custom IDs, and finalizes partial evidence atomically", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const client = new FakeBatchClient();
      const submitted = await submitClassificationBatch(options(), dependencies(database, client));
      const mappings = database.prepare(`
        SELECT custom_id, product_id FROM classification_batch_items ORDER BY product_id
      `).all() as Array<{ custom_id: string; product_id: string }>;
      client.outputText = `${JSON.stringify({
        id: "batch-request-1",
        custom_id: mappings[0]?.custom_id,
        response: {
          status_code: 200,
          request_id: "request-1",
          body: successBody("product-1"),
        },
        error: null,
      })}\n`;
      client.errorText = `${JSON.stringify({
        id: "batch-request-2",
        custom_id: mappings[1]?.custom_id,
        response: null,
        error: { code: "server_error", message: "failed" },
      })}\n`;
      client.state = {
        ...client.state,
        status: "completed",
        output_file_id: "file-output",
        error_file_id: "file-error",
        model: "gpt-5.6-luna",
        request_counts: { total: 2, completed: 1, failed: 1 },
        usage: {
          input_tokens: 140,
          output_tokens: 25,
          total_tokens: 165,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };

      await expect(pollClassificationBatch(submitted.jobId, dependencies(database, client)))
        .resolves.toMatchObject({ status: "completed", completed: 1, failed: 1 });
      const finalized = await finalizeClassificationBatch(
        submitted.jobId,
        dependencies(database, client),
      );

      expect(finalized).toMatchObject({
        classified: 1,
        failed: 1,
        pending: 1,
        status: "finalized_partial",
      });
      expect(client.downloaded).toEqual(["file-output", "file-error"]);
      expect(database.prepare(`
        SELECT product_id, model, decision FROM classifications
      `).get()).toEqual({
        product_id: "product-1",
        model: "gpt-5.6-luna-2026-06-30",
        decision: "1101002",
      });
      expect(database.prepare(`
        SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
               SUM(classification_id IS NULL) AS failure_rows
        FROM cost_ledger
      `).get()).toEqual({ input_tokens: 140, output_tokens: 25, failure_rows: 1 });
      expect(database.prepare("SELECT status FROM classification_batch_jobs").get())
        .toEqual({ status: "finalized_partial" });
      expect(database.prepare(`
        SELECT status FROM classification_batch_events ORDER BY occurred_at, id
      `).all()).toEqual(expect.arrayContaining([
        { status: "preparing" },
        { status: "submitted" },
        { status: "completed" },
        { status: "finalized_partial" },
      ]));
    } finally {
      database.close();
    }
  });

  it("fails closed on strict schema/custom-ID invalid output while retaining aggregate billed usage", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database, 1);
      const client = new FakeBatchClient();
      client.state.request_counts = { total: 1, completed: 0, failed: 0 };
      const submitted = await submitClassificationBatch(options(3), dependencies(database, client));
      const mapping = database.prepare("SELECT custom_id FROM classification_batch_items").get() as {
        custom_id: string;
      };
      client.outputText = `${JSON.stringify({
        id: "batch-request-bad",
        custom_id: mapping.custom_id,
        response: {
          status_code: 200,
          request_id: "request-bad",
          body: {
            ...successBody("product-1"),
            output: [{
              type: "message",
              content: [{
                type: "output_text",
                text: JSON.stringify({
                  results: [{
                    productId: "product-1",
                    ipcaItemId: "ipca-arroz",
                    confidence: 0.9,
                    rationaleCode: "match",
                    unexpected: true,
                  }],
                }),
              }],
            }],
          },
        },
        error: null,
      })}\n`;
      client.state = {
        ...client.state,
        status: "completed",
        output_file_id: "file-output",
        request_counts: { total: 1, completed: 1, failed: 0 },
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };

      await pollClassificationBatch(submitted.jobId, dependencies(database, client));
      await expect(finalizeClassificationBatch(submitted.jobId, dependencies(database, client)))
        .rejects.toThrow();
      expect(database.prepare("SELECT COUNT(*) AS count FROM classifications").get())
        .toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT category, input_tokens, output_tokens FROM cost_ledger
      `).get()).toEqual({
        category: "classification_failure",
        input_tokens: 100,
        output_tokens: 20,
      });
      expect(database.prepare("SELECT status FROM classification_batch_jobs").get())
        .toEqual({ status: "finalize_failed" });
    } finally {
      database.close();
    }
  });

  it("returns pending without creating a job or making a call when no client/key exists", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const result = await submitClassificationBatch(options(), dependencies(database));
      expect(result).toMatchObject({ pending: 2, status: "provider_unavailable", submitted: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM classification_batch_jobs").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
