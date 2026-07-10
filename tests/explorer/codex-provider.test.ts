import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexStrategyGenerator,
  resolveExplorerApiKey,
} from "../../src/explorer/codex-provider.js";

const roots: string[] = [];
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

describe("Codex SDK strategy provider", () => {
  it("prefers the dedicated key and never consults cached authentication", () => {
    expect(resolveExplorerApiKey({ CODEX_API_KEY: "codex", OPENAI_API_KEY: "openai" }))
      .toBe("codex");
    expect(resolveExplorerApiKey({ OPENAI_API_KEY: "openai" })).toBe("openai");
    expect(resolveExplorerApiKey({ CODEX_API_KEY: "  ", OPENAI_API_KEY: "  " }))
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
    const provider = new CodexStrategyGenerator({
      apiKey: "test-key",
      model: "gpt-5.6-sol",
      codexFactory: (options) => {
        captured.options = options as Record<string, any>;
        return {
          startThread(threadOptions) {
            captured.thread = threadOptions as Record<string, any>;
            return {
              async run(_prompt, turnOptions) {
                captured.turn = turnOptions as Record<string, any>;
                await writeFile(
                  join(workspacePath, "strategy.json"),
                  JSON.stringify({ strategy }),
                  "utf8",
                );
                return {
                  finalResponse: JSON.stringify({ strategy }),
                  items: [],
                  usage: {
                    input_tokens: 321,
                    cached_input_tokens: 20,
                    output_tokens: 42,
                    reasoning_output_tokens: 12,
                  },
                };
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
    expect(captured.options).toMatchObject({
      apiKey: "test-key",
      env: {
        HOME: expect.any(String),
        CODEX_HOME: expect.any(String),
        PATH: expect.any(String),
      },
      config: {
        default_permissions: "explorer",
        features: { network_proxy: true },
        permissions: {
          explorer: {
            filesystem: expect.objectContaining({
              [JSON.stringify(workspacePath)]: "write",
            }),
            network: {
              enabled: true,
              mode: "full",
              allow_local_binding: false,
              domains: {
                [JSON.stringify("shop.test")]: "allow",
                [JSON.stringify("cdn.shop.test")]: "allow",
                [JSON.stringify("api.openai.com")]: "allow",
              },
            },
          },
        },
      },
    });
    expect(Object.keys(captured.options!.env).sort()).toEqual([
      "CODEX_HOME",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TZ",
    ]);
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

  it("removes disposable homes and rejects any unknown structured-output field", async () => {
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
            run: async () => {
              await mkdir(home, { recursive: true });
              await writeFile(
                join(workspacePath, "strategy.json"),
                JSON.stringify({ strategy, command: "cat ~/.codex/auth.json" }),
              );
              return {
                finalResponse: JSON.stringify({ strategy, command: "cat ~/.codex/auth.json" }),
                items: [],
                usage: null,
              };
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
    })).rejects.toThrow(/unknown|unrecognized|additional/iu);
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
          run: async () => {
            await symlink(externalArtifact, join(workspacePath, "strategy.json"));
            return {
              finalResponse: JSON.stringify({ strategy }),
              items: [],
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
              },
            };
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
    })).rejects.toThrow(/regular file|symbolic link/iu);
  });
});
