import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../../src/cli.js";
import { openDatabase } from "../../src/db/database.js";
import { seedAuthoritativeWeights } from "./helpers.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("precos index CLI", () => {
  it("emits one JSON no-data snapshot without network in tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-index-cli-"));
    directories.push(root);
    const database = openDatabase(":memory:");
    seedAuthoritativeWeights(database);
    let stdout = "";
    const cli = buildCli({
      database,
      env: { PROJECT_ROOT: root },
      now: () => new Date("2026-07-13T11:00:00.000Z"),
      stdout: (text) => { stdout += text; },
      sidraClient: {
        async fetchSeries() {
          return {
            points: [], missingMonths: [], responseSha256: "c".repeat(64),
            endpoint: "https://servicodados.ibge.gov.br/api/v3/agregados/7060",
            status: "no_overlap" as const,
          };
        },
      },
    });
    cli.exitOverride();
    await cli.parseAsync(["node", "precos", "index", "--export", "--json"]);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("no_index_data");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    database.close();
  });

  it("rejects malformed dates before export", async () => {
    const database = openDatabase(":memory:");
    const cli = buildCli({ database, stdout: () => {}, stderr: () => {} });
    cli.exitOverride();
    await expect(cli.parseAsync(["node", "precos", "index", "--through", "2026-02-31"]))
      .rejects.toThrow();
    database.close();
  });

  it("rejects an in-project output symlink before the export boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-index-cli-root-"));
    const outside = await mkdtemp(join(tmpdir(), "precos-index-cli-outside-"));
    directories.push(root, outside);
    await symlink(outside, join(root, "exports"), "dir");
    const database = openDatabase(":memory:");
    let called = false;
    const cli = buildCli({
      database,
      env: { PROJECT_ROOT: root },
      stdout: () => {},
      exportResearchData: async () => {
        called = true;
        throw new Error("export boundary should not run");
      },
    });
    cli.exitOverride();

    await expect(cli.parseAsync([
      "node", "precos", "index", "--export", "--output", "exports", "--json",
    ])).rejects.toThrow(/symbolic link|symlink/i);
    expect(called).toBe(false);
    database.close();
  });

  it("emits the published unavailable evidence while require-official exits failing", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-index-cli-official-"));
    directories.push(root);
    const database = openDatabase(":memory:");
    seedAuthoritativeWeights(database);
    let stdout = "";
    const cli = buildCli({
      database,
      env: { PROJECT_ROOT: root },
      now: () => new Date("2026-07-13T11:00:00.000Z"),
      stdout: (text) => { stdout += text; },
      sidraClient: { async fetchSeries() { throw new Error("fixture unavailable"); } },
    });
    cli.exitOverride();

    await expect(cli.parseAsync([
      "node", "precos", "index", "--export", "--require-official", "--json",
    ])).rejects.toMatchObject({ name: "OfficialSourceUnavailableError" });
    expect(JSON.parse(stdout)).toMatchObject({ status: "official_unavailable" });
    const latest = JSON.parse(await readFile(join(root, "data", "exports", "latest.json"), "utf8"));
    expect(latest.snapshotDirectory).toMatch(/^snapshots\//u);
    database.close();
  });
});
