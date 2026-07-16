import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCli, type CliDependencies } from "../../src/cli.js";
import { openDatabase } from "../../src/db/database.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

async function invoke(
  arguments_: string[],
  dependencies: CliDependencies,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  const cli = buildCli({
    ...dependencies,
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  });
  cli.exitOverride();
  try {
    await cli.parseAsync(["node", "precos", ...arguments_]);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return {
      stdout,
      stderr,
      exitCode: typeof error === "object" && error !== null && "exitCode" in error
        ? Number(error.exitCode)
        : 1,
    };
  }
}

function seedReferences(count: number): Array<{
  canonicalUrl: string;
  externalId: string;
  sourceCategory: string;
}> {
  return Array.from({ length: count }, (_, index) => ({
    canonicalUrl: `https://shop.test/produto/cafe-torrado-${index}/p`,
    externalId: String(index),
    sourceCategory: "Mercearia",
  }));
}

async function seedFixture(): Promise<{
  database: ReturnType<typeof openDatabase>;
  directory: string;
  filePath: string;
  dependencies: CliDependencies;
}> {
  const database = openDatabase(":memory:");
  databases.push(database);
  database.prepare(
    `INSERT INTO retailers (id, name, base_url, cep, domains_json, active)
     VALUES ('r1', 'R1', 'https://shop.test', '01310-100', '["shop.test"]', 0)`,
  ).run();
  const directory = await mkdtemp(join(tmpdir(), `precos-catalog-import-${randomUUID()}-`));
  const filePath = join(directory, "r1-seeds.json");
  await writeFile(filePath, JSON.stringify(seedReferences(30)), "utf8");
  return {
    database,
    directory,
    filePath,
    dependencies: {
      database,
      databasePath: ":memory:",
      lockPath: join(directory, "pipeline.lock"),
    },
  };
}

describe("catalog import CLI", () => {
  it("imports a JSON seed file and emits the JSON summary", async () => {
    const { database, filePath, dependencies } = await seedFixture();

    const result = await invoke(
      ["catalog", "import", "--retailer", "r1", "--file", filePath, "--json"],
      dependencies,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      retailerId: "r1",
      sourceLabel: "r1-seeds.json",
      dryRun: false,
      alreadyImported: false,
      refs: 30,
      newProducts: 30,
      activeInScopeProducts: 30,
      challengeReady: true,
    });
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM catalog_seed_refs WHERE retailer_id = 'r1'",
    ).get() as { count: number }).count).toBe(30);
  });

  it("is idempotent across repeated CLI runs of the same file", async () => {
    const { database, filePath, dependencies } = await seedFixture();

    const first = await invoke(
      ["catalog", "import", "--retailer", "r1", "--file", filePath, "--json"],
      dependencies,
    );
    const second = await invoke(
      ["catalog", "import", "--retailer", "r1", "--file", filePath, "--json"],
      dependencies,
    );

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      alreadyImported: true,
      newProducts: 0,
    });
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM catalog_seed_imports",
    ).get() as { count: number }).count).toBe(1);
  });

  it("supports CSV input and a human summary line", async () => {
    const { database, directory, dependencies } = await seedFixture();
    const csvPath = join(directory, "r1-seeds.csv");
    await writeFile(csvPath, [
      "canonical_url,external_id,source_category,title",
      ...seedReferences(30).map((ref) =>
        `${ref.canonicalUrl},${ref.externalId},${ref.sourceCategory},`),
    ].join("\n"), "utf8");

    const result = await invoke(
      ["catalog", "import", "--retailer", "r1", "--file", csvPath],
      dependencies,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("catalog import r1: 30 in-scope refs");
    expect(result.stdout).toContain("challenge READY");
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM products WHERE retailer_id = 'r1'",
    ).get() as { count: number }).count).toBe(30);
  });

  it("dry-runs without writing", async () => {
    const { database, filePath, dependencies } = await seedFixture();

    const result = await invoke(
      ["catalog", "import", "--retailer", "r1", "--file", filePath, "--dry-run", "--json"],
      dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      importId: null,
      challengeReady: true,
    });
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM products",
    ).get() as { count: number }).count).toBe(0);
  });

  it("refuses an active retailer without writing", async () => {
    const { database, filePath, dependencies } = await seedFixture();
    database.prepare("UPDATE retailers SET active = 1 WHERE id = 'r1'").run();

    const result = await invoke(
      ["catalog", "import", "--retailer", "r1", "--file", filePath, "--json"],
      dependencies,
    );

    expect(result.exitCode).toBe(1);
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM products",
    ).get() as { count: number }).count).toBe(0);
  });

  it("rejects an invalid --format value", async () => {
    const { filePath, dependencies } = await seedFixture();

    const result = await invoke(
      ["catalog", "import", "--retailer", "r1", "--file", filePath, "--format", "xml"],
      dependencies,
    );

    expect(result.exitCode).not.toBe(0);
  });
});
