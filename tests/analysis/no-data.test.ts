import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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
    const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
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
});
