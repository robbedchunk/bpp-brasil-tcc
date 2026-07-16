import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import { z } from "zod";

import { StrategySchema } from "../strategies/schema.js";
import type {
  GenerationRequest,
  GenerationResult,
  StrategyGenerator,
} from "./provider.js";

export const DEFAULT_EXPLORER_MODEL = "gpt-5.6-sol";
export const DEFAULT_EXPLORER_REASONING_EFFORT = "high";
export const DEFAULT_EXPLORER_TIMEOUT_MS = 480_000;
// Healing turns retry against a drifted retailer with prior-failure context and
// replay evidence in the prompt, so at high reasoning effort they run materially
// longer than initial exploration turns. Aborting a turn mid-flight kills the
// Codex process before `turn.completed` usage can arrive, which forces the
// deliberate fail-closed unauditable-spend charge of the remaining event
// reservation. Healing therefore gets a longer turn timeout by default.
export const DEFAULT_EXPLORER_HEALING_TIMEOUT_MS = 960_000;
const MIN_EXPLORER_TIMEOUT_MS = 30_000;
const MAX_EXPLORER_TIMEOUT_MS = 1_800_000;
const EXPLORER_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
type ExplorerReasoningEffort = (typeof EXPLORER_REASONING_EFFORTS)[number];

const StrategyEnvelopeSchema = z.object({ strategy: StrategySchema }).strict();

function nullableWireSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return { anyOf: [schema, { type: "null" }] };
  }
  const type = (schema as { type?: unknown }).type;
  if (typeof type === "string") {
    return {
      ...schema,
      type: type === "null" ? type : [type, "null"],
    };
  }
  if (Array.isArray(type)) {
    return {
      ...schema,
      type: type.includes("null") ? type : [...type, "null"],
    };
  }
  return { anyOf: [schema, { type: "null" }] };
}

function codexWireSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(codexWireSchema);
  if (value === null || typeof value !== "object") return value;

  const schema = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, codexWireSchema(child)]),
  ) as Record<string, unknown>;
  delete schema.propertyNames;
  if ("oneOf" in schema) {
    schema.anyOf = schema.oneOf;
    delete schema.oneOf;
  }
  const objectType = schema.type === "object"
    || (Array.isArray(schema.type) && schema.type.includes("object"));
  const schemaAdditionalProperties = schema.additionalProperties !== null
    && typeof schema.additionalProperties === "object"
    && !Array.isArray(schema.additionalProperties);
  if (objectType && schemaAdditionalProperties && !("properties" in schema)) {
    schema.properties = {};
    schema.required = [];
  }
  if (schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const properties = schema.properties as Record<string, unknown>;
    const previouslyRequired = new Set(
      Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [],
    );
    for (const [key, property] of Object.entries(properties)) {
      if (!previouslyRequired.has(key)) properties[key] = nullableWireSchema(property);
    }
    schema.required = Object.keys(properties);
  }
  return schema;
}

const STRATEGY_OUTPUT_SCHEMA = codexWireSchema(z.toJSONSchema(StrategyEnvelopeSchema));
const MAX_ARTIFACT_BYTES = 1_000_000;
const MAX_WORKSPACE_BYTES = 8_000_000;
const MAX_WORKSPACE_ENTRIES = 128;
const MAX_WORKSPACE_DEPTH = 8;
const SANDBOX_DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface CodexThreadLike {
  runStreamed(
    prompt: string,
    options?: TurnOptions,
  ): Promise<{
    events: AsyncIterable<
      | { type: "turn.started" }
      | { type: "turn.completed"; usage: CodexUsageLike | null }
      | { type: "turn.failed"; error: { message: string } }
      | { type: "error"; message: string }
      | {
          type: "item.completed";
          item: { type: string; text?: string };
        }
      | { type: "thread.started"; thread_id: string }
      | { type: "item.started" | "item.updated"; item: unknown }
    >;
  }>;
}

