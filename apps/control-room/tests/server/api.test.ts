// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../src/db/database.js";
import type { ControlRoomConfig } from "../../src/server/config.js";
import { buildServer } from "../../src/server/index.js";

const directories: string[] = [];
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  directories.push(root);
  return root;
}

function config(root: string, actionsEnabled = false): ControlRoomConfig {
  return {
    packageRoot: join(root, "apps/control-room"),
    projectRoot: root,
    databasePath: join(root, "data/precos.sqlite"),
    host: "127.0.0.1",
    port: 4318,
    actionsEnabled,
    development: true,
    staticRoot: join(root, "apps/control-room/dist/web"),
    openaiConfigured: false,
    notificationConfigured: false,
    modelBudgetLimitUsd: 50,
  };
}

async function serverFor(root: string): Promise<FastifyInstance> {
  const server = await buildServer(config(root));
  servers.push(server);
  return server;
}

function seedOperationalFixture(root: string): void {
  const database = openDatabase(join(root, "data/precos.sqlite"));
  database.prepare(`
    INSERT INTO retailers
      (id, name, base_url, cep, platform_hint, domains_json, active, degraded)
    VALUES
      ('nebula-market', 'Mercado Nebulosa', 'https://nebula.example',
       '04567-000', 'fixture-platform', '["nebula.example"]', 1, 0)
  `).run();
  database.prepare(`
    INSERT INTO strategies
      (id, retailer_id, purpose, tier, version, strategy_json, provenance)
    VALUES
      ('strategy-nebula', 'nebula-market', 'extraction', 1, 1, '{}', 'fixture')
  `).run();
  const insertProduct = database.prepare(`
    INSERT INTO products
      (id, retailer_id, canonical_url, title, in_scope, active,
       first_seen, last_seen, last_observed_at, descriptive_title)
    VALUES (?, 'nebula-market', ?, ?, 1, 1, '2026-03-01', '2026-03-02',
            '2026-03-02T10:00:00.000Z', 1)
  `);
  for (let index = 1; index <= 10; index += 1) {
    insertProduct.run(
      `product-${index}`,
      `https://nebula.example/private/product-${index}`,
      `Produto ${index}`,
    );
  }
  database.prepare(`
    INSERT INTO runs
      (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
       status, attempted, ok, failed, started_at, metadata_json)
    VALUES
      ('run-nebula', 'nebula-market', 'collect', '2026-03-02',
       'strategy-nebula', 1, 'running', 0, 0, 0,
       '2026-03-02T10:00:00.000Z',
       '{"planned":10,"skipped":0,"stoppedForBlocking":false}')
  `).run();
  const insertObservation = database.prepare(`
    INSERT INTO observations
      (id, product_id, run_id, strategy_id, strategy_version, observed_at,
       collection_day, title, price_cents, available)
    VALUES (?, ?, 'run-nebula', 'strategy-nebula', 1,
            '2026-03-02T10:03:00.000Z', '2026-03-02', ?, 1000, 1)
  `);
  for (let index = 1; index <= 9; index += 1) {
    insertObservation.run(`observation-${index}`, `product-${index}`, `Produto ${index}`);
  }
  database.prepare(`
    INSERT INTO run_failures
      (id, run_id, retailer_id, product_id, canonical_url, category, message,
       attempt, strategy_id, strategy_version, occurred_at, responded)
    VALUES
      ('failure-nebula', 'run-nebula', 'nebula-market', 'product-10',
       'https://nebula.example/private/product-10', 'invalid-price',
       'secret failure at /home/private/replay', 1,
       'strategy-nebula', 1, '2026-03-02T10:04:00.000Z', 1)
  `).run();
  database.prepare(`
    UPDATE runs
    SET status = 'completed', attempted = 10, ok = 9, failed = 1,
        finished_at = '2026-03-02T10:05:00.000Z'
    WHERE id = 'run-nebula'
  `).run();
  database.prepare(`
    INSERT INTO heartbeats
      (id, pipeline, scheduled_for, completed_at, status, details_json)
    VALUES
      ('heartbeat-nebula', 'collect', '2026-03-02T09:59:00.000Z',
       '2026-03-02T10:06:00.000Z', 'completed',
       '{"trigger":"systemd-timer","releaseId":"fixture-release","retailerIds":["nebula-market"],"retailerFailures":[]}')
  `).run();
  database.close();
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Control Room read API", () => {
  it("reports a missing database without creating it", async () => {
    const root = await fixtureRoot("control-room-missing-");
    const server = await serverFor(root);

    const response = await server.inject({ method: "GET", url: "/api/v1/meta" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      application: { observerMode: true, actionsEnabled: false },
      database: { state: "missing", dataVersion: null },
    });
    await expect(stat(join(root, "data/precos.sqlite")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enumerates arbitrary fork data and never returns private fields", async () => {
    const root = await fixtureRoot("control-room-dynamic-");
    seedOperationalFixture(root);
    const databasePath = join(root, "data/precos.sqlite");
    const before = digest(await readFile(databasePath));
    const server = await serverFor(root);

    const overview = await server.inject({ method: "GET", url: "/api/v1/overview" });
    const run = await server.inject({ method: "GET", url: "/api/v1/runs/run-nebula" });

    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      totals: {
        retailers: 1,
        activeRetailers: 1,
        products: 10,
        runs: 1,
      },
      scheduledHeartbeat: {
        releaseId: "fixture-release",
        retailerCount: 1,
        failedRetailerCount: 0,
      },
      retailers: [{ id: "nebula-market", name: "Mercado Nebulosa" }],
      recentRuns: [{
        id: "run-nebula",
        health: "healthy",
        constraint: "none",
        dominantFailureCategory: "invalid-price",
      }],
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      run: { id: "run-nebula", retailerName: "Mercado Nebulosa" },
      failureCategories: [{ category: "invalid-price", responded: true, count: 1 }],
    });
    for (const body of [overview.body, run.body]) {
      expect(body).not.toContain("nebula.example");
      expect(body).not.toContain("secret failure");
      expect(body).not.toContain("/home/private");
      expect(body).not.toContain("response_path");
      expect(body).not.toContain("canonical_url");
    }
    expect(digest(await readFile(databasePath))).toBe(before);
  });

  it("fails operational resources closed for an older schema", async () => {
    const root = await fixtureRoot("control-room-old-schema-");
    const database = openDatabase(join(root, "data/precos.sqlite"));
    database.prepare("DELETE FROM schema_migrations WHERE version = 20").run();
    database.close();
    const server = await serverFor(root);

    const meta = await server.inject({ method: "GET", url: "/api/v1/meta" });
    const overview = await server.inject({ method: "GET", url: "/api/v1/overview" });

    expect(meta.json()).toMatchObject({ database: { state: "older" } });
    expect(overview.statusCode).toBe(503);
    expect(overview.json()).toMatchObject({ error: { code: "schema_unavailable" } });
  });

  it("verifies artifact pointers at runtime without serving generated files", async () => {
    const root = await fixtureRoot("control-room-artifacts-");
    const exportRoot = join(root, "data/exports");
    const snapshotId = "fixture-snapshot";
    const snapshotRoot = join(exportRoot, "snapshots", snapshotId);
    await mkdir(snapshotRoot, { recursive: true });
    const manifest = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      snapshotId,
      generatedAt: "2026-03-02T12:00:00.000Z",
      methodVersion: "fixture-method",
      status: "complete",
      files: [{ rows: 3 }, { rows: 5 }],
    }));
    await writeFile(join(snapshotRoot, "manifest.json"), manifest);
    await writeFile(join(exportRoot, "latest.json"), JSON.stringify({
      schemaVersion: 1,
      snapshotId,
      snapshotDirectory: `snapshots/${snapshotId}`,
      manifestSha256: digest(manifest),
    }));
    const server = await serverFor(root);

    const response = await server.inject({ method: "GET", url: "/api/v1/artifacts/latest" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      export: {
        available: true,
        verified: true,
        snapshotId,
        files: 2,
        rows: 8,
      },
      analysis: { available: false, verified: false },
    });
    expect(response.body).not.toContain("manifest.json");
  });

  it("rejects non-local Host headers", async () => {
    const root = await fixtureRoot("control-room-host-");
    const server = await serverFor(root);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/meta",
      headers: { host: "remote.example" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_host" } });
  });
});
