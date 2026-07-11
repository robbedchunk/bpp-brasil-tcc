import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const projectRoot = resolve(".");
const fixtureRoot = resolve("tests/fixtures/analysis");
const python = resolve("var/analysis-venv/bin/python");
const required = [
  "runs.csv", "healing_events.csv", "aggregate_daily.csv",
  "coverage_daily.csv", "monthly_comparison.csv",
] as const;

afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))));

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeInputManifest(input: string): Promise<void> {
  const files = [];
  for (const name of required) {
    const bytes = await readFile(join(input, name));
    const text = bytes.toString("utf8").trimEnd();
    const [header = "", ...rows] = text.split("\n");
    files.push({
      path: name,
      sha256: hash(bytes),
      bytes: bytes.byteLength,
      rows: rows.length,
      columns: header.split(","),
    });
  }
  await writeFile(join(input, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    snapshotId: "fixture-snapshot",
    generatedAt: "2026-07-10T12:00:00.000Z",
    timezone: "America/Sao_Paulo",
    methodVersion: "tcc-food-at-home-v1",
    status: "complete",
    snapshotDirectory: "snapshots/fixture-snapshot",
    files,
  }, null, 2)}\n`);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "precos-analysis-input-"));
  roots.push(root);
  await cp(fixtureRoot, root, { recursive: true });
  await writeInputManifest(root);
  return root;
}

function runAnalysis(input: string, output: string): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, ["analysis/generate.py", "--input", input, "--output", output], {
      cwd: projectRoot,
      env: { ...process.env, MPLCONFIGDIR: join(output, ".mpl") },
      stdio: ["ignore", "pipe", "pipe"],
    });
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

function pngDimensions(bytes: Buffer): [number, number] {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("reproducible thesis analysis", () => {
  it("generates fixed figures, the healing table, and auditable summaries", async () => {
    const input = await fixture();
    const output = await mkdtemp(join(tmpdir(), "precos-analysis-output-"));
    roots.push(output);
    const result = await runAnalysis(input, output);
    expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    const summary = JSON.parse(result.stdout);
    expect(summary.status).toBe("complete");
    const snapshot = join(output, "snapshots", "fixture-snapshot");
    for (const name of [
      "success-rate.png", "healing-events.csv", "index-vs-ipca.png",
      "index-coverage-and-dispersion.csv", "manifest.json",
    ]) expect((await stat(join(snapshot, name))).size).toBeGreaterThan(0);
    expect(pngDimensions(await readFile(join(snapshot, "success-rate.png"))))
      .toEqual([1600, 900]);
    expect(pngDimensions(await readFile(join(snapshot, "index-vs-ipca.png"))))
      .toEqual([1600, 1200]);
    const manifest = JSON.parse(await readFile(join(snapshot, "manifest.json"), "utf8"));
    expect(manifest.summaries.dailySuccessRates["r1:2026-05-30"]).toBe(0.75);
    expect(manifest.plotting.successRateDateLimits).toEqual(["2026-05-29", "2026-06-03"]);
    expect(manifest.plotting.successRateDateLocator).toBe("daily");
    expect(manifest.plotting.successRateHealingLegend).toEqual([
      "detecção de deriva", "recuperação automática",
    ]);
    expect(manifest.plotting.indexFootnote).toMatch(/promocional.*sete dias.*média igual.*POF/iu);
    expect(manifest.caveats).toContain("não é intervalo de confiança");
    expect(manifest.caveats).toContain("sem validação estatística");
    expect(manifest.inputs).toHaveLength(required.length);
    expect(manifest.inputs.map((input: { path: string }) => input.path)).toEqual([...required]);
    for (const input of manifest.inputs) {
      expect(input).toEqual(expect.objectContaining({
        path: expect.any(String),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        bytes: expect.any(Number),
        rows: expect.any(Number),
        columns: expect.any(Array),
      }));
    }
    const healing = await readFile(join(snapshot, "healing-events.csv"), "utf8");
    expect(healing.split("\n")[0]).toBe(
      "event_id,retailer_name,onset_run_id,drift_started_at,detected_at,recovered_at,status,healed_automatically,attempts,tier_transition,duration_hours",
    );
    expect(healing).toContain("heal-1,Mercado Um,run-1");
    expect(healing).toContain(",recovered,true,");
    expect(healing).toContain("heal-2,Mercado Dois,run-4");
    expect(healing).toContain(",open,false,");
    const coverage = await readFile(join(snapshot, "index-coverage-and-dispersion.csv"), "utf8");
    expect(coverage.split("\n")[0]).toBe(
      "date,chain_segment,index_level,covered_weight_pct_total_ipca,total_food_at_home_weight_pct_total_ipca,coverage_fraction,covered_subitem_count,retailer_count,product_pair_count,descriptive_low_relative,descriptive_high_relative,unclassified_count,no_healthy_run_count,unavailable_count,carried_expired_count,no_denominator_count,invalid_price_count",
    );
  });

  it("produces byte-identical artifacts for the same input", async () => {
    const input = await fixture();
    const outputA = await mkdtemp(join(tmpdir(), "precos-analysis-a-"));
    const outputB = await mkdtemp(join(tmpdir(), "precos-analysis-b-"));
    roots.push(outputA, outputB);
    expect((await runAnalysis(input, outputA)).exitCode).toBe(0);
    expect((await runAnalysis(input, outputB)).exitCode).toBe(0);
    for (const name of [
      "success-rate.png", "healing-events.csv", "index-vs-ipca.png",
      "index-coverage-and-dispersion.csv", "manifest.json",
    ]) {
      const [left, right] = await Promise.all([
        readFile(join(outputA, "snapshots", "fixture-snapshot", name)),
        readFile(join(outputB, "snapshots", "fixture-snapshot", name)),
      ]);
      expect(hash(left), name).toBe(hash(right));
    }
  });

  it("fails closed on a tampered input without publishing latest", async () => {
    const input = await fixture();
    await writeFile(join(input, "runs.csv"), "tampered\n");
    const output = await mkdtemp(join(tmpdir(), "precos-analysis-tampered-"));
    roots.push(output);
    const result = await runAnalysis(input, output);
    expect(result.exitCode).not.toBe(0);
    await expect(readFile(join(output, "latest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to reuse an output when the same snapshot ID has different verified input", async () => {
    const input = await fixture();
    const output = await mkdtemp(join(tmpdir(), "precos-analysis-reuse-"));
    roots.push(output);
    expect((await runAnalysis(input, output)).exitCode).toBe(0);
    const runsPath = join(input, "runs.csv");
    await writeFile(runsPath, (await readFile(runsPath, "utf8")).replace("run-1a", "run-9a"));
    await writeInputManifest(input);
    const second = await runAnalysis(input, output);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toMatch(/snapshot.*changed|input.*manifest|bound.*input/i);
  });

  it.each(["modified", "missing"])(
    "refuses to republish latest when an existing output is %s",
    async (mode) => {
      const input = await fixture();
      const output = await mkdtemp(join(tmpdir(), `precos-analysis-${mode}-output-`));
      roots.push(output);
      expect((await runAnalysis(input, output)).exitCode).toBe(0);
      const artifact = join(output, "snapshots", "fixture-snapshot", "success-rate.png");
      if (mode === "modified") await writeFile(artifact, "tampered");
      else await rm(artifact);
      await rm(join(output, "latest.json"));

      const second = await runAnalysis(input, output);

      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toMatch(/output|artifact|hash|missing/i);
      await expect(readFile(join(output, "latest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    ["snapshot ID", { snapshotId: "wrong-snapshot" }],
    ["manifest hash", { manifestSha256: "0".repeat(64) }],
    ["snapshot path", { snapshotDirectory: "snapshots/../fixture-snapshot" }],
  ])("binds input latest.json to its %s", async (_name, override) => {
    const direct = await fixture();
    const exportsRoot = await mkdtemp(join(tmpdir(), "precos-analysis-latest-input-"));
    const output = await mkdtemp(join(tmpdir(), "precos-analysis-latest-output-"));
    roots.push(exportsRoot, output);
    const snapshot = join(exportsRoot, "snapshots", "fixture-snapshot");
    await mkdir(join(exportsRoot, "snapshots"));
    await cp(direct, snapshot, { recursive: true });
    const manifestBytes = await readFile(join(snapshot, "manifest.json"));
    await writeFile(join(exportsRoot, "latest.json"), `${JSON.stringify({
      schemaVersion: 1,
      snapshotId: "fixture-snapshot",
      snapshotDirectory: "snapshots/fixture-snapshot",
      manifestSha256: hash(manifestBytes),
      ...override,
    })}\n`);

    const result = await runAnalysis(exportsRoot, output);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/latest|snapshot|manifest|path|hash/i);
    await expect(readFile(join(output, "latest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects negative coverage instead of plotting invalid evidence", async () => {
    const input = await fixture();
    const coveragePath = join(input, "coverage_daily.csv");
    await writeFile(
      coveragePath,
      (await readFile(coveragePath, "utf8")).replace("0.660169496865", "-0.100000000000"),
    );
    await writeInputManifest(input);
    const output = await mkdtemp(join(tmpdir(), "precos-analysis-invalid-number-"));
    roots.push(output);
    const result = await runAnalysis(input, output);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/coverage|non-negative|range/i);
  });
});
