import { basename, relative, sep } from "node:path";

import type Database from "better-sqlite3";

import {
  inspectSchemaCapability,
  openReadOnlyDatabase,
  readDataVersion,
  type SchemaCapability,
  withReadOnlySnapshot,
} from "../../../../../src/db/read-only.js";
import type { DatabaseStateSchema } from "../../shared/contracts.js";
import type { z } from "zod";

const REQUIRED_TABLES = [
  "schema_migrations",
  "retailers",
  "runs",
  "heartbeats",
  "products",
  "observations",
  "run_failures",
  "strategies",
  "strategy_validation_evidence",
  "classifications",
  "classification_scope_decisions",
  "healing_events",
  "exploration_runs",
  "cost_ledger",
  "model_budget_reservations",
  "request_admissions",
  "discovery_reference_admissions",
  "replay_slot_admissions",
] as const;

type DatabaseState = z.infer<typeof DatabaseStateSchema>;

export interface DatabaseInspection {
  state: DatabaseState;
  label: string;
  dataVersion: number | null;
  schemaCapability: SchemaCapability | null;
}

export interface ReadSnapshotContext {
  database: Database.Database;
  generatedAt: string;
  dataVersion: number;
  schemaCapability: SchemaCapability;
}

export class ReadModelUnavailableError extends Error {
  constructor(
    readonly code: "database_missing" | "schema_unavailable" | "database_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ReadModelUnavailableError";
  }
}

function databaseLabel(projectRoot: string, databasePath: string): string {
  const path = relative(projectRoot, databasePath);
  if (path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep)) {
    return path;
  }
  return basename(databasePath);
}

export class ReadModelService {
  private database: Database.Database | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly databasePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  label(): string {
    return databaseLabel(this.projectRoot, this.databasePath);
  }

  inspect(): DatabaseInspection {
    let database: Database.Database;
    try {
      database = this.connection();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "missing") {
        return {
          state: "missing",
          label: this.label(),
          dataVersion: null,
          schemaCapability: null,
        };
      }
      return {
        state: "missing",
        label: this.label(),
        dataVersion: null,
        schemaCapability: null,
      };
    }

    const schemaCapability = inspectSchemaCapability(database, REQUIRED_TABLES);
    const state = this.stateForCapability(database, schemaCapability);
    return {
      state,
      label: this.label(),
      dataVersion: readDataVersion(database),
      schemaCapability,
    };
  }

  snapshot<T>(operation: (context: ReadSnapshotContext) => T): T {
    let database: Database.Database;
    try {
      database = this.connection();
    } catch (error) {
      throw new ReadModelUnavailableError(
        "database_missing",
        "O banco operacional ainda não foi inicializado.",
      );
    }
    const schemaCapability = inspectSchemaCapability(database, REQUIRED_TABLES);
    if (schemaCapability.status !== "compatible") {
      throw new ReadModelUnavailableError(
        "schema_unavailable",
        "O esquema do banco não é compatível com esta versão do Control Room.",
      );
    }

    try {
      return withReadOnlySnapshot(database, () => operation({
        database,
        generatedAt: this.now().toISOString(),
        dataVersion: readDataVersion(database),
        schemaCapability,
      }));
    } catch (error) {
      if (error instanceof ReadModelUnavailableError) throw error;
      throw new ReadModelUnavailableError(
        "database_unavailable",
        "Não foi possível ler uma fotografia coerente do banco operacional.",
      );
    }
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  private connection(): Database.Database {
    if (this.database !== null && this.database.open) return this.database;
    this.database = openReadOnlyDatabase(this.databasePath);
    return this.database;
  }

  private stateForCapability(
    database: Database.Database,
    capability: SchemaCapability,
  ): DatabaseState {
    if (capability.status !== "compatible") return capability.status;
    const count = database.prepare("SELECT COUNT(*) AS count FROM retailers").get() as { count: number };
    return count.count === 0 ? "ready_empty" : "ready";
  }
}
