import { describe, expect, it } from "vitest";
import { APIConnectionError } from "openai";

import {
  reconcileUnknownSubmissions,
  submitClassificationBatch,
  SUBMISSION_RECONCILE_LIST_LIMIT,
  type OpenAIBatchClient,
  type RemoteBatch,
} from "../../src/classify/batch.js";
import { openDatabase } from "../../src/db/database.js";
import {
  BudgetGuard,
  classificationMonthlyCommittedUsd,
} from "../../src/ops/budget.js";

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
      (id, retailer_id, canonical_url, title, brand, source_category,
       descriptive_title, first_seen, last_seen)
    VALUES (?, 'retailer', ?, ?, 'Marca', 'Mercearia', 1,
            '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `);
  for (let index = 1; index <= count; index += 1) {
    insert.run(`product-${index}`, `https://mercado.test/product-${index}`, `Arroz ${index}`);
  }
}

/** Uploads succeed; batch creation loses every response so the submission
 * outcome is unknown. The listing contents are controlled per test. */
class AmbiguousBatchClient implements OpenAIBatchClient {
  createCalls = 0;
  listCalls = 0;
  createLosesResponse = true;
  listData: RemoteBatch[] = [];
  lastCreatedJobId: string | undefined;

  readonly files: OpenAIBatchClient["files"] = {
    create: async () => ({ id: "file-input" }),
    content: async () => new Response(""),
  };

  readonly batches: OpenAIBatchClient["batches"] = {
    create: async (body) => {
      this.createCalls += 1;
      this.lastCreatedJobId = body.metadata.local_job_id;
      if (this.createLosesResponse) {
        throw new APIConnectionError({ message: "response lost after create" });
      }
      return {
        id: `batch-created-${this.createCalls}`,
        status: "in_progress",
        input_file_id: body.input_file_id,
        metadata: body.metadata,
      };
    },
    retrieve: async () => {
      throw new Error("retrieve is not expected in these tests");
    },
    list: async () => {
      this.listCalls += 1;
      return { data: this.listData };
    },
  };
}

function remoteFor(jobId: string, overrides: Partial<RemoteBatch> = {}): RemoteBatch {
  return {
    id: "batch-remote-1",
    status: "in_progress",
    input_file_id: "file-input",
    model: "gpt-5.6-luna-2026-06-30",
    metadata: { local_job_id: jobId, classification_version: "2" },
    ...overrides,
  };
}

function dependencies(
  database: ReturnType<typeof openDatabase>,
  client?: OpenAIBatchClient,
  at = "2026-07-16T12:00:00.000Z",
) {
  return {
    database,
    ...(client === undefined ? {} : { client }),
    budgetGuard: new BudgetGuard(),
    model: "gpt-5.6-luna",
    now: () => new Date(at),
    sleep: async () => {},
    maxAttempts: 1,
  };
}

async function strandUnknownSubmission(
  database: ReturnType<typeof openDatabase>,
  client: AmbiguousBatchClient,
): Promise<string> {
  await expect(submitClassificationBatch(
    { version: 2, confidenceThreshold: 0.8 },
    dependencies(database, client),
  )).rejects.toThrow(/lost/u);
  const row = database.prepare(
    "SELECT id, status FROM classification_batch_jobs",
  ).get() as { id: string; status: string };
  expect(row.status).toBe("submission_unknown");
  return row.id;
}

