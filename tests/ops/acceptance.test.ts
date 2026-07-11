import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { openDatabase } from "../../src/db/database.js";
import {
  buildClassificationReviewTemplate,
  evaluateClassificationReview,
} from "../../src/classify/review.js";
import {
  loadRetailerConfigs,
  registerRetailerConfigs,
  type RetailerConfig,
} from "../../src/retailers/config.js";
import type { Strategy } from "../../src/strategies/schema.js";
import {
  attestStrategyValidationEvidence,
  evidenceValueSha256,
  StrategyValidationEvidenceSchema,
  strategyEvidenceSha256,
  validationRefSha256,
  validationReceiptSha256,
  validationSampleSetSha256,
  type StrategyValidationEvidence,
} from "../../src/strategies/validation-evidence.js";
import {
  acceptanceExitCode,
  aggregateAcceptanceStatus,
  buildAcceptanceReport,
  classificationAutomationIsCurrent,
  csvDataRowCount,
  csvOverlapRowCount,
  experimentalSeriesState,
  evaluateM2,
  evaluateM3,
  evaluateM4,
  evaluateClassificationHumanReview,
  evaluateActiveStrategyValidationReceipts,
  resolveAcceptanceEvaluatedCommit,
  releaseSourceMatchesEvaluatedCommit,
  renderAcceptanceMarkdown,
  readSystemdInstallationState,
  reviewFindingState,
  scheduledWindowIsPending,
  sourceWorktreeClean,
  validateAcceptanceReportShape,
  validateTimerDefinitions,
  type AcceptanceReport,
} from "../../src/ops/acceptance.js";
import { insertTrustedStrategyValidationEvidence } from "../helpers/strategy-validation.js";

const databases: Database.Database[] = [];
const {
  privateKey: TEST_VALIDATION_PRIVATE_KEY,
  publicKey: TEST_VALIDATION_PUBLIC_KEY,
} = generateKeyPairSync("ed25519");

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(): Database.Database {
  const database = openDatabase(":memory:");
  databases.push(database);
  return database;
}

function scheduledProvenance(at: string, invocationId = "a".repeat(32)) {
  const canonicalAt = new Date(at).toISOString();
  return {
    provenanceVersion: 1 as const,
    trigger: "systemd-timer" as const,
    serviceUnit: "precos-daily.service" as const,
    timerUnit: "precos-daily.timer" as const,
    invocationId,
    cgroupSha256: "b".repeat(64),
    releaseId: "c".repeat(32),
    timerLastTriggerAt: canonicalAt,
    serviceStartedAt: canonicalAt,
    timerCausalitySha256: createHash("sha256").update(JSON.stringify({
      invocationId,
      serviceStartedAt: canonicalAt,
      serviceUnit: "precos-daily.service",
      timerLastTriggerAt: canonicalAt,
      timerUnit: "precos-daily.timer",
    })).digest("hex"),
  };
}

function m3Criterion(result: ReturnType<typeof evaluateM3>, id: string) {
  const item = result.criteria.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`Missing M3 criterion ${id}`);
  return item;
}

function seedRetailer(database: Database.Database, id: string, products = 30): void {
  database.prepare(`
    INSERT INTO retailers(id, name, base_url, cep, domains_json)
    VALUES (?, ?, ?, '01001000', ?)
  `).run(id, id, `https://${id}.example.test`, JSON.stringify([`${id}.example.test`]));
  database.prepare(`
    INSERT INTO strategies(
      id, retailer_id, purpose, tier, version, strategy_json, provenance,
      validation_sample_size, validation_successes, validation_rate, active,
      validated_at
    ) VALUES (?, ?, 'extraction', 1, 1, '{}', 'fixture', 30, 27, 0.9, 0,
      '2026-07-10T00:00:00.000Z')
  `).run(`strategy-${id}`, id);
  insertTrustedStrategyValidationEvidence(database, `strategy-${id}`);
  database.prepare(`UPDATE strategies
    SET active = 1, activated_at = '2026-07-10T00:00:00.000Z'
    WHERE id = ?`)
    .run(`strategy-${id}`);
  const insert = database.prepare(`
    INSERT INTO products(
      id, retailer_id, canonical_url, title, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, '2026-07-01', '2026-07-10')
  `);
  for (let index = 0; index < products; index += 1) {
    insert.run(`${id}-product-${index}`, id, `https://${id}.example.test/${index}`, `Product ${index}`);
  }
}

function seedHumanReviewClassifications(
  database: Database.Database,
  count = 200,
  version = 7,
): void {
  seedRetailer(database, "review-retailer", count);
  database.prepare(`
    INSERT INTO ipca_items(id, code, name, weight, weight_period, source_url, citation)
    VALUES ('review-item', '1100001', 'Review item', 1, '2026-01',
      'https://example.test/ipca', 'review fixture')
  `).run();
  const rows = database.prepare(`
    SELECT id, title, brand, source_category FROM products
    WHERE retailer_id = 'review-retailer' ORDER BY id
  `).all() as Array<{ id: string; title: string; brand: string | null; source_category: string | null }>;
  const insert = database.prepare(`
    INSERT INTO classifications(
      id, product_id, ipca_item_id, version, decision, confidence, method,
      prompt_version, model, input_json, output_json, created_at
    ) VALUES (?, ?, 'review-item', ?, '1100001', 0.95, 'llm',
      'review-v1', 'review-model', ?, '{}', ?)
  `);
  rows.forEach((row, index) => insert.run(
    `review-classification-${String(index).padStart(3, "0")}`,
    row.id,
    version,
    JSON.stringify({
      productId: row.id,
      title: row.title,
      brand: row.brand,
      sourceCategory: row.source_category,
      allowedItems: [],
    }),
    `2026-07-11T04:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
  ));
}

function fillReviewLabels(csv: string): string {
  return `${csv.trimEnd().split("\n").map((line, index) =>
    index === 0 ? line : `${line}1100001`).join("\n")}\n`;
}

function strategyReceipt(
  config: RetailerConfig,
  purpose: "discovery" | "extraction",
  sourceCommit = "a".repeat(40),
) {
  const strategy = config[purpose] as Strategy;
  const validation = config.validation[purpose];
  const regionalSeller = purpose === "extraction"
    && strategy.purpose === "extraction"
    && strategy.tier === "api"
    ? strategy.regionalContext?.catalogSellerId ?? null
    : null;
  const samples = Array.from({ length: 30 }, (_, index) => {
    const externalId = String(10_000 + index);
    const ref = {
      canonicalUrl: `https://carrefourbrfood.vtexcommercestable.com.br/product-${index}/p`,
      externalId,
      sourceCategory: "/Mercearia/",
    };
    const request = {
      method: "GET" as const,
      url: `https://carrefourbrfood.vtexcommercestable.com.br/api/catalog_system/pub/products/search?fq=productId:${externalId}`,
      bodySha256: null,
    };
    const valid = index < validation.successes;
    const outcome = valid
      ? purpose === "extraction"
        ? {
            status: "valid" as const,
            fields: {
              title: `Product ${index}`,
              brand: "Brand",
              price: 10,
              promoPrice: 9,
              unit: "1 kg",
              available: true,
            },
          }
        : { status: "valid" as const, fields: null }
      : {
          status: "invalid" as const,
          failure: {
            category: "invalid-price" as const,
            message: "No positive price",
            responded: true,
            statusCode: 200,
          },
        };
    return {
      ordinal: index + 1,
      startedOffsetMs: index * 1_100,
      durationMs: 100 + index,
      ref,
      refSha256: validationRefSha256(ref),
      request,
      requestSha256: evidenceValueSha256(request),
      response: {
        finalUrl: request.url,
        statusCode: 200,
        contentType: "application/json",
        bodyBytes: 100 + index,
        bodySha256: createHash("sha256").update(`response-${purpose}-${index}`).digest("hex"),
      },
      outcome,
      outcomeSha256: evidenceValueSha256(outcome),
      validatedFacts: {
        returnedProductId: externalId,
        catalogSellerId: regionalSeller,
        catalogSellerMatchCount: regionalSeller === null ? null : 1,
      },
    };
  });
  const parsedSamples = StrategyValidationEvidenceSchema.shape.samples.parse(samples);
  const elapsedMs = 29 * 1_100 + 129;
  const finishedAt = validation.validatedAt ?? "2026-07-11T05:00:00.000Z";
  return attestStrategyValidationEvidence({
    schemaVersion: 2,
    retailerId: config.id,
    purpose,
    strategyVersion: config.strategyVersions[purpose],
    strategySha256: strategyEvidenceSha256(strategy),
    validatedAt: validation.validatedAt,
    executor: {
      program: "scripts/validate-strategies.ts",
      version: 1,
      mode: "trusted-live-host",
      runtime: "node-v24.18.0",
      sourceCommit,
      playwrightVersion: "1.61.1",
      chromiumVersion: "Chromium 141.0.0.0",
      artifactSha256: "d".repeat(64),
      challengeAlgorithm: "active-in-scope-category-url-bucket-round-robin-v1",
      sequentialPacingMs: 1_100,
      timeoutMs: 15_000,
      maxBodyBytes: 2_000_000,
      startedAt: new Date(Date.parse(finishedAt) - elapsedMs).toISOString(),
      finishedAt,
      elapsedMs,
      requestHeadersStored: false,
      responseBodiesStored: false,
    },
    attempted: 30,
    valid: validation.successes,
    score: validation.score,
    activatable: true,
    sampleSetSha256: validationSampleSetSha256(parsedSamples),
    samples: parsedSamples,
  }, TEST_VALIDATION_PRIVATE_KEY);
}

