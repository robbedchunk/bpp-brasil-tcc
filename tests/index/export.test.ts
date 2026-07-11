import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exportResearchData } from "../../src/index/export.js";
import type { SidraClient } from "../../src/index/types.js";
import {
  finalizeSeedRuns,
  indexDatabase,
  seedAuthoritativeWeights,
  seedObservation,
  seedProduct,
  seedRetailer,
  seedRun,
} from "./helpers.js";

const databases: ReturnType<typeof indexDatabase>[] = [];
const directories: string[] = [];
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const emptySidra: SidraClient = {
  async fetchSeries() {
    return {
      points: [],
      missingMonths: [],
      responseSha256: "b".repeat(64),
      endpoint: "https://servicodados.ibge.gov.br/api/v3/agregados/7060",
      status: "no_overlap" as const,
    };
  },
};

describe("research snapshot export", () => {
  it("atomically publishes fixed header-valid files and a verified manifest", async () => {
    const database = indexDatabase();
    databases.push(database);
    seedAuthoritativeWeights(database);
    seedRetailer(database, "r1");
    const outputRoot = await mkdtemp(join(tmpdir(), "precos-export-"));
    directories.push(outputRoot);

    const manifest = await exportResearchData(database, {
      outputRoot,
      sidraClient: emptySidra,
      now: () => new Date("2026-07-13T11:00:00.000Z"),
    });

    expect(manifest.status).toBe("no_index_data");
    expect(manifest.files).toHaveLength(12);
    expect(manifest.snapshotDirectory).not.toMatch(/^\//u);
    const latest = JSON.parse(await readFile(join(outputRoot, "latest.json"), "utf8"));
    expect(latest.snapshotDirectory).toBe(manifest.snapshotDirectory);
    const snapshot = join(outputRoot, manifest.snapshotDirectory.replace(/^snapshots\//u, "snapshots/"));
    expect((await readdir(snapshot)).sort()).toEqual([
      "aggregate_daily.csv", "classification_coverage.csv", "coverage_daily.csv",
      "failures.csv", "healing_events.csv", "manifest.json", "model_costs.csv",
      "monthly_comparison.csv", "official_ipca_monthly.csv", "product_relatives.csv",
      "retailer_subitem_daily.csv", "runs.csv", "subitem_daily.csv",
    ]);
    for (const file of manifest.files) {
      const bytes = await readFile(join(snapshot, file.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
      expect(bytes.at(-1)).toBe(10);
      expect((await stat(join(snapshot, file.path))).size).toBeGreaterThan(0);
    }
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toMatch(/raw-html|canonical_url|response_path|details_json/u);
  });

  it("publishes an honest unavailable snapshot before require-official fails", async () => {
    const database = indexDatabase();
    databases.push(database);
    seedAuthoritativeWeights(database);
    const outputRoot = await mkdtemp(join(tmpdir(), "precos-export-fail-"));
    directories.push(outputRoot);
    const first = await exportResearchData(database, {
      outputRoot, sidraClient: emptySidra, now: () => new Date("2026-07-13T11:00:00.000Z"),
    });
    const before = await readFile(join(outputRoot, "latest.json"), "utf8");

    let failure: unknown;
    try {
      await exportResearchData(database, {
        outputRoot,
        sidraClient: { async fetchSeries() { throw new Error("SIDRA unavailable"); } },
        requireOfficial: true,
        now: () => new Date("2026-07-20T11:00:00.000Z"),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "OfficialSourceUnavailableError",
      manifest: { status: "official_unavailable" },
    });
    const after = await readFile(join(outputRoot, "latest.json"), "utf8");
    expect(after).not.toBe(before);
    const latest = JSON.parse(after) as { snapshotDirectory: string };
    const published = JSON.parse(await readFile(
      join(outputRoot, latest.snapshotDirectory, "manifest.json"),
      "utf8",
    ));
    expect(published).toMatchObject({
      status: "official_unavailable",
      sources: { sidra: { status: "unavailable" } },
    });
    expect(first.snapshotId).toBeTruthy();
  });

  it("materializes one coherent database view before the SIDRA network boundary", async () => {
    const database = indexDatabase();
    databases.push(database);
    seedAuthoritativeWeights(database);
    seedRetailer(database, "r1");
    const outputRoot = await mkdtemp(join(tmpdir(), "precos-export-coherent-"));
    directories.push(outputRoot);
    const manifest = await exportResearchData(database, {
      outputRoot,
      now: () => new Date("2026-07-13T11:00:00.000Z"),
      sidraClient: {
        async fetchSeries() {
          seedRun(database, { id: "arrived-during-network", retailerId: "r1", day: "2026-07-13" });
          return emptySidra.fetchSeries("2026-07", "2026-07");
        },
      },
    });
    expect(manifest.sources.database.counts.runs).toBe(0);
    const runsEvidence = manifest.files.find((file) => file.path === "runs.csv");
    expect(runsEvidence?.rows).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 1 });
  });

  it("exports the registered retailer name for retailer/subitem rows", async () => {
    const database = indexDatabase();
    databases.push(database);
    seedAuthoritativeWeights(database);
    seedRetailer(database, "r1");
    seedProduct(database, { id: "p1", retailerId: "r1", itemId: "ipca-sp-1101002" });
    seedRun(database, { id: "d1", retailerId: "r1", day: "2026-06-01" });
    seedRun(database, { id: "d2", retailerId: "r1", day: "2026-06-02" });
    seedObservation(database, { id: "o1", productId: "p1", runId: "d1", day: "2026-06-01", price: 1_000 });
    seedObservation(database, { id: "o2", productId: "p1", runId: "d2", day: "2026-06-02", price: 1_100 });
    finalizeSeedRuns(database);
    const outputRoot = await mkdtemp(join(tmpdir(), "precos-export-name-"));
    directories.push(outputRoot);
    const manifest = await exportResearchData(database, {
      outputRoot, sidraClient: emptySidra, now: () => new Date("2026-07-13T11:00:00.000Z"),
    });
    const csv = await readFile(
      join(outputRoot, manifest.snapshotDirectory, "retailer_subitem_daily.csv"),
      "utf8",
    );
    expect(csv).toContain("r1,Retailer r1,ipca-sp-1101002");
  });

  it.each([
    ["partial", (database: ReturnType<typeof indexDatabase>) => {
      database.prepare("DELETE FROM ipca_items WHERE id = (SELECT id FROM ipca_items ORDER BY id LIMIT 1)").run();
    }, /84/u],
    ["wrong total", (database: ReturnType<typeof indexDatabase>) => {
      database.prepare("UPDATE ipca_items SET weight_text = '0.0000', weight = 0 WHERE id = (SELECT id FROM ipca_items WHERE weight_text <> '0.0000' ORDER BY id LIMIT 1)").run();
    }, /12\.1181/u],
    ["missing provenance", (database: ReturnType<typeof indexDatabase>) => {
      database.prepare("UPDATE ipca_items SET source_archive_sha256 = NULL WHERE id = (SELECT id FROM ipca_items ORDER BY id LIMIT 1)").run();
    }, /hash|provenance/iu],
    ["uniform but unapproved provenance", (database: ReturnType<typeof indexDatabase>) => {
      database.prepare("UPDATE ipca_items SET source_archive_sha256 = ?").run("f".repeat(64));
    }, /approved|archive|provenance/iu],
  ])("refuses a %s authoritative weight set before contacting SIDRA", async (_name, corrupt, message) => {
    const database = indexDatabase();
    databases.push(database);
    seedAuthoritativeWeights(database);
    corrupt(database);
    const outputRoot = await mkdtemp(join(tmpdir(), "precos-export-bad-weights-"));
    directories.push(outputRoot);
    let contacted = false;

    await expect(exportResearchData(database, {
      outputRoot,
      sidraClient: { async fetchSeries() { contacted = true; return emptySidra.fetchSeries("2026-07", "2026-07"); } },
      now: () => new Date("2026-07-13T11:00:00.000Z"),
    })).rejects.toThrow(message);
    expect(contacted).toBe(false);
    await expect(readFile(join(outputRoot, "latest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an output root symlinked outside its lexical boundary", async () => {
    const database = indexDatabase();
    databases.push(database);
    seedAuthoritativeWeights(database);
    const container = await mkdtemp(join(tmpdir(), "precos-export-link-container-"));
    const outside = await mkdtemp(join(tmpdir(), "precos-export-link-outside-"));
    directories.push(container, outside);
    const outputRoot = join(container, "exports");
    await symlink(outside, outputRoot, "dir");

    await expect(exportResearchData(database, {
      outputRoot,
      sidraClient: emptySidra,
      now: () => new Date("2026-07-13T11:00:00.000Z"),
    })).rejects.toThrow(/symbolic link|symlink/i);
    expect(await readdir(outside)).toEqual([]);
  });
});
