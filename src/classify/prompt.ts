import { createHash } from "node:crypto";

import type { ClassificationInput } from "./provider.js";

export const CLASSIFICATION_PROMPT_VERSION = "ipca-sp-food-at-home-v1";

export const CLASSIFICATION_INSTRUCTIONS = `You classify Brazilian grocery products into the supplied São Paulo IPCA food-at-home subitems.

Rules:
- Use only the supplied allowed item IDs. Never invent an item.
- Use the product title, brand, and source category only.
- Return null when the product is ambiguous, outside food at home, a mixed basket, or lacks enough evidence.
- Confidence is from 0 to 1. Use a short stable snake_case rationaleCode.
- Return exactly one result for every productId and no other results.

Examples:
- "Arroz agulhinha tipo 1 5 kg" -> the allowed Arroz item, rationale exact_food_match.
- "Cesta básica 20 itens" -> null, rationale mixed_basket.
- "Produto mercearia" -> null, rationale insufficient_detail.`;

export const CLASSIFICATION_PROMPT_HASH = createHash("sha256")
  .update(`${CLASSIFICATION_PROMPT_VERSION}\n${CLASSIFICATION_INSTRUCTIONS}`, "utf8")
  .digest("hex");

export function buildClassificationPrompt(
  inputs: readonly ClassificationInput[],
): string {
  return JSON.stringify({
    products: inputs.map((input) => ({
      productId: input.productId,
      title: input.title,
      brand: input.brand,
      sourceCategory: input.sourceCategory,
      allowedItems: input.allowedItems.map((item) => ({
        id: item.id,
        code: item.code,
        name: item.name,
      })),
    })),
  });
}