function seedCollection(
  database: Database.Database,
  retailerId: string,
  day: string,
  ok = 27,
  attempted = 30,
  scheduledTime = "06:00:00.000Z",
  trigger: "manual" | "systemd-timer" = "systemd-timer",
  operational: {
    monitorFailedRunIds?: string[];
    retailerFailures?: Array<Record<string, unknown>>;
  } = {},
  createHeartbeat = true,
  idSuffix = "",
): void {
  const runId = `run-${retailerId}-${day}${idSuffix}`;
  const scheduledAt = `${day}T${scheduledTime}`;
  const completedAt = new Date(Date.parse(scheduledAt) + 10 * 60_000).toISOString();
  const observedAt = new Date(Date.parse(scheduledAt) + 5 * 60_000).toISOString();
  database.prepare(`
    INSERT INTO runs(
      id, retailer_id, stage, collection_day, strategy_id, strategy_version,
      status, attempted, ok, failed, started_at, finished_at
    ) VALUES (?, ?, 'collect', ?, ?, 1, 'running', 0, 0, 0, ?, NULL)
  `).run(
    runId,
    retailerId,
    day,
    `strategy-${retailerId}`,
    scheduledAt,
  );
  const products = database.prepare(
    "SELECT id FROM products WHERE retailer_id = ? ORDER BY id LIMIT ?",
  ).all(retailerId, ok) as Array<{ id: string }>;
  const observation = database.prepare(`
    INSERT INTO observations(
      id, product_id, run_id, strategy_id, strategy_version, observed_at,
      collection_day, price_cents
    ) VALUES (?, ?, ?, ?, 1, ?, ?, 100)
  `);
  for (const [index, product] of products.entries()) {
    observation.run(
      `observation-${runId}-${index}`,
      product.id,
      runId,
      `strategy-${retailerId}`,
      observedAt,
      day,
    );
  }
  database.prepare(`
    UPDATE runs
    SET status = 'completed', attempted = ?, ok = ?, failed = ?, finished_at = ?
    WHERE id = ?
  `).run(attempted, ok, attempted - ok, completedAt, runId);
  if (createHeartbeat) {
    database.prepare(`
      INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
      VALUES (?, 'collect', ?, ?, 'completed', ?)
    `).run(
      `heartbeat-${runId}`,
      scheduledAt,
      completedAt,
      JSON.stringify({
      trigger,
      ...(trigger === "systemd-timer" ? scheduledProvenance(scheduledAt) : {}),
        runIds: [runId],
        monitorFailedRunIds: operational.monitorFailedRunIds ?? [],
        retailerFailures: operational.retailerFailures ?? [],
      }),
    );
  }
}

function seedM4Evidence(database: Database.Database, estimateSource: string): void {
  database.prepare(`
    INSERT INTO retailers(id, name, base_url, cep, domains_json)
    VALUES ('agent-retailer', 'Agent retailer', 'https://agent.example.test', '01001000', '["agent.example.test"]')
  `).run();
  for (const purpose of ["discovery", "extraction"]) {
    const strategyId = `agent-${purpose}`;
    const previousStrategyId = `hand-${purpose}`;
    const explorationId = `exploration-${purpose}`;
    database.prepare(`
      INSERT INTO strategies(
        id, retailer_id, purpose, tier, version, strategy_json, provenance,
        validation_sample_size, validation_successes, validation_rate, active,
        retired_at
      ) VALUES (?, 'agent-retailer', ?, 1, 1, '{}', 'hand-written',
        30, 27, 0.9, 0, '2026-07-10T10:00:00.000Z')
    `).run(previousStrategyId, purpose);
    database.prepare(`
      INSERT INTO strategies(
        id, retailer_id, purpose, tier, version, strategy_json, provenance,
        model, prompt_version, validation_sample_size, validation_successes,
        validation_rate, active, validated_at, activated_at
      ) VALUES (?, 'agent-retailer', ?, 1, 2, '{}',
        'Codex SDK; trusted host validation', 'gpt-test', 'prompt-v1',
        30, 27, 0.9, 0, '2026-07-10T10:00:00.000Z', NULL)
    `).run(strategyId, purpose);
    insertTrustedStrategyValidationEvidence(database, strategyId);
    database.prepare(`
      UPDATE strategies
      SET active = 1, activated_at = '2026-07-10T10:00:00.000Z'
      WHERE id = ?
    `).run(strategyId);
    database.prepare(`
      INSERT INTO exploration_runs(
        id, retailer_id, purpose, trigger, previous_strategy_id,
        candidate_strategy_id, status,
        outcome, event_budget, events_used, input_tokens, output_tokens,
        cost_usd, started_at, finished_at
      ) VALUES (?, 'agent-retailer', ?, 'fixture', ?, ?, 'finished', 'activated',
        1, 1, 100, 20, 0.1, '2026-07-10T09:00:00.000Z', '2026-07-10T10:00:00.000Z')
    `).run(explorationId, purpose, previousStrategyId, strategyId);
    database.prepare(`
      INSERT INTO exploration_attempts(
        id, exploration_run_id, attempt_number, model, prompt_version,
        prompt_hash, input_tokens, cached_input_tokens, output_tokens,
        reasoning_output_tokens, cost_usd, cost_estimated, estimate_source,
        rate_version, external_sample_size, external_successes, external_score,
        outcome, created_at
      ) VALUES (?, ?, 1, 'gpt-test', 'prompt-v1', ?, 100, 10, 20, 5,
        0.1, 1, ?, 'rates-v1', 30, 27, 0.9, 'activated',
        '2026-07-10T10:00:00.000Z')
    `).run(`attempt-${purpose}`, explorationId, "a".repeat(64), estimateSource);
    database.prepare(`
      INSERT INTO model_budget_reservations(
        id, category, retailer_id, exploration_run_id, amount_usd,
        actual_cost_usd, status, month_start, reserved_at, settled_at
      ) VALUES (?, 'strategy-exploration', 'agent-retailer', ?, 1, 0.1,
        'settled', '2026-07-01', '2026-07-10T09:00:00.000Z',
        '2026-07-10T10:00:00.000Z')
    `).run(`reservation-${purpose}`, explorationId);
    database.prepare(`
      INSERT INTO cost_ledger(
        id, category, retailer_id, exploration_run_id, provider, model,
        input_tokens, output_tokens, cost_usd, occurred_at, details_json
      ) VALUES (?, 'strategy-exploration', 'agent-retailer', ?, 'codex-sdk',
        'gpt-test', 100, 20, 0.1, '2026-07-10T10:00:00.000Z',
        ?)
    `).run(`ledger-${purpose}`, explorationId, JSON.stringify({
      attemptNumber: 1,
      cachedInputTokens: 10,
      reasoningOutputTokens: 5,
      costEstimated: true,
      estimateSource,
      rateVersion: "rates-v1",
      promptHash: "a".repeat(64),
    }));
  }
}

