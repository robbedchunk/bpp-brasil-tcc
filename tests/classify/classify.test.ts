import { describe, expect, it } from "vitest";

import { buildCli, type CliDependencies } from "../../src/cli.js";
import {
  buildReviewSample,
  classifyNewProducts,
} from "../../src/classify/classify.js";
import type {
  ClassificationBatchResult,
  ClassificationInput,
  ProductClassifier,
} from "../../src/classify/provider.js";
import { openDatabase } from "../../src/db/database.js";
import { BudgetGuard } from "../../src/ops/budget.js";
import {
  loadIpcaItems,
  loadItems,
} from "../../scripts/load-ipca-items.js";

const ARCHIVE_SHA = "0ba845113682c96015a0e93daf4b10bc93aad82c2c1d6ea406282af958bf9104";
const SOURCE_URL = "https://ftp.ibge.gov.br/Precos_Indices_de_Precos_ao_Consumidor/IPCA/Atualizacao_das_Estruturas_POF2017-2018/Estruturas_para_divulgacao_dez19.zip";

const CSV_HEADER = [
  "pof_vintage",
  "weight_reference_month",
  "effective_from",
  "sidra_area_level",
  "sidra_area_code",
  "area_name",
  "snipc_subgroup_code",
  "sidra_category_id",
  "snipc_subitem_code",
  "subitem_name",
  "weight_pct_total_ipca",
  "source_sheet",
  "source_row",
  "source_url",
  "source_archive_sha256",
].join(",");

function validReferenceCsv(): string {
  const rows = Array.from({ length: 84 }, (_, index) => {
    const sequence = index + 1;
    const code = String(1_100_000 + sequence);
    return [
      "POF 2017-2018",
      "2019-12",
      "2020-01-01",
      "Unidade da Federação",
      "35",
      "São Paulo (SP)",
      "1100000",
      String(70_000 + sequence),
      code,
      `Subitem ${sequence}`,
      index === 0 ? "12.1181" : "0.0000",
      "SP",
      String(10 + sequence),
      SOURCE_URL,
      ARCHIVE_SHA,
    ].join(",");
  });
  return `${CSV_HEADER}\n${rows.join("\n")}\n`;
}

function replaceCell(csv: string, rowIndex: number, columnIndex: number, value: string): string {
  const lines = csv.trimEnd().split("\n");
  const row = lines[rowIndex + 1]?.split(",");
  if (row === undefined) throw new Error("missing fixture row");
  row[columnIndex] = value;
  lines[rowIndex + 1] = row.join(",");
  return `${lines.join("\n")}\n`;
}

function seedRetailer(database: ReturnType<typeof openDatabase>): void {
  database.prepare(
    `INSERT INTO retailers (id, name, base_url, cep, domains_json)
     VALUES ('retailer', 'Mercado', 'https://mercado.test', '01310-100', '["mercado.test"]')`,
  ).run();
}

function seedItems(database: ReturnType<typeof openDatabase>): void {
  database.exec(`
    INSERT INTO ipca_items
      (id, code, name, weight, weight_period, source_url, citation)
    VALUES
      ('ipca-arroz', '1101002', 'Arroz', 0.5, '2019-12', '${SOURCE_URL}', 'IBGE SP row 31'),
      ('ipca-feijao', '1101073', 'Feijão', 0.4, '2019-12', '${SOURCE_URL}', 'IBGE SP row 44')
  `);
}

function seedProducts(database: ReturnType<typeof openDatabase>, count: number): string[] {
  seedRetailer(database);
  const insert = database.prepare(
    `INSERT INTO products
       (id, retailer_id, canonical_url, title, brand, source_category, first_seen, last_seen)
     VALUES (?, 'retailer', ?, ?, ?, ?, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')`,
  );
  return Array.from({ length: count }, (_, index) => {
    const id = `product-${String(index + 1).padStart(3, "0")}`;
    insert.run(
      id,
      `https://mercado.test/${id}`,
      `Arroz tipo 1 pacote ${index + 1}`,
      index % 2 === 0 ? "Marca A" : null,
      index % 3 === 0 ? "Mercearia" : null,
    );
    return id;
  });
}

