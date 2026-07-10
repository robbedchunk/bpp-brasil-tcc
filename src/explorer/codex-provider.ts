import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
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

interface CodexThreadLike {
  run(
    prompt: string,
    options?: TurnOptions,
  ): Promise<{
    finalResponse: string;
    items: unknown[];
    usage: null | {
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
    };
  }>;
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

async function readRegularArtifact(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("strategy.json must be one regular file, not a symbolic link");
  }
  if (metadata.size > 1_000_000) {
    throw new Error("strategy.json exceeds the trusted host size limit");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== metadata.size) {
      throw new Error("strategy.json changed before the trusted host could read it");
    }
    return await handle.readFile("utf8");
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

  constructor(options: CodexStrategyGeneratorOptions = {}) {
    const env = options.env ?? process.env;
    this.#apiKey = optional(options.apiKey) ?? resolveExplorerApiKey(env);
    this.#model = optional(options.model) ?? explorerModelFromEnv(env);
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
    this.#factory = options.codexFactory ?? ((codexOptions) => new Codex(codexOptions));
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    if (this.#apiKey === undefined) {
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
    try {
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
        apiKey: this.#apiKey,
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
      const turn = await thread.run(request.prompt, {
        outputSchema: STRATEGY_OUTPUT_SCHEMA,
        signal: controller.signal,
      });
      const response = parseEnvelope(turn.finalResponse, "Codex final response");
      const artifactText = await readRegularArtifact(join(workspacePath, "strategy.json"));
      const artifact = parseEnvelope(artifactText, "strategy.json");
      if (JSON.stringify(response) !== JSON.stringify(artifact)) {
        throw new Error("Codex response and strategy.json artifact differ");
      }
      if (turn.usage === null) {
        throw new Error("Codex completed without auditable token usage");
      }
      return {
        status: "candidate",
        model: this.#model,
        strategy: artifact.strategy,
        usage: {
          inputTokens: turn.usage.input_tokens,
          outputTokens: turn.usage.output_tokens,
          cachedInputTokens: turn.usage.cached_input_tokens,
          reasoningOutputTokens: turn.usage.reasoning_output_tokens,
        },
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await rm(stateRoot, { recursive: true, force: true });
    }
  }
}
