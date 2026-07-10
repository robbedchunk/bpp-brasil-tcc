import { chmodSync, readFileSync } from "node:fs";

import Database from "better-sqlite3";

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const APPEND_ONLY_SQL = readFileSync(
  new URL("./migrations/002_append_only.sql", import.meta.url),
  "utf8",
);

const MIGRATIONS = [
  { version: 1, name: "m0_foundation", sql: SCHEMA_SQL },
  { version: 2, name: "append_only_evidence", sql: APPEND_ONLY_SQL },
] as const;

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const findMigration = database.prepare(
    "SELECT 1 FROM schema_migrations WHERE version = ?",
  );
  const recordMigration = database.prepare(
    `INSERT INTO schema_migrations (version, name, applied_at)
     VALUES (?, ?, ?)`,
  );
  const applyPendingMigrations = database.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (findMigration.get(migration.version) !== undefined) {
        continue;
      }

      database.exec(migration.sql);
      recordMigration.run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    }
  });

  applyPendingMigrations.immediate();
}

export function openDatabase(path: string): Database.Database {
  const database = new Database(path);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    migrate(database);

    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
