import type Database from "better-sqlite3";

import type { ProductRef } from "./types.js";

export const VALIDATION_CHALLENGE_ALGORITHM =
  "active-in-scope-category-url-bucket-round-robin-v1";

/**
 * Selects an authoritative challenge before candidate execution. Round-robin
 * ordering across category and URL-suffix buckets prevents a narrow candidate
 * from defining the 30 references on which it will later be judged.
 */
export function selectStrategyValidationChallenge(
  database: Database.Database,
  retailerId: string,
  limit = 30,
): ProductRef[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Validation reference limit must be positive");
  }
  return (database.prepare(`
    WITH eligible AS (
      SELECT canonical_url, retailer_product_id, source_category,
             COALESCE(NULLIF(lower(trim(source_category)), ''), 'uncategorized')
               || ':' || printf('%02d', unicode(substr(canonical_url, -1, 1)) % 8)
               AS stratum
      FROM products
      WHERE retailer_id = ? AND active = 1 AND in_scope = 1
    ), ranked AS (
      SELECT canonical_url, retailer_product_id, source_category, stratum,
             ROW_NUMBER() OVER (
               PARTITION BY stratum ORDER BY canonical_url
             ) AS stratum_rank
      FROM eligible
    )
    SELECT canonical_url, retailer_product_id, source_category
    FROM ranked
    ORDER BY stratum_rank, stratum, canonical_url
    LIMIT ?
  `).all(retailerId, limit) as Array<{
    canonical_url: string;
    retailer_product_id: string | null;
    source_category: string | null;
  }>).map((row) => ({
    canonicalUrl: row.canonical_url,
    externalId: row.retailer_product_id,
    sourceCategory: row.source_category,
  }));
}
