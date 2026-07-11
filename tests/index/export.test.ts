import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exportResearchData } from "../../src/index/export.js";
import type { SidraClient } from "../../src/index/types.js";
import {
  indexDatabase,
  seedItem,
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
    seedRetailer(database, "r1");
    seedItem(database, "item-a", "1101002", "Arroz", "0.4030");
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

  it("leaves the previous latest pointer when publication fails", async () => {
    const database = indexDatabase();
    databases.push(database);
    const outputRoot = await mkdtemp(join(tmpdir(), "precos-export-fail-"));
    directories.push(outputRoot);
    const first = await exportResearchData(database, {
      outputRoot, sidraClient: emptySidra, now: () => new Date("2026-07-13T11:00:00.000Z"),
    });
    const before = await readFile(join(outputRoot, "latest.json"), "utf8");

    await expect(exportResearchData(database, {
      outputRoot,
      sidraClient: { async fetchSeries() { throw new Error("SIDRA unavailable"); } },
      requireOfficial: true,
      now: () => new Date("2026-07-20T11:00:00.000Z"),
    })).rejects.toThrow(/SIDRA unavailable/);
    expect(await readFile(join(outputRoot, "latest.json"), "utf8")).toBe(before);
    expect(first.snapshotId).toBeTruthy();
  });

  it("materializes one coherent database view before the SIDRA network boundary", async () => {
    const database = indexDatabase();
    databases.push(database);
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
    seedRetailer(database, "r1");
    seedItem(database, "item-a", "1101002", "Arroz", "0.4030");
    seedProduct(database, { id: "p1", retailerId: "r1", itemId: "item-a" });
    seedRun(database, { id: "d1", retailerId: "r1", day: "2026-06-01" });
    seedRun(database, { id: "d2", retailerId: "r1", day: "2026-06-02" });
    seedObservation(database, { id: "o1", productId: "p1", runId: "d1", day: "2026-06-01", price: 1_000 });
    seedObservation(database, { id: "o2", productId: "p1", runId: "d2", day: "2026-06-02", price: 1_100 });
    const outputRoot = await mkdtemp(join(tmpdir(), "precos-export-name-"));
    directories.push(outputRoot);
    const manifest = await exportResearchData(database, {
      outputRoot, sidraClient: emptySidra, now: () => new Date("2026-07-13T11:00:00.000Z"),
    });
    const csv = await readFile(
      join(outputRoot, manifest.snapshotDirectory, "retailer_subitem_daily.csv"),
      "utf8",
    );
    expect(csv).toContain("r1,Retailer r1,item-a");
  });
});
