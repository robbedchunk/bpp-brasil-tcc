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
    WITH latest_cohort AS (
      SELECT runs.id
      FROM runs
      WHERE runs.retailer_id = ?
        AND runs.stage = 'discover'
        AND runs.status = 'completed'
        AND runs.ok > 0
        AND runs.failed = 0
        AND EXISTS (
          SELECT 1 FROM product_scope_decisions
          WHERE product_scope_decisions.run_id = runs.id
        )
      ORDER BY runs.finished_at DESC, runs.id DESC
      LIMIT 1
    ), eligible AS (
      SELECT canonical_url, retailer_product_id, source_category,
             COALESCE(NULLIF(lower(trim(source_category)), ''), 'uncategorized')
               || ':' || printf('%02d', unicode(substr(canonical_url, -1, 1)) % 8)
               AS stratum
      FROM products
      WHERE retailer_id = ? AND active = 1 AND in_scope = 1
        AND (
          (
            EXISTS (SELECT 1 FROM latest_cohort)
            AND products.last_observed_at IS NOT NULL
            AND products.last_collection_attempt_at IS products.last_observed_at
            AND EXISTS (
              SELECT 1
              FROM product_scope_decisions
              WHERE product_scope_decisions.run_id = (SELECT id FROM latest_cohort)
                AND product_scope_decisions.product_id = products.id
                AND product_scope_decisions.in_scope = 1
            )
          )
          OR NOT EXISTS (SELECT 1 FROM latest_cohort)
        )
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
  `).all(retailerId, retailerId, limit) as Array<{
    canonical_url: string;
    retailer_product_id: string | null;
    source_category: string | null;
  }>).map((row) => ({
    canonicalUrl: row.canonical_url,
    externalId: row.retailer_product_id,
    sourceCategory: row.source_category,
  }));
}
