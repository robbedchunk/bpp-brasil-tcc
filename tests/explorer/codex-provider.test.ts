import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  CodexStrategyGenerator,
  resolveExplorerApiKey,
  resolveExplorerBaseUrl,
} from "../../src/explorer/codex-provider.js";

const roots: string[] = [];
const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
const codexCliEntrypoint = join(
  dirname(sdkRequire.resolve("@openai/codex/package.json")),
  "bin",
  "codex.js",
);
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const strategy = {
  schemaVersion: 1,
  purpose: "extraction",
  tier: "dom",
  allowedDomains: ["shop.test"],
  url: "{productUrl}",
  selectors: {
    title: [{ selector: ".product-title" }],
    brand: [{ selector: ".brand" }],
    price: [{ selector: ".price" }],
    promoPrice: [{ selector: ".promo" }],
    unit: [{ selector: ".unit" }],
    availability: [{ selector: ".stock" }],
  },
} as const;

const usage = (
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  reasoningOutputTokens = 0,
) => ({
  input_tokens: inputTokens,
  cached_input_tokens: cachedInputTokens,
  output_tokens: outputTokens,
  reasoning_output_tokens: reasoningOutputTokens,
});

function streamed(
  finalResponse: string,
  tokenUsage: ReturnType<typeof usage> | null,
  errorAfterCompletion?: Error,
) {
  return {
    events: (async function* () {
      yield { type: "turn.started" as const };
      yield {
        type: "item.completed" as const,
        item: { id: "message-1", type: "agent_message" as const, text: finalResponse },
      };
      yield { type: "turn.completed" as const, usage: tokenUsage };
      if (errorAfterCompletion !== undefined) throw errorAfterCompletion;
    })(),
  };
}