describe("submission_unknown reconciliation", () => {
  it("adopts a remote batch found by local job metadata so poll/finalize can settle it", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const client = new AmbiguousBatchClient();
      const jobId = await strandUnknownSubmission(database, client);
      const committedWhileUnknown = classificationMonthlyCommittedUsd(
        database,
        new Date("2026-07-16T12:00:00.000Z"),
      );
      expect(committedWhileUnknown).toBeGreaterThan(0);
      client.listData = [remoteFor(jobId)];

      const results = await reconcileUnknownSubmissions(
        dependencies(database, client, "2026-07-16T12:05:00.000Z"),
      );

      expect(results).toEqual([{
        jobId,
        outcome: "adopted",
        providerBatchId: "batch-remote-1",
      }]);
      expect(database.prepare(`
        SELECT status, provider_batch_id, actual_model, error_message
        FROM classification_batch_jobs WHERE id = ?
      `).get(jobId)).toEqual({
        status: "submitted",
        provider_batch_id: "batch-remote-1",
        actual_model: "gpt-5.6-luna-2026-06-30",
        error_message: null,
      });
      expect(database.prepare(`
        SELECT status FROM classification_batch_events
        WHERE job_id = ? ORDER BY occurred_at, id
      `).all(jobId)).toEqual([
        { status: "preparing" },
        { status: "submission_unknown" },
        { status: "submitted" },
      ]);
      // The adopted job keeps its budget commitment: the remote request is real.
      expect(classificationMonthlyCommittedUsd(
        database,
        new Date("2026-07-16T12:00:00.000Z"),
      )).toBeCloseTo(committedWhileUnknown, 10);
    } finally {
      database.close();
    }
  });

  it("releases an unknown submission only when the provider listing is exhaustive, freeing budget and products", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const client = new AmbiguousBatchClient();
      const jobId = await strandUnknownSubmission(database, client);
      client.listData = [remoteFor("some-other-job", { id: "batch-unrelated" })];

      const results = await reconcileUnknownSubmissions(dependencies(database, client));

      expect(results).toEqual([{ jobId, outcome: "released", providerBatchId: null }]);
      expect(database.prepare(
        "SELECT status FROM classification_batch_jobs WHERE id = ?",
      ).get(jobId)).toEqual({ status: "submission_released" });
      expect(classificationMonthlyCommittedUsd(
        database,
        new Date("2026-07-16T12:00:00.000Z"),
      )).toBe(0);

      // The released products are eligible again and resubmit cleanly.
      client.createLosesResponse = false;
      const resubmitted = await submitClassificationBatch(
        { version: 2, confidenceThreshold: 0.8 },
        dependencies(database, client),
      );
      expect(resubmitted).toMatchObject({ status: "submitted", submitted: 2 });
    } finally {
      database.close();
    }
  });

  it("keeps the fail-closed hold when the listing may be incomplete", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const client = new AmbiguousBatchClient();
      const jobId = await strandUnknownSubmission(database, client);
      client.listData = Array.from(
        { length: SUBMISSION_RECONCILE_LIST_LIMIT },
        (_, index) => remoteFor(`unrelated-${index}`, { id: `batch-noise-${index}` }),
      );

      const results = await reconcileUnknownSubmissions(dependencies(database, client));

      expect(results).toEqual([{ jobId, outcome: "unresolved", providerBatchId: null }]);
      expect(database.prepare(
        "SELECT status FROM classification_batch_jobs WHERE id = ?",
      ).get(jobId)).toEqual({ status: "submission_unknown" });
      // The held claim still blocks a duplicate paid submission of the products.
      const blocked = await submitClassificationBatch(
        { version: 2, confidenceThreshold: 0.8 },
        dependencies(database, client),
      );
      expect(blocked).toMatchObject({ eligible: 0, status: "completed" });
      expect(client.createCalls).toBe(1);
    } finally {
      database.close();
    }
  });

  it("leaves unknown submissions untouched without a provider client", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const client = new AmbiguousBatchClient();
      const jobId = await strandUnknownSubmission(database, client);

      const results = await reconcileUnknownSubmissions(dependencies(database));

      expect(results).toEqual([{ jobId, outcome: "unresolved", providerBatchId: null }]);
      expect(database.prepare(
        "SELECT status FROM classification_batch_jobs WHERE id = ?",
      ).get(jobId)).toEqual({ status: "submission_unknown" });
    } finally {
      database.close();
    }
  });

  it("is a no-op without unknown submissions", async () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const client = new AmbiguousBatchClient();
      await expect(reconcileUnknownSubmissions(dependencies(database, client)))
        .resolves.toEqual([]);
      expect(client.listCalls).toBe(0);
    } finally {
      database.close();
    }
  });
});