class FixtureClassifier implements ProductClassifier {
  readonly calls: ClassificationInput[][] = [];
  readonly #itemForCall: (input: ClassificationInput, callIndex: number) => string | null;
  readonly #confidence: number;

  constructor(options: {
    confidence?: number;
    itemForCall?: (input: ClassificationInput, callIndex: number) => string | null;
  } = {}) {
    this.#confidence = options.confidence ?? 0.96;
    this.#itemForCall = options.itemForCall ?? (() => "ipca-arroz");
  }

  async classify(inputs: readonly ClassificationInput[]): Promise<ClassificationBatchResult> {
    const callIndex = this.calls.length;
    this.calls.push(inputs.map((input) => ({ ...input, allowedItems: [...input.allowedItems] })));
    return {
      provider: "fixture",
      model: "gpt-5.6-luna",
      promptVersion: "fixture-v1",
      promptHash: "a".repeat(64),
      results: inputs.map((input) => ({
        productId: input.productId,
        ipcaItemId: this.#itemForCall(input, callIndex),
        confidence: this.#confidence,
        rationaleCode: "exact_food_match",
      })),
      usage: { inputTokens: inputs.length * 10, outputTokens: inputs.length * 5 },
    };
  }
}

function classificationOptions(overrides: Partial<{
  batchSize: number;
  confidenceThreshold: number;
  dryRun: boolean;
  version: number;
}> = {}) {
  return {
    batchSize: 50,
    confidenceThreshold: 0.8,
    version: 1,
    ...overrides,
  };
}

describe("official IPCA reference loader", () => {
  it("parses 84 cited São Paulo food-at-home rows and preserves codes as strings", () => {
    const items = loadItems(validReferenceCsv());

    expect(items).toHaveLength(84);
    expect(items).toContainEqual(expect.objectContaining({
      areaCode: "35",
      categoryId: "70001",
      code: "1100001",
      group: "alimentação no domicílio",
      subgroupCode: "1100000",
      weight: expect.any(Number),
    }));
    expect(items.reduce((sum, item) => sum + item.weight, 0)).toBeCloseTo(12.1181, 8);
  });

  it.each([
    ["a duplicate code", (csv: string) => replaceCell(csv, 1, 8, "1100001")],
    ["a negative weight", (csv: string) => replaceCell(csv, 1, 10, "-0.1")],
    ["a non-food subgroup", (csv: string) => replaceCell(csv, 1, 6, "1200000")],
    ["a missing citation", (csv: string) => replaceCell(csv, 1, 13, "")],
    ["an invalid archive hash", (csv: string) => replaceCell(csv, 1, 14, "f".repeat(64))],
    ["the wrong row count", (csv: string) => `${csv.trimEnd().split("\n").slice(0, -1).join("\n")}\n`],
    ["the wrong total", (csv: string) => replaceCell(csv, 0, 10, "12.0000")],
  ])("rejects %s", (_label, mutate) => {
    expect(() => loadItems(mutate(validReferenceCsv()))).toThrow();
  });

  it("loads full provenance idempotently by SNIPC code", () => {
    const database = openDatabase(":memory:");
    try {
      const first = loadIpcaItems(database, validReferenceCsv());
      const second = loadIpcaItems(database, validReferenceCsv());

      expect(first).toMatchObject({ loaded: 84, totalWeight: "12.1181" });
      expect(second).toEqual(first);
      expect(database.prepare("SELECT COUNT(*) AS count FROM ipca_items").get()).toEqual({ count: 84 });
      expect(database.prepare(
        `SELECT code, sidra_area_code, sidra_category_id, source_sheet,
                source_row, source_archive_sha256
         FROM ipca_items WHERE code = '1100001'`,
      ).get()).toEqual({
        code: "1100001",
        sidra_area_code: "35",
        sidra_category_id: "70001",
        source_sheet: "SP",
        source_row: 11,
        source_archive_sha256: ARCHIVE_SHA,
      });
    } finally {
      database.close();
    }
  });
});

