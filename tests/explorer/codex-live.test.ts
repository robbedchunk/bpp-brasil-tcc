import { describe, expect, it } from "vitest";

import {
  CodexStrategyGenerator,
  resolveExplorerApiKey,
} from "../../src/explorer/codex-provider.js";
import { createSandboxPackage } from "../../src/explorer/package.js";
import { buildExplorerPrompt } from "../../src/explorer/prompt.js";
import { ExtractionStrategySchema } from "../../src/strategies/schema.js";
import { validateExtractionStrategy } from "../../src/strategies/validate.js";

const enabled = process.env.LIVE_OPENAI === "1"
  && resolveExplorerApiKey(process.env) !== undefined;

describe("opt-in live Codex SDK acceptance", () => {
  it.runIf(enabled)("returns a typed strategy that passes the trusted 30-reference gate", async () => {
    const oldStrategy = ExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "api",
      allowedDomains: ["shop.test"],
      request: { method: "GET", url: "{productUrl}", headers: {} },
      fields: {
        title: "$.title",
        brand: "$.brand",
        price: "$.price",
        promoPrice: "$.promo",
        unit: "$.unit",
        availability: "$.available",
      },
    });
    const refs = Array.from({ length: 30 }, (_, index) => ({
      canonicalUrl: `https://shop.test/products/${index}`,
      externalId: String(index),
      sourceCategory: "fixture",
    }));
    const sandbox = await createSandboxPackage({
      retailerId: "live-fixture",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      samples: refs.map((ref) => ({
        canonicalUrl: ref.canonicalUrl,
        body: JSON.stringify({
          title: "Arroz",
          brand: "Marca",
          price: 12.99,
          promo: 10.99,
          unit: "1 kg",
          available: true,
        }),
      })),
      oldStrategy,
    });
    try {
      const result = await new CodexStrategyGenerator().generate({
        retailerId: "live-fixture",
        purpose: "extraction",
        allowedDomains: ["shop.test"],
        workspacePath: sandbox.workspacePath,
        prompt: buildExplorerPrompt({
          purpose: "extraction",
          allowedDomains: ["shop.test"],
          eventBudgetUsd: 5,
          attempt: 1,
          maxAttempts: 1,
          hasOldStrategy: false,
        }),
      });
      expect(result.status).toBe("candidate");
      if (result.status !== "candidate") return;
      const strategy = ExtractionStrategySchema.parse(result.strategy);
      const report = await validateExtractionStrategy(strategy, refs, async () => ({
        ok: true,
        fields: {
          title: "Arroz",
          brand: "Marca",
          price: 12.99,
          promoPrice: 10.99,
          unit: "1 kg",
          available: true,
        },
      }));
      expect(report).toMatchObject({ attempted: 30, score: 1, activatable: true });
    } finally {
      await sandbox.dispose();
    }
  }, 180_000);
});
