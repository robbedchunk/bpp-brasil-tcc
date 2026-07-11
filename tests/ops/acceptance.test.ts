import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import {
  acceptanceExitCode,
  aggregateAcceptanceStatus,
  evaluateM2,
  evaluateM3,
  evaluateM4,
  renderAcceptanceMarkdown,
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
    `${day}T06:00:00.000Z`,
    `${day}T06:10:00.000Z`,
  );
  const products = database.prepare(
    "SELECT id FROM products WHERE retailer_id = ? ORDER BY id LIMIT ?",
  ).all(retailerId, attempted) as Array<{ id: string }>;
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
    `${day}T06:00:00.000Z`,
    `${day}T06:10:00.000Z`,
    JSON.stringify({ runIds: [runId] }),
  );
}

describe("acceptance status and evidence", () => {
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
    const oneDay = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(oneDay.criterion.status).toBe("pending");
    expect(oneDay.criterion.reasonCodes).toContain("TIME_WINDOW_NOT_ELAPSED");

    for (const retailer of ["alpha", "beta"]) {
      seedCollection(database, retailer, "2026-07-10");
    }
    const consecutive = evaluateM2(database, new Date("2026-07-10T12:00:00.000Z"));
    expect(consecutive.criterion.status).toBe("pass");
    expect(consecutive.criterion.evidenceIds.length).toBeGreaterThan(0);
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
    for (const retailer of ["alpha", "beta", "gamma", "delta"]) seedRetailer(database, retailer, 5);
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