describe("incremental classification", () => {
  it("classifies 120 new products in deterministic batches of 50, 50, and 20", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 120);
      const provider = new FixtureClassifier();

      const result = await classifyNewProducts(classificationOptions(), {
        database,
        provider,
        budgetGuard: new BudgetGuard(50),
        now: () => new Date("2026-07-10T12:00:00.000Z"),
      });

      expect(provider.calls.map((call) => call.length)).toEqual([50, 50, 20]);
      expect(provider.calls[0]?.[0]).toEqual({
        productId: "product-001",
        title: "Arroz tipo 1 pacote 1",
        brand: "Marca A",
        sourceCategory: "Mercearia",
        allowedItems: [
          { id: "ipca-arroz", code: "1101002", name: "Arroz" },
          { id: "ipca-feijao", code: "1101073", name: "Feijão" },
        ],
      });
      expect(result).toMatchObject({
        batches: 3,
        classified: 120,
        eligible: 120,
        pending: 0,
        unclassified: 0,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM classifications").get()).toEqual({ count: 120 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM cost_ledger").get()).toEqual({ count: 120 });
    } finally {
      database.close();
    }
  });

  it("keeps low-confidence model suggestions unclassified while retaining raw evidence", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      const [productId] = seedProducts(database, 1);
      const provider = new FixtureClassifier({ confidence: 0.79 });

      const result = await classifyNewProducts(classificationOptions(), {
        database,
        provider,
        budgetGuard: new BudgetGuard(),
      });

      expect(result).toMatchObject({ classified: 1, unclassified: 1 });
      expect(database.prepare(
        "SELECT current_ipca_item_id AS ipcaItemId FROM products WHERE id = ?",
      ).get(productId)).toEqual({ ipcaItemId: null });
      const evidence = database.prepare(
        `SELECT ipca_item_id, decision, output_json, model, prompt_version,
                input_tokens, output_tokens, cost_usd
         FROM classifications WHERE product_id = ?`,
      ).get(productId) as Record<string, unknown>;
      expect(evidence).toMatchObject({
        decision: "unclassified",
        ipca_item_id: null,
        model: "gpt-5.6-luna",
        prompt_version: "fixture-v1",
        input_tokens: 10,
        output_tokens: 5,
      });
      expect(evidence.cost_usd).toEqual(expect.any(Number));
      expect(JSON.parse(String(evidence.output_json))).toMatchObject({
        ipcaItemId: "ipca-arroz",
        rationaleCode: "exact_food_match",
      });
    } finally {
      database.close();
    }
  });

  it("appends a new version and only mutates the product's current pointer", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      const [productId] = seedProducts(database, 1);
      const provider = new FixtureClassifier({
        itemForCall: (_input, callIndex) => callIndex === 0 ? "ipca-arroz" : "ipca-feijao",
      });
      const dependencies = { database, provider, budgetGuard: new BudgetGuard() };

      await classifyNewProducts(classificationOptions({ version: 1 }), dependencies);
      await classifyNewProducts(classificationOptions({ version: 2 }), dependencies);

      expect(database.prepare(
        "SELECT COUNT(*) AS n FROM classifications WHERE product_id = ?",
      ).get(productId)).toEqual({ n: 2 });
      expect(database.prepare(
        "SELECT current_ipca_item_id AS id FROM products WHERE id = ?",
      ).get(productId)).toEqual({ id: "ipca-feijao" });
      expect(database.prepare(
        "SELECT version, ipca_item_id AS id, decision FROM classifications WHERE product_id = ? ORDER BY version",
      ).all(productId)).toEqual([
        { version: 1, id: "ipca-arroz", decision: "1101002" },
        { version: 2, id: "ipca-feijao", decision: "1101073" },
      ]);
    } finally {
      database.close();
    }
  });

  it("makes dry-run and provider-unavailable plans without API or evidence writes", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 3);
      const provider = new FixtureClassifier();

      const dryRun = await classifyNewProducts(classificationOptions({ dryRun: true }), {
        database,
        provider,
        budgetGuard: new BudgetGuard(),
      });
      const unavailable = await classifyNewProducts(classificationOptions(), {
        database,
        budgetGuard: new BudgetGuard(),
      });

      expect(dryRun).toMatchObject({ dryRun: true, eligible: 3, pending: 3, status: "dry_run" });
      expect(unavailable).toMatchObject({ pending: 3, status: "provider_unavailable" });
      expect(provider.calls).toEqual([]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM classifications").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM cost_ledger").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("routes a budget-denied batch to pending without calling the provider", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 2);
      const provider = new FixtureClassifier();

      const result = await classifyNewProducts(classificationOptions(), {
        database,
        provider,
        budgetGuard: new BudgetGuard(0),
      });

      expect(result).toMatchObject({ budgetDenied: 2, pending: 2, status: "budget_denied" });
      expect(provider.calls).toEqual([]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM classifications").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("exports a deterministic, capped sample spanning classification strata", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 240);
      const provider = new FixtureClassifier({
        itemForCall: (input) => Number(input.productId.slice(-3)) % 2 === 0
          ? "ipca-feijao"
          : "ipca-arroz",
      });
      await classifyNewProducts(classificationOptions({ batchSize: 40 }), {
        database,
        provider,
        budgetGuard: new BudgetGuard(),
      });

      const first = buildReviewSample(database, { limit: 999, version: 1 });
      const second = buildReviewSample(database, { limit: 200, version: 1 });

      expect(first).toHaveLength(200);
      expect(first).toEqual(second);
      expect(new Set(first.map((row) => row.ipcaItemId))).toEqual(
        new Set(["ipca-arroz", "ipca-feijao"]),
      );
    } finally {
      database.close();
    }
  });
});

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

