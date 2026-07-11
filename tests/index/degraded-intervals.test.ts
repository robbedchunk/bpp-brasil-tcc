import { afterEach, describe, expect, it } from "vitest";

import { loadIndexInput } from "../../src/index/relatives.js";
import {
  buildSeededDailyIndex as buildDailyIndex,
  finalizeSeedRuns,
  indexDatabase,
  seedItem,
  seedObservation,
  seedProduct,
  seedRetailer,
  seedRun,
} from "./helpers.js";

const databases: ReturnType<typeof indexDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function transition(
  database: ReturnType<typeof indexDatabase>,
  retailerId: string,
  degraded: boolean,
  effectiveAt: string,
): void {
  const result = database.prepare(`
    UPDATE retailers
    SET degraded = ?, degraded_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(
    degraded ? 1 : 0,
    degraded ? "fixture healing failure" : null,
    effectiveAt,
    retailerId,
  );
  expect(result.changes).toBe(1);
}

function seedPanel(): ReturnType<typeof indexDatabase> {
  const database = indexDatabase();
  databases.push(database);
  seedRetailer(database, "control");
  seedRetailer(database, "subject");
  seedItem(database, "item-a", "1101002", "Arroz", "12.1181");
  seedProduct(database, { id: "control-product", retailerId: "control", itemId: "item-a" });
  seedProduct(database, { id: "subject-product", retailerId: "subject", itemId: "item-a" });
  return database;
}

describe("temporal degraded-retailer index exclusion", () => {
  it("excludes only runs inside a degraded interval and never looks ahead from current state", () => {
    const database = seedPanel();
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];

    for (const [index, day] of days.entries()) {
      seedRun(database, { id: `control-${day}`, retailerId: "control", day });
      seedObservation(database, {
        id: `control-observation-${day}`,
        productId: "control-product",
        runId: `control-${day}`,
        day,
        price: 1_000 + index * 100,
      });
      seedRun(database, {
        id: `subject-${day}`,
        retailerId: "subject",
        day,
        ...(day === "2026-06-02"
          ? { attempted: 10, ok: 7, status: "partial" as const }
          : {}),
      });
      seedObservation(database, {
        id: `subject-observation-${day}`,
        productId: "subject-product",
        runId: `subject-${day}`,
        day,
        price: 2_000 + index * 100,
      });
    }

    transition(database, "subject", true, "2026-06-02T05:00:00.000Z");
    transition(database, "subject", false, "2026-06-03T05:00:00.000Z");
    // The current mutable state is degraded, but this future transition must
    // not rewrite the historical eligibility of completed retailer-days.
    transition(database, "subject", true, "2026-06-05T05:00:00.000Z");

    finalizeSeedRuns(database);
    const input = loadIndexInput(database);
    expect(input.healthyRetailerDays.has("subject\u00002026-06-01")).toBe(true);
    expect(input.healthyRetailerDays.has("subject\u00002026-06-02")).toBe(false);
    expect(input.healthyRetailerDays.has("subject\u00002026-06-03")).toBe(true);
    expect(input.healthyRetailerDays.has("subject\u00002026-06-04")).toBe(true);
    expect(input.actualsByProduct.get("subject-product")?.map(({ day }) => day))
      .toEqual(["2026-06-01", "2026-06-03", "2026-06-04"]);

    const series = buildDailyIndex(database);
    expect(series.productRelatives.some(({ retailerId, day }) =>
      retailerId === "subject" && day === "2026-06-02")).toBe(false);
    expect(series.productRelatives.some(({ retailerId, day }) =>
      retailerId === "subject" && day === "2026-06-03")).toBe(false);
    expect(series.productRelatives.find(({ retailerId, day }) =>
      retailerId === "subject" && day === "2026-06-04")).toMatchObject({
      numeratorCents: 2_300,
      denominatorCents: 2_200,
    });
    expect(series.aggregate.find(({ day }) => day === "2026-06-02")?.retailerCount).toBe(1);
    expect(series.aggregate.find(({ day }) => day === "2026-06-04")?.retailerCount).toBe(2);
  });

  it("treats degraded/recovered effective timestamps as inclusive state boundaries", () => {
    const database = seedPanel();
    for (const day of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
      seedRun(database, {
        id: `subject-${day}`,
        retailerId: "subject",
        day,
        startedAt: `${day}T06:00:00.000Z`,
      });
    }

    transition(database, "subject", true, "2026-06-02T06:00:00.000Z");
    transition(database, "subject", false, "2026-06-03T06:00:00.000Z");

    finalizeSeedRuns(database);
    const input = loadIndexInput(database);
    expect([...input.healthyRetailerDays].filter((key) => key.startsWith("subject\u0000")))
      .toEqual([
        "subject\u00002026-06-01",
        "subject\u00002026-06-03",
      ]);
  });
});
