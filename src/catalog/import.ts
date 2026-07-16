import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";

import {
  decideFoodAtHomeScope,
  MAX_FOOD_CATALOG_PRODUCTS,
} from "./scope.js";
import type { ProductRef } from "../strategies/types.js";

/**
 * Trusted strategy validation preselects exactly 30 authoritative references
 * (scripts/validate-strategies.ts SAMPLE_SIZE and the
 * selectStrategyValidationChallenge default). An operator seed below this
 * count can never produce a usable independent challenge.
 */
export const CATALOG_SEED_MINIMUM_REFERENCES = 30;

const DISCOVERY_PLACEHOLDER_TITLE = "Produto aguardando observação descritiva";

export interface CatalogSeedEntry extends ProductRef {
  /** Optional operator-supplied display title; never overwrites an existing row. */
  title: string | null;
}

export interface CatalogSeedRejection {
  index: number;
  canonicalUrl: string | null;
  reason: string;
}

export class CatalogSeedImportError extends Error {
  readonly rejections: readonly CatalogSeedRejection[];

  constructor(message: string, rejections: readonly CatalogSeedRejection[] = []) {
    const shown = rejections.slice(0, 5).map((rejection) =>
      `#${rejection.index + 1} ${rejection.canonicalUrl ?? "(no URL)"}: ${rejection.reason}`);
    super(rejections.length === 0
      ? message
      : `${message}: ${shown.join("; ")}${
        rejections.length > shown.length
          ? ` (+${rejections.length - shown.length} more)`
          : ""
      }`);
    this.name = "CatalogSeedImportError";
    this.rejections = rejections;
  }
}

export type CatalogSeedFileFormat = "json" | "csv";

const SeedEntrySchema = z.object({
  canonicalUrl: z.string().min(1),
  externalId: z.string().min(1).nullable().optional(),
  sourceCategory: z.string().min(1).nullable().optional(),
  title: z.string().min(1).nullable().optional(),
}).strict();

const CSV_COLUMNS = new Set([
  "canonical_url",
  "external_id",
  "source_category",
  "title",
]);

function nullableCell(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Parses an operator seed reference file. JSON files are a top-level array of
 * `{ canonicalUrl, externalId?, sourceCategory?, title? }` objects; CSV files
 * use a `canonical_url,external_id,source_category,title` header where empty
 * cells mean null. Structural errors reject the whole file.
 */
export function parseCatalogSeedFile(
  content: string,
  format: CatalogSeedFileFormat,
): CatalogSeedEntry[] {
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new CatalogSeedImportError(
        `Seed file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new CatalogSeedImportError("A JSON seed file must be a top-level array of references");
    }
    return parsed.map((candidate, index) => {
      const result = SeedEntrySchema.safeParse(candidate);
      if (!result.success) {
        throw new CatalogSeedImportError("Seed file entry is malformed", [{
          index,
          canonicalUrl: typeof (candidate as { canonicalUrl?: unknown })?.canonicalUrl === "string"
            ? (candidate as { canonicalUrl: string }).canonicalUrl
            : null,
          reason: result.error.issues.map((issue) =>
            `${issue.path.join(".") || "entry"}: ${issue.message}`).join(", "),
        }]);
      }
      return {
        canonicalUrl: result.data.canonicalUrl.trim(),
        externalId: result.data.externalId ?? null,
        sourceCategory: result.data.sourceCategory ?? null,
        title: result.data.title ?? null,
      };
    });
  }
  let records: Array<Record<string, string>>;
  try {
    records = parseCsv(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Array<Record<string, string>>;
  } catch (error) {
    throw new CatalogSeedImportError(
      `Seed file is not valid CSV: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return records.map((record, index) => {
    const unknownColumns = Object.keys(record).filter((column) => !CSV_COLUMNS.has(column));
    if (unknownColumns.length > 0) {
      throw new CatalogSeedImportError("Seed file entry is malformed", [{
        index,
        canonicalUrl: nullableCell(record.canonical_url),
        reason: `unknown CSV column(s): ${unknownColumns.join(", ")}`,
      }]);
    }
    const canonicalUrl = nullableCell(record.canonical_url);
    if (canonicalUrl === null) {
      throw new CatalogSeedImportError("Seed file entry is malformed", [{
        index,
        canonicalUrl: null,
        reason: "canonical_url is required",
      }]);
    }
    return {
      canonicalUrl,
      externalId: nullableCell(record.external_id),
      sourceCategory: nullableCell(record.source_category),
      title: nullableCell(record.title),
    };
  });
}

export interface CatalogSeedImportInput {
  retailerId: string;
  entries: readonly CatalogSeedEntry[];
  /** Short file label (basename); never a private absolute path. */
  sourceLabel: string;
  fileSha256: string;
  dryRun?: boolean;
  now?: () => Date;
  id?: () => string;
}

export interface CatalogSeedImportSummary {
  retailerId: string;
  importId: string | null;
  sourceLabel: string;
  fileSha256: string;
  dryRun: boolean;
  alreadyImported: boolean;
  refs: number;
  newProducts: number;
  refreshedProducts: number;
  activeInScopeProducts: number;
  challengeReady: boolean;
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/u, "");
}

/** Mirrors the collection transport's allowlist semantics (src/collection/http.ts). */
function domainRejection(
  canonicalUrl: string,
  allowedDomains: readonly string[],
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(canonicalUrl);
  } catch {
    return "canonical URL is not a valid absolute URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `URL protocol is not allowed: ${parsed.protocol}`;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return "URL credentials are not allowed";
  }
  const hostname = normalizedHostname(parsed.hostname);
  const allowed = allowedDomains.some((domain) => {
    const candidate = normalizedHostname(domain.trim());
    return candidate.length > 0
      && (hostname === candidate || hostname.endsWith(`.${candidate}`));
  });
  return allowed
    ? null
    : `URL domain is not in the retailer allowlist: ${parsed.hostname}`;
}

