import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const APPEND_ONLY_SQL = readFileSync(
  new URL("./migrations/002_append_only.sql", import.meta.url),
  "utf8",
);
const IPCA_PROVENANCE_SQL = readFileSync(
  new URL("./migrations/003_ipca_provenance.sql", import.meta.url),
  "utf8",
);
const CLASSIFICATION_AUDIT_SQL = readFileSync(
  new URL("./migrations/004_classification_audit.sql", import.meta.url),
  "utf8",
);

const MIGRATIONS = [
  { version: 1, name: "m0_foundation", sql: SCHEMA_SQL },
  { version: 2, name: "append_only_evidence", sql: APPEND_ONLY_SQL },
  { version: 3, name: "ipca_item_provenance", sql: IPCA_PROVENANCE_SQL },
  { version: 4, name: "classification_audit", sql: CLASSIFICATION_AUDIT_SQL },
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
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const database = new Database(path);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("recursive_triggers = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
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
