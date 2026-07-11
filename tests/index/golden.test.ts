import { afterEach, describe, expect, it } from "vitest";

import {
  experimentalDailySeriesFacts,
} from "../../src/index/aggregate.js";
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

describe("hand-computed experimental index", () => {
  it("uses promo prices, Jevons, equal retailer means, and covered weights", () => {
    const database = indexDatabase();
    databases.push(database);
    seedRetailer(database, "r1");
    seedRetailer(database, "r2");
    seedItem(database, "item-a", "1101002", "Item A", "6.0000");
    seedItem(database, "item-b", "1102006", "Item B", "4.0000");

    for (const [id, retailer, item] of [
      ["a1", "r1", "item-a"],
      ["a2", "r1", "item-a"],
      ["a3", "r2", "item-a"],
      ["b1", "r1", "item-b"],
    ] as const) seedProduct(database, { id, retailerId: retailer, itemId: item });

    for (const day of ["2026-06-01", "2026-06-02"] as const) {
      seedRun(database, { id: `r1-${day}`, retailerId: "r1", day, attempted: 3 });
      seedRun(database, { id: `r2-${day}`, retailerId: "r2", day });
    }

    const prices = [
      ["a1", "r1", 1_200, 1_000, 1_200, 1_100],
      ["a2", "r1", 1_000, null, 900, null],
      ["a3", "r2", 1_000, null, 1_020, null],
      ["b1", "r1", 1_000, null, 1_050, null],
    ] as const;
    for (const [product, retailer, p1, promo1, p2, promo2] of prices) {
      seedObservation(database, {
        id: `${product}-d1`, productId: product, runId: `${retailer}-2026-06-01`,
        day: "2026-06-01", price: p1, promo: promo1,
      });
      seedObservation(database, {
        id: `${product}-d2`, productId: product, runId: `${retailer}-2026-06-02`,
        day: "2026-06-02", price: p2, promo: promo2,
      });
    }

    const series = buildDailyIndex(database);
    const itemA = (Math.sqrt(0.99) + 1.02) / 2;
    const expectedDaily = itemA * 0.6 + 1.05 * 0.4;

    expect(series.aggregate).toHaveLength(2);
    expect(series.aggregate[0]).toMatchObject({
      day: "2026-06-01", dailyRelative: null, indexLevel: "100.000000000000",
    });
    expect(Number(series.aggregate[1]?.indexLevel)).toBeCloseTo(100 * expectedDaily, 10);
    expect(series.retailerSubitems.find((point) =>
      point.retailerId === "r1" && point.ipcaItemId === "item-a")
      ?.productPairCount).toBe(2);
    expect(series.subitems.find((point) => point.ipcaItemId === "item-a")
      ?.retailerCount).toBe(2);
    expect(series.productRelatives.find((point) => point.productId === "a1"))
      .toMatchObject({ numeratorCents: 1_100, denominatorCents: 1_000 });
    expect(experimentalDailySeriesFacts(series)).toEqual({
      aggregatePointCount: 2,
      movementPointCount: 1,
      hasExperimentalDailySeries: true,
    });
  });

  it("preserves Decimal precision until the published output boundary", () => {
    const database = indexDatabase();
    databases.push(database);
    seedRetailer(database, "r1");
    seedItem(database, "item-a", "1101002", "Item A", "12.1181");
    seedProduct(database, { id: "p1", retailerId: "r1", itemId: "item-a" });
    seedProduct(database, { id: "p2", retailerId: "r1", itemId: "item-a" });
    seedRun(database, { id: "d1", retailerId: "r1", day: "2026-06-01", attempted: 2 });
    seedRun(database, { id: "d2", retailerId: "r1", day: "2026-06-02", attempted: 2 });
    seedObservation(database, { id: "p1-d1", productId: "p1", runId: "d1", day: "2026-06-01", price: 997 });
    seedObservation(database, { id: "p2-d1", productId: "p2", runId: "d1", day: "2026-06-01", price: 991 });
    seedObservation(database, { id: "p1-d2", productId: "p1", runId: "d2", day: "2026-06-02", price: 900 });
    seedObservation(database, { id: "p2-d2", productId: "p2", runId: "d2", day: "2026-06-02", price: 901 });

    const series = buildDailyIndex(database);

    expect(series.retailerSubitems[0]?.relative).toBe("0.905939600135");
    expect(series.subitems[0]?.relative).toBe("0.905939600135");
    expect(series.aggregate[1]?.dailyRelative).toBe("0.905939600135");
  });

  it("distinguishes a baseline-only index from a nonempty daily series", () => {
    const database = indexDatabase();
    databases.push(database);
    seedRetailer(database, "r1");
    seedItem(database, "item-a", "1101002", "Item A", "12.1181");
    seedProduct(database, { id: "p1", retailerId: "r1", itemId: "item-a" });
    seedRun(database, { id: "d1", retailerId: "r1", day: "2026-06-01" });
    seedObservation(database, {
      id: "p1-d1", productId: "p1", runId: "d1", day: "2026-06-01", price: 997,
    });

    expect(experimentalDailySeriesFacts(buildDailyIndex(database))).toEqual({
      aggregatePointCount: 1,
      movementPointCount: 0,
      hasExperimentalDailySeries: false,
    });
  });
});
