import { existsSync } from "node:fs";

import Database from "better-sqlite3";

import { EXPECTED_SCHEMA_MIGRATIONS } from "./migration-manifest.js";

export type ReadOnlyDatabaseErrorCode = "missing" | "invalid_path" | "open_failed";

export class ReadOnlyDatabaseError extends Error {
  constructor(
    readonly code: ReadOnlyDatabaseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReadOnlyDatabaseError";
  }
}

export type SchemaCapabilityStatus =
  | "compatible"
  | "older"
  | "newer"
  | "incompatible"
  | "unrecognized";

export interface SchemaCapability {
  status: SchemaCapabilityStatus;
  currentVersion: number | null;
  expectedVersion: number;
  actionsSafe: boolean;
  missingTables: string[];
  mismatchedMigrations: Array<{
    version: number;
    expectedName: string;
    actualName: string | null;
  }>;
}

interface MigrationRow {
  version: number;
  name: string;
}

function expectedSchemaVersion(): number {
  return EXPECTED_SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;
}

function existingTableNames(
  database: Database.Database,
  tables: readonly string[],
): Set<string> {
  const names = [...new Set(tables)];
  if (names.length === 0) return new Set();
  const placeholders = names.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT name
     FROM sqlite_schema
     WHERE type = 'table' AND name IN (${placeholders})`,
  ).all(...names) as Array<{ name: string }>;
  return new Set(rows.map(({ name }) => name));
}

/**
 * Opens a file-backed database for observation without creating files, changing
 * journal mode, running migrations, or reconciling interrupted work.
 */
export function openReadOnlyDatabase(path: string): Database.Database {
  if (path === ":memory:" || path.trim() === "") {
    throw new ReadOnlyDatabaseError(
      "invalid_path",
      "Read-only operational access requires an existing file-backed database",
    );
  }
  if (!existsSync(path)) {
    throw new ReadOnlyDatabaseError("missing", `Database does not exist: ${path}`);
  }

  let database: Database.Database;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new ReadOnlyDatabaseError(
      "open_failed",
      `Unable to open database read-only: ${path}`,
      { cause: error },
    );
  }

  try {
    database.pragma("query_only = ON");
    database.pragma("foreign_keys = ON");
    database.pragma("recursive_triggers = ON");
    database.pragma("busy_timeout = 5000");
    return database;
  } catch (error) {
    database.close();
    throw new ReadOnlyDatabaseError(
      "open_failed",
      `Unable to configure read-only database access: ${path}`,
      { cause: error },
    );
  }
}

export function inspectSchemaCapability(
  database: Database.Database,
  requiredTables: readonly string[] = [],
): SchemaCapability {
  const expectedVersion = expectedSchemaVersion();
  const existingTables = existingTableNames(database, [
    "schema_migrations",
    ...requiredTables,
  ]);
  if (!existingTables.has("schema_migrations")) {
    return {
      status: "unrecognized",
      currentVersion: null,
      expectedVersion,
      actionsSafe: false,
      missingTables: [...requiredTables].sort(),
      mismatchedMigrations: [],
    };
  }

  const rows = database.prepare(
    "SELECT version, name FROM schema_migrations ORDER BY version",
  ).all() as MigrationRow[];
  const actualByVersion = new Map(rows.map((row) => [row.version, row.name]));
  const mismatchedMigrations = EXPECTED_SCHEMA_MIGRATIONS.flatMap((migration) => {
    const actualName = actualByVersion.get(migration.version) ?? null;
    return actualName === migration.name
      ? []
      : [{ version: migration.version, expectedName: migration.name, actualName }];
  });
  const currentVersion = rows.reduce(
    (maximum, row) => Math.max(maximum, row.version),
    0,
  );
  const missingTables = requiredTables
    .filter((table) => !existingTables.has(table))
    .sort();
  const hasUnexpectedKnownRangeMigration = rows.some((row) => {
    const expected = EXPECTED_SCHEMA_MIGRATIONS.find(({ version }) => version === row.version);
    return row.version <= expectedVersion && expected?.name !== row.name;
  });

  let status: SchemaCapabilityStatus;
  if (hasUnexpectedKnownRangeMigration || missingTables.length > 0) {
    status = "incompatible";
  } else if (currentVersion < expectedVersion) {
    status = "older";
  } else if (currentVersion > expectedVersion) {
    status = "newer";
  } else if (mismatchedMigrations.length > 0) {
    status = "incompatible";
  } else {
    status = "compatible";
  }

  return {
    status,
    currentVersion,
    expectedVersion,
    actionsSafe: status === "compatible",
    missingTables,
    mismatchedMigrations,
  };
}

export function readDataVersion(database: Database.Database): number {
  const value = database.pragma("data_version", { simple: true });
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("SQLite returned an invalid data_version");
  }
  return value;
}

export function withReadOnlySnapshot<T>(
  database: Database.Database,
  operation: () => T,
): T {
  return database.transaction(operation).deferred();
}
