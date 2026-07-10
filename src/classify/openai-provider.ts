import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import {
  CLASSIFICATION_INSTRUCTIONS,
  CLASSIFICATION_PROMPT_HASH,
  CLASSIFICATION_PROMPT_VERSION,
  buildClassificationPrompt,
} from "./prompt.js";
import type {
  ClassificationBatchResult,
  ClassificationInput,
  ProductClassifier,
} from "./provider.js";

export const DEFAULT_CLASSIFICATION_MODEL = "gpt-5.6-luna";

const ResultSchema = z.object({
  productId: z.string().min(1),
  ipcaItemId: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  rationaleCode: z.string().regex(/^[a-z0-9][a-z0-9_]{0,63}$/u),
}).strict();

const ClassificationResponseSchema = z.object({
  results: z.array(ResultSchema),
}).strict();

interface ResponsesClient {
  responses: {
    parse(request: unknown): Promise<unknown>;
  };
}

interface ParsedResponse {
  output_parsed?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  } | null;
}

export interface OpenAIProductClassifierOptions {
  apiKey?: string;
  client?: ResponsesClient;
  env?: NodeJS.ProcessEnv;
  maxAttempts?: number;
  model?: string;
  sleep?: (milliseconds: number) => Promise<void>;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function transientApiFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = "status" in error ? Number(error.status) : Number.NaN;
  if (
    status === 408
    || status === 409
    || status === 429
    || (status >= 500 && status <= 599)
  ) return true;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  return new Set([
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETUNREACH",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
  ]).has(code);
}

function integerUsage(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`OpenAI response usage.${name} must be a non-negative integer`);
  }
  return value;
}

function validateResults(
  parsed: unknown,
  inputs: readonly ClassificationInput[],
): ReturnType<typeof ClassificationResponseSchema.parse>["results"] {
  const output = ClassificationResponseSchema.parse(parsed);
  const expectedIds = new Set(inputs.map((input) => input.productId));
  const seen = new Set<string>();
  if (expectedIds.size !== inputs.length) {
    throw new Error("Classification input product IDs must be unique");
  }
  if (output.results.length !== inputs.length) {
    throw new Error("Classification output must contain exactly one result per input");
  }
  const inputById = new Map(inputs.map((input) => [input.productId, input]));
  for (const result of output.results) {
    if (!expectedIds.has(result.productId) || seen.has(result.productId)) {
      throw new Error(`Unexpected or duplicate classification product ID: ${result.productId}`);
    }
    seen.add(result.productId);
    const input = inputById.get(result.productId);
    const allowedIds = new Set(input?.allowedItems.map((item) => item.id) ?? []);
    if (result.ipcaItemId !== null && !allowedIds.has(result.ipcaItemId)) {
      throw new Error(`Classification item is outside the allowlist: ${result.ipcaItemId}`);
    }
  }
  return output.results;
}

export class OpenAIProductClassifier implements ProductClassifier {
  readonly #client: ResponsesClient;
  readonly #maxAttempts: number;
  readonly #model: string;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: OpenAIProductClassifierOptions = {}) {
    const env = options.env ?? process.env;
    this.#model = optional(options.model)
      ?? optional(env.OPENAI_CLASSIFICATION_MODEL)
      ?? DEFAULT_CLASSIFICATION_MODEL;
    this.#maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 5) {
      throw new RangeError("maxAttempts must be an integer from 1 to 5");
    }
    this.#sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (options.client !== undefined) {
      this.#client = options.client;
    } else {
      const apiKey = optional(options.apiKey) ?? optional(env.OPENAI_API_KEY);
      if (apiKey === undefined) throw new Error("An OpenAI API key is required");
      this.#client = new OpenAI({ apiKey, maxRetries: 0 }) as unknown as ResponsesClient;
    }
  }

  async classify(
    inputs: readonly ClassificationInput[],
  ): Promise<ClassificationBatchResult> {
    if (inputs.length === 0) {
      return {
        provider: "openai",
        model: this.#model,
        promptVersion: CLASSIFICATION_PROMPT_VERSION,
        promptHash: CLASSIFICATION_PROMPT_HASH,
        results: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    let response: ParsedResponse | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        response = await this.#client.responses.parse({
          model: this.#model,
          store: false,
          instructions: CLASSIFICATION_INSTRUCTIONS,
          input: buildClassificationPrompt(inputs),
          text: {
            format: zodTextFormat(
              ClassificationResponseSchema,
              "ipca_product_classifications",
            ),
          },
        }) as ParsedResponse;
        break;
      } catch (error) {
        if (!transientApiFailure(error) || attempt === this.#maxAttempts) throw error;
        await this.#sleep(250 * (2 ** (attempt - 1)));
      }
    }
    if (response === undefined) throw new Error("OpenAI response was not produced");

    const results = validateResults(response.output_parsed, inputs);
    return {
      provider: "openai",
      model: this.#model,
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      promptHash: CLASSIFICATION_PROMPT_HASH,
      results,
      usage: {
        inputTokens: integerUsage("input_tokens", response.usage?.input_tokens),
        outputTokens: integerUsage("output_tokens", response.usage?.output_tokens),
      },
    };
  }
}