/**
 * Mirrors the discovery placeholder-title heuristic
 * (src/db/repositories.ts productTitle, deliberately not exported there).
 */
function seedTitle(entry: CatalogSeedEntry): string {
  if (entry.title !== null && entry.title.trim().length > 0) return entry.title.trim();
  try {
    const technicalSegments = new Set(["item", "p", "pd", "product", "produto"]);
    const segments = new URL(entry.canonicalUrl).pathname.split("/").filter(Boolean);
    for (const segment of segments.reverse()) {
      const decoded = decodeURIComponent(segment).trim();
      if (technicalSegments.has(decoded.toLocaleLowerCase("pt-BR"))) continue;
      const humanized = decoded
        .replace(/[-_]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
      if (humanized.length > 0 && !/^\d+$/u.test(humanized)) return humanized;
    }
  } catch {
    // Fall through to the placeholder used by discovery.
  }
  return DISCOVERY_PLACEHOLDER_TITLE;
}

interface RetailerRow {
  id: string;
  active: number;
  domains_json: string;
}

/**
 * Imports an operator-curated cold-start catalog seed for one INACTIVE
 * retailer. Every reference must sit inside the retailer's registered domain
 * allowlist and pass the fail-closed food-at-home scope rule; any rejection
 * refuses the whole import so the seeded challenge basis stays deterministic.
 * The import touches no network and charges no request/reference admission
 * ledger. Re-importing the identical file is a no-op.
 */
export function importCatalogSeeds(
  database: Database.Database,
  input: CatalogSeedImportInput,
): CatalogSeedImportSummary {
  const now = input.now ?? (() => new Date());
  const makeId = input.id ?? randomUUID;
  if (!/^[a-f0-9]{64}$/u.test(input.fileSha256)) {
    throw new CatalogSeedImportError("Seed file digest must be a lowercase SHA-256 hex string");
  }
  if (
    input.sourceLabel.trim().length === 0
    || input.sourceLabel.startsWith("/")
    || input.sourceLabel.includes("..")
  ) {
    throw new CatalogSeedImportError(
      "Seed source label must be a short relative file label, never a private absolute path",
    );
  }

  const retailer = database.prepare(
    "SELECT id, active, domains_json FROM retailers WHERE id = ?",
  ).get(input.retailerId) as RetailerRow | undefined;
  if (retailer === undefined) {
    throw new CatalogSeedImportError(
      `Retailer ${input.retailerId} is not registered; run `
      + "`npm run retailers:register -- --bootstrap-inactive --retailer "
      + `${input.retailerId}\` first`,
    );
  }
  if (retailer.active !== 0) {
    throw new CatalogSeedImportError(
      `Retailer ${input.retailerId} is ACTIVE; operator catalog seeds are cold-start only `
      + "and never touch an active retailer's discovery-owned catalog",
    );
  }
  const activeStrategies = (database.prepare(
    "SELECT COUNT(*) AS count FROM strategies WHERE retailer_id = ? AND active = 1",
  ).get(input.retailerId) as { count: number }).count;
  if (activeStrategies > 0) {
    throw new CatalogSeedImportError(
      `Retailer ${input.retailerId} has an active strategy; operator catalog seeds are `
      + "cold-start only",
    );
  }
  const allowedDomains = z.array(z.string()).parse(JSON.parse(retailer.domains_json));

  const rejections: CatalogSeedRejection[] = [];
  const seenUrls = new Set<string>();
  for (const [index, entry] of input.entries.entries()) {
    const reject = (reason: string): void => {
      rejections.push({ index, canonicalUrl: entry.canonicalUrl || null, reason });
    };
    const domainProblem = domainRejection(entry.canonicalUrl, allowedDomains);
    if (domainProblem !== null) {
      reject(domainProblem);
      continue;
    }
    if (seenUrls.has(entry.canonicalUrl)) {
      reject("duplicate canonical URL in the seed file");
      continue;
    }
    seenUrls.add(entry.canonicalUrl);
    const scope = decideFoodAtHomeScope(entry);
    if (!scope.inScope) {
      const terms = scope.evidence.excludedTerms.length > 0
        ? ` (matched excluded terms: ${scope.evidence.excludedTerms.join(", ")})`
        : "";
      reject(`out of food-at-home scope: ${scope.reason}${terms}`);
    }
  }
  if (rejections.length > 0) {
    throw new CatalogSeedImportError(
      `Refusing the whole import: ${rejections.length} of ${input.entries.length} `
      + "seed reference(s) failed domain or scope validation",
      rejections,
    );
  }
  if (input.entries.length < CATALOG_SEED_MINIMUM_REFERENCES) {
    throw new CatalogSeedImportError(
      `A usable validation challenge needs at least ${CATALOG_SEED_MINIMUM_REFERENCES} in-scope `
      + `references; the seed file has ${input.entries.length}`,
    );
  }
  if (input.entries.length > MAX_FOOD_CATALOG_PRODUCTS) {
    throw new CatalogSeedImportError(
      `Seed files are bounded by the ${MAX_FOOD_CATALOG_PRODUCTS}-product catalog cap; `
      + `the seed file has ${input.entries.length}`,
    );
  }

  const activeInScopeCount = (): number => (database.prepare(
    "SELECT COUNT(*) AS count FROM products WHERE retailer_id = ? AND active = 1 AND in_scope = 1",
  ).get(input.retailerId) as { count: number }).count;

  const existingImport = database.prepare(
    `SELECT id, ref_count AS refCount FROM catalog_seed_imports
     WHERE retailer_id = ? AND file_sha256 = ?`,
  ).get(input.retailerId, input.fileSha256) as
    | { id: string; refCount: number }
    | undefined;
  if (existingImport !== undefined) {
    if (existingImport.refCount !== input.entries.length) {
      throw new CatalogSeedImportError(
        `Import ${existingImport.id} already recorded this file digest with `
        + `${existingImport.refCount} reference(s), not ${input.entries.length}`,
      );
    }
    const count = activeInScopeCount();
    return {
      retailerId: input.retailerId,
      importId: existingImport.id,
      sourceLabel: input.sourceLabel,
      fileSha256: input.fileSha256,
      dryRun: input.dryRun === true,
      alreadyImported: true,
      refs: input.entries.length,
      newProducts: 0,
      refreshedProducts: 0,
      activeInScopeProducts: count,
      challengeReady: count >= CATALOG_SEED_MINIMUM_REFERENCES,
    };
  }

  const existingProduct = database.prepare(
    "SELECT id FROM products WHERE retailer_id = ? AND canonical_url = ?",
  );
  if (input.dryRun === true) {
    const alreadyCounted = database.prepare(
      `SELECT 1 FROM products
       WHERE retailer_id = ? AND canonical_url = ? AND active = 1 AND in_scope = 1`,
    );
    let existing = 0;
    let projected = activeInScopeCount();
    for (const entry of input.entries) {
      if (existingProduct.get(input.retailerId, entry.canonicalUrl) !== undefined) {
        existing += 1;
      }
      if (alreadyCounted.get(input.retailerId, entry.canonicalUrl) === undefined) {
        projected += 1;
      }
    }
    return {
      retailerId: input.retailerId,
      importId: null,
      sourceLabel: input.sourceLabel,
      fileSha256: input.fileSha256,
      dryRun: true,
      alreadyImported: false,
      refs: input.entries.length,
      newProducts: input.entries.length - existing,
      refreshedProducts: existing,
      activeInScopeProducts: projected,
      challengeReady: projected >= CATALOG_SEED_MINIMUM_REFERENCES,
    };
  }

  const importId = makeId();
  const importedAt = now().toISOString();
  let newProducts = 0;
  let refreshedProducts = 0;
  const run = database.transaction(() => {
    database.prepare(
      `INSERT INTO catalog_seed_imports
         (id, retailer_id, source_label, file_sha256, ref_count, imported_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      importId,
      input.retailerId,
      input.sourceLabel,
      input.fileSha256,
      input.entries.length,
      importedAt,
    );
    const upsert = database.prepare(
      `INSERT INTO products
         (id, retailer_id, canonical_url, retailer_product_id, title,
          source_category, in_scope, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (retailer_id, canonical_url) DO UPDATE SET
         retailer_product_id =
           COALESCE(excluded.retailer_product_id, products.retailer_product_id),
         source_category = COALESCE(excluded.source_category, products.source_category),
         in_scope = 1,
         last_seen = excluded.last_seen,
         active = 1,
         updated_at = excluded.last_seen`,
    );
    const insertSeedRef = database.prepare(
      `INSERT INTO catalog_seed_refs
         (id, import_id, product_id, retailer_id, canonical_url,
          retailer_product_id, source_category, in_scope, reason,
          evidence_json, rule_version, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    );
    for (const entry of input.entries) {
      const preexisting = existingProduct.get(input.retailerId, entry.canonicalUrl) !== undefined;
      upsert.run(
        makeId(),
        input.retailerId,
        entry.canonicalUrl,
        entry.externalId,
        seedTitle(entry),
        entry.sourceCategory,
        importedAt,
        importedAt,
      );
      const product = existingProduct.get(input.retailerId, entry.canonicalUrl) as
        | { id: string }
        | undefined;
      if (product === undefined) {
        throw new CatalogSeedImportError(
          `Seed product row for ${entry.canonicalUrl} did not persist`,
        );
      }
      const scope = decideFoodAtHomeScope(entry);
      insertSeedRef.run(
        makeId(),
        importId,
        product.id,
        input.retailerId,
        entry.canonicalUrl,
        entry.externalId,
        entry.sourceCategory,
        scope.reason,
        JSON.stringify(scope.evidence),
        scope.ruleVersion,
        importedAt,
      );
      if (preexisting) refreshedProducts += 1;
      else newProducts += 1;
    }
  });
  run.immediate();

  const count = activeInScopeCount();
  return {
    retailerId: input.retailerId,
    importId,
    sourceLabel: input.sourceLabel,
    fileSha256: input.fileSha256,
    dryRun: false,
    alreadyImported: false,
    refs: input.entries.length,
    newProducts,
    refreshedProducts,
    activeInScopeProducts: count,
    challengeReady: count >= CATALOG_SEED_MINIMUM_REFERENCES,
  };
}
