import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../../src/db/database.js";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function databaseWithRetailer(): ReturnType<typeof openDatabase> {
  const database = openDatabase(":memory:");
  databases.push(database);
  database.prepare(`
    INSERT INTO retailers (id, name, base_url, cep, domains_json)
    VALUES ('retailer-1', 'Retailer 1', 'https://retailer.test', '01310-100', '["retailer.test"]')
  `).run();
  return database;
}

describe("append-only retailer state history", () => {
  it("backfills a legacy current degradation at its best-known update boundary", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    database.exec(`
      DROP TRIGGER retailer_state_events_after_retailer_insert;
      DROP TRIGGER retailer_state_events_after_state_change;
      DROP TRIGGER retailer_state_events_no_update;
      DROP TRIGGER retailer_state_events_no_delete;
      DROP TABLE retailer_state_events;
      DELETE FROM schema_migrations WHERE version = 12;

      INSERT INTO retailers
        (id, name, base_url, cep, domains_json, degraded, degraded_reason,
         created_at, updated_at)
      VALUES
        ('legacy', 'Legacy', 'https://legacy.test', '01310-100', '["legacy.test"]',
         1, 'legacy degraded state',
         '2026-06-01T00:00:00.000Z', '2026-06-03T05:00:00.000Z');
    `);

    migrate(database);

    expect(database.prepare(`
      SELECT state, reason, source, effective_at
      FROM retailer_state_events WHERE retailer_id = 'legacy'
    `).get()).toEqual({
      state: "degraded",
      reason: "legacy degraded state",
      source: "migration_backfill",
      effective_at: "2026-06-03T05:00:00.000Z",
    });
  });

  it("records only actual degraded/recovered transitions with exact effective times", () => {
    const database = databaseWithRetailer();

    database.prepare(`
      UPDATE retailers
      SET degraded = 1,
          degraded_reason = 'three failed healing events',
          updated_at = '2026-07-10T05:00:00.000Z'
      WHERE id = 'retailer-1'
    `).run();
    database.prepare(`
      UPDATE retailers
      SET degraded_reason = 'same state, clarified reason',
          updated_at = '2026-07-10T05:01:00.000Z'
      WHERE id = 'retailer-1'
    `).run();
    database.prepare(`
      UPDATE retailers
      SET degraded = 0,
          degraded_reason = NULL,
          updated_at = '2026-07-10T06:00:00.000Z'
      WHERE id = 'retailer-1'
    `).run();

    expect(database.prepare(`
      SELECT state, reason, source, effective_at
      FROM retailer_state_events
      WHERE retailer_id = 'retailer-1'
      ORDER BY sequence
    `).all()).toEqual([
      {
        state: "recovered",
        reason: null,
        source: "retailer_insert",
        effective_at: expect.any(String),
      },
      {
        state: "degraded",
        reason: "three failed healing events",
        source: "retailer_transition",
        effective_at: "2026-07-10T05:00:00.000Z",
      },
      {
        state: "recovered",
        reason: null,
        source: "retailer_transition",
        effective_at: "2026-07-10T06:00:00.000Z",
      },
    ]);
  });

  it("rejects mutation, deletion, and malformed transition timestamps", () => {
    const database = databaseWithRetailer();

    expect(() => database.prepare(`
      UPDATE retailers
      SET degraded = 1, degraded_reason = 'bad timestamp', updated_at = 'not-a-time'
      WHERE id = 'retailer-1'
    `).run()).toThrow(/CHECK/iu);
    expect(database.prepare(
      "SELECT degraded FROM retailers WHERE id = 'retailer-1'",
    ).get()).toEqual({ degraded: 0 });
    expect(() => database.prepare(
      "UPDATE retailer_state_events SET state = 'degraded'",
    ).run()).toThrow(/immutable/iu);
    expect(() => database.prepare(
      "DELETE FROM retailer_state_events",
    ).run()).toThrow(/append-only/iu);
  });
});
