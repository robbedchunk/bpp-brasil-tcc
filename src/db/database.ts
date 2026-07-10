import { chmodSync, readFileSync } from "node:fs";

import Database from "better-sqlite3";

const MIGRATION_VERSION = 1;
const MIGRATION_NAME = "m0_foundation";
const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const applied = database
    .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(MIGRATION_VERSION);
  if (applied !== undefined) {
    return;
  }

  database.transaction(() => {
    database.exec(SCHEMA_SQL);
    database
      .prepare(
        `INSERT INTO schema_migrations (version, name, applied_at)
         VALUES (?, ?, ?)`,
      )
      .run(MIGRATION_VERSION, MIGRATION_NAME, new Date().toISOString());
  })();
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
