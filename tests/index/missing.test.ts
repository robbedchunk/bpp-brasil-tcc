import { afterEach, describe, expect, it } from "vitest";

import {
  buildSeededDailyIndex as buildDailyIndex,
  indexDatabase,
  seedItem,
  seedObservation,
  seedProduct,
  seedRetailer,
  seedRun,
} from "./helpers.js";

const databases: ReturnType<typeof indexDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function baseDatabase(): ReturnType<typeof indexDatabase> {
  const database = indexDatabase();
  databases.push(database);
  seedRetailer(database, "r1");
  seedItem(database, "item-a", "1101002", "Arroz", "0.4030");
  seedProduct(database, { id: "p1", retailerId: "r1", itemId: "item-a" });
  return database;
}

describe("index missingness", () => {
  it("carries a product through day seven and drops it on day eight", () => {
    const database = baseDatabase();
    for (let day = 1; day <= 9; day += 1) {
      const date = `2026-06-${String(day).padStart(2, "0")}`;
      seedRun(database, { id: `run-${day}`, retailerId: "r1", day: date });
    }
    seedObservation(database, {
      id: "p1-d1", productId: "p1", runId: "run-1", day: "2026-06-01", price: 1_000,
    });

    const series = buildDailyIndex(database);
    expect(series.productRelatives.find((point) => point.day === "2026-06-08"))
      .toMatchObject({ numeratorCarried: true, numeratorSourceDay: "2026-06-01" });
    expect(series.productRelatives.some((point) => point.day === "2026-06-09")).toBe(false);
    expect(series.coverage.find((point) => point.day === "2026-06-09")?.carriedExpiredCount)
      .toBeGreaterThan(0);
  });

  it("combines healthy same-day runs, excludes unhealthy runs, and honors latest rows", () => {
    const database = baseDatabase();
    seedRun(database, { id: "d1", retailerId: "r1", day: "2026-06-01" });
    seedRun(database, { id: "bad", retailerId: "r1", day: "2026-06-02", attempted: 10, ok: 6, status: "partial" });
    seedRun(database, { id: "good-a", retailerId: "r1", day: "2026-06-02" });
    seedRun(database, { id: "good-b", retailerId: "r1", day: "2026-06-02", startedAt: "2026-06-02T07:00:00.000Z" });
    seedObservation(database, { id: "d1-price", productId: "p1", runId: "d1", day: "2026-06-01", price: 1_000 });
    seedObservation(database, { id: "bad-price", productId: "p1", runId: "bad", day: "2026-06-02", price: 9_999 });
    seedObservation(database, { id: "good-old", productId: "p1", runId: "good-a", day: "2026-06-02", price: 1_100, observedAt: "2026-06-02T06:05:00.000Z" });
    seedObservation(database, { id: "good-latest", productId: "p1", runId: "good-b", day: "2026-06-02", price: 1_200, available: false, observedAt: "2026-06-02T07:05:00.000Z" });

    const series = buildDailyIndex(database);
    const relative = series.productRelatives.find((point) => point.day === "2026-06-02");
    expect(relative).toBeUndefined();
    expect(series.coverage.find((point) => point.day === "2026-06-02"))
      .toMatchObject({ unavailableCount: 1, productPairCount: 0 });
  });

  it("does not carry an absent retailer and starts a new chain after a panel gap", () => {
    const database = baseDatabase();
    seedRun(database, { id: "d1", retailerId: "r1", day: "2026-06-01" });
    seedRun(database, { id: "d3", retailerId: "r1", day: "2026-06-03" });
    seedRun(database, { id: "d4", retailerId: "r1", day: "2026-06-04" });
    seedObservation(database, { id: "o1", productId: "p1", runId: "d1", day: "2026-06-01", price: 1_000 });
    seedObservation(database, { id: "o3", productId: "p1", runId: "d3", day: "2026-06-03", price: 1_100 });
    seedObservation(database, { id: "o4", productId: "p1", runId: "d4", day: "2026-06-04", price: 1_210 });

    const series = buildDailyIndex(database);
    expect(series.productRelatives.some((point) => point.day === "2026-06-03")).toBe(false);
    expect(series.aggregate.find((point) => point.day === "2026-06-03"))
      .toMatchObject({ chainSegment: 2, indexLevel: "100.000000000000", dailyRelative: null });
    expect(Number(series.aggregate.find((point) => point.day === "2026-06-04")?.indexLevel))
      .toBeCloseTo(110, 10);
  });

  it("uses the latest classification and excludes inactive-scope products only", () => {
    const database = baseDatabase();
    database.prepare(`
      INSERT INTO classifications
        (id, product_id, ipca_item_id, version, decision, confidence, method, created_at)
      VALUES ('p1-classification-v2', 'p1', NULL, 2, 'unclassified', 0.4, 'rule',
              '2026-01-02T00:00:00.000Z')
    `).run();
    seedRun(database, { id: "d1", retailerId: "r1", day: "2026-06-01" });
    seedRun(database, { id: "d2", retailerId: "r1", day: "2026-06-02" });
    seedObservation(database, { id: "o1", productId: "p1", runId: "d1", day: "2026-06-01", price: 1_000 });
    seedObservation(database, { id: "o2", productId: "p1", runId: "d2", day: "2026-06-02", price: 1_100 });

    expect(buildDailyIndex(database).productRelatives).toEqual([]);
    expect(buildDailyIndex(database, { cutoffAt: "2026-01-01T12:00:00.000Z" }))
      .toMatchObject({ productRelatives: expect.any(Array) });
    expect(buildDailyIndex(database, { cutoffAt: "2026-01-01T12:00:00.000Z" }).productRelatives)
      .toHaveLength(1);
    expect(buildDailyIndex(database, { classificationVersion: 1 }).productRelatives).toHaveLength(1);
    database.prepare("UPDATE products SET active = 0 WHERE id = 'p1'").run();
    expect(buildDailyIndex(database, { classificationVersion: 1 }).productRelatives).toHaveLength(1);
    database.prepare("UPDATE products SET in_scope = 0 WHERE id = 'p1'").run();
    expect(buildDailyIndex(database, { classificationVersion: 1 }).productRelatives).toEqual([]);
  });

  it("accounts for mutually exclusive baseline exclusions and never excludes a carried contributor", () => {
    const database = baseDatabase();
    seedProduct(database, { id: "unavailable", retailerId: "r1", itemId: "item-a" });
    seedProduct(database, { id: "invalid", retailerId: "r1", itemId: "item-a" });
    seedProduct(database, { id: "no-price", retailerId: "r1", itemId: "item-a" });
    seedProduct(database, { id: "unclassified", retailerId: "r1", itemId: null });
    seedRetailer(database, "r2");
    seedProduct(database, { id: "no-run", retailerId: "r2", itemId: null });
    seedRun(database, { id: "d1", retailerId: "r1", day: "2026-06-01", attempted: 4 });
    seedRun(database, { id: "d2", retailerId: "r1", day: "2026-06-02", attempted: 4 });
    seedObservation(database, { id: "good-d1", productId: "p1", runId: "d1", day: "2026-06-01", price: 1_000 });
    seedObservation(database, { id: "unavailable-d1", productId: "unavailable", runId: "d1", day: "2026-06-01", price: 1_000, available: false });
    seedObservation(database, { id: "invalid-d1", productId: "invalid", runId: "d1", day: "2026-06-01", price: 0 });

    const series = buildDailyIndex(database);
    expect(series.coverage.find((point) => point.day === "2026-06-01")).toMatchObject({
      productPairCount: 0,
      unclassifiedCount: 1,
      noHealthyRunCount: 1,
      unavailableCount: 1,
      invalidPriceCount: 1,
      noDenominatorCount: 1,
      carriedExpiredCount: 0,
    });
    expect(series.coverage.find((point) => point.day === "2026-06-02")).toMatchObject({
      productPairCount: 1,
      unclassifiedCount: 1,
      noHealthyRunCount: 1,
      unavailableCount: 0,
      invalidPriceCount: 0,
      noDenominatorCount: 3,
      carriedExpiredCount: 0,
    });
  });

  it("records an expired carry on a new baseline day without fabricating coverage", () => {
    const database = baseDatabase();
    seedRun(database, { id: "d1", retailerId: "r1", day: "2026-06-01" });
    seedRun(database, { id: "d9", retailerId: "r1", day: "2026-06-09" });
    seedObservation(database, { id: "p1-d1", productId: "p1", runId: "d1", day: "2026-06-01", price: 1_000 });

    const series = buildDailyIndex(database);

    expect(series.coverage.find((point) => point.day === "2026-06-09")).toMatchObject({
      coveredSubitemCount: 0,
      carriedExpiredCount: 1,
      noDenominatorCount: 0,
    });
  });
});
