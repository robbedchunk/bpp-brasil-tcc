import { describe, expect, it } from "vitest";

import {
  classificationFailureSpendMonthUsd,
  classifyNewProducts,
  listActiveClassificationQuarantine,
  planClassificationBatches,
  releaseClassificationQuarantine,
  MAX_RUN_SHAPE_FAILURES,
  MIN_ADAPTIVE_BATCH_SIZE,
  SHAPE_FAILURE_QUARANTINE_THRESHOLD,
  type ClassificationProduct,
} from "../../src/classify/classify.js";
import { ClassificationProviderError } from "../../src/classify/provider.js";
import type {
  ClassificationAttemptEvidence,
  ClassificationBatchResult,
  ClassificationInput,
  ProductClassifier,
} from "../../src/classify/provider.js";
import type { AlertEvent } from "../../src/ops/alerts.js";
import { openDatabase } from "../../src/db/database.js";
import { BudgetGuard } from "../../src/ops/budget.js";

function seedItems(database: ReturnType<typeof openDatabase>): void {
  database.exec(`
    INSERT INTO retailers (id, name, base_url, cep, domains_json)
    VALUES ('retailer', 'Mercado', 'https://mercado.test', '01310-100', '["mercado.test"]');
    INSERT INTO ipca_items
      (id, code, name, weight, weight_period, source_url, citation)
    VALUES
      ('ipca-arroz', '1101002', 'Arroz', 0.4030, '2019-12', 'https://ibge.test', 'IBGE');
  `);
}

function seedProducts(database: ReturnType<typeof openDatabase>, count: number): string[] {
  const insert = database.prepare(`
    INSERT INTO products
      (id, retailer_id, canonical_url, title, brand, source_category,
       descriptive_title, first_seen, last_seen)
    VALUES (?, 'retailer', ?, ?, 'Marca', 'Mercearia', 1,
            '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `);
  return Array.from({ length: count }, (_, index) => {
    const id = `product-${String(index + 1).padStart(3, "0")}`;
    insert.run(id, `https://mercado.test/${id}`, `Arroz tipo 1 pacote ${index + 1}`);
    return id;
  });
}

function shapeAttempt(
  inputs: readonly ClassificationInput[],
  failureKind = "validation_failed",
): ClassificationAttemptEvidence {
  return {
    provider: "openai",
    requestedModel: "gpt-5.6-luna",
    actualModel: "gpt-5.6-luna-2026-06-30",
    responseId: `resp-shape-${inputs.length}`,
    attempt: 1,
    inputTokens: inputs.length * 10,
    outputTokens: inputs.length * 2,
    failureKind,
  };
}

/** Fails the exactly-one-result invariant while `failing` is true. */
class SwitchableClassifier implements ProductClassifier {
  failing = true;
  failureKind = "validation_failed";
  readonly callSizes: number[] = [];

