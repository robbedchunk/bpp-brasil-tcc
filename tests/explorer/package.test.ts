import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSandboxPackage,
  type SandboxPackage,
} from "../../src/explorer/package.js";
import { buildExplorerPrompt } from "../../src/explorer/prompt.js";

const packages: SandboxPackage[] = [];
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
        body: "Authorization: Bearer sk-secret-value /home/alice/private/source.html",
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
    expect(joined).not.toContain("/home/alice");
    expect(joined).toContain("[REDACTED]");
    expect((await stat(join(sandbox.workspacePath, "validate-strategy"))).mode & 0o111)
      .not.toBe(0);

    await sandbox.dispose();
    await expect(access(sandbox.workspacePath)).rejects.toThrow();
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
    expect(extraction).not.toMatch(/self[- ]?certif|activation score/iu);
    expect(extraction.length).toBeLessThan(1_500);
  });
});