describe("classification CLI", () => {
  it("reports missing-key products pending, writes a local-path alert, and stores no evidence", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 1);
      const alerts: unknown[] = [];

      const result = await invokeCli(["classify", "--json"], {
        database,
        databasePath: ":memory:",
        env: { PROJECT_ROOT: process.cwd(), OPENAI_API_KEY: "" },
        alertSink: { send: async (event) => { alerts.push(event); } },
      });

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        eligible: 1,
        pending: 1,
        status: "provider_unavailable",
      });
      expect(alerts).toEqual([expect.objectContaining({
        severity: "warning",
        title: "IPCA classification pending",
        details: { pending: 1, version: 1 },
      })]);
      expect(JSON.stringify(alerts)).not.toContain("OPENAI_API_KEY");
      expect(database.prepare("SELECT COUNT(*) AS count FROM classifications").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("prints a dry-run plan without requiring a provider or emitting an alert", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 1);
      const alerts: unknown[] = [];

      const result = await invokeCli(["classify", "--dry-run", "--json"], {
        database,
        databasePath: ":memory:",
        env: { PROJECT_ROOT: process.cwd() },
        alertSink: { send: async (event) => { alerts.push(event); } },
      });

      expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, pending: 1, status: "dry_run" });
      expect(alerts).toEqual([]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM classifications").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("exports a requested review sample as deterministic JSON even without --json", async () => {
    const database = openDatabase(":memory:");
    try {
      seedItems(database);
      seedProducts(database, 2);
      const result = await invokeCli(["classify", "--review-sample", "200"], {
        database,
        databasePath: ":memory:",
        env: { PROJECT_ROOT: process.cwd() },
        productClassifier: new FixtureClassifier(),
      });

      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({ classified: 2, status: "completed" });
      expect(output.reviewSample).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});
