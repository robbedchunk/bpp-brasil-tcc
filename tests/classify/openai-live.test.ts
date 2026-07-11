import { describe, expect, it } from "vitest";

import { OpenAIProductClassifier } from "../../src/classify/openai-provider.js";

const enabled = process.env.LIVE_OPENAI === "1"
  && (process.env.OPENAI_API_KEY?.trim().length ?? 0) > 0;

describe("opt-in live OpenAI-compatible classification smoke", () => {
  it.runIf(enabled)("completes exactly one Responses API attempt", async () => {
    const result = await new OpenAIProductClassifier({ maxAttempts: 1 }).classify([{
      productId: "live-product-1",
      title: "Arroz agulhinha tipo 1 5 kg",
      brand: "Marca A",
      sourceCategory: "Mercearia",
      allowedItems: [
        { id: "ipca-arroz", code: "1101002", name: "Arroz" },
        { id: "ipca-feijao", code: "1101073", name: "Feijão" },
      ],
    }]);

    expect(result).toMatchObject({
      provider: "openai",
      results: [{ productId: "live-product-1" }],
      usage: {
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      },
    });
  }, 180_000);
});
