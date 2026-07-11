import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openDatabase } from "../../src/db/database.js";
import {
  acceptanceExitCode,
  aggregateAcceptanceStatus,
  classificationAutomationIsCurrent,
  evaluateM2,
  evaluateM3,
  evaluateM4,
  renderAcceptanceMarkdown,
  validateAcceptanceReportShape,
  validateTimerDefinitions,
  type AcceptanceReport,
} from "../../src/ops/acceptance.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(): Database.Database {
  const database = openDatabase(":memory:");
  databases.push(database);
  return database;
}

function seedRetailer(database: Database.Database, id: string, products = 30): void {
  database.prepare(`
    INSERT INTO retailers(id, name, base_url, cep, domains_json)
    VALUES (?, ?, ?, '01001000', ?)
  `).run(id, id, `https://${id}.example.test`, JSON.stringify([`${id}.example.test`]));
  database.prepare(`
    INSERT INTO strategies(
      id, retailer_id, purpose, tier, version, strategy_json, provenance,
      validation_sample_size, validation_successes, validation_rate, active
    ) VALUES (?, ?, 'extraction', 1, 1, '{}', 'fixture', 30, 27, 0.9, 1)
  `).run(`strategy-${id}`, id);
  const insert = database.prepare(`
    INSERT INTO products(
      id, retailer_id, canonical_url, title, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, '2026-07-01', '2026-07-10')
  `);
  for (let index = 0; index < products; index += 1) {
    insert.run(`${id}-product-${index}`, id, `https://${id}.example.test/${index}`, `Product ${index}`);
  }
}

function seedCollection(
  database: Database.Database,
  retailerId: string,
  day: string,
  ok = 27,
  attempted = 30,
  scheduledTime = "06:00:00.000Z",
): void {
  const runId = `run-${retailerId}-${day}`;
  database.prepare(`
    INSERT INTO runs(
      id, retailer_id, stage, collection_day, strategy_id, strategy_version,
      status, attempted, ok, failed, started_at, finished_at
    ) VALUES (?, ?, 'collect', ?, ?, 1, 'completed', ?, ?, ?, ?, ?)
  `).run(
    runId,
    retailerId,
    day,
    `strategy-${retailerId}`,
    attempted,
    ok,
    attempted - ok,
    `${day}T${scheduledTime}`,
    `${day}T06:10:00.000Z`,
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
      `${day}T06:05:00.000Z`,
      day,
    );
  }
  database.prepare(`
    INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
    VALUES (?, 'collect', ?, ?, 'completed', ?)
  `).run(
    `heartbeat-${runId}`,
    `${day}T${scheduledTime}`,
    `${day}T06:10:00.000Z`,
    JSON.stringify({ runIds: [runId] }),
  );
}

function seedM4Evidence(database: Database.Database, estimateSource: string): void {
  database.prepare(`
    INSERT INTO retailers(id, name, base_url, cep, domains_json)
    VALUES ('agent-retailer', 'Agent retailer', 'https://agent.example.test', '01001000', '["agent.example.test"]')
  `).run();
  for (const purpose of ["discovery", "extraction"]) {
    const strategyId = `agent-${purpose}`;
    const explorationId = `exploration-${purpose}`;
    database.prepare(`
      INSERT INTO strategies(
        id, retailer_id, purpose, tier, version, strategy_json, provenance,
        model, prompt_version, validation_sample_size, validation_successes,
        validation_rate, active, validated_at, activated_at
      ) VALUES (?, 'agent-retailer', ?, 1, 1, '{}',
        'Codex SDK; trusted host validation', 'gpt-test', 'prompt-v1',
        30, 27, 0.9, 1, '2026-07-10T10:00:00.000Z', '2026-07-10T10:00:00.000Z')
    `).run(strategyId, purpose);
    database.prepare(`
      INSERT INTO exploration_runs(
        id, retailer_id, purpose, trigger, candidate_strategy_id, status,
        outcome, event_budget, events_used, input_tokens, output_tokens,
        cost_usd, started_at, finished_at
      ) VALUES (?, 'agent-retailer', ?, 'fixture', ?, 'completed', 'activated',
        1, 1, 100, 20, 0.1, '2026-07-10T09:00:00.000Z', '2026-07-10T10:00:00.000Z')
    `).run(explorationId, purpose, strategyId);
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
        '{"attemptNumber":1,"costEstimated":true}')
    `).run(`ledger-${purpose}`, explorationId);
  }
}

describe("acceptance status and evidence", () => {
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
    expect(evaluateM2(missing, new Date("2026-07-10T12:00:00.000Z")).criterion.status).toBe("fail");
  });

  it("does not let full manual daytime runs qualify as scheduled M2 evidence", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta"]) {
      seedRetailer(database, retailer);
      seedCollection(database, retailer, "2026-07-09", 30, 30, "15:00:00.000Z");
      seedCollection(database, retailer, "2026-07-10", 30, 30, "15:00:00.000Z");
    }
    expect(evaluateM2(database, new Date("2026-07-10T18:00:00.000Z")).criterion.status).not.toBe("pass");
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

  it("uses only the latest classification and retains low-confidence products in M3", () => {
    const database = fixture();
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) {
      seedRetailer(database, retailer, 5);
      seedCollection(database, retailer, "2026-07-10", 5, 5);
    }
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
    });
    expect(result.criterion.status).toBe("pass");
    expect(result.evidence[0]?.facts.activeProducts).toBe(20);
    expect(result.evidence[0]?.facts.highConfidenceProducts).toBe(16);
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

  it("does not approve a three-retailer exception from authority alone", () => {
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
    expect(result.criterion.status).toBe("pending");
    expect(result.criterion.reasonCodes).toContain("AUTHORITY_APPROVAL_REQUIRED");
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
    expect(evaluateM3(database, {
      credentialConfigured: true,
      siteValidated: true,
      authorityApproved: true,
    }).criterion.status).toBe("fail");
  });

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

  it("rejects a stale rendered daily service without the classification OnSuccess link", async () => {
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
