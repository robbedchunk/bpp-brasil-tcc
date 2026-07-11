import type { StrategyPurpose } from "./provider.js";

export interface ExplorerPromptInput {
  purpose: StrategyPurpose;
  allowedDomains: readonly string[];
  eventBudgetUsd: number;
  attempt: number;
  maxAttempts: number;
}

export function buildExplorerPrompt(input: ExplorerPromptInput): string {
  const tiers = input.purpose === "extraction"
    ? "api, then embedded-json, then dom, then restricted script"
    : "sitemap, then api, then dom-crawl, then restricted script";
  const placeholders = input.purpose === "extraction"
    ? "{productUrl}, {externalId}, {sourceCategory}"
    : "{page}, {pageSize}, {offset}, {from}, {to}, {cursor}, {segment}";
  return [
    `Create one deterministic ${input.purpose} strategy for the supplied redacted samples.`,
    `Try tiers in this order: ${tiers}. Stop at the lowest robust tier.`,
    `Network access is limited to: ${input.allowedDomains.join(", ")}.`,
    "Use polite, read-only probing; do not seek credentials, environment files, auth state, or unrelated paths.",
    `Allowed ${input.purpose} URL placeholders: ${placeholders}.`,
    "Read AGENTS.md, strategy-schema.md, samples.json, and optional old-strategy.json/failures.json.",
    ...(input.attempt > 1
      ? ["If failures.json has priorAttempts, read them and use a DIFFERENT approach after a failure of the same tier."]
      : []),
    "Write exactly one strict root object {\"strategy\": ...} to strategy.json and return the same object.",
    `This is attempt ${input.attempt}/${input.maxAttempts}; stop before the USD ${input.eventBudgetUsd} event limit.`,
    "The trusted host will parse and independently validate the artifact.",
  ].join("\n");
}