  async classify(inputs: readonly ClassificationInput[]): Promise<ClassificationBatchResult> {
    this.callSizes.push(inputs.length);
    if (this.failing) {
      throw new ClassificationProviderError(
        "Classification output must contain exactly one result per input",
        [shapeAttempt(inputs, this.failureKind)],
      );
    }
    return {
      provider: "openai",
      model: "gpt-5.6-luna-2026-06-30",
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

function run(
  database: ReturnType<typeof openDatabase>,
  provider: ProductClassifier,
  overrides: {
    batchSize?: number;
    concurrency?: number;
    minimumBatchSize?: number;
    alertSink?: { send(event: AlertEvent): Promise<void> };
    when?: string;
  } = {},
) {
  return classifyNewProducts({
    batchSize: overrides.batchSize ?? 40,
    concurrency: overrides.concurrency ?? 1,
    ...(overrides.minimumBatchSize === undefined
      ? {}
      : { minimumBatchSize: overrides.minimumBatchSize }),
    confidenceThreshold: 0.8,
    version: 1,
  }, {
    database,
    provider,
    budgetGuard: new BudgetGuard(50),
    now: () => new Date(overrides.when ?? "2026-07-16T06:30:00.000Z"),
    ...(overrides.alertSink === undefined ? {} : { alertSink: overrides.alertSink }),
  });
}

describe("adaptive batch split on shape failure", () => {
  it("runs at most three provider requests concurrently and settles every reservation", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 6);
      let active = 0;
      let peak = 0;
      const provider: ProductClassifier = {
        async classify(inputs) {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setImmediate(resolve));
          active -= 1;
          return {
            provider: "openai",
            model: "gpt-5.6-luna-2026-06-30",
            promptVersion: "fixture-v1",
            promptHash: "b".repeat(64),
            results: inputs.map((input) => ({
              productId: input.productId,
              ipcaItemId: "ipca-arroz",
              confidence: 0.95,
              rationaleCode: "exact_food_match",
            })),
            usage: { inputTokens: 10, outputTokens: 2 },
          };
        },
      };

      const result = await run(database, provider, {
        batchSize: 1,
        concurrency: 3,
      });

      expect(result).toMatchObject({
        status: "completed",
        batches: 6,
        classified: 6,
        pending: 0,
      });
      expect(peak).toBe(3);
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM classification_sync_reservations
        WHERE status = 'reserved'
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("halves the batch for previously failed products instead of resubmitting the identical request", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 40);
      const provider = new SwitchableClassifier();

      const first = await run(database, provider);
      expect(first).toMatchObject({
        status: "completed",
        classified: 0,
        pending: 40,
        shapeFailedBatches: 1,
        shapeFailedProducts: 40,
        shapeFailurePaused: false,
      });
      expect(provider.callSizes).toEqual([40]);
      expect(database.prepare(`
        SELECT COUNT(*) AS count, COUNT(DISTINCT request_sha256) AS requests
        FROM classification_shape_failures
      `).get()).toEqual({ count: 40, requests: 1 });
      // Shape evidence carries the same request fingerprint as the budget
      // reservation, so failures join back to their paid attempt.
      expect(database.prepare(`
        SELECT DISTINCT request_sha256 FROM classification_shape_failures
      `).get()).toEqual(database.prepare(`
        SELECT request_sha256 FROM classification_sync_reservations
      `).get());
      // Fail-closed accounting: no reservation is left open after the failure.
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM classification_sync_reservations
        WHERE status = 'reserved'
      `).get()).toEqual({ count: 0 });

      provider.failing = false;
      const second = await run(database, provider);
      expect(provider.callSizes.slice(1)).toEqual([20, 20]);
      expect(second).toMatchObject({
        status: "completed",
        classified: 40,
        pending: 0,
        plannedBatches: 2,
        shapeFailedBatches: 0,
      });
    } finally {
      database.close();
    }
  });

  it("floors the split so one bad batch cannot fan out into tiny paid calls", () => {
    const products = Array.from({ length: 24 }, (_, index) => ({
      id: `p-${String(index).padStart(2, "0")}`,
      retailer_id: "retailer",
      title: "t",
      brand: null,
      source_category: null,
    })) satisfies ClassificationProduct[];
    const counts = new Map(products.map(({ id }) => [id, 2]));

    const batches = planClassificationBatches(products, counts, 40);

    // floor(40 / 2^2) = 10 = MIN_ADAPTIVE_BATCH_SIZE.
    expect(batches.map((batch) => batch.length)).toEqual([10, 10, 4]);
    expect(MIN_ADAPTIVE_BATCH_SIZE).toBe(10);
    expect(planClassificationBatches(products, new Map(), 40)
      .map((batch) => batch.length)).toEqual([24]);
  });

  it("allows an explicit operator floor below the nightly default", () => {
    const products = Array.from({ length: 10 }, (_, index) => ({
      id: `p-${index}`,
      retailer_id: "retailer",
      title: "t",
      brand: null,
      source_category: null,
    })) satisfies ClassificationProduct[];
    const counts = new Map(products.map(({ id }) => [id, 2]));

    expect(planClassificationBatches(products, counts, 10, 1)
      .map((batch) => batch.length)).toEqual([2, 2, 2, 2, 2]);
  });

  it("keeps failure tiers in separate requests so healthy products are not dragged into a failing set", () => {
    const products = Array.from({ length: 6 }, (_, index) => ({
      id: `p-${index}`,
      retailer_id: "retailer",
      title: "t",
      brand: null,
      source_category: null,
    })) satisfies ClassificationProduct[];
    const counts = new Map([["p-4", 1], ["p-5", 1]]);

    const batches = planClassificationBatches(products, counts, 4, 2);

    expect(batches.map((batch) => batch.map(({ id }) => id))).toEqual([
      ["p-0", "p-1", "p-2", "p-3"],
      ["p-4", "p-5"],
    ]);
  });
});

describe("shape-failure circuit breaker and quarantine", () => {
  it("pauses the run fail-closed after repeated in-run shape failures", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 40);
      const provider = new SwitchableClassifier();

      await run(database, provider, { when: "2026-07-14T06:30:00.000Z" }); // 1 x 40
      await run(database, provider, { when: "2026-07-15T06:30:00.000Z" }); // 2 x 20

      const third = await run(database, provider, { when: "2026-07-16T06:30:00.000Z" });

      expect(provider.callSizes).toEqual([40, 20, 20, 10, 10, 10]);
      expect(third).toMatchObject({
        status: "shape_failure_paused",
        shapeFailurePaused: true,
        shapeFailedBatches: MAX_RUN_SHAPE_FAILURES,
        classified: 0,
      });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM classification_sync_reservations
        WHERE status = 'reserved'
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("quarantines products after N failures with an alert, keeps them visible, and honors an operator release", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 40);
      const provider = new SwitchableClassifier();
      const alerts: AlertEvent[] = [];
      const alertSink = { send: async (event: AlertEvent) => { alerts.push(event); } };

      await run(database, provider, { alertSink, when: "2026-07-13T06:30:00.000Z" });
      await run(database, provider, { alertSink, when: "2026-07-14T06:30:00.000Z" });
      await run(database, provider, { alertSink, when: "2026-07-15T06:30:00.000Z" });
      expect(alerts).toEqual([]);

      // 30 products now have 3 failures; 10 (the unattempted fourth batch) have 2.
      const fourth = await run(database, provider, { alertSink, when: "2026-07-16T06:30:00.000Z" });
      expect(fourth).toMatchObject({
        quarantinedNew: 30,
        quarantinedActive: 30,
        shapeFailedBatches: 1,
        status: "completed",
        classified: 0,
        pending: 40,
      });
      expect(fourth.quarantinedProductIds).toHaveLength(30);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        severity: "error",
        title: "IPCA classification products quarantined",
        details: expect.objectContaining({
          version: 1,
          quarantined: 30,
          threshold: SHAPE_FAILURE_QUARANTINE_THRESHOLD,
        }),
      });

      const callsBeforeFifth = provider.callSizes.length;
      const fifth = await run(database, provider, { alertSink, when: "2026-07-17T06:30:00.000Z" });
      expect(fifth).toMatchObject({
        quarantinedNew: 10,
        quarantinedActive: 40,
        plannedBatches: 0,
        classified: 0,
        pending: 40,
        status: "completed",
      });
      expect(listActiveClassificationQuarantine(database, 1)).toHaveLength(40);
      // Quarantined products are held, not silently dropped — and not billed.
      expect(provider.callSizes.length).toBe(callsBeforeFifth);

      const released = releaseClassificationQuarantine(database, {
        version: 1,
        reason: "operator reviewed shape failures",
        occurredAt: "2026-07-18T09:00:00.000Z",
      });
      expect(released).toHaveLength(40);
      expect(listActiveClassificationQuarantine(database, 1)).toEqual([]);

      provider.failing = false;
      const sixth = await run(database, provider, { alertSink, when: "2026-07-19T06:30:00.000Z" });
      expect(sixth).toMatchObject({
        status: "completed",
        classified: 40,
        pending: 0,
        quarantinedActive: 0,
        quarantinedNew: 0,
      });
      // The release reset the failure count, so the run used full batches again.
      expect(provider.callSizes.at(-1)).toBe(40);
      expect(alerts).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("rethrows non-shape provider failures unchanged", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 2);
      const transportOnly: ProductClassifier = {
        classify: async () => {
          throw new ClassificationProviderError("connection reset", []);
        },
      };
      await expect(run(database, transportOnly)).rejects.toThrow("connection reset");

      const billedTransient: ProductClassifier = {
        classify: async (inputs) => {
          throw new ClassificationProviderError(
            "OpenAI classification response was queued",
            [{ ...shapeAttempt(inputs), failureKind: "transient_response_error" }],
          );
        },
      };
      await expect(run(database, billedTransient)).rejects.toThrow("queued");
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM classification_shape_failures",
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});

describe("classification failure spend visibility", () => {
  it("surfaces cumulative monthly classification_failure spend in the run summary", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 10);
      database.prepare(`
        INSERT INTO cost_ledger (id, category, provider, model, cost_usd, occurred_at)
        VALUES
          ('prior-failure', 'classification_failure', 'openai', 'gpt-5.6-luna',
           0.30, '2026-07-14T06:42:23.333Z'),
          ('other-month', 'classification_failure', 'openai', 'gpt-5.6-luna',
           9.99, '2026-06-14T06:42:23.333Z')
      `).run();
      const provider = new SwitchableClassifier();

      const summary = await run(database, provider, { batchSize: 10 });

      expect(summary.failureSpendRunUsd).toBeGreaterThan(0);
      expect(summary.failureSpendMonthUsd).toBeCloseTo(
        0.30 + summary.failureSpendRunUsd,
        10,
      );
      expect(classificationFailureSpendMonthUsd(
        database,
        new Date("2026-06-20T00:00:00.000Z"),
      )).toBeCloseTo(9.99, 10);
    } finally {
      database.close();
    }
  });
});
