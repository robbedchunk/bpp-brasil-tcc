import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  reextractFromReplay,
  runReplayReextraction,
} from "../../src/collection/reextract.js";
import {
  readReplayPayload,
  writeReplayPayload,
} from "../../src/collection/replay.js";
import { attachPrivateReplay } from "../../src/collection/private-replay.js";
import { openDatabase } from "../../src/db/database.js";
import { createRun, insertObservation } from "../../src/db/repositories.js";
import { ApiExtractionStrategySchema } from "../../src/strategies/schema.js";
import {
  extractionStrategy,
  seedRetailer,
  seedStrategy,
} from "../pipeline/helpers.js";

const directories: string[] = [];
const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("private replay artifacts", () => {
  it.each(["api", "embedded-json", "dom", "script"])(
    "keeps %s raw response bytes non-enumerable while preserving private sampling",
    (tier) => {
      const raw = `raw-private-${tier}-bytes`;
      const result = attachPrivateReplay({
        ok: false,
        failure: { category: "parse", message: "fixture", responded: true },
        html: raw,
      }, { body: raw, mediaType: "text/html" });

      expect(result.replay?.body).toBe(raw);
      expect(result.html).toBe(raw);
      expect(Object.keys(result)).not.toContain("replay");
      expect(Object.keys(result)).not.toContain("html");
      expect(JSON.stringify(result)).not.toContain(raw);
    },
  );

  it("writes content-addressed relative artifacts with private modes and verifies reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-replay-artifact-"));
    directories.push(root);
    const body = JSON.stringify({ title: "Arroz", price: 10 });
    const artifact = await writeReplayPayload(
      { body, mediaType: "application/json" },
      root,
      "2026-07-10",
      "retailer-1",
    );

    expect(artifact).toMatchObject({
      path: `2026-07-10/retailer-1/${createHash("sha256").update(body).digest("hex")}.json.gz`,
      mediaType: "application/json",
      body,
    });
    expect(artifact.path.startsWith("/")).toBe(false);
    expect((await stat(join(root, "2026-07-10", "retailer-1"))).mode & 0o777)
      .toBe(0o700);
    expect((await stat(join(root, artifact.path))).mode & 0o777).toBe(0o600);
    await expect(readReplayPayload(root, artifact)).resolves.toEqual(artifact);
  });

  it("rejects tampered bytes and reference/path mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-replay-tamper-"));
    directories.push(root);
    const artifact = await writeReplayPayload(
      { body: "original", mediaType: "text/plain" },
      root,
      "2026-07-10",
      "retailer-1",
    );
    await writeFile(join(root, artifact.path), gzipSync("tampered"));

    await expect(readReplayPayload(root, artifact)).rejects.toThrow(/SHA-256/iu);
    await expect(readReplayPayload(root, {
      path: artifact.path.replace(artifact.sha256, "b".repeat(64)),
      sha256: artifact.sha256,
    })).rejects.toThrow(/content-addressed/iu);
    await expect(readReplayPayload(root, {
      path: `../${artifact.path}`,
      sha256: artifact.sha256,
    })).rejects.toThrow(/content-addressed|private path/iu);
  });

  it("repairs a truncated final-name artifact through atomic no-replace publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-replay-repair-"));
    directories.push(root);
    const body = JSON.stringify({ title: "Arroz tipo 1", price: 10 });
    const sha256 = createHash("sha256").update(body).digest("hex");
    const directory = join(root, "2026-07-10", "retailer-1");
    const path = join(directory, `${sha256}.json.gz`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, Buffer.from([0x1f, 0x8b, 0x00]));

    const artifact = await writeReplayPayload(
      { body, mediaType: "application/json" },
      root,
      "2026-07-10",
      "retailer-1",
    );

    await expect(readReplayPayload(root, artifact)).resolves.toMatchObject({ body, sha256 });
    expect((await readdir(directory)).filter((file) => file.startsWith(".replay-")))
      .toEqual([]);
  });

  it("publishes one verified winner across concurrent identical writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-replay-concurrent-write-"));
    directories.push(root);
    const payload = {
      body: JSON.stringify({ title: "Feijao carioca", price: 8 }),
      mediaType: "application/json" as const,
    };

    const artifacts = await Promise.all(Array.from({ length: 20 }, () =>
      writeReplayPayload(payload, root, "2026-07-10", "retailer-1")));

    expect(new Set(artifacts.map(({ path }) => path)).size).toBe(1);
    await expect(readReplayPayload(root, artifacts[0]!)).resolves.toMatchObject(payload);
    expect(await readdir(join(root, "2026-07-10", "retailer-1")))
      .toEqual([artifacts[0]!.path.split("/").at(-1)]);
  });

  it("re-extracts an API response offline after hash verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-reextract-"));
    directories.push(root);
    const artifact = await writeReplayPayload({
      body: JSON.stringify({
        title: "Arroz Tipo 1",
        brand: "Marca",
        price: 12.99,
        promo: 10.99,
        unit: "5 kg",
        available: true,
      }),
      mediaType: "application/json",
    }, root, "2026-07-10", "retailer-1");
    const strategy = ApiExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "api",
      allowedDomains: ["shop.test"],
      request: { method: "GET", url: "https://shop.test/api/{externalId}", headers: {} },
      fields: {
        title: "$.title",
        brand: "$.brand",
        price: "$.price",
        promoPrice: "$.promo",
        unit: "$.unit",
        availability: "$.available",
      },
    });
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error("network must remain offline");
    };
    try {
      const result = await reextractFromReplay(strategy, {
        canonicalUrl: "https://shop.test/produto/arroz",
        externalId: "123",
        sourceCategory: "Mercearia",
      }, artifact, { replayRoot: root });

      expect(result).toEqual({
        ok: true,
        fields: {
          title: "Arroz Tipo 1",
          brand: "Marca",
          price: 12.99,
          promoPrice: 10.99,
          unit: "5 kg",
          available: true,
        },
      });
      expect(result.replay?.body).toContain("Arroz Tipo 1");
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs an audited private re-extraction workflow without persisting raw bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-reextract-workflow-"));
    directories.push(root);
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    const strategyId = seedStrategy(database, "extraction", extractionStrategy);
    database.prepare(`
      INSERT INTO products
        (id, retailer_id, canonical_url, retailer_product_id, title,
         source_category, first_seen, last_seen)
      VALUES ('workflow-product', 'retailer-1', 'https://shop.test/arroz', '123',
              'Arroz tipo 1 pacote 5 kg', 'Mercearia',
              '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
    `).run();
    createRun(database, {
      id: "workflow-run",
      retailerId: "retailer-1",
      stage: "collect",
      collectionDay: "2026-07-10",
      strategyId,
      strategyVersion: 1,
      startedAt: "2026-07-10T12:00:00.000Z",
    });
    const privateMarker = "raw-private-marker-must-not-persist";
    const artifact = await writeReplayPayload({
      body: JSON.stringify({
        title: "Arroz tipo 1 pacote 5 kg",
        brand: "Marca",
        price: 12.99,
        promo: 10.99,
        unit: "5 kg",
        available: true,
        privateMarker,
      }),
      mediaType: "application/json",
    }, root, "2026-07-10", "retailer-1");
    insertObservation(database, {
      id: "workflow-observation",
      product: {
        id: "workflow-product",
        canonicalUrl: "https://shop.test/arroz",
        externalId: "123",
        sourceCategory: "Mercearia",
      },
      runId: "workflow-run",
      result: {
        ok: true,
        fields: {
          title: "Arroz tipo 1 pacote 5 kg",
          brand: "Marca",
          price: 12.99,
          promoPrice: 10.99,
          unit: "5 kg",
          available: true,
        },
      },
      observedAt: "2026-07-10T12:00:01.000Z",
      collectionDay: "2026-07-10",
      strategyId,
      strategyVersion: 1,
      replay: { path: artifact.path, sha256: artifact.sha256 },
    });

    const summary = await runReplayReextraction({
      database,
      observationId: "workflow-observation",
      replayRoot: root,
      id: () => "reextraction-audit",
      now: () => new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      id: "reextraction-audit",
      observationId: "workflow-observation",
      status: "succeeded",
      result: { ok: true, fields: { title: "Arroz tipo 1 pacote 5 kg" } },
    });
    const stored = database.prepare(`
      SELECT status, result_json AS result, response_path AS path
      FROM replay_reextractions WHERE id = 'reextraction-audit'
    `).get() as { status: string; result: string; path: string };
    expect(stored).toMatchObject({ status: "succeeded", path: artifact.path });
    expect(stored.result).not.toContain(privateMarker);
    expect(stored.result).not.toContain("replay");
    expect(JSON.stringify(summary)).not.toContain(privateMarker);
    expect(() => database.prepare(
      "UPDATE replay_reextractions SET status = status WHERE id = 'reextraction-audit'",
    ).run()).toThrow(/immutable/iu);
  });
});
