import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const StrategyEnvelopeSchema = z.object({ strategy: StrategySchema }).strict();
const STRATEGY_OUTPUT_SCHEMA = z.toJSONSchema(StrategyEnvelopeSchema);
const MAX_ARTIFACT_BYTES = 1_000_000;
const MAX_WORKSPACE_BYTES = 8_000_000;
const MAX_WORKSPACE_ENTRIES = 128;
const MAX_WORKSPACE_DEPTH = 8;

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

export function explorerModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return optional(env.OPENAI_EXPLORER_MODEL) ?? DEFAULT_EXPLORER_MODEL;
}

// The SDK flattens config objects into dotted paths. Quoting map keys here is
// required for hostnames and absolute paths containing dots to remain one TOML key.
function configMapKey(value: string): string {
  return JSON.stringify(value);
}

function safeDomains(domains: readonly string[]): string[] {
  const normalized = domains.map((domain) => domain.trim().toLowerCase());
  for (const domain of normalized) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain)) {
      throw new Error(`Invalid retailer domain: ${domain}`);
    }
  }
  return [...new Set([...normalized, "api.openai.com"])];
}

function codexConfig(
  workspacePath: string,
  domains: readonly string[],
): NonNullable<CodexOptions["config"]> {
  const quotedWorkspace = configMapKey(workspacePath);
  const filesystem: Record<string, string | number> = {
    glob_scan_max_depth: 8,
    [configMapKey(":minimal")]: "read",
    [quotedWorkspace]: "write",
    [configMapKey(`${workspacePath}/*env*`)]: "deny",
    [configMapKey(`${workspacePath}/**/*env*`)]: "deny",
    [configMapKey(`${workspacePath}/*auth*`)]: "deny",
    [configMapKey(`${workspacePath}/**/*auth*`)]: "deny",
    [configMapKey(`${workspacePath}/*credential*`)]: "deny",
    [configMapKey(`${workspacePath}/**/*credential*`)]: "deny",
  };
  const domainPermissions = Object.fromEntries(
    safeDomains(domains).map((domain) => [configMapKey(domain), "allow"]),
  );
  return {
    default_permissions: "explorer",
    approval_policy: "never",
    features: { network_proxy: true },
    shell_environment_policy: {
      inherit: "none",
      ignore_default_excludes: false,
      include_only: ["PATH", "HOME", "LANG", "LC_ALL", "TZ"],
    },
    permissions: {
      explorer: {
        description: "Disposable retailer strategy exploration",
        workspace_roots: { [quotedWorkspace]: true },
        filesystem,
        network: {
          enabled: true,
          mode: "full",
          allow_local_binding: false,
          domains: domainPermissions,
        },
      },
    },
  };
}

function parseEnvelope(text: string, source: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} was not valid JSON`);
  }
  return StrategyEnvelopeSchema.parse(parsed);
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
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #temporaryRoot: string;
  readonly #factory: (options: CodexOptions) => CodexLike;
  readonly #removeTemporaryState: NonNullable<
    CodexStrategyGeneratorOptions["removeTemporaryState"]
  >;

  constructor(options: CodexStrategyGeneratorOptions = {}) {
    const env = options.env ?? process.env;
    this.#apiKey = optional(options.apiKey) ?? resolveExplorerApiKey(env);
    this.#model = optional(options.model) ?? explorerModelFromEnv(env);
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
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
        const runtimeEnv = {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          CODEX_HOME: codexHome,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          TZ: "UTC",
        };
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), this.#timeoutMs);
        const codex = this.#factory({
          apiKey,
          env: runtimeEnv,
          config: codexConfig(workspacePath, request.allowedDomains),
        });
        const thread = codex.startThread({
          model: this.#model,
          workingDirectory: workspacePath,
          skipGitRepoCheck: true,
          modelReasoningEffort: "medium",
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
          streamError = error instanceof Error ? error.message : String(error) || "Codex stream failed";
        }
        const usage = completedUsage === null
          ? { inputTokens: 0, outputTokens: 0 }
          : generationUsage(completedUsage);
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
          const response = parseEnvelope(finalResponse, "Codex final response");
          const artifactText = await readRegularArtifact(join(workspacePath, "strategy.json"));
          const artifact = parseEnvelope(artifactText, "strategy.json");
          if (canonicalJson(response) !== canonicalJson(artifact)) {
            throw new Error("Codex response and strategy.json artifact differ");
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