interface CodexUsageLike {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

interface CodexLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

export interface CodexStrategyGeneratorOptions {
  apiKey?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  temporaryRoot?: string;
  codexFactory?: (options: CodexOptions) => CodexLike;
  removeTemporaryState?: (
    path: string,
    options: { recursive: true; force: true },
  ) => Promise<void>;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function resolveExplorerApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return optional(env.CODEX_API_KEY) ?? optional(env.OPENAI_API_KEY);
}

export function resolveExplorerBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return optional(env.CODEX_BASE_URL) ?? optional(env.OPENAI_BASE_URL);
}

export function explorerModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return optional(env.OPENAI_EXPLORER_MODEL) ?? DEFAULT_EXPLORER_MODEL;
}

export function explorerReasoningEffortFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ExplorerReasoningEffort {
  const value = optional(env.OPENAI_EXPLORER_REASONING_EFFORT);
  if (value === undefined) return DEFAULT_EXPLORER_REASONING_EFFORT;
  if ((EXPLORER_REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as ExplorerReasoningEffort;
  }
  throw new Error(
    "OPENAI_EXPLORER_REASONING_EFFORT must be one of none, low, medium, high, xhigh",
  );
}

function timeoutMsFromEnvValue(name: string, value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be an integer from 30000 to 1800000`);
  }
  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_EXPLORER_TIMEOUT_MS
    || timeoutMs > MAX_EXPLORER_TIMEOUT_MS
  ) {
    throw new Error(`${name} must be an integer from 30000 to 1800000`);
  }
  return timeoutMs;
}

export function explorerTimeoutMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = optional(env.OPENAI_EXPLORER_TIMEOUT_MS);
  if (value === undefined) return DEFAULT_EXPLORER_TIMEOUT_MS;
  return timeoutMsFromEnvValue("OPENAI_EXPLORER_TIMEOUT_MS", value);
}

export function explorerHealingTimeoutMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = optional(env.OPENAI_EXPLORER_HEALING_TIMEOUT_MS);
  if (value === undefined) {
    // Healing must never get a shorter turn than initial exploration, even
    // when an operator raised the base turn timeout above the healing default.
    return Math.max(
      explorerTimeoutMsFromEnv(env),
      DEFAULT_EXPLORER_HEALING_TIMEOUT_MS,
    );
  }
  return timeoutMsFromEnvValue("OPENAI_EXPLORER_HEALING_TIMEOUT_MS", value);
}

// A malformed per-request override is clamped, never thrown: by the time the
// generator runs, the caller has already booked the attempt, and a thrown
// configuration error is indistinguishable from an aborted paid turn — it
// would be charged fail-closed as unauditable spend.
function boundedTurnTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return undefined;
  return Math.min(
    MAX_EXPLORER_TIMEOUT_MS,
    Math.max(MIN_EXPLORER_TIMEOUT_MS, Math.trunc(timeoutMs)),
  );
}

function tomlString(value: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Unable to encode Codex TOML string");
  return serialized;
}

function endpointHostname(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error("Explorer base URL must be a valid HTTP(S) URL");
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || endpoint.hostname.length === 0
  ) {
    throw new Error("Explorer base URL must be a valid HTTP(S) URL");
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new Error("Explorer base URL must not contain embedded credentials");
  }
  if (endpoint.hash.length > 0) {
    throw new Error("Explorer base URL must not contain a fragment");
  }
  return endpoint.hostname.toLowerCase();
}

function safeDomains(domains: readonly string[], baseUrl: string | undefined): string[] {
  const normalized = domains.map((domain) => domain.trim().toLowerCase());
  for (const domain of normalized) {
    if (!SANDBOX_DOMAIN_PATTERN.test(domain)) {
      throw new Error(`Invalid retailer domain: ${domain}`);
    }
  }
  const gatewayHostname = endpointHostname(baseUrl);
  if (gatewayHostname !== undefined && !SANDBOX_DOMAIN_PATTERN.test(gatewayHostname)) {
    throw new Error(`Invalid explorer endpoint hostname: ${gatewayHostname}`);
  }
  const allowed = [
    ...normalized,
    "api.openai.com",
    ...(gatewayHostname === undefined || gatewayHostname === "api.openai.com"
      ? []
      : [gatewayHostname]),
  ];
  return [...new Set(allowed)];
}

// Permission maps cannot safely cross the SDK's dotted config-override
// serializer because quoted keys containing dots are split into path segments.
// A real TOML file preserves each quoted hostname and absolute path as one key.
function codexConfigToml(
  workspacePath: string,
  domains: readonly string[],
  baseUrl: string | undefined,
): string {
  const filesystemRules: Array<[string, "read" | "write" | "deny"]> = [
    [":minimal", "read"],
    [workspacePath, "write"],
    [`${workspacePath}/*env*`, "deny"],
    [`${workspacePath}/**/*env*`, "deny"],
    [`${workspacePath}/*auth*`, "deny"],
    [`${workspacePath}/**/*auth*`, "deny"],
    [`${workspacePath}/*credential*`, "deny"],
    [`${workspacePath}/**/*credential*`, "deny"],
  ];
  const lines = [
    'default_permissions = "explorer"',
    'approval_policy = "never"',
    "",
    "[features]",
    "network_proxy = true",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    "ignore_default_excludes = false",
    'include_only = ["PATH", "HOME", "LANG", "LC_ALL", "TZ"]',
    "",
    "[permissions.explorer]",
    'description = "Disposable retailer strategy exploration"',
    "",
    "[permissions.explorer.workspace_roots]",
    `${tomlString(workspacePath)} = true`,
    "",
    "[permissions.explorer.filesystem]",
    "glob_scan_max_depth = 8",
    ...filesystemRules.map(([path, access]) => `${tomlString(path)} = ${tomlString(access)}`),
    "",
    "[permissions.explorer.network]",
    "enabled = true",
    'mode = "full"',
    "allow_local_binding = false",
    "",
    "[permissions.explorer.network.domains]",
    ...safeDomains(domains, baseUrl).map(
      (domain) => `${tomlString(domain)} = "allow"`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export function stripOptionalNulls(value: unknown, schema: z.core.$ZodType): unknown {
  let inner = schema;
  while (
    inner instanceof z.ZodOptional
    || inner instanceof z.ZodNullable
    || inner instanceof z.ZodDefault
    || inner instanceof z.ZodReadonly
  ) {
    inner = inner.unwrap();
  }
  if (inner instanceof z.ZodObject && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, unknown> = { ...value };
    for (const [key, field] of Object.entries(inner.shape)) {
      if (result[key] === null && field.isOptional()) {
        delete result[key];
      } else if (key in result) {
        result[key] = stripOptionalNulls(result[key], field);
      }
    }
    return result;
  }
  if (inner instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((item) => stripOptionalNulls(item, inner.element));
  }
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) {
    return inner.options.reduce(
      (current, option) => stripOptionalNulls(current, option),
      value,
    );
  }
  if (inner instanceof z.ZodLazy) return stripOptionalNulls(value, inner.unwrap());
  return value;
}

function parseEnvelope(text: string, source: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} was not valid JSON`);
  }
  return StrategyEnvelopeSchema.parse(stripOptionalNulls(parsed, StrategyEnvelopeSchema));
}