describe("Codex SDK strategy provider", () => {
  it("compares JSON semantically rather than by object property order", () => {
    expect(canonicalJson({ nested: { b: 2, a: 1 }, z: 0 }))
      .toBe(canonicalJson({ z: 0, nested: { a: 1, b: 2 } }));
  });

  it("prefers the dedicated key and never consults cached authentication", () => {
    expect(resolveExplorerApiKey({ CODEX_API_KEY: "codex", OPENAI_API_KEY: "openai" }))
      .toBe("codex");
    expect(resolveExplorerApiKey({ OPENAI_API_KEY: "openai" })).toBe("openai");
    expect(resolveExplorerApiKey({ CODEX_API_KEY: "  ", OPENAI_API_KEY: "  " }))
      .toBeUndefined();
  });

  it("prefers the dedicated base URL and treats blank values as unset", () => {
    expect(resolveExplorerBaseUrl({
      CODEX_BASE_URL: " http://127.0.0.1:8080/v1 ",
      OPENAI_BASE_URL: "https://fallback.example/v1",
    })).toBe("http://127.0.0.1:8080/v1");
    expect(resolveExplorerBaseUrl({ OPENAI_BASE_URL: "http://localhost:8080/v1" }))
      .toBe("http://localhost:8080/v1");
    expect(resolveExplorerBaseUrl({ CODEX_BASE_URL: "  ", OPENAI_BASE_URL: "  " }))
      .toBeUndefined();
  });

  it("uses the exact permission profile, strict root schema, and disposable homes", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "explorer-provider-test-"));
    roots.push(workspacePath);
    const captured: {
      options?: Record<string, any>;
      thread?: Record<string, any>;
      turn?: Record<string, any>;
    } = {};
    let configToml = "";
    let configMode = 0;
    const provider = new CodexStrategyGenerator({
      apiKey: "test-key",
      env: {},
      model: "gpt-5.6-sol",
      codexFactory: (options) => {
        captured.options = options as Record<string, any>;
        return {
          startThread(threadOptions) {
            captured.thread = threadOptions as Record<string, any>;
            return {
              async runStreamed(_prompt, turnOptions) {
                captured.turn = turnOptions as Record<string, any>;
                const configPath = join(options.env!.CODEX_HOME!, "config.toml");
                configToml = await readFile(configPath, "utf8");
                configMode = (await stat(configPath)).mode & 0o777;
                await writeFile(
                  join(workspacePath, "strategy.json"),
                  JSON.stringify({ strategy }),
                  "utf8",
                );
                return streamed(JSON.stringify({ strategy }), usage(321, 42, 20, 12));
              },
            };
          },
        };
      },
    });

    const result = await provider.generate({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test", "cdn.shop.test"],
      workspacePath,
      prompt: "Create the artifact.",
    });

    expect(result).toMatchObject({
      status: "candidate",
      model: "gpt-5.6-sol",
      strategy,
      usage: { inputTokens: 321, outputTokens: 42 },
    });
    expect(captured.options).not.toHaveProperty("codexPathOverride");
    expect(captured.options).not.toHaveProperty("baseUrl");
    expect(captured.options).not.toHaveProperty("config");
    expect(captured.options).toMatchObject({
      apiKey: "test-key",
      env: {
        HOME: expect.any(String),
        CODEX_HOME: expect.any(String),
        PATH: expect.any(String),
      },
    });
    expect(configToml).toBe([
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
      `${JSON.stringify(workspacePath)} = true`,
      "",
      "[permissions.explorer.filesystem]",
      "glob_scan_max_depth = 8",
      `${JSON.stringify(":minimal")} = "read"`,
      `${JSON.stringify(workspacePath)} = "write"`,
      `${JSON.stringify(`${workspacePath}/*env*`)} = "deny"`,
      `${JSON.stringify(`${workspacePath}/**/*env*`)} = "deny"`,
      `${JSON.stringify(`${workspacePath}/*auth*`)} = "deny"`,
      `${JSON.stringify(`${workspacePath}/**/*auth*`)} = "deny"`,
      `${JSON.stringify(`${workspacePath}/*credential*`)} = "deny"`,
      `${JSON.stringify(`${workspacePath}/**/*credential*`)} = "deny"`,
      "",
      "[permissions.explorer.network]",
      "enabled = true",
      'mode = "full"',
      "allow_local_binding = false",
      "",
      "[permissions.explorer.network.domains]",
      '"shop.test" = "allow"',
      '"cdn.shop.test" = "allow"',
      '"api.openai.com" = "allow"',
      "",
    ].join("\n"));
    expect(configMode).toBe(0o600);
    expect(Object.keys(captured.options!.env).sort()).toEqual([
      "CODEX_HOME",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TZ",
    ]);
    expect(captured.options!.env.CODEX_HOME.startsWith(
      join(resolve("var"), "codex-explorer-state-"),
    )).toBe(true);
    expect(captured.thread).toMatchObject({
      workingDirectory: workspacePath,
      skipGitRepoCheck: true,
      model: "gpt-5.6-sol",
      modelReasoningEffort: "medium",
      approvalPolicy: "never",
      webSearchMode: "disabled",
    });
    expect(captured.thread).not.toHaveProperty("sandboxMode");
    expect(captured.thread).not.toHaveProperty("networkAccessEnabled");
    expect(captured.thread).not.toHaveProperty("additionalDirectories");
    expect(captured.turn?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["strategy"],
    });
    expect(captured.turn?.outputSchema.properties.strategy).toBeTruthy();
    await expect(access(captured.options!.env.HOME)).rejects.toThrow();
    await expect(access(captured.options!.env.CODEX_HOME)).rejects.toThrow();
  });

  it.each([
    {
      label: "dedicated loopback override",
      env: {
        CODEX_API_KEY: "test-key",
        CODEX_BASE_URL: "http://127.0.0.1:8080/v1",
        OPENAI_BASE_URL: "https://fallback.example/v1",
      },
      expectedBaseUrl: "http://127.0.0.1:8080/v1",
      expectedDomains: ["shop.test", "api.openai.com", "127.0.0.1"],
    },
    {
      label: "shared localhost fallback",
      env: {
        CODEX_API_KEY: "test-key",
        OPENAI_BASE_URL: "http://localhost:8080/v1",
      },
      expectedBaseUrl: "http://localhost:8080/v1",
      expectedDomains: ["shop.test", "api.openai.com", "localhost"],
    },
    {
      label: "official endpoint",
      env: {
        CODEX_API_KEY: "test-key",
        CODEX_BASE_URL: "https://api.openai.com/v1",
      },
      expectedBaseUrl: "https://api.openai.com/v1",
      expectedDomains: ["shop.test", "api.openai.com"],
    },
  ])("passes the $label base URL and only its non-default host to the sandbox", async ({
    env,
    expectedBaseUrl,
    expectedDomains,
  }) => {
    const workspacePath = await mkdtemp(join(tmpdir(), "explorer-provider-endpoint-test-"));
    roots.push(workspacePath);
    let captured: Record<string, any> | undefined;
    let configToml = "";
    const provider = new CodexStrategyGenerator({
      env,
      codexFactory: (options) => {
        captured = options as Record<string, any>;
        return {
          startThread: () => ({
            runStreamed: async () => {
              configToml = await readFile(join(options.env!.CODEX_HOME!, "config.toml"), "utf8");
              await writeFile(join(workspacePath, "strategy.json"), JSON.stringify({ strategy }));
              return streamed(JSON.stringify({ strategy }), usage(3, 2));
            },
          }),
        };
      },
    });

    await expect(provider.generate({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      workspacePath,
      prompt: "Create the artifact.",
    })).resolves.toMatchObject({ status: "candidate" });

    expect(captured).toMatchObject({ baseUrl: expectedBaseUrl });
    expect(captured).not.toHaveProperty("config");
    expect(configToml.split("\n").filter((line) => line.endsWith(' = "allow"')))
      .toEqual(expectedDomains.map((domain) => `${JSON.stringify(domain)} = "allow"`));
  });

  it("writes dotted domain keys in a config.toml the pinned real Codex CLI parses", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "explorer-provider-cli-config-test-"));
    roots.push(workspacePath);
    let cliParsedConfig = false;
    const provider = new CodexStrategyGenerator({
      apiKey: "test-key",
      env: {},
      codexFactory: (options) => {
        const parsed = spawnSync(process.execPath, [
          codexCliEntrypoint,
          "features",
          "list",
        ], {
          encoding: "utf8",
          env: options.env,
          timeout: 10_000,
        });
        if (parsed.error !== undefined) throw parsed.error;
        if (parsed.status !== 0) {
          throw new Error(`Pinned Codex CLI rejected config.toml: ${parsed.stderr.trim()}`);
        }
        cliParsedConfig = true;
        return {
          startThread: () => ({
            runStreamed: async () => {
              await writeFile(join(workspacePath, "strategy.json"), JSON.stringify({ strategy }));
              return streamed(JSON.stringify({ strategy }), usage(2, 1));
            },
          }),
        };
      },
    });

    await expect(provider.generate({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      workspacePath,
      prompt: "Load the offline config only.",
    })).resolves.toMatchObject({ status: "candidate" });
    expect(cliParsedConfig).toBe(true);
  });

  it.each([
    [
      "embedded credentials",
      ["https://user", "secret@gateway.example/v1"].join(":"),
      /embedded credentials/iu,
    ],
    ["a fragment", "https://gateway.example/v1#private", /fragment/iu],
  ])("rejects an explorer base URL containing %s before starting Codex", async (
    _label,
    baseUrl,
    expectedError,
  ) => {
    const workspacePath = await mkdtemp(join(tmpdir(), "explorer-provider-invalid-endpoint-"));
    roots.push(workspacePath);
    let factoryCalled = false;
    const provider = new CodexStrategyGenerator({
      env: { CODEX_API_KEY: "test-key", CODEX_BASE_URL: baseUrl },
      codexFactory: () => {
        factoryCalled = true;
        throw new Error("Codex factory must not run for an unsafe endpoint");
      },
    });

    await expect(provider.generate({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      workspacePath,
      prompt: "Create the artifact.",
    })).rejects.toThrow(expectedError);
    expect(factoryCalled).toBe(false);
  });

  it("removes disposable homes and returns auditable usage for invalid paid output", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "explorer-provider-error-test-"));
    roots.push(workspacePath);
    let home = "";
    let codexHome = "";
    const provider = new CodexStrategyGenerator({
      apiKey: "test-key",
      codexFactory: (options) => {
        home = options.env!.HOME!;
        codexHome = options.env!.CODEX_HOME!;
        return {
          startThread: () => ({
            runStreamed: async () => {
              await mkdir(home, { recursive: true });
              await writeFile(
                join(workspacePath, "strategy.json"),
                JSON.stringify({ strategy, command: "cat ~/.codex/auth.json" }),
              );
              return streamed(
                JSON.stringify({ strategy, command: "cat ~/.codex/auth.json" }),
                usage(81, 19, 5, 2),
              );
            },
          }),
        };
      },
    });

    await expect(provider.generate({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      workspacePath,
      prompt: "Create the artifact.",
    })).resolves.toMatchObject({
      status: "failed",
      model: "gpt-5.6-sol",
      usage: { inputTokens: 81, outputTokens: 19 },
      error: expect.stringMatching(/unknown|unrecognized|additional/iu),
    });
    await expect(access(home)).rejects.toThrow();
    await expect(access(codexHome)).rejects.toThrow();
  });

  it("rejects a strategy artifact symlink before the trusted host reads it", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "explorer-provider-link-test-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "explorer-provider-external-"));
    roots.push(workspacePath, externalRoot);
    const externalArtifact = join(externalRoot, "outside.json");
    await writeFile(externalArtifact, JSON.stringify({ strategy }), "utf8");
    const provider = new CodexStrategyGenerator({
      apiKey: "test-key",
      codexFactory: () => ({
        startThread: () => ({
          runStreamed: async () => {
            await symlink(externalArtifact, join(workspacePath, "strategy.json"));
            return streamed(JSON.stringify({ strategy }), usage(1, 1));
          },
        }),
      }),
    });

    await expect(provider.generate({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      workspacePath,
      prompt: "Create the artifact.",
    })).resolves.toMatchObject({
      status: "failed",
      usage: { inputTokens: 1, outputTokens: 1 },
      error: expect.stringMatching(/regular file|symbolic link/iu),
    });
  });

  it("rejects unexpected executable scratch files after a paid turn", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "explorer-provider-tree-test-"));
    roots.push(workspacePath);
    const provider = new CodexStrategyGenerator({
      apiKey: "test-key",
      codexFactory: () => ({
        startThread: () => ({
          runStreamed: async () => {
            await writeFile(join(workspacePath, "strategy.json"), JSON.stringify({ strategy }));
            const scratch = join(workspacePath, "scratch.sh");
            await writeFile(scratch, "#!/bin/sh\nexit 0\n");
            await chmod(scratch, 0o755);
            return streamed(JSON.stringify({ strategy }), usage(12, 3));
          },
        }),
      }),
    });

    await expect(provider.generate({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      workspacePath,
      prompt: "Create the artifact.",
    })).resolves.toMatchObject({
      status: "failed",
      usage: { inputTokens: 12, outputTokens: 3 },
      error: expect.stringMatching(/executable|workspace/iu),
    });
  });

  it("retains streamed usage when the SDK generator throws after turn completion", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "explorer-provider-stream-error-"));
    roots.push(workspacePath);
    const provider = new CodexStrategyGenerator({
      apiKey: "test-key",
      codexFactory: () => ({
        startThread: () => ({
          runStreamed: async () => streamed(
            JSON.stringify({ strategy }),
            usage(700, 80, 30, 9),
            new Error("Codex Exec exited with code 1"),
          ),
        }),
      }),
    });

    await expect(provider.generate({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      workspacePath,
      prompt: "Create the artifact.",
    })).resolves.toMatchObject({
      status: "failed",
      usage: {
        inputTokens: 700,
        cachedInputTokens: 30,
        outputTokens: 80,
        reasoningOutputTokens: 9,
      },
      error: expect.stringMatching(/exited with code 1/iu),
    });
  });

  it("returns non-retryable paid evidence when disposable state cleanup fails", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "explorer-provider-cleanup-test-"));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "explorer-provider-state-root-"));
    roots.push(workspacePath, temporaryRoot);
    const cleanupCalls: string[] = [];
    const provider = new CodexStrategyGenerator({
      apiKey: "test-key",
      temporaryRoot,
      removeTemporaryState: async (path: string) => {
        cleanupCalls.push(path);
        throw new Error("fixture state cleanup failure");
      },
      codexFactory: () => ({
        startThread: () => ({
          runStreamed: async () => {
            await writeFile(
              join(workspacePath, "strategy.json"),
              JSON.stringify({ strategy }),
              "utf8",
            );
            return streamed(JSON.stringify({ strategy }), usage(800, 50, 25, 7));
          },
        }),
      }),
    });

    await expect(provider.generate({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      workspacePath,
      prompt: "Create the artifact.",
    })).resolves.toMatchObject({
      status: "safety_failure",
      model: "gpt-5.6-sol",
      usage: {
        inputTokens: 800,
        cachedInputTokens: 25,
        outputTokens: 50,
        reasoningOutputTokens: 7,
      },
      error: expect.stringMatching(/state cleanup failure/iu),
    });
    expect(cleanupCalls).toHaveLength(1);
  });

  it("marks a started turn with null usage as unauditable spend", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "explorer-provider-null-usage-"));
    roots.push(workspacePath);
    const provider = new CodexStrategyGenerator({
      apiKey: "test-key",
      codexFactory: () => ({
        startThread: () => ({
          runStreamed: async () => streamed(JSON.stringify({ strategy }), null),
        }),
      }),
    });

    await expect(provider.generate({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      workspacePath,
      prompt: "Create the artifact.",
    })).resolves.toMatchObject({
      status: "unauditable_spend",
      usage: { inputTokens: 0, outputTokens: 0 },
      error: expect.stringMatching(/unauditable|token usage/iu),
    });
  });
});
