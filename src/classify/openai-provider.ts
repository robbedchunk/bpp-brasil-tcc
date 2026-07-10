import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
} from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import {
  CLASSIFICATION_INSTRUCTIONS,
  CLASSIFICATION_PROMPT_HASH,
  CLASSIFICATION_PROMPT_VERSION,
  buildClassificationPrompt,
} from "./prompt.js";
import { ClassificationProviderError } from "./provider.js";
import type {
  ClassificationBatchResult,
  ClassificationAttemptEvidence,
  ClassificationInput,
  ProductClassifier,
} from "./provider.js";

export const DEFAULT_CLASSIFICATION_MODEL = "gpt-5.6-luna";

export const ClassificationResultSchema = z.object({
  productId: z.string().min(1),
  ipcaItemId: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  rationaleCode: z.string().regex(/^[a-z0-9][a-z0-9_]{0,63}$/u),
}).strict();

export const ClassificationResponseSchema = z.object({
  results: z.array(ClassificationResultSchema),
}).strict();

interface ResponsesClient {
  responses: {
    create?(request: unknown): Promise<unknown>;
    parse?(request: unknown): Promise<unknown>;
  };
}

interface ParsedResponse {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  output?: unknown;
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

export function classificationModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return optional(env.OPENAI_CLASSIFICATION_MODEL) ?? DEFAULT_CLASSIFICATION_MODEL;
}

const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function nestedErrorCode(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? nestedErrorCode(error.cause, depth + 1) : null;
}

export function isTransientOpenAIError(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError || error instanceof APIConnectionError) {
    return true;
  }
  if (typeof error !== "object" || error === null) return false;
  const status = "status" in error ? Number(error.status) : Number.NaN;
  if (
    status === 408
    || status === 409
    || status === 429
    || (status >= 500 && status <= 599)
  ) return true;
  return TRANSIENT_NETWORK_CODES.has(nestedErrorCode(error) ?? "");
}

function integerUsage(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`OpenAI response usage.${name} must be a non-negative integer`);
  }
  return value;
}

function actualModel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("OpenAI response model is required for auditable billing");
  }
  return value.trim();
}

function responseId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

interface CustomAttemptShape {
  actualModel?: unknown;
  responseId?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  failureKind?: unknown;
}

function customAttemptEvidence(
  error: unknown,
  requestedModel: string,
  attempt: number,
): ClassificationAttemptEvidence | null {
  if (
    typeof error !== "object"
    || error === null
    || !("classificationAttempt" in error)
    || typeof error.classificationAttempt !== "object"
    || error.classificationAttempt === null
  ) return null;
  const value = error.classificationAttempt as CustomAttemptShape;
  try {
    const kind = typeof value.failureKind === "string" ? value.failureKind.trim() : "";
    if (kind.length === 0) return null;
    return {
      provider: "openai",
      requestedModel,
      actualModel: actualModel(value.actualModel),
      responseId: responseId(value.responseId),
      attempt,
      inputTokens: integerUsage("input_tokens", value.inputTokens),
      outputTokens: integerUsage("output_tokens", value.outputTokens),
      failureKind: kind,
    };
  } catch {
    return null;
  }
}

function responseAttemptEvidence(
  response: ParsedResponse,
  requestedModel: string,
  attempt: number,
  failureKind: string,
): ClassificationAttemptEvidence {
  return {
    provider: "openai",
    requestedModel,
    actualModel: actualModel(response.model),
    responseId: responseId(response.id),
    attempt,
    inputTokens: integerUsage("input_tokens", response.usage?.input_tokens),
    outputTokens: integerUsage("output_tokens", response.usage?.output_tokens),
    failureKind,
  };
}

function containsRefusal(output: unknown): boolean {
  if (!Array.isArray(output)) return false;
  return output.some((item) => {
    if (typeof item !== "object" || item === null || !("content" in item)) return false;
    return Array.isArray(item.content) && item.content.some(
      (content: unknown) => typeof content === "object" && content !== null
        && "type" in content && content.type === "refusal",
    );
  });
}

