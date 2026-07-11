import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { listPriorSuccessfulReplayEvidence } from "../../src/db/repositories.js";
import { healRetailer } from "../../src/healing/heal.js";
import {
  extractionStrategy,
  seedRetailer,
  seedStrategy,
} from "../pipeline/helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("healer replay consumption", () => {
  it("bounds 2,000 onset failures before handing representative context to exploration", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    database.prepare(`
      INSERT INTO runs
        (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
         status, attempted, ok, failed, started_at)
      VALUES ('large-drift', 'retailer-1', 'collect', '2026-07-10',
              'retailer-1-extraction-v1', 1, 'running', 0, 0, 0,
              '2026-07-10T00:00:00.000Z')
    `).run();
    const insert = database.prepare(`
      INSERT INTO run_failures
        (id, run_id, retailer_id, canonical_url, category, responded, message,
         strategy_id, strategy_version, occurred_at)
      VALUES (?, 'large-drift', 'retailer-1', ?, ?, 1, ?,
              'retailer-1-extraction-v1', 1, '2026-07-10T00:00:30.000Z')
    `);
    database.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) {
        insert.run(
          `large-failure-${index}`,
          `https://shop.test/produto/${index % 100}`,
          index % 2 === 0 ? "missing-fields" : "parse",
          `representative ${index % 100}`,
        );
      }
    }).immediate();
    database.prepare(`
      UPDATE runs SET status = 'failed', attempted = 2000, failed = 2000,
                      finished_at = '2026-07-10T00:01:00.000Z'
      WHERE id = 'large-drift'
    `).run();
    let included = 0;
    let total = 0;

    await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "large-drift",
      now: () => new Date("2026-07-10T00:05:00.000Z"),
      explore: async (_retailerId, _purpose, dependencies) => {
        included = dependencies.failureSamples?.length ?? 0;
        total = dependencies.failureSampleTotal ?? 0;
        return {
          explorationRunId: "large-exploration",
          activated: false,
          attempts: 0,
          externalScore: null,
          outcome: "provider_unavailable",
          costUsd: 0,
        };
      },
    });

    expect(included).toBe(60);
    expect(total).toBe(2_000);
  });

  it("selects only the latest prior replay per failing URL before applying the bound", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    database.prepare(`
      INSERT INTO runs
        (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
         status, attempted, ok, failed, started_at)
      VALUES ('archive-skew', 'retailer-1', 'collect', '2026-07-01',
              'retailer-1-extraction-v1', 1, 'running', 0, 0, 0,
              '2026-07-01T00:00:00.000Z')
    `).run();
    const insertProduct = database.prepare(`
      INSERT INTO products
        (id, retailer_id, canonical_url, title, first_seen, last_seen)
      VALUES (?, 'retailer-1', ?, ?, '2026-07-01T00:00:00.000Z',
              '2026-07-01T00:00:00.000Z')
    `);
    const insertObservation = database.prepare(`
      INSERT INTO observations
        (id, product_id, run_id, strategy_id, strategy_version, observed_at,
         collection_day, title, price_cents, response_path, response_sha256)
      VALUES (?, ?, 'archive-skew', 'retailer-1-extraction-v1', 1, ?,
              '2026-07-01', ?, 1000, ?, ?)
    `);
    const urls = Array.from({ length: 6 }, (_, index) =>
      `https://shop.test/produto/${index}`);
    urls.forEach((url, index) => {
      insertProduct.run(`skew-product-${index}`, url, `Produto descritivo ${index}`);
      const versions = index === 0 ? 7 : 1;
      for (let version = 0; version < versions; version += 1) {
        const digit = ((index + version + 1) % 15 + 1).toString(16);
        const hash = digit.repeat(64);
        insertObservation.run(
          `skew-observation-${index}-${version}`,
          `skew-product-${index}`,
          index === 0
            ? `2026-07-01T23:00:0${version}.000Z`
            : `2026-07-01T12:00:0${index}.000Z`,
          `Produto descritivo ${index}`,
          `2026-07-01/retailer-1/${hash}.json.gz`,
          hash,
        );
      }
    });

    const evidence = listPriorSuccessfulReplayEvidence(database, {
      retailerId: "retailer-1",
      beforeCollectionDay: "2026-07-10",
      canonicalUrls: urls,
      limit: 5,
    });

    expect(evidence).toHaveLength(5);
    expect(new Set(evidence.map(({ canonicalUrl }) => canonicalUrl)).size).toBe(5);
    expect(evidence[0]?.canonicalUrl).toBe(urls[0]);
    expect(evidence[0]?.replay.path).toContain("8".repeat(64));
  });

  it("passes only verifier-approved private bodies to exploration and audits rejections", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    database.prepare(`
      INSERT INTO runs
        (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
         status, attempted, ok, failed, started_at, finished_at)
      VALUES
        ('drift-replay', 'retailer-1', 'collect', '2026-07-10',
         'retailer-1-extraction-v1', 1, 'running', 0, 0, 0,
         '2026-07-10T00:00:00.000Z', NULL)
    `).run();
    const insertFailure = database.prepare(`
      INSERT INTO run_failures
        (id, run_id, retailer_id, canonical_url, category, responded, message,
         strategy_id, strategy_version, response_path, response_sha256, occurred_at)
      VALUES (?, 'drift-replay', 'retailer-1', ?, 'missing-fields', 1, 'fixture drift',
              'retailer-1-extraction-v1', 1, ?, ?, '2026-07-10T00:00:30.000Z')
    `);
    const goodHash = "a".repeat(64);
    const badHash = "b".repeat(64);
    insertFailure.run(
      "failure-good",
      "https://shop.test/produto/good",
      `2026-07-10/retailer-1/${goodHash}.json.gz`,
      goodHash,
    );
    insertFailure.run(
      "failure-bad",
      "https://shop.test/produto/bad",
      `2026-07-10/retailer-1/${badHash}.json.gz`,
      badHash,
    );
    database.prepare(`
      UPDATE runs SET status = 'failed', attempted = 2, failed = 2,
                      finished_at = '2026-07-10T00:01:00.000Z'
      WHERE id = 'drift-replay'
    `).run();
    database.prepare(`
      INSERT INTO products
        (id, retailer_id, canonical_url, title, first_seen, last_seen)
      VALUES ('archive-product', 'retailer-1', 'https://shop.test/produto/good',
              'Arroz tipo 1 pacote 5 kg', '2026-07-01T00:00:00.000Z',
              '2026-07-01T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO runs
        (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
         status, attempted, ok, failed, started_at, finished_at)
      VALUES ('archive-run', 'retailer-1', 'collect', '2026-07-01',
              'retailer-1-extraction-v1', 1, 'running', 0, 0, 0,
              '2026-07-01T00:00:00.000Z', NULL)
    `).run();
    const insertArchive = database.prepare(`
      INSERT INTO observations
        (id, product_id, run_id, strategy_id, strategy_version, observed_at,
         collection_day, title, price_cents, response_path, response_sha256)
      VALUES (?, 'archive-product', 'archive-run', 'retailer-1-extraction-v1', 1,
              ?, '2026-07-01', 'Arroz tipo 1 pacote 5 kg', 1299, ?, ?)
    `);
    for (let index = 0; index < 7; index += 1) {
      const hash = (index + 2).toString(16).repeat(64);
      insertArchive.run(
        `archive-${index}`,
        `2026-07-01T00:00:0${index}.000Z`,
        `2026-07-01/retailer-1/${hash}.json.gz`,
        hash,
      );
    }

    let sandboxSamples: unknown;
    const outcome = await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "drift-replay",
      now: () => new Date("2026-07-10T00:05:00.000Z"),
      readReplay: async (_root, reference) => {
        if (reference.sha256 === badHash) throw new Error("hash verification failed");
        return {
          body: reference.sha256 === goodHash
            ? "verified-private-body"
            : `archive-${reference.sha256[0]}`,
          mediaType: "application/json",
          path: reference.path,
          sha256: reference.sha256,
        };
      },
      explore: async (_retailerId, _purpose, dependencies) => {
        sandboxSamples = dependencies.sandboxSamples;
        return {
          explorationRunId: "exploration-fixture",
          activated: false,
          attempts: 0,
          externalScore: null,
          outcome: "provider_unavailable",
          costUsd: 0,
        };
      },
    });

    expect(outcome.status).toBe("provider_unavailable");
    expect((sandboxSamples as unknown[])[0]).toEqual({
      canonicalUrl: "https://shop.test/produto/good",
      body: "verified-private-body",
      capture: "current",
      collectionDay: "2026-07-10",
    });
    expect((sandboxSamples as Array<{ capture?: string }>).filter(
      ({ capture }) => capture === "archive",
    )).toHaveLength(1);
    const details = database.prepare(
      "SELECT details_json AS details FROM healing_events",
    ).get() as { details: string };
    expect(JSON.parse(details.details)).toMatchObject({
      replaySamplesUsed: 2,
      replaySamplesRejected: 1,
      archiveReplaySamplesUsed: 1,
      archiveReplaySamplesRejected: 0,
    });
  });
});