describe("acceptance status and evidence", () => {
  it("closes a scheduled window early only with completed causal evidence", () => {
    const now = new Date("2026-07-11T07:20:00.000Z");
    const deadline = new Date("2026-07-11T08:15:00.000Z");
    expect(scheduledWindowIsPending({
      now,
      deadline,
      evidenceSatisfied: true,
      serviceActive: false,
    })).toBe(false);
    expect(scheduledWindowIsPending({
      now,
      deadline,
      evidenceSatisfied: false,
      serviceActive: false,
    })).toBe(true);
    expect(scheduledWindowIsPending({
      now,
      deadline,
      evidenceSatisfied: true,
      serviceActive: true,
    })).toBe(true);
    expect(scheduledWindowIsPending({
      now: new Date("2026-07-11T08:16:00.000Z"),
      deadline,
      evidenceSatisfied: false,
      serviceActive: false,
    })).toBe(false);
  });
  it("uses the single exact report/drill CLI contract", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.acceptance).toBe("tsx ops/acceptance.ts report");
    expect(packageJson.scripts["acceptance:drill"]).toBe("tsx ops/acceptance.ts drill");
  });
  it("aggregates fail over pending over pass and maps CLI exit codes", () => {
    expect(aggregateAcceptanceStatus(["pass", "pending", "pass"])).toBe("pending");
    expect(aggregateAcceptanceStatus(["pending", "fail", "pass"])).toBe("fail");
    expect(aggregateAcceptanceStatus(["pass", "pass"])).toBe("pass");
    expect(acceptanceExitCode("pending", false)).toBe(0);
    expect(acceptanceExitCode("pending", true)).toBe(3);
    expect(acceptanceExitCode("fail", false)).toBe(1);
  });

  it("resolves a trailing report/receipt commit to the last implementation cut", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-evidence-cut-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Evidence Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "evidence@example.test"], { cwd: root });
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "implementation.ts"), "export const implemented = true;\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "implementation"], { cwd: root });
      const implementation = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

      await mkdir(join(root, "data", "acceptance", "evidence"), { recursive: true });
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "data", "acceptance", "acceptance.json"), "{}\n");
      await writeFile(join(root, "data", "acceptance", "evidence", "fresh-clone.json"), "{}\n");
      await writeFile(join(root, "data", "acceptance", "evidence", "healing-sabotage-drill.json"), "{}\n");
      await writeFile(join(root, "data", "acceptance", "evidence", "classification-review-v7.json"), "{}\n");
      await writeFile(join(root, "docs", "acceptance-report.md"), "# Generated report\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "evidence only"], { cwd: root });

      expect(resolveAcceptanceEvaluatedCommit(root)).toBe(implementation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves porcelain status columns when allowing only modified acceptance evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-worktree-clean-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Evidence Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "evidence@example.test"], { cwd: root });
      await mkdir(join(root, "data", "acceptance", "evidence"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      const receipt = join(root, "data", "acceptance", "evidence", "fresh-clone.json");
      const source = join(root, "src", "implementation.ts");
      await writeFile(receipt, "{}\n");
      await writeFile(source, "export const implemented = true;\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });

      await writeFile(receipt, "{\"updated\":true}\n");
      expect(sourceWorktreeClean(root)).toBe(true);
      await writeFile(source, "export const implemented = false;\n");
      expect(sourceWorktreeClean(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "src/changed.ts",
    "tests/changed.test.ts",
    "retailers/changed.json",
    "data/precos.sqlite",
    "data/exports/latest.json",
    "analysis/output/latest.json",
    "data/acceptance/unreviewed-note.json",
    "data/acceptance/evidence/classification-review-v0.json",
  ])("makes %s a new implementation cut instead of evidence-only ancestry", async (path) => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-cut-attack-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Evidence Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "evidence@example.test"], { cwd: root });
      await writeFile(join(root, "README.md"), "implementation\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "implementation"], { cwd: root });
      await mkdir(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
      await writeFile(join(root, path), "changed\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "not evidence only"], { cwd: root });
      const changedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "acceptance-report.md"), "generated\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "trailing evidence"], { cwd: root });

      expect(resolveAcceptanceEvaluatedCommit(root)).toBe(changedCommit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a frozen release current across committed mutable state only", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-release-state-tail-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Evidence Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "evidence@example.test"], { cwd: root });
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "implementation.ts"), "export const implemented = true;\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "implementation"], { cwd: root });
      const releaseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();

      await mkdir(join(root, "data", "exports", "cut"), { recursive: true });
      await mkdir(join(root, "analysis", "output", "cut"), { recursive: true });
      await writeFile(join(root, "data", "precos.sqlite"), "scheduled evidence\n");
      await writeFile(join(root, "data", "exports", "cut", "manifest.json"), "{}\n");
      await writeFile(join(root, "analysis", "output", "cut", "manifest.json"), "{}\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "runtime state"], { cwd: root });
      const evaluatedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();

      expect(resolveAcceptanceEvaluatedCommit(root)).toBe(evaluatedCommit);
      expect(releaseSourceMatchesEvaluatedCommit(root, releaseCommit, evaluatedCommit)).toBe(true);
      expect(releaseSourceMatchesEvaluatedCommit(root, evaluatedCommit, releaseCommit)).toBe(true);

      await mkdir(join(root, "retailers"), { recursive: true });
      await writeFile(join(root, "retailers", "changed.json"), "{}\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "runtime configuration"], { cwd: root });
      const changedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();

      expect(releaseSourceMatchesEvaluatedCommit(root, releaseCommit, changedCommit)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a nonempty experimental relative chain while allowing absent official overlap", () => {
    const exportManifest = (rows: number, status: "no_index_data" | "complete") => ({
      status,
      files: [
        "product_relatives.csv",
        "retailer_subitem_daily.csv",
        "subitem_daily.csv",
        "aggregate_daily.csv",
      ].map((path) => ({ path, rows })),
    });
    const analysisManifest = (rows: number, noIndexData: boolean) => ({
      statuses: { noIndexData, noOfficialOverlap: true },
      inputs: [{ path: "aggregate_daily.csv", rows }],
    });

    expect(experimentalSeriesState(
      exportManifest(0, "no_index_data"),
      analysisManifest(0, true),
    )).toMatchObject({ valid: true, nonempty: false, aggregateDailyRows: 0 });
    expect(experimentalSeriesState(
      exportManifest(1, "complete"),
      analysisManifest(1, false),
    )).toMatchObject({ valid: true, nonempty: true, aggregateDailyRows: 1 });
    expect(experimentalSeriesState(
      exportManifest(0, "complete"),
      analysisManifest(0, false),
    ).valid).toBe(false);
    expect(experimentalSeriesState(
      { status: "complete", files: [{ path: "aggregate_daily.csv", rows: 1 }] },
      analysisManifest(1, false),
    ).valid).toBe(false);
  });

  it("counts only genuine numeric official/experimental overlap rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acceptance-overlap-"));
    try {
      const path = join(directory, "monthly_comparison.csv");
      await writeFile(path, [
        "month,status,experimental_variation_pct,official_variation_pct",
        "2026-05,overlap,1.25,0.80",
        "2026-06,no_overlap,,0.90",
        "2026-07,overlap,not-a-number,1.10",
        "",
      ].join("\n"));
      expect(csvOverlapRowCount(path)).toBe(1);
      await writeFile(path, [
        "month,status,experimental_variation_pct,official_variation_pct",
        "2026-06,no_overlap,,0.90",
        "",
      ].join("\n"));
      expect(csvOverlapRowCount(path)).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("counts actual CSV data rows instead of trusting manifest metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-series-csv-"));
    try {
      const path = join(root, "aggregate_daily.csv");
      await writeFile(path, "date,daily_relative\n2026-07-10,1.01\n");
      expect(csvDataRowCount(path)).toBe(1);
      await writeFile(path, "date,daily_relative\n");
      expect(csvDataRowCount(path)).toBe(0);
      await writeFile(path, 'date,daily_relative\n"unterminated\n');
      expect(csvDataRowCount(path)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires two consecutive qualifying collection days for two retailers", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-09");
    }
    const oneDay = evaluateM2(database, new Date("2026-07-10T05:00:00.000Z"));
    expect(oneDay.criterion.status).toBe("pending");
    expect(oneDay.criterion.reasonCodes).toContain("TIME_WINDOW_NOT_ELAPSED");

    for (const retailer of ["alpha", "beta"]) {
      seedCollection(database, retailer, "2026-07-10");
    }
    const consecutive = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(consecutive.criterion.status).toBe("pass");
    expect(consecutive.criterion.evidenceIds.length).toBeGreaterThan(0);
  });

  it("fails M2 once the next real 03:00 São Paulo boundary is missed", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-09");
    }
    const result = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(result.criterion.status).toBe("fail");
    expect(result.criterion.reasonCodes).toContain("MISSED_SCHEDULED_RUN");
  });

  it("keeps M2 pending during randomized/completion grace and fails no-heartbeat after it", () => {
    const duringWindow = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(duringWindow, retailer);
      seedCollection(duringWindow, retailer, "2026-07-09");
    }
    expect(evaluateM2(duringWindow, new Date("2026-07-10T06:30:00.000Z")).criterion.status).toBe("pending");

    const missing = fixture();
    missing.prepare("UPDATE schema_migrations SET applied_at = '2026-07-09T00:00:00.000Z'").run();
    expect(evaluateM2(
      missing,
      new Date("2026-07-10T12:00:00.000Z"),
      new Date("2026-07-09T00:00:00.000Z"),
    ).criterion.status).toBe("fail");
    expect(evaluateM2(missing, new Date("2026-07-10T12:00:00.000Z")).criterion.status)
      .toBe("pending");
  });

  it("does not fail a deployment made after today's daily start before tomorrow's first deadline", () => {
    const database = fixture();
    const deployedAt = new Date("2026-07-10T06:30:00.000Z"); // 03:30 São Paulo
    const result = evaluateM2(
      database,
      new Date("2026-07-10T07:30:00.000Z"),
      deployedAt,
      "a".repeat(32),
    );
    expect(result.criterion.status).toBe("pending");
    expect(result.criterion.reasonCodes).toContain("TIME_WINDOW_NOT_ELAPSED");
  });

  it("does not let full manual daytime runs qualify as scheduled M2 evidence", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-09", 30, 30, "06:05:00.000Z", "manual");
      seedCollection(database, retailer, "2026-07-10", 30, 30, "06:05:00.000Z", "manual");
    }
    expect(evaluateM2(database, new Date("2026-07-10T18:00:00.000Z")).criterion.status).not.toBe("pass");
  });

  it("rejects a completed-label heartbeat that admits monitor or retailer failures", () => {
    const database = fixture();
    seedRetailer(database, "alpha");
    seedCollection(
      database,
      "alpha",
      "2026-07-10",
      30,
      30,
      "06:05:00.000Z",
      "systemd-timer",
      { monitorFailedRunIds: ["run-alpha-2026-07-10"] },
    );

    const result = evaluateM2(database, new Date("2026-07-10T18:00:00.000Z"));
    expect(result.criterion.status).toBe("fail");
    expect(result.criterion.reasonCodes).toContain("EVIDENCE_CONTRADICTION");
  });

  it("accepts timer-provenanced persistent catch-up outside the nominal 03:00 window", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-09", 30, 30, "09:47:00.000Z");
      seedCollection(database, retailer, "2026-07-10", 30, 30, "10:12:00.000Z");
    }
    expect(evaluateM2(database, new Date("2026-07-10T18:00:00.000Z")).criterion.status)
      .toBe("pass");
  });

  it("fails rather than accepting future scheduled, run, or observation evidence", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-11");
      seedCollection(database, retailer, "2026-07-12");
    }
    const result = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(result.criterion.status).toBe("fail");
    expect(result.criterion.reasonCodes).toContain("EVIDENCE_CONTRADICTION");
  });

  it("rejects the exact 0.899 validation boundary", () => {
    const database = fixture();
    database.exec("DROP TRIGGER strategies_active_validation_binding_no_update");
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      database.prepare("UPDATE strategies SET validation_rate = 0.899 WHERE retailer_id = ?")
        .run(retailer);
      seedCollection(database, retailer, "2026-07-09", 30, 30);
      seedCollection(database, retailer, "2026-07-10", 30, 30);
    }
    const result = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(result.criterion.status).not.toBe("pass");
    expect(result.evidence[0]?.facts.qualifyingRetailers).toBe(0);
  });

  it("rejects undersized and below-boundary M2 runs", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-09", 1, 1);
      seedCollection(database, retailer, "2026-07-10", 26, 29);
    }
    const result = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(result.criterion.status).toBe("pending");
    expect(result.evidence[0]?.facts.qualifyingRetailers).toBe(0);
  });

  it.each([
    ["cross-retailer strategy", "strategy-alpha", 1],
    ["wrong strategy version", "strategy-beta", 2],
  ])("rejects M2 runs bound to a %s", (_label, strategyId, strategyVersion) => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-09", 30, 30);
      seedCollection(database, retailer, "2026-07-10", 30, 30);
    }
    database.exec("DROP TRIGGER runs_restrict_update");
    database.prepare(`
      UPDATE runs SET strategy_id = ?, strategy_version = ?
      WHERE retailer_id = 'beta'
    `).run(strategyId, strategyVersion);

    const result = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(result.criterion.status).not.toBe("pass");
    expect(result.evidence[0]?.facts.qualifyingRetailers).toBe(1);
  });

  it("rejects M2 runs that substitute a discovery strategy", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      database.prepare(`
        INSERT INTO strategies(
          id, retailer_id, purpose, tier, version, strategy_json, provenance,
          validation_sample_size, validation_successes, validation_rate, active,
          validated_at
        ) VALUES (?, ?, 'discovery', 1, 1, '{}', 'fixture', 30, 27, 0.9, 0,
          '2026-07-10T00:00:00.000Z')
      `).run(`discovery-${retailer}`, retailer);
      insertTrustedStrategyValidationEvidence(
        database,
        `discovery-${retailer}`,
        {
          receiptSha256: "d".repeat(64),
          sampleSetSha256: "e".repeat(64),
          attestationKeyId: "f".repeat(64),
        },
      );
      database.prepare(`UPDATE strategies
        SET active = 1, activated_at = '2026-07-10T00:00:00.000Z'
        WHERE id = ?`)
        .run(`discovery-${retailer}`);
      seedCollection(database, retailer, "2026-07-09", 30, 30);
      seedCollection(database, retailer, "2026-07-10", 30, 30);
    }
    database.exec("DROP TRIGGER runs_restrict_update");
    database.prepare(`
      UPDATE runs SET strategy_id = 'discovery-beta'
      WHERE retailer_id = 'beta'
    `).run();

    const result = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(result.criterion.status).not.toBe("pass");
    expect(result.evidence[0]?.facts.qualifyingRetailers).toBe(1);
  });

  it("rejects observations that are not bound to the run strategy and version", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-09", 30, 30);
      seedCollection(database, retailer, "2026-07-10", 30, 30);
    }
    database.exec("DROP TRIGGER observations_no_update");
    database.prepare(`
      UPDATE observations SET strategy_id = 'strategy-alpha'
      WHERE product_id LIKE 'beta-product-%'
    `).run();

    const result = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(result.criterion.status).not.toBe("pass");
    expect(result.evidence[0]?.facts.qualifyingRetailers).toBe(1);
  });

  it("accepts consecutive scheduled days only from the currently deployed release", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-09", 30, 30);
      seedCollection(database, retailer, "2026-07-10", 30, 30);
    }
    const deployedAt = new Date("2026-07-09T00:00:00.000Z");
    expect(evaluateM2(
      database,
      new Date("2026-07-10T12:00:00.000Z"),
      deployedAt,
      "c".repeat(32),
    ).criterion.status).toBe("pass");
    const wrongRelease = evaluateM2(
      database,
      new Date("2026-07-10T12:00:00.000Z"),
      deployedAt,
      "d".repeat(32),
    );
    expect(wrongRelease.criterion.status).toBe("fail");
    expect(wrongRelease.criterion.reasonCodes).toContain("EVIDENCE_CONTRADICTION");
  });

  it("ignores legacy heartbeat provenance before deployment but rejects it in the current window", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-09", 30, 30);
      seedCollection(database, retailer, "2026-07-10", 30, 30);
    }
    const legacyDetails = JSON.stringify({
      trigger: "systemd-timer",
      runIds: ["legacy-run"],
      monitorFailedRunIds: [],
      retailerFailures: [],
    });
    database.prepare(`
      INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
      VALUES ('legacy-heartbeat', 'collect', '2026-07-08T06:00:00.000Z',
        '2026-07-08T06:01:00.000Z', 'completed', ?)
    `).run(legacyDetails);
    const deployedAt = new Date("2026-07-09T00:00:00.000Z");
    const current = evaluateM2(
      database,
      new Date("2026-07-10T12:00:00.000Z"),
      deployedAt,
      "c".repeat(32),
    );
    expect(current.criterion.status).toBe("pass");
    expect(current.evidence[0]?.facts.contradictoryHeartbeats).toBe(0);

    database.prepare(`
      INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
      VALUES ('current-legacy-shape', 'collect', '2026-07-10T08:00:00.000Z',
        '2026-07-10T08:01:00.000Z', 'completed', ?)
    `).run(legacyDetails);
    const malformedCurrent = evaluateM2(
      database,
      new Date("2026-07-10T12:00:00.000Z"),
      deployedAt,
      "c".repeat(32),
    );
    expect(malformedCurrent.criterion.status).toBe("fail");
    expect(malformedCurrent.criterion.reasonCodes).toContain("EVIDENCE_CONTRADICTION");
  });

  it("uses only the latest classification and retains low-confidence products in M3", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) {
      seedRetailer(database, retailer, 5);
      seedCollection(database, retailer, "2026-07-10", 5, 5, "06:00:00.000Z", "systemd-timer", {}, false);
    }
    database.prepare(`
      INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
      VALUES ('heartbeat-latest-panel', 'collect', '2026-07-10T06:00:00.000Z',
        '2026-07-10T06:11:00.000Z', 'completed', ?)
    `).run(JSON.stringify({
      ...scheduledProvenance("2026-07-10T06:00:00.000Z"),
      runIds: ["alpha", "beta", "gamma", "delta"].map((retailer) => `run-${retailer}-2026-07-10`),
      monitorFailedRunIds: [],
      retailerFailures: [],
    }));
    database.prepare(`
      INSERT INTO ipca_items(id, code, name, weight, weight_period, source_url, citation)
      VALUES ('item', '1', 'Item', 1, '2026-01', 'https://example.test', 'fixture')
    `).run();
    const insert = database.prepare(`
      INSERT INTO classifications(id, product_id, ipca_item_id, version, decision, confidence, method)
      VALUES (?, ?, 'item', ?, 'accepted', ?, 'fixture')
    `);
    const products = database.prepare("SELECT id FROM products ORDER BY id").all() as Array<{ id: string }>;
    for (const [index, product] of products.entries()) {
      insert.run(`classification-old-${index}`, product.id, 1, 0.99);
      insert.run(`classification-new-${index}`, product.id, 2, index < 16 ? 0.8 : 0.79);
    }
    const result = evaluateM3(database, {
      credentialConfigured: true,
      siteValidated: true,
      authorityApproved: true,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(m3Criterion(result, "m3-live-panel").status).toBe("pass");
    expect(m3Criterion(result, "m3-classification-coverage").status).toBe("pass");
    expect(result.evidence.find((item) => item.id === "db-m3-latest-classification-coverage")?.facts.activeProducts).toBe(20);
    expect(result.evidence.find((item) => item.id === "db-m3-latest-classification-coverage")?.facts.highConfidenceProducts).toBe(16);
  });

  it("ignores predeployment legacy heartbeat schema for the current M3 panel", () => {
    const database = fixture();
    const runIds: string[] = [];
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) {
      seedRetailer(database, retailer, 1);
      seedCollection(
        database,
        retailer,
        "2026-07-10",
        1,
        1,
        "06:00:00.000Z",
        "systemd-timer",
        {},
        false,
      );
      runIds.push(`run-${retailer}-2026-07-10`);
    }
    database.prepare(`
      INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
      VALUES ('legacy-panel-heartbeat', 'collect', '2026-07-08T06:00:00.000Z',
        '2026-07-08T06:01:00.000Z', 'completed', ?)
    `).run(JSON.stringify({
      trigger: "systemd-timer",
      runIds: ["legacy-run"],
      monitorFailedRunIds: [],
      retailerFailures: [],
    }));
    database.prepare(`
      INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
      VALUES ('current-panel-heartbeat', 'collect', '2026-07-10T06:00:00.000Z',
        '2026-07-10T06:11:00.000Z', 'completed', ?)
    `).run(JSON.stringify({
      ...scheduledProvenance("2026-07-10T06:00:00.000Z"),
      runIds,
      monitorFailedRunIds: [],
      retailerFailures: [],
    }));
    const result = evaluateM3(database, {
      credentialConfigured: false,
      siteValidated: true,
      deployedAt: new Date("2026-07-09T00:00:00.000Z"),
      releaseId: "c".repeat(32),
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(m3Criterion(result, "m3-live-panel").status).toBe("pass");
    expect(result.evidence.find((item) => item.id === "db-m3-live-panel")?.facts)
      .toMatchObject({ contradictoryHeartbeats: 0 });
  });

  it("keeps M4 credential and spend gates pending without invoking a provider", () => {
    const database = fixture();
    seedRetailer(database, "alpha");
    const withoutCredential = evaluateM4(database, {
      credentialConfigured: false,
      spendAuthorized: false,
      siteValidated: false,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(withoutCredential.criterion.status).toBe("pending");
    expect(withoutCredential.criterion.reasonCodes).toEqual(["CREDENTIAL_NOT_CONFIGURED"]);

    const withoutSpend = evaluateM4(database, {
      credentialConfigured: true,
      spendAuthorized: false,
      siteValidated: false,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(withoutSpend.criterion.status).toBe("pending");
    expect(withoutSpend.criterion.reasonCodes).toEqual(["LIVE_SPEND_NOT_AUTHORIZED"]);
  });

  it("requires explicit token and cost-status evidence before M4 can pass", () => {
    const valid = fixture();
    seedM4Evidence(valid, "published rate card");
    expect(evaluateM4(valid, {
      credentialConfigured: true,
      spendAuthorized: true,
      siteValidated: true,
    }, new Date("2026-07-10T12:00:00.000Z")).criterion.status).toBe("pass");

    const missingStatus = fixture();
    seedM4Evidence(missingStatus, "");
    const result = evaluateM4(missingStatus, {
      credentialConfigured: true,
      spendAuthorized: true,
      siteValidated: true,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(result.criterion.status).toBe("fail");
  });

  it("does not approve a three-retailer exception from an unaudited authority flag", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta", "gamma"]) seedRetailer(database, retailer, 1);
    database.prepare(`
      INSERT INTO ipca_items(id, code, name, weight, weight_period, source_url, citation)
      VALUES ('item', '1', 'Item', 1, '2026-01', 'https://example.test', 'fixture')
    `).run();
    const products = database.prepare("SELECT id FROM products").all() as Array<{ id: string }>;
    const insert = database.prepare(`
      INSERT INTO classifications(id, product_id, ipca_item_id, version, decision, confidence, method)
      VALUES (?, ?, 'item', 1, 'accepted', 0.9, 'fixture')
    `);
    for (const [index, product] of products.entries()) insert.run(`classification-${index}`, product.id);
    const result = evaluateM3(database, {
      credentialConfigured: true,
      siteValidated: true,
      authorityApproved: true,
      decisionsDocumented: false,
      namedBackupDocumented: false,
      blockedDayTriggerProven: false,
    } as never);
    expect(m3Criterion(result, "m3-live-panel").status).toBe("pending");
    expect(m3Criterion(result, "m3-live-panel").reasonCodes).toContain("SITE_VALIDATION_PENDING");
  });

  it("fails M3 when all external gates are declared available but collection proof is absent", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) seedRetailer(database, retailer, 1);
    database.prepare(`INSERT INTO ipca_items(id, code, name, weight, weight_period, source_url, citation)
      VALUES ('item', '1', 'Item', 1, '2026-01', 'https://example.test', 'fixture')`).run();
    const products = database.prepare("SELECT id FROM products").all() as Array<{ id: string }>;
    for (const [index, product] of products.entries()) {
      database.prepare(`INSERT INTO classifications(id, product_id, ipca_item_id, version, decision, confidence, method)
        VALUES (?, ?, 'item', 1, 'accepted', 0.9, 'fixture')`).run(`coverage-${index}`, product.id);
    }
    const result = evaluateM3(database, {
      credentialConfigured: true,
      siteValidated: true,
      authorityApproved: true,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(m3Criterion(result, "m3-live-panel").status).not.toBe("pass");
    expect(m3Criterion(result, "m3-classification-coverage").status).toBe("pass");
  });

  it("fails an active degraded panel before considering credential or site gates", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) seedRetailer(database, retailer, 1);
    database.prepare("UPDATE retailers SET degraded = 1, degraded_reason = 'blocked' WHERE id = 'alpha'").run();
    const result = evaluateM3(database, {
      credentialConfigured: false,
      siteValidated: false,
    });
    expect(m3Criterion(result, "m3-live-panel").status).toBe("fail");
    expect(m3Criterion(result, "m3-live-panel").reasonCodes).toContain("UNSAFE_CONFIGURATION");
  });

  it("keeps a never-yet-complete retailer panel externally site/credential gated", () => {
    const database = fixture();
    seedRetailer(database, "alpha", 1);
    seedRetailer(database, "beta", 1);
    const result = evaluateM3(database, {
      credentialConfigured: false,
      siteValidated: false,
    });
    expect(m3Criterion(result, "m3-live-panel").reasonCodes).toContain("SITE_VALIDATION_PENDING");
    expect(m3Criterion(result, "m3-classification-coverage").status).toBe("pending");
    expect(m3Criterion(result, "m3-classification-coverage").reasonCodes).toContain("CREDENTIAL_NOT_CONFIGURED");
    expect(result.gates.map((item) => item.criterionId).sort()).toEqual([
      "m3-classification-coverage",
      "m3-live-panel",
    ]);
  });

  it("keeps a manual-only panel pending and rejects stale scheduled proof", () => {
    const manual = fixture();
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) {
      seedRetailer(manual, retailer, 1);
      seedCollection(manual, retailer, "2026-07-10", 1, 1, "06:00:00.000Z", "manual");
    }
    const manualResult = evaluateM3(manual, {
      credentialConfigured: false,
      siteValidated: true,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(m3Criterion(manualResult, "m3-live-panel").status).toBe("pending");
    expect(m3Criterion(manualResult, "m3-live-panel").reasonCodes)
      .toContain("SCHEDULED_RUN_NOT_YET_DUE");

    const stale = fixture();
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) {
      seedRetailer(stale, retailer, 1);
      seedCollection(stale, retailer, "2026-07-08", 1, 1);
    }
    const staleResult = evaluateM3(stale, {
      credentialConfigured: false,
      siteValidated: true,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(m3Criterion(staleResult, "m3-live-panel").status).toBe("fail");
    expect(m3Criterion(staleResult, "m3-live-panel").reasonCodes)
      .toContain("MISSED_SCHEDULED_RUN");
  });

  it("keeps the latest qualifying scheduled panel when a newer manual heartbeat exists", () => {
    const database = fixture();
    const scheduledRunIds: string[] = [];
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) {
      seedRetailer(database, retailer, 1);
      seedCollection(
        database,
        retailer,
        "2026-07-10",
        1,
        1,
        "06:00:00.000Z",
        "systemd-timer",
        {},
        false,
      );
      scheduledRunIds.push(`run-${retailer}-2026-07-10`);
    }
    database.prepare(`
      INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
      VALUES ('scheduled-panel', 'collect', '2026-07-10T06:00:00.000Z',
        '2026-07-10T06:10:00.000Z', 'completed', ?)
    `).run(JSON.stringify({
      ...scheduledProvenance("2026-07-10T06:00:00.000Z"),
      runIds: scheduledRunIds,
      monitorFailedRunIds: [],
      retailerFailures: [],
    }));
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) {
      seedCollection(
        database,
        retailer,
        "2026-07-10",
        0,
        0,
        "10:00:00.000Z",
        "manual",
        {},
        true,
        "-manual",
      );
    }

    const result = evaluateM3(database, {
      credentialConfigured: false,
      siteValidated: true,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(m3Criterion(result, "m3-live-panel").status).toBe("pass");
    expect(result.evidence.find((item) => item.id === "db-m3-live-panel")?.facts)
      .toMatchObject({ latestHeartbeatId: "scheduled-panel", contradictoryHeartbeats: 0 });
  });

  it("requires a healthy substantive scheduled run for every panel retailer", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-10", retailer === "delta" ? 20 : 30, 30);
    }
    const result = evaluateM3(database, {
      credentialConfigured: false,
      siteValidated: true,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(m3Criterion(result, "m3-live-panel").status).toBe("fail");
    expect(m3Criterion(result, "m3-live-panel").reasonCodes)
      .toContain("EVIDENCE_CONTRADICTION");
  });

  it("does not union an older success across a newer failed panel heartbeat", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) {
      seedRetailer(database, retailer, 1);
      seedCollection(database, retailer, "2026-07-10", 1, 1, "06:00:00.000Z", "systemd-timer", {}, false);
    }
    database.prepare(`
      INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
      VALUES ('panel-success', 'collect', '2026-07-10T06:00:00.000Z',
        '2026-07-10T06:10:00.000Z', 'completed', ?)
    `).run(JSON.stringify({
      ...scheduledProvenance("2026-07-10T06:00:00.000Z"),
      runIds: ["alpha", "beta", "gamma", "delta"].map((retailer) => `run-${retailer}-2026-07-10`),
      monitorFailedRunIds: [],
      retailerFailures: [],
    }));
    database.prepare(`
      INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
      VALUES ('panel-failed', 'collect', '2026-07-10T07:00:00.000Z',
        '2026-07-10T07:01:00.000Z', 'failed', ?)
    `).run(JSON.stringify({
      ...scheduledProvenance("2026-07-10T07:00:00.000Z", "d".repeat(32)),
      runIds: [],
      monitorFailedRunIds: [],
      retailerFailures: [{ retailerId: "alpha", message: "controlled failure" }],
    }));

    const result = evaluateM3(database, {
      credentialConfigured: false,
      siteValidated: true,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(m3Criterion(result, "m3-live-panel")).toMatchObject({
      status: "fail",
      reasonCodes: ["EVIDENCE_CONTRADICTION"],
    });
  });

  it("keeps the human classification review as an independent authority gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-human-review-pending-"));
    try {
      const database = fixture();
      seedHumanReviewClassifications(database);
      const result = evaluateClassificationHumanReview(
        root,
        database,
        new Date("2026-07-11T06:00:00.000Z"),
      );
      expect(result.criterion).toMatchObject({
        id: "m3-classification-human-review",
        status: "pending",
        reasonCodes: ["AUTHORITY_APPROVAL_REQUIRED"],
      });
      expect(result.gates).toEqual([
        expect.objectContaining({ kind: "authority", criterionId: "m3-classification-human-review" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes only a complete version-bound human review and fails a tampered artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-human-review-"));
    try {
      const database = fixture();
      seedHumanReviewClassifications(database);
      const template = buildClassificationReviewTemplate(database, {
        version: 7,
        sampledAt: "2026-07-11T05:00:00.000Z",
      });
      const reviewed = evaluateClassificationReview(database, fillReviewLabels(template.csv), {
        reviewerId: "opaque-review-session-01",
        reviewedAt: "2026-07-11T05:30:00.000Z",
        now: new Date("2026-07-11T06:00:00.000Z"),
      });
      const directory = join(root, "data", "acceptance", "evidence");
      await mkdir(directory, { recursive: true });
      const path = join(directory, "classification-review-v7.json");
      await writeFile(path, JSON.stringify(reviewed));
      const passed = evaluateClassificationHumanReview(
        root,
        database,
        new Date("2026-07-11T06:00:00.000Z"),
      );
      expect(passed.criterion.status).toBe("pass");
      expect(passed.evidence[0]?.facts).toMatchObject({
        artifactValid: true,
        sampleSize: 200,
        precision: 1,
      });

      await writeFile(path, JSON.stringify({ ...reviewed, sampleSha256: "0".repeat(64) }));
      const tampered = evaluateClassificationHumanReview(
        root,
        database,
        new Date("2026-07-11T06:00:00.000Z"),
      );
      expect(tampered.criterion.status).toBe("fail");
      expect(tampered.criterion.reasonCodes).toContain("EVIDENCE_CONTRADICTION");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails active strategies with missing or malformed validation receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-strategy-receipts-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Receipt Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "receipt@example.test"], { cwd: root });
      await writeFile(join(root, "README.md"), "receipt registry fixture\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
      const database = fixture();
      seedRetailer(database, "alpha", 1);
      const missing = evaluateActiveStrategyValidationReceipts(
        root,
        database,
        new Date("2026-07-11T06:00:00.000Z"),
      );
      expect(missing.criterion.status).toBe("fail");
      expect(missing.criterion.reasonCodes).toContain("REQUIRED_ARTIFACT_MISSING");

      await mkdir(join(root, "data", "validation"), { recursive: true });
      await writeFile(join(root, "data", "validation", "alpha-extraction-v1.json"), "{}\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "malformed receipt"], { cwd: root });
      const malformed = evaluateActiveStrategyValidationReceipts(
        root,
        database,
        new Date("2026-07-11T06:00:00.000Z"),
      );
      expect(malformed.criterion.status).toBe("fail");
      expect(malformed.criterion.reasonCodes).toContain("EVIDENCE_CONTRADICTION");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts identity-bound v2 receipts and rejects strengthened evidence attacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-strategy-receipts-v2-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Receipt Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "receipt@example.test"], { cwd: root });
      await mkdir(join(root, "retailers"), { recursive: true });
      await mkdir(join(root, "data", "validation"), { recursive: true });
      await mkdir(join(root, "data", "validation", "attempts"), { recursive: true });
      await mkdir(join(root, "ops"), { recursive: true });
      await writeFile(
        join(root, "data", "validation", "attempts", "manifest.json"),
        `${JSON.stringify({ schemaVersion: 1, attempts: [] })}\n`,
      );
      await writeFile(
        join(root, "data", "validation", "successor-plans.json"),
        `${JSON.stringify({ schemaVersion: 1, plans: [] })}\n`,
      );
      await writeFile(
        join(root, "ops", "validation-attestation-public.pem"),
        TEST_VALIDATION_PUBLIC_KEY.export({ type: "spki", format: "pem" }),
      );
      await writeFile(
        join(root, "ops", "validator-bundle.sha256"),
        `${"d".repeat(64)}\n`,
      );
      await writeFile(
        join(root, "retailers", "carrefour.json"),
        await readFile(resolve("retailers/carrefour.json")),
      );
      execFileSync("git", ["add", "retailers", "ops"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "validation implementation"], { cwd: root });
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      const configs = loadRetailerConfigs(join(root, "retailers"));
      const config = configs.find((candidate) => candidate.id === "carrefour");
      if (config === undefined) throw new Error("Carrefour fixture config is missing");
      const discoveryReceipt = strategyReceipt(config, "discovery", sourceCommit);
      const extractionReceipt = strategyReceipt(config, "extraction", sourceCommit);
      const boundConfig: RetailerConfig = {
        ...config,
        validation: {
          discovery: {
            ...config.validation.discovery,
            receiptSha256: validationReceiptSha256(discoveryReceipt),
          },
          extraction: {
            ...config.validation.extraction,
            receiptSha256: validationReceiptSha256(extractionReceipt),
          },
        },
      };
      await writeFile(
        join(root, "retailers", "carrefour.json"),
        `${JSON.stringify(boundConfig, null, 2)}\n`,
      );
      const discoveryPath = join(
        root,
        "data",
        "validation",
        basename(boundConfig.validation.discovery.receiptPath ?? ""),
      );
      const extractionPath = join(
        root,
        "data",
        "validation",
        basename(boundConfig.validation.extraction.receiptPath ?? ""),
      );
      const serialize = (receipt: StrategyValidationEvidence) => `${JSON.stringify(receipt)}\n`;
      await writeFile(discoveryPath, serialize(discoveryReceipt));
      await writeFile(extractionPath, serialize(extractionReceipt));
      const database = fixture();
      registerRetailerConfigs(database, [boundConfig], {
        projectRoot: root,
        testVerificationPublicKey: TEST_VALIDATION_PUBLIC_KEY,
      });
      const insertProduct = database.prepare(`
        INSERT INTO products(
          id, retailer_id, canonical_url, retailer_product_id, title,
          source_category, first_seen, last_seen
        ) VALUES (?, 'carrefour', ?, ?, ?, ?, '2026-07-10', '2026-07-11')
      `);
      extractionReceipt.samples.forEach((sample, index) => insertProduct.run(
        `carrefour-validation-${index}`,
        sample.ref.canonicalUrl,
        sample.ref.externalId,
        `Product ${index}`,
        sample.ref.sourceCategory,
      ));
      execFileSync("git", ["add", "retailers", "data"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "valid receipt registry"], { cwd: root });

      const now = new Date("2026-07-11T16:00:00.000Z");
      const passed = evaluateActiveStrategyValidationReceipts(root, database, now);
      expect(passed.criterion.status).toBe("pass");
      expect(passed.evidence[0]?.facts).toMatchObject({
        activeStrategies: 2,
        receiptFiles: 2,
        validReceipts: 2,
        missingActiveReceipts: 0,
        malformedReceipts: 0,
        untrackedReceipts: 0,
        configRegistryValid: true,
      });

      const attacks: Array<[
        string,
        (receipt: StrategyValidationEvidence) => void,
      ]> = [
        ["recomputed reference absent from the authoritative DB sample", (receipt) => {
          const sample = receipt.samples[0]!;
          sample.ref.canonicalUrl = "https://carrefourbrfood.vtexcommercestable.com.br/attacker/p";
          sample.refSha256 = validationRefSha256(sample.ref);
          receipt.sampleSetSha256 = validationSampleSetSha256(receipt.samples);
        }],
        ["request changed behind its hash", (receipt) => {
          receipt.samples[0]!.request.url += "&attacker=1";
        }],
        ["normalized outcome changed behind its hash", (receipt) => {
          const outcome = receipt.samples[0]!.outcome;
          if (outcome.status !== "valid" || outcome.fields === null) {
            throw new Error("Expected a valid extraction outcome");
          }
          outcome.fields.price = 999;
        }],
        ["returned product identity mismatch", (receipt) => {
          receipt.samples[0]!.validatedFacts.returnedProductId = "attacker-product";
        }],
        ["regional catalog seller mismatch", (receipt) => {
          receipt.samples[0]!.validatedFacts.catalogSellerId = "attacker-seller";
        }],
        ["placeholder response-body digest", (receipt) => {
          receipt.samples[0]!.response.bodySha256 = "0".repeat(64);
        }],
        ["sample-set digest mismatch", (receipt) => {
          receipt.sampleSetSha256 = "f".repeat(64);
        }],
        ["strategy identity cross-binding", (receipt) => {
          receipt.strategySha256 = strategyEvidenceSha256(config.discovery);
        }],
        ["validation timestamp disagrees with activation", (receipt) => {
          receipt.validatedAt = "2026-07-11T05:08:25.000Z";
        }],
        ["internally valid aggregate disagrees with DB activation", (receipt) => {
          const sample = receipt.samples[27]!;
          sample.outcome = {
            status: "invalid",
            failure: {
              category: "invalid-price",
              message: "No positive price",
              responded: true,
              statusCode: 200,
            },
          };
          sample.outcomeSha256 = evidenceValueSha256(sample.outcome);
          receipt.valid = 27;
          receipt.score = 0.9;
          receipt.sampleSetSha256 = validationSampleSetSha256(receipt.samples);
        }],
      ];
      for (const [name, mutate] of attacks) {
        const attacked = structuredClone(extractionReceipt);
        mutate(attacked);
        await writeFile(extractionPath, serialize(attacked));
        const result = evaluateActiveStrategyValidationReceipts(root, database, now);
        expect([name, result.criterion.status]).toEqual([name, "fail"]);
        expect(result.criterion.reasonCodes).toContain("EVIDENCE_CONTRADICTION");
        await writeFile(extractionPath, serialize(extractionReceipt));
      }

      expect(evaluateActiveStrategyValidationReceipts(root, database, now).criterion.status)
        .toBe("pass");

      database.exec(`
        DROP TRIGGER strategies_active_validation_binding_no_update;
        DROP TRIGGER strategies_lifecycle_is_monotonic;
      `);
      database.prepare(`
        UPDATE strategies
        SET active = 0,
          activated_at = '2026-07-11T15:10:00.000Z',
          retired_at = '2026-07-11T15:30:00.000Z'
        WHERE retailer_id = 'carrefour' AND purpose = 'extraction'
      `).run();
      expect(evaluateActiveStrategyValidationReceipts(root, database, now).criterion.status)
        .toBe("pass");

      database.prepare(`
        UPDATE strategies SET activated_at = '2026-07-11T09:00:00.000Z'
        WHERE retailer_id = 'carrefour' AND purpose = 'discovery'
      `).run();
      const activeChronologyAttack = evaluateActiveStrategyValidationReceipts(root, database, now);
      expect(activeChronologyAttack.criterion.status).toBe("fail");
      expect(activeChronologyAttack.criterion.reasonCodes).toContain("EVIDENCE_CONTRADICTION");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails malformed activated M4 evidence even when the credential is absent", () => {
    const database = fixture();
    seedM4Evidence(database, "published rate card");
    database.exec("DROP TRIGGER cost_ledger_no_update");
    database.prepare("UPDATE cost_ledger SET retailer_id = NULL WHERE id = 'ledger-extraction'").run();
    const result = evaluateM4(database, {
      credentialConfigured: false,
      spendAuthorized: false,
      siteValidated: false,
    }, new Date("2026-07-10T12:00:00.000Z"));
    expect(result.criterion.status).toBe("fail");
    expect(result.criterion.reasonCodes).toContain("EVIDENCE_CONTRADICTION");
  });

  it("requires exact 30-reference and 27-success M4 activation evidence", () => {
    const shortSample = fixture();
    seedM4Evidence(shortSample, "published rate card");
    shortSample.exec("DROP TRIGGER exploration_attempts_no_update");
    shortSample.prepare("UPDATE exploration_attempts SET external_sample_size = 29 WHERE id = 'attempt-extraction'").run();
    expect(evaluateM4(shortSample, {
      credentialConfigured: true,
      spendAuthorized: true,
      siteValidated: true,
    }, new Date("2026-07-10T12:00:00.000Z")).criterion.status).toBe("fail");

    const tooFewSuccesses = fixture();
    seedM4Evidence(tooFewSuccesses, "published rate card");
    tooFewSuccesses.exec("DROP TRIGGER exploration_attempts_no_update");
    tooFewSuccesses.prepare("UPDATE exploration_attempts SET external_successes = 26, external_score = 0.8666666666666667 WHERE id = 'attempt-extraction'").run();
    expect(evaluateM4(tooFewSuccesses, {
      credentialConfigured: true,
      spendAuthorized: true,
      siteValidated: true,
    }, new Date("2026-07-10T12:00:00.000Z")).criterion.status).toBe("fail");
  });

  it("validates tracked review state and fails open critical findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-review-state-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Review Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "review@example.test"], { cwd: root });
      await mkdir(join(root, "ops"), { recursive: true });
      const path = join(root, "ops", "review-findings.json");
      await writeFile(path, JSON.stringify({
        schemaVersion: 1,
        findings: [
          { id: "open", milestone: "M5", severity: "critical", status: "open", fixCommit: null },
          { id: "earlier", milestone: "M3", severity: "important", status: "open", fixCommit: null },
        ],
      }));
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "review state"], { cwd: root });
      const state = reviewFindingState(root, "M5", new Date("2026-07-10T12:00:00.000Z"));
      expect(state).toMatchObject({ valid: true, openCriticalOrImportant: 1 });
      const publication = reviewFindingState(root, "M7", new Date("2026-07-10T12:00:00.000Z"));
      expect(publication).toMatchObject({ valid: true, openCriticalOrImportant: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds schedule activation to the private installed-unit receipt and hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-systemd-state-"));
    const installed = join(root, "installed");
    try {
      await mkdir(join(root, "var", "operations"), { recursive: true });
      await mkdir(installed, { recursive: true });
      const names = [
        "precos-backup.service", "precos-backup.timer", "precos-classification.service",
        "precos-daily.service", "precos-daily.timer", "precos-healing.service",
        "precos-healing.timer", "precos-heartbeat.service", "precos-heartbeat.timer",
        "precos-weekly-discovery.service", "precos-weekly-discovery.timer",
        "precos-weekly-index.service", "precos-weekly-index.timer",
      ];
      const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
      const units = [];
      for (const name of names) {
        const content = `unit:${name}\n`;
        await writeFile(join(installed, name), content);
        units.push({ name, sha256: sha256(content) });
      }
      const unitSetSha256 = sha256(units.map((unit) => `${unit.name}\0${unit.sha256}\n`).join(""));
      const receiptPath = join(root, "var", "operations", "systemd-install.json");
      const releaseId = "a".repeat(32);
      const sourceCommit = "b".repeat(40);
      const deployedAt = "2026-07-10T10:30:00.000Z";
      const releasePath = join(root, "release");
      await mkdir(releasePath);
      const releaseManifest = "fixture release manifest\n";
      await writeFile(join(releasePath, "release-manifest.json"), releaseManifest);
      await writeFile(receiptPath, JSON.stringify({
        schemaVersion: 2,
        scheduleActivatedAt: "2026-07-10T10:00:00.000Z",
        deployedAt,
        sourceCommit,
        releaseId,
        releasePath,
        releaseManifestSha256: sha256(releaseManifest),
        unitSetSha256,
        units,
      }), { mode: 0o600 });
      await chmod(receiptPath, 0o600);
      const validateRelease = () => ({
        schemaVersion: 1 as const,
        releaseId,
        sourceCommit,
        deployedAt,
        releasePath,
        sourceRoot: root,
        stateRoot: root,
        artifactSetSha256: "c".repeat(64),
        artifacts: [],
        links: [],
        signature: {
          algorithm: "ed25519" as const,
          keyId: "d".repeat(64),
          payloadSha256: "e".repeat(64),
          value: `${"A".repeat(86)}==`,
        },
      });
      expect(readSystemdInstallationState(root, new Date("2026-07-10T12:00:00.000Z"), installed, validateRelease))
        .toMatchObject({ valid: true, unitSetSha256, releaseId, sourceCommit });
      await writeFile(join(installed, names[0]!), "tampered\n");
      expect(readSystemdInstallationState(root, new Date("2026-07-10T12:00:00.000Z"), installed, validateRelease).valid)
        .toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the default report command read-only and never regenerates analysis", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acceptance-read-only-"));
    const databasePath = join(directory, "precos.sqlite");
    const database = openDatabase(databasePath);
    database.close();
    const before = await readFile(resolve("analysis/output/latest.json"));
    const commandIds: string[] = [];
    try {
      await buildAcceptanceReport({
        projectRoot: resolve("."),
        databasePath,
        now: () => new Date("2026-07-11T03:00:00.000Z"),
        runCommand: async (id) => {
          commandIds.push(id);
          return {
            id,
            exitCode: 0,
            startedAt: "2026-07-11T03:00:00.000Z",
            finishedAt: "2026-07-11T03:00:01.000Z",
            outputSha256: "a".repeat(64),
            facts: { completed: true },
          };
        },
        serviceReader: {
          async read(units) {
            return units.map((unit) => ({
              unit,
              enabled: false,
              active: false,
              result: null,
              invocationId: null,
              lastStartedAt: null,
              lastFinishedAt: null,
            }));
          },
        },
      });
      expect(commandIds).toEqual(["m1-offline", "m5-healing", "m6-index-analysis"]);
      expect(await readFile(resolve("analysis/output/latest.json"))).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("checks corresponding service templates and rejects loose snapshot schemas", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-units-"));
    try {
      await mkdir(join(root, "ops"), { recursive: true });
      await writeFile(join(root, "ops", "precos-daily.timer"), "[Timer]\nOnCalendar=*-*-* 03:00:00 America/Sao_Paulo\nRandomizedDelaySec=15m\nPersistent=true\nUnit=precos-daily.service\n");
      expect(validateTimerDefinitions(root, join(root, "installed")).valid).toBe(false);
      expect(() => validateAcceptanceReportShape({ overallStatus: "pass" })).toThrow(/snapshot/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale rendered daily service without either classification outcome link", async () => {
    const installed = await mkdtemp(join(tmpdir(), "acceptance-rendered-units-"));
    try {
      const root = resolve(".");
      execFileSync("bash", ["ops/install-systemd.sh", "--dry-run"], {
        cwd: root,
        env: { ...process.env, SYSTEMD_UNIT_DIR: installed },
        stdio: "ignore",
      });
      expect(validateTimerDefinitions(root, installed).valid).toBe(true);
      const dailyPath = join(installed, "precos-daily.service");
      const daily = await readFile(dailyPath, "utf8");
      await writeFile(dailyPath, daily.replace("OnSuccess=precos-classification.service\n", ""));
      expect(validateTimerDefinitions(root, installed).valid).toBe(false);
      await writeFile(dailyPath, daily.replace("OnFailure=precos-classification.service\n", ""));
      expect(validateTimerDefinitions(root, installed).valid).toBe(false);

      await writeFile(dailyPath, daily);
      const copiedRoot = join(installed, "source");
      await mkdir(join(copiedRoot, "ops"), { recursive: true });
      for (const timer of [
        "precos-backup.timer",
        "precos-daily.timer",
        "precos-healing.timer",
        "precos-heartbeat.timer",
        "precos-weekly-discovery.timer",
        "precos-weekly-index.timer",
      ]) {
        const service = timer.replace(/\.timer$/u, ".service");
        await writeFile(
          join(copiedRoot, "ops", timer),
          await readFile(join(root, "ops", timer)),
        );
        await writeFile(
          join(copiedRoot, "ops", service),
          await readFile(join(root, "ops", service)),
        );
      }
      await writeFile(
        join(copiedRoot, "ops", "precos-classification.service"),
        await readFile(join(root, "ops", "precos-classification.service")),
      );
      expect(validateTimerDefinitions(copiedRoot, installed).valid).toBe(true);
      const copiedDailyPath = join(copiedRoot, "ops", "precos-daily.service");
      const copiedDaily = await readFile(copiedDailyPath, "utf8");
      await writeFile(copiedDailyPath, `${copiedDaily}Environment=OPENAI_BASE_URL=https://gateway.invalid/v1\n`);
      expect(validateTimerDefinitions(copiedRoot, installed).valid).toBe(false);
      await writeFile(copiedDailyPath, `${copiedDaily}Environment=CODEX_BASE_URL=https://gateway.invalid/v1\n`);
      expect(validateTimerDefinitions(copiedRoot, installed).valid).toBe(false);
    } finally {
      await rm(installed, { recursive: true, force: true });
    }
  });

  it("keeps classification automation in progress while the daily service is active", () => {
    const currentDailyStart = new Date("2026-07-11T06:00:00.000Z");
    const base = {
      dailyResult: "success",
      dailyStartedAt: "2026-07-11T06:02:00.000Z",
      classificationActive: false,
      classificationResult: null,
      classificationStartedAt: null,
      currentDailyStart,
    } as const;
    expect(classificationAutomationIsCurrent({ ...base, dailyActive: true })).toMatchObject({
      current: true,
      dailyRunObserved: true,
    });
    expect(classificationAutomationIsCurrent({ ...base, dailyActive: false }).current).toBe(false);
  });

  it("requires post-collection classification after a partial daily service result", () => {
    const currentDailyStart = new Date("2026-07-11T06:00:00.000Z");
    const base = {
      dailyActive: false,
      dailyResult: "exit-code",
      dailyStartedAt: "2026-07-11T06:02:00.000Z",
      classificationActive: false,
      classificationResult: "success",
      currentDailyStart,
    } as const;
    expect(classificationAutomationIsCurrent({
      ...base,
      classificationStartedAt: "2026-07-11T06:03:00.000Z",
    })).toEqual({ current: true, dailyRunObserved: true });
    expect(classificationAutomationIsCurrent({
      ...base,
      classificationStartedAt: "2026-07-10T06:03:00.000Z",
    })).toEqual({ current: false, dailyRunObserved: true });
  });

  it("fails contradictory heartbeat JSON before executing json_each", () => {
    const database = fixture();
    database.pragma("ignore_check_constraints = ON");
    database.prepare(`
      INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
      VALUES ('broken', 'collect', '2026-07-10T06:00:00.000Z',
        '2026-07-10T06:10:00.000Z', 'completed', 'not-json')
    `).run();
    const result = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(result.criterion.status).toBe("fail");
    expect(result.criterion.reasonCodes).toEqual(["EVIDENCE_CONTRADICTION"]);
  });

  it("renders Markdown from the same report without leaking command output", () => {
    const report = {
      schemaVersion: 1,
      generatedAt: "2026-07-10T12:00:00.000Z",
      timezone: "America/Sao_Paulo",
      evaluatedCommit: "a".repeat(40),
      databaseSha256: "b".repeat(64),
      overallStatus: "pending",
      milestones: Object.fromEntries(["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"].map((id) => [id, {
        status: id === "M2" ? "pending" : "pass",
        criteria: [{ id: `${id.toLowerCase()}-criterion`, status: id === "M2" ? "pending" : "pass", summary: "Evidence summary", reasonCodes: id === "M2" ? ["TIME_WINDOW_NOT_ELAPSED"] : [], evidenceIds: [`evidence-${id}`] }],
      }])),
      publication: { status: "pass", findings: [] },
      pendingGates: [],
      evidence: [],
    } as unknown as AcceptanceReport;
    const markdown = renderAcceptanceMarkdown(report);
    expect(markdown).toContain("Overall status: **PENDING**");
    expect(markdown).toContain("TIME_WINDOW_NOT_ELAPSED");
    expect(markdown).not.toContain("stdout");
  });
});
