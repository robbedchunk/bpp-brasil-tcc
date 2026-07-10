import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { OpenAIProductClassifier } from "../../src/classify/openai-provider.js";
import type { ClassificationInput } from "../../src/classify/provider.js";

const input: ClassificationInput = {
  productId: "product-1",
  title: "Arroz agulhinha tipo 1 5 kg",
  brand: "Marca A",
  sourceCategory: "Mercearia",
  allowedItems: [
    { id: "ipca-arroz", code: "1101002", name: "Arroz" },
    { id: "ipca-feijao", code: "1101073", name: "Feijão" },
  ],
};

async function fixtureResponse(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    new URL("../fixtures/openai/classification-response.json", import.meta.url),
    "utf8",
  )) as Record<string, unknown>;
}

describe("OpenAI structured classification provider", () => {
  it("uses responses.parse with a strict required root object and store disabled", async () => {
    let captured: any;
    const client = {
      responses: {
        parse: async (request: unknown) => {
          captured = request;
          return fixtureResponse();
        },
      },
    };
    const provider = new OpenAIProductClassifier({ client, env: {} });

    const result = await provider.classify([input]);

    expect(result).toMatchObject({
      model: "gpt-5.6-luna",
      provider: "openai",
      results: [{
        productId: "product-1",
        ipcaItemId: "ipca-arroz",
        confidence: 0.97,
        rationaleCode: "exact_food_match",
      }],
      usage: { inputTokens: 321, outputTokens: 42 },
    });
    expect(result.promptHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(captured).toMatchObject({ model: "gpt-5.6-luna", store: false });
    expect(captured.text.format).toMatchObject({
      type: "json_schema",
      strict: true,
      schema: { additionalProperties: false },
    });
    expect(captured.text.format.schema.required).toEqual(["results"]);
    const resultSchema = captured.text.format.schema.properties.results.items;
    expect(resultSchema.additionalProperties).toBe(false);
    expect(resultSchema.required).toEqual([
      "productId",
      "ipcaItemId",
      "confidence",
      "rationaleCode",
    ]);
    expect(JSON.stringify(captured.input)).toContain("Arroz agulhinha tipo 1 5 kg");
    expect(JSON.stringify(captured.input)).not.toContain("canonicalUrl");
  });

  it.each([
    ["a missing result", { results: [] }],
    ["a duplicate result", {
      results: [
        { productId: "product-1", ipcaItemId: "ipca-arroz", confidence: 0.9, rationaleCode: "match" },
        { productId: "product-1", ipcaItemId: "ipca-arroz", confidence: 0.9, rationaleCode: "match" },
      ],
    }],
    ["an unknown input ID", {
      results: [{ productId: "other", ipcaItemId: "ipca-arroz", confidence: 0.9, rationaleCode: "match" }],
    }],
    ["an item outside the allowlist", {
      results: [{ productId: "product-1", ipcaItemId: "ipca-other", confidence: 0.9, rationaleCode: "match" }],
    }],
  ])("host-rejects %s", async (_label, outputParsed) => {
    const response = await fixtureResponse();
    const client = {
      responses: { parse: async () => ({ ...response, output_parsed: outputParsed }) },
    };
    const provider = new OpenAIProductClassifier({ client, env: {} });

    await expect(provider.classify([input])).rejects.toThrow();
  });

  it("retries transient API failures and then succeeds", async () => {
    let attempts = 0;
    const client = {
      responses: {
        parse: async () => {
          attempts += 1;
          if (attempts < 3) throw Object.assign(new Error("rate limited"), { status: 429 });
          return fixtureResponse();
        },
      },
    };
    const provider = new OpenAIProductClassifier({
      client,
      env: {},
      sleep: async () => {},
    });

    await expect(provider.classify([input])).resolves.toMatchObject({ provider: "openai" });
    expect(attempts).toBe(3);
  });

  it("does not retry permanent or host-validation failures", async () => {
    let attempts = 0;
    const client = {
      responses: {
        parse: async () => {
          attempts += 1;
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        },
      },
    };
    const provider = new OpenAIProductClassifier({
      client,
      env: {},
      sleep: async () => {},
    });

    await expect(provider.classify([input])).rejects.toThrow("unauthorized");
    expect(attempts).toBe(1);
  });

  it("rejects a completed response without auditable token usage", async () => {
    const response = await fixtureResponse();
    const provider = new OpenAIProductClassifier({
      client: {
        responses: { parse: async () => ({ ...response, usage: null }) },
      },
      env: {},
    });

    await expect(provider.classify([input])).rejects.toThrow(/usage/iu);
  });
});
