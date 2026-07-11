import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exportResearchData } from "../../src/index/export.js";
import {
  finalizeSeedRuns,
  indexDatabase,
  seedAuthoritativeWeights,
  seedObservation,
  seedProduct,
  seedRetailer,
  seedRun,
} from "../index/helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function runAnalysis(input: string, output: string): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(resolve("var/analysis-venv/bin/python"), [
      "analysis/generate.py", "--input", input, "--output", output,
    ], { cwd: resolve("."), env: { ...process.env, MPLCONFIGDIR: join(output, ".mpl") }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}

const headers = {
  "runs.csv": "run_id,retailer_id,retailer_name,collection_day,stage,status,attempted,ok,failed,success_rate,strategy_id,strategy_version,started_at,finished_at,error_category\n",
  "healing_events.csv": "event_id,retailer_id,retailer_name,purpose,status,onset_run_id,previous_strategy_id,successor_strategy_id,attempts,tier_from,tier_to,drift_started_at,detected_at,recovered_at,duration_seconds\n",
  "aggregate_daily.csv": "date,previous_date,chain_segment,daily_relative,index_level,covered_weight_pct_total_ipca,total_food_at_home_weight_pct_total_ipca,coverage_fraction,covered_subitem_count,retailer_count,product_pair_count,descriptive_low_relative,descriptive_high_relative,method_version\n",
  "coverage_daily.csv": "date,covered_weight_pct_total_ipca,total_food_at_home_weight_pct_total_ipca,coverage_fraction,covered_subitem_count,retailer_count,product_pair_count,unclassified_count,no_healthy_run_count,unavailable_count,carried_expired_count,no_denominator_count,invalid_price_count\n2026-07-10,0.0000,12.1181,0.000000000000,0,0,0,60,0,0,0,0,0\n",
  "monthly_comparison.csv": "month,experimental_variation_pct,official_variation_pct,status,experimental_chain_segment\n",
} as const;

describe("no-data analysis", () => {
  it("emits labelled figures without inventing observations or overlap", async () => {
    const input = await mkdtemp(join(tmpdir(), "precos-analysis-empty-input-"));
    const output = await mkdtemp(join(tmpdir(), "precos-analysis-empty-output-"));
    roots.push(input, output);
    const files = [];
    for (const [name, text] of Object.entries(headers)) {
      const bytes = Buffer.from(text);
      const [header = ""] = text.trimEnd().split("\n");
      await writeFile(join(input, name), bytes);
      files.push({
        path: name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        rows: Math.max(0, text.trimEnd().split("\n").length - 1),
        columns: header.split(","),
      });
    }
    await writeFile(join(input, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      snapshotId: "empty-snapshot",
      generatedAt: "2026-07-10T12:00:00.000Z",
      timezone: "America/Sao_Paulo",
      methodVersion: "tcc-food-at-home-v1",
      status: "no_index_data",
      snapshotDirectory: "snapshots/empty-snapshot",
      files,
    }, null, 2)}\n`);
    await mkdir(join(output, ".mpl"));
    const result = await runAnalysis(input, output);
    expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({ status: "no_index_data", officialOverlap: false });
    const manifest = JSON.parse(await readFile(
      join(output, "snapshots", "empty-snapshot", "manifest.json"), "utf8",
    ));
    expect(manifest.statuses).toMatchObject({ noIndexData: true, noOfficialOverlap: true });
    expect(manifest.summaries.dailySuccessRates).toEqual({});
    expect(manifest.inputs).toHaveLength(5);
    const coverage = await readFile(
      join(output, "snapshots", "empty-snapshot", "index-coverage-and-dispersion.csv"),
      "utf8",
    );
    expect(coverage).toContain("2026-07-10");
    expect(coverage).toMatch(/,60,0,0,0,0,0\n$/u);
  });

  it("keeps a real baseline-only export and its analysis honestly no-data", async () => {
    const database = indexDatabase();
    const input = await mkdtemp(join(tmpdir(), "precos-analysis-baseline-input-"));
    const output = await mkdtemp(join(tmpdir(), "precos-analysis-baseline-output-"));
    roots.push(input, output);
    try {
      seedAuthoritativeWeights(database);
      seedRetailer(database, "r1");
      seedProduct(database, {
        id: "p1",
        retailerId: "r1",
        itemId: "ipca-sp-1101002",
        version: 1,
      });
      seedRun(database, { id: "run-1", retailerId: "r1", day: "2026-07-10" });
      seedObservation(database, {
        id: "observation-1",
        productId: "p1",
        runId: "run-1",
        day: "2026-07-10",
        price: 1_000,
      });
      finalizeSeedRuns(database);
      const exported = await exportResearchData(database, {
        outputRoot: input,
        now: () => new Date("2026-07-13T11:00:00.000Z"),
        sidraClient: {
          async fetchSeries() {
            return {
              points: [],
              missingMonths: [],
              responseSha256: "b".repeat(64),
              endpoint: "https://servicodados.ibge.gov.br/api/v3/agregados/7060",
              status: "no_overlap" as const,
            };
          },
        },
      });
      expect(exported.status).toBe("no_index_data");
      expect(exported.files.find(({ path }) => path === "aggregate_daily.csv")?.rows)
        .toBe(1);
      expect(exported.files.find(({ path }) => path === "product_relatives.csv")?.rows)
        .toBe(0);

      await mkdir(join(output, ".mpl"));
      const result = await runAnalysis(input, output);
      expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
      const latest = JSON.parse(await readFile(join(output, "latest.json"), "utf8")) as {
        snapshotDirectory: string;
      };
      const manifest = JSON.parse(await readFile(
        join(output, latest.snapshotDirectory, "manifest.json"),
        "utf8",
      ));
      expect(manifest.statuses).toMatchObject({
        noIndexData: true,
        noOfficialOverlap: true,
      });
    } finally {
      database.close();
    }
  });
});