function generationUsage(usage: CodexUsageLike) {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

async function auditWorkspaceTree(workspacePath: string): Promise<void> {
  let entries = 0;
  let totalBytes = 0;
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > MAX_WORKSPACE_DEPTH) {
      throw new Error("Generated workspace exceeds the trusted host depth limit");
    }
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > MAX_WORKSPACE_ENTRIES) {
        throw new Error("Generated workspace exceeds the trusted host entry limit");
      }
      const relative = relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      const path = join(directory, child.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Generated workspace contains a symbolic link: ${relative}`);
      }
      if (metadata.isDirectory()) {
        await visit(path, relative, depth + 1);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(`Generated workspace contains a non-regular file: ${relative}`);
      }
      if ((metadata.mode & 0o111) !== 0 && relative !== "validate-strategy") {
        throw new Error(`Generated workspace contains an unexpected executable: ${relative}`);
      }
      if (metadata.size > MAX_ARTIFACT_BYTES) {
        throw new Error(`Generated workspace file exceeds the trusted host size limit: ${relative}`);
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_WORKSPACE_BYTES) {
        throw new Error("Generated workspace exceeds the trusted host total size limit");
      }
    }
  };
  const root = await lstat(workspacePath);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Generated workspace root must remain a regular directory");
  }
  await visit(workspacePath, "", 0);
}

async function descriptorReadUtf8(
  handle: Awaited<ReturnType<typeof open>>,
  limit: number,
): Promise<{ text: string; bytes: number }> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > limit) throw new Error("strategy.json exceeds the trusted host size limit");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return { text: Buffer.concat(chunks, total).toString("utf8"), bytes: total };
}

function sameArtifactIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.isFile() === right.isFile()
    && left.nlink === right.nlink
    && left.size === right.size;
}

async function readRegularArtifact(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("strategy.json must be one regular file, not a symbolic link");
  }
  if (metadata.size > MAX_ARTIFACT_BYTES) {
    throw new Error("strategy.json exceeds the trusted host size limit");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameArtifactIdentity(metadata, opened)) {
      throw new Error("strategy.json changed before the trusted host could read it");
    }
    const read = await descriptorReadUtf8(handle, MAX_ARTIFACT_BYTES);
    const after = await handle.stat();
    if (!after.isFile() || !sameArtifactIdentity(opened, after) || read.bytes !== after.size) {
      throw new Error("strategy.json changed while the trusted host read it");
    }
    return read.text;
  } finally {
    await handle.close();
  }
}

export class CodexStrategyGenerator implements StrategyGenerator {
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string | undefined;
  readonly #model: string;
  readonly #reasoningEffort: ExplorerReasoningEffort;
  readonly #timeoutMs: number;
  readonly #temporaryRoot: string;
  readonly #factory: (options: CodexOptions) => CodexLike;
  readonly #removeTemporaryState: NonNullable<
    CodexStrategyGeneratorOptions["removeTemporaryState"]
  >;

  constructor(options: CodexStrategyGeneratorOptions = {}) {
    const env = options.env ?? process.env;
    this.#apiKey = optional(options.apiKey) ?? resolveExplorerApiKey(env);
    this.#baseUrl = resolveExplorerBaseUrl(env);
    this.#model = optional(options.model) ?? explorerModelFromEnv(env);
    this.#reasoningEffort = explorerReasoningEffortFromEnv(env);
    this.#timeoutMs = options.timeoutMs ?? explorerTimeoutMsFromEnv(env);
    const projectRoot = resolve(optional(env.PROJECT_ROOT) ?? DEFAULT_PROJECT_ROOT);
    this.#temporaryRoot = resolve(options.temporaryRoot ?? join(projectRoot, "var"));
    this.#factory = options.codexFactory ?? ((codexOptions) => new Codex(codexOptions));
    this.#removeTemporaryState = options.removeTemporaryState ?? rm;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const apiKey = this.#apiKey;
    if (apiKey === undefined) {
      return {
        status: "provider_unavailable",
        model: this.#model,
        usage: { inputTokens: 0, outputTokens: 0 },
        error: "Explorer API credentials are not configured",
      };
    }

    await mkdir(this.#temporaryRoot, { recursive: true, mode: 0o700 });
    const stateRoot = await mkdtemp(join(this.#temporaryRoot, "codex-explorer-state-"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: GenerationResult | undefined;
    let generationError: unknown;
    let cleanupError: unknown;
    try {
      result = await (async (): Promise<GenerationResult> => {
        const home = join(stateRoot, "home");
        const codexHome = join(stateRoot, "codex-home");
        await Promise.all([
          mkdir(home, { recursive: true, mode: 0o700 }),
          mkdir(codexHome, { recursive: true, mode: 0o700 }),
        ]);
        const workspacePath = resolve(request.workspacePath);
        await writeFile(
          join(codexHome, "config.toml"),
          codexConfigToml(workspacePath, request.allowedDomains, this.#baseUrl),
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        const runtimeEnv = {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          CODEX_HOME: codexHome,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          TZ: "UTC",
        };
        const timeoutMs = boundedTurnTimeoutMs(request.timeoutMs) ?? this.#timeoutMs;
        const controller = new AbortController();
        let timedOut = false;
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        const codex = this.#factory({
          apiKey,
          ...(this.#baseUrl === undefined ? {} : { baseUrl: this.#baseUrl }),
          env: runtimeEnv,
        });
        const thread = codex.startThread({
          model: this.#model,
          workingDirectory: workspacePath,
          skipGitRepoCheck: true,
          modelReasoningEffort: this.#reasoningEffort as unknown as NonNullable<ThreadOptions["modelReasoningEffort"]>,
          approvalPolicy: "never",
          webSearchMode: "disabled",
        });
        let finalResponse = "";
        let completedUsage: CodexUsageLike | null = null;
        let streamError: string | undefined;
        let turnStarted = false;
        try {
          const streamed = await thread.runStreamed(request.prompt, {
            outputSchema: STRATEGY_OUTPUT_SCHEMA,
            signal: controller.signal,
          });
          for await (const event of streamed.events) {
            if (event.type === "turn.started") {
              turnStarted = true;
            } else if (event.type === "item.completed") {
              if (event.item.type === "agent_message" && typeof event.item.text === "string") {
                finalResponse = event.item.text;
              }
            } else if (event.type === "turn.completed") {
              completedUsage = event.usage;
            } else if (event.type === "turn.failed") {
              streamError = event.error.message;
            } else if (event.type === "error") {
              streamError = event.message;
            }
          }
        } catch (error) {
          const thrownMessage = error instanceof Error
            ? error.message
            : String(error) || "Codex stream failed";
          streamError = streamError === undefined
            ? thrownMessage
            : `${streamError}; ${thrownMessage}`;
        }
        const usage = completedUsage === null
          ? { inputTokens: 0, outputTokens: 0 }
          : generationUsage(completedUsage);
        if (completedUsage === null && timedOut) {
          // Attribute the abort to this host's own turn timeout so the
          // durable evidence names the limit that fired instead of the
          // generic AbortError text. Accounting is unchanged: the turn was
          // killed before usage arrived, so the spend stays unauditable.
          const timeoutMessage =
            `the ${timeoutMs}ms explorer turn timeout aborted the turn before usage accounting`;
          streamError = streamError === undefined
            ? timeoutMessage
            : `${timeoutMessage}: ${streamError}`;
        }
        if (completedUsage === null) {
          return {
            status: "unauditable_spend",
            model: this.#model,
            usage,
            error: streamError === undefined
              ? `${turnStarted ? "Started Codex turn" : "Codex stream"} completed without auditable token usage`
              : `Codex spend is unauditable${turnStarted ? " after turn start" : ""}: ${streamError}`,
          };
        }
        if (streamError !== undefined) {
          return { status: "failed", model: this.#model, usage, error: streamError };
        }
        try {
          await auditWorkspaceTree(workspacePath);
          const artifactText = await readRegularArtifact(join(workspacePath, "strategy.json"));
          const artifact = parseEnvelope(artifactText, "strategy.json");
          let response: ReturnType<typeof parseEnvelope>;
          try {
            response = parseEnvelope(finalResponse, "Codex final response");
          } catch {
            return {
              status: "candidate",
              model: this.#model,
              strategy: artifact.strategy,
              usage,
              warning: "Codex final response was invalid; accepted validated strategy.json artifact",
            };
          }
          if (canonicalJson(response) !== canonicalJson(artifact)) {
            return {
              status: "candidate",
              model: this.#model,
              strategy: artifact.strategy,
              usage,
              warning: "Codex final response diverged; accepted validated strategy.json artifact",
            };
          }
          return {
            status: "candidate",
            model: this.#model,
            strategy: artifact.strategy,
            usage,
          };
        } catch (error) {
          return {
            status: "failed",
            model: this.#model,
            usage,
            error: error instanceof Error ? error.message : String(error) || "Invalid Codex artifact",
          };
        }
      })();
    } catch (error) {
      generationError = error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      try {
        await this.#removeTemporaryState(stateRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error;
      }
    }

    if (result === undefined) {
      throw generationError ?? cleanupError ?? new Error("Codex generation produced no result");
    }
    if (cleanupError !== undefined) {
      const message = cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError) || "Disposable Codex state cleanup failed";
      if (result.status === "unauditable_spend") {
        return { ...result, error: `${result.error}; disposable state cleanup failed: ${message}` };
      }
      return {
        status: "safety_failure",
        model: result.model,
        usage: result.usage,
        error: `Disposable Codex state cleanup failed: ${message}`,
      };
    }
    return result;
  }
}
