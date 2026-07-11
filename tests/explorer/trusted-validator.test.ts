import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { upsertDiscoveredProduct } from "../../src/db/repositories.js";
import { openDatabase } from "../../src/db/database.js";
import { createTrustedCandidateValidator } from "../../src/explorer/trusted-validator.js";
import { loadRetailerConfigs } from "../../src/retailers/config.js";
import { canonicalEvidenceJson } from "../../src/strategies/validation-evidence.js";
import { signedCandidateReport } from "../helpers/validation-receipt.js";

const roots: string[] = [];
const databases: Array<ReturnType<typeof openDatabase>> = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("generated-strategy trusted validator bridge", () => {
  it("publishes only a verified signed candidate receipt at its canonical path", async () => {
    const root = await mkdtemp(join(tmpdir(), "trusted-validator-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, "retailers"), { recursive: true }),
      mkdir(join(root, "dist/scripts"), { recursive: true }),
      mkdir(join(root, "ops"), { recursive: true }),
      mkdir(join(root, "var/operations"), { recursive: true }),
    ]);
    const sourceConfig = JSON.parse(await readFile(
      join(process.cwd(), "retailers/extra-mercado.json"),
      "utf8",
    )) as Record<string, unknown>;
    await writeFile(
      join(root, "retailers/extra-mercado.json"),
      `${JSON.stringify(sourceConfig)}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(root, "dist/scripts/validate-strategies.js"), "// fixture\n");
    const config = loadRetailerConfigs(join(root, "retailers"))[0]!;
    const databasePath = join(root, "evidence.sqlite");
    const database = openDatabase(databasePath);
    databases.push(database);
    database.prepare(`
      INSERT INTO retailers(id, name, base_url, cep, domains_json, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(
      config.id,
      config.name,
      config.baseUrl,
      config.cep,
      JSON.stringify(config.allowedDomains),
    );
    const refs = Array.from({ length: 30 }, (_value, index) => ({
      canonicalUrl: `https://www.extramercado.com.br/produto/${index}/fixture-${index}`,
      externalId: String(index),
      sourceCategory: "Alimentos",
    }));
    refs.forEach((ref, index) => upsertDiscoveredProduct(
      database,
      config.id,
      ref,
      new Date(Date.UTC(2026, 6, 10, 0, 0, index)).toISOString(),
    ));
    const context = {
      retailerId: config.id,
      purpose: "extraction" as const,
      strategyVersion: config.strategyVersions.extraction + 1,
    };
    const signed = signedCandidateReport(config.extraction, refs, context, 0.9);
    if (signed.receipt === undefined) throw new Error("Fixture receipt was not created");
    await writeFile(
      join(root, "ops/validation-attestation-public.pem"),
      signed.receipt.verificationPublicKey.export({ type: "spki", format: "pem" }),
      { mode: 0o644 },
    );

    const validate = createTrustedCandidateValidator({
      database,
      projectRoot: root,
      executeRunner: async (_executable, arguments_) => {
        const outputIndex = arguments_.indexOf("--output-directory");
        const outputDirectory = arguments_[outputIndex + 1];
        if (outputDirectory === undefined) throw new Error("Missing fixture output directory");
        await mkdir(outputDirectory, { recursive: true });
        const path = join(
          outputDirectory,
          `${context.retailerId}-${context.purpose}-v${context.strategyVersion}.json`,
        );
        await writeFile(path, `${canonicalEvidenceJson(signed.receipt!.evidence)}\n`);
        return { stdout: `${JSON.stringify({ path })}\n`, stderr: "" };
      },
    });
    const report = await validate(config.extraction, refs, context);

    expect(report).toMatchObject({ attempted: 30, valid: 27, activatable: true });
    const canonical = join(
      root,
      `data/validation/${context.retailerId}-${context.purpose}-v${context.strategyVersion}.json`,
    );
    expect(JSON.parse(await readFile(canonical, "utf8"))).toMatchObject({
      retailerId: context.retailerId,
      strategyVersion: context.strategyVersion,
    });
    expect(await readdir(join(root, "var/validation-candidates"))).toEqual([]);
    await report.receipt?.cleanup?.();
    await expect(readFile(canonical)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
