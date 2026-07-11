import { execFile } from "node:child_process";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSandboxPackage,
  type SandboxPackage,
} from "../../src/explorer/package.js";
import { buildExplorerPrompt } from "../../src/explorer/prompt.js";
import { StrategySchema } from "../../src/strategies/schema.js";

const packages: SandboxPackage[] = [];
const executeFile = promisify(execFile);
afterEach(async () => {
  await Promise.all(packages.splice(0).map((item) => item.dispose()));
});

describe("disposable exploration package", () => {
  it("contains only redacted strategy material and an executable validator", async () => {
    const sandbox = await createSandboxPackage({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      samples: [{
        canonicalUrl: "https://shop.test/products/1",
        capture: "current",
        collectionDay: "2026-07-10",
        body: `Authorization: Bearer sk-secret-value /home/alice/private/source.html
          {"session_token":"opaque-json-secret","cookie":"sid=opaque-cookie"}
          <meta name="csrf-token" content="opaque-meta-secret">
          <div data-session-token="opaque-attribute-secret">`,
      }],
      oldStrategy: {
        schemaVersion: 1,
        purpose: "extraction",
        tier: "dom",
        allowedDomains: ["shop.test"],
        url: "{productUrl}",
        selectors: {
          title: [{ selector: ".old-title" }],
          brand: [{ selector: ".brand" }],
          price: [{ selector: ".price" }],
          promoPrice: [{ selector: ".promo" }],
          unit: [{ selector: ".unit" }],
          availability: [{ selector: ".stock" }],
        },
        apiKey: "opaque-old-secret",
      },
      failureSamples: [{
        canonicalUrl: "https://shop.test/products/1",
        category: "missing-fields",
        message: "selector failed at /home/alice/project/src/file.ts",
      }],
    });
    packages.push(sandbox);

    expect(sandbox.files.sort()).toEqual([
      "AGENTS.md",
      "failures.json",
      "old-strategy.json",
      "samples.json",
      "strategy-schema.md",
      "validate-strategy",
    ]);
    const packaged = await Promise.all(
      sandbox.files.map((name) => readFile(join(sandbox.workspacePath, name), "utf8")),
    );
    const joined = packaged.join("\n");
    expect(joined).not.toContain("sk-secret-value");
    expect(joined).not.toContain("opaque-old-secret");
    expect(joined).not.toContain("/home/alice");
    expect(joined).not.toContain("opaque-json-secret");
    expect(joined).not.toContain("opaque-cookie");
    expect(joined).not.toContain("opaque-meta-secret");
    expect(joined).not.toContain("opaque-attribute-secret");
    expect(joined).toContain("[REDACTED]");
    expect(joined).toContain("currently ACTIVE strategy");
    expect(JSON.parse(await readFile(
      join(sandbox.workspacePath, "samples.json"),
      "utf8",
    )).samples[0]).toMatchObject({
      capture: "current",
      collectionDay: "2026-07-10",
    });
    expect((await stat(join(sandbox.workspacePath, "validate-strategy"))).mode & 0o111)
      .not.toBe(0);

    await sandbox.dispose();
    await expect(access(sandbox.workspacePath)).rejects.toThrow();
  });

  it("deduplicates and bounds representative failure evidence with honest metadata", async () => {
    const sandbox = await createSandboxPackage({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      samples: [{ canonicalUrl: "https://shop.test/products/1" }],
      failureSampleTotal: 2_000,
      failureSamples: Array.from({ length: 2_000 }, (_, index) => ({
        canonicalUrl: `https://shop.test/products/${index % 100}`,
        category: ["missing-fields", "parse", "http-403"][index % 3]!,
        message: `representative failure ${index % 100}`,
      })),
    });
    packages.push(sandbox);

    const failures = JSON.parse(await readFile(
      join(sandbox.workspacePath, "failures.json"),
      "utf8",
    )) as { total: number; included: number; samples: Array<{ category: string }> };
    expect(failures).toMatchObject({ total: 2_000, included: 60 });
    expect(failures.samples).toHaveLength(60);
    expect(new Set(failures.samples.map(({ category }) => category)))
      .toEqual(new Set(["missing-fields", "parse", "http-403"]));
  });

  it("builds a short tier-ordered prompt without asking the model to certify itself", () => {
    const extraction = buildExplorerPrompt({
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      eventBudgetUsd: 5,
      attempt: 1,
      maxAttempts: 3,
    });
    const discovery = buildExplorerPrompt({
      purpose: "discovery",
      allowedDomains: ["shop.test"],
      eventBudgetUsd: 5,
      attempt: 1,
      maxAttempts: 3,
    });

    expect(extraction.indexOf("api")).toBeLessThan(extraction.indexOf("embedded-json"));
    expect(extraction.indexOf("embedded-json")).toBeLessThan(extraction.indexOf("dom"));
    expect(extraction.indexOf("dom")).toBeLessThan(extraction.indexOf("script"));
    expect(discovery.indexOf("sitemap")).toBeLessThan(discovery.indexOf("api"));
    expect(extraction).toContain("strategy.json");
    expect(extraction).toContain("shop.test");
    expect(extraction).toContain("USD 5");
    expect(extraction).toContain("{productUrl}, {externalId}, {sourceCategory}");
    expect(discovery).toContain("{page}, {pageSize}, {offset}, {from}, {to}, {cursor}, {segment}");
    expect(extraction).toContain("currently ACTIVE strategy");
    expect(extraction).not.toMatch(/self[- ]?certif|activation score/iu);
    expect(extraction.length).toBeLessThan(1_500);
  });

  it("redacts bounded prior exploration attempts in failures.json", async () => {
    const sandbox = await createSandboxPackage({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      samples: [{ canonicalUrl: "https://shop.test/products/1" }],
      failureAttempts: Array.from({ length: 4 }, (_, index) => ({
        outcome: "validation_failed",
        errorMessage: `Authorization: Bearer prior-secret-${index}`,
        candidate: {
          request: { headers: { authorization: `Bearer candidate-secret-${index}` } },
        },
      })),
    });
    packages.push(sandbox);

    const failures = await readFile(join(sandbox.workspacePath, "failures.json"), "utf8");
    expect(failures).not.toContain("prior-secret");
    expect(failures).not.toContain("candidate-secret");
    expect(JSON.parse(failures).priorAttempts).toHaveLength(3);
    expect(failures).toContain("[REDACTED]");
  });

  it("validates the closed strategy shape and rejects stored credentials or code", async () => {
    const sandbox = await createSandboxPackage({
      retailerId: "shop",
      purpose: "extraction",
      allowedDomains: ["shop.test"],
      samples: [{ canonicalUrl: "https://shop.test/products/1" }],
    });
    packages.push(sandbox);
    const artifact = (strategy: Record<string, unknown>) => writeFile(
      join(sandbox.workspacePath, "strategy.json"),
      JSON.stringify({ strategy }),
      { encoding: "utf8", mode: 0o600 },
    );
    const valid = {
      schemaVersion: 1,
      purpose: "extraction",
      tier: "api",
      allowedDomains: ["shop.test"],
      request: {
        method: "GET",
        url: "https://shop.test/products/{externalId}",
        headers: { accept: "application/json" },
      },
      fields: {
        title: "$.title",
        brand: "$.brand",
        price: "$.price",
        promoPrice: "$.promo",
        unit: "$.unit",
        availability: "$.available",
      },
    };
    await artifact(valid);
    const accepted = await executeFile(
      process.execPath,
      [join(sandbox.workspacePath, "validate-strategy")],
      { cwd: sandbox.workspacePath },
    );
    expect(accepted.stdout).toMatch(/exact trusted-host strategy schema/iu);

    await artifact({
      ...valid,
      request: {
        ...valid.request,
        headers: { Cookie: "must-not-be-stored" },
      },
    });
    await expect(executeFile(
      process.execPath,
      [join(sandbox.workspacePath, "validate-strategy")],
      { cwd: sandbox.workspacePath },
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/credential|cookie/iu) });

    await artifact({ ...valid, code: "return process.env" });
    await expect(executeFile(
      process.execPath,
      [join(sandbox.workspacePath, "validate-strategy")],
      { cwd: sandbox.workspacePath },
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/unrecognized|unknown|code/iu) });

    const hostRejected = [
      {
        ...valid,
        request: { ...valid.request, url: "https://shop.test/{processEnv}" },
      },
      {
        ...valid,
        request: { ...valid.request, query: { constructor: "unsafe" } },
      },
      {
        schemaVersion: 1,
        purpose: "discovery",
        tier: "api",
        allowedDomains: ["shop.test"],
        request: {
          method: "GET",
          url: "https://shop.test/products?page={page}",
          headers: {},
        },
        itemsPath: "$.items[*]",
        refFields: { url: "$.url" },
        pagination: { kind: "page", start: -1, pageSize: 0, maxPages: 0 },
        maxProducts: 0,
      },
      {
        schemaVersion: 1,
        purpose: "extraction",
        tier: "script",
        allowedDomains: ["shop.test"],
        operations: [{ op: "waitFor", selector: ".ready", state: "ready", timeoutMs: 50_000 }],
      },
    ];
    for (const invalid of hostRejected) {
      expect(StrategySchema.safeParse(invalid).success).toBe(false);
      await artifact(invalid);
      await expect(executeFile(
        process.execPath,
        [join(sandbox.workspacePath, "validate-strategy")],
        { cwd: sandbox.workspacePath },
      )).rejects.toBeDefined();
    }
  });
});