function responseOutputText(output: unknown): string {
  if (!Array.isArray(output)) {
    throw new Error("OpenAI response output must be an array");
  }
  const texts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null || !("content" in item)) continue;
    if (!Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        typeof content === "object"
        && content !== null
        && "type" in content
        && content.type === "output_text"
        && "text" in content
        && typeof content.text === "string"
      ) texts.push(content.text);
    }
  }
  if (texts.length !== 1) {
    throw new Error("OpenAI response must contain exactly one output_text");
  }
  return texts[0] ?? "";
}

async function requestStructuredResponse(
  client: ResponsesClient,
  request: unknown,
  requestedModel: string,
  attempt: number,
): Promise<ParsedResponse> {
  if (client.responses.create !== undefined) {
    const response = await client.responses.create(request) as ParsedResponse;
    const status = typeof response.status === "string" ? response.status : "unknown";
    if (status !== "completed" || containsRefusal(response.output)) {
      return { ...response, output_parsed: null };
    }
    try {
      return {
        ...response,
        output_parsed: ClassificationResponseSchema.parse(
          JSON.parse(responseOutputText(response.output)) as unknown,
        ),
      };
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "OpenAI structured response parsing failed";
      const wrapped = new Error(message, { cause: error });
      Object.assign(wrapped, {
        classificationAttempt: responseAttemptEvidence(
          response,
          requestedModel,
          attempt,
          "schema_invalid",
        ),
      });
      throw wrapped;
    }
  }
  if (client.responses.parse !== undefined) {
    return client.responses.parse(request) as Promise<ParsedResponse>;
  }
  throw new Error("OpenAI Responses client must implement create or parse");
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
      ?? classificationModelFromEnv(env);
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
    let completedAttempt = 0;
    const failedAttempts: ClassificationAttemptEvidence[] = [];
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        response = await requestStructuredResponse(this.#client, {
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
        }, this.#model, attempt);
        completedAttempt = attempt;
        break;
      } catch (error) {
        const billedAttempt = customAttemptEvidence(error, this.#model, attempt);
        if (billedAttempt !== null) failedAttempts.push(billedAttempt);
        if (!isTransientOpenAIError(error) || attempt === this.#maxAttempts) {
          throw new ClassificationProviderError(
            error instanceof Error ? error.message : "OpenAI classification request failed",
            failedAttempts,
            { cause: error },
          );
        }
        await this.#sleep(250 * (2 ** (attempt - 1)));
      }
    }
    if (response === undefined) throw new Error("OpenAI response was not produced");

    let results: ReturnType<typeof validateResults>;
    const status = typeof response.status === "string" ? response.status : "unknown";
    if (status !== "completed") {
      const evidence = responseAttemptEvidence(response, this.#model, completedAttempt, "incomplete");
      throw new ClassificationProviderError(
        `OpenAI classification response was ${status}`,
        [...failedAttempts, evidence],
      );
    }
    try {
      results = validateResults(response.output_parsed, inputs);
    } catch (error) {
      const failureKind = response.output_parsed === null && containsRefusal(response.output)
        ? "refusal"
        : error instanceof z.ZodError
          ? "schema_invalid"
          : "validation_failed";
      const evidence = responseAttemptEvidence(
        response,
        this.#model,
        completedAttempt,
        failureKind,
      );
      throw new ClassificationProviderError(
        error instanceof Error ? error.message : "OpenAI classification validation failed",
        [...failedAttempts, evidence],
        { cause: error },
      );
    }
    return {
      provider: "openai",
      model: actualModel(response.model),
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      promptHash: CLASSIFICATION_PROMPT_HASH,
      results,
      usage: {
        inputTokens: integerUsage("input_tokens", response.usage?.input_tokens),
        outputTokens: integerUsage("output_tokens", response.usage?.output_tokens),
      },
      failedAttempts,
    };
  }
}
