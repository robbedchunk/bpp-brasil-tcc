import type Database from "better-sqlite3";

export function seedRetailer(
  database: Database.Database,
  id = "retailer-1",
): void {
  database.prepare(
    `INSERT INTO retailers
       (id, name, base_url, cep, domains_json, active)
     VALUES (?, ?, 'https://shop.test', '01310-100', '["shop.test"]', 1)`,
  ).run(id, `Retailer ${id}`);
}

export function seedStrategy(
  database: Database.Database,
  purpose: "discovery" | "extraction",
  strategy: object,
  retailerId = "retailer-1",
): string {
  const id = `${retailerId}-${purpose}-v1`;
  database.prepare(
    `INSERT INTO strategies
     (id, retailer_id, purpose, tier, version, strategy_json, provenance,
        validation_sample_size, validation_successes, validation_rate, active,
        validated_at, activated_at)
     VALUES (?, ?, ?, 1, 1, ?, 'test fixture', 30, 30, 1, 0,
             '2026-07-10T00:00:00.000Z', NULL)`,
  ).run(id, retailerId, purpose, JSON.stringify(strategy));
  database.prepare(`
    INSERT INTO strategy_validation_evidence
      (strategy_id, receipt_path, receipt_sha256, sample_set_sha256,
       executor_json, attestation_key_id, attempted, valid, score, validated_at)
    VALUES (?, ?, ?, ?, '{}', ?, 30, 30, 1, '2026-07-10T00:00:00.000Z')
  `).run(
    id,
    `data/validation/${id}.json`,
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
  );
  database.prepare(
    `UPDATE strategies
     SET active = 1, activated_at = '2026-07-10T00:00:00.000Z'
     WHERE id = ?`,
  ).run(id);
  return id;
}

export const discoveryStrategy = {
  schemaVersion: 1,
  purpose: "discovery",
  tier: "sitemap",
  allowedDomains: ["shop.test"],
  sitemapUrls: ["https://shop.test/sitemap.xml"],
  maxSitemaps: 1,
  maxProducts: 10_000,
} as const;

export const extractionStrategy = {
  schemaVersion: 1,
  purpose: "extraction",
  tier: "api",
  allowedDomains: ["shop.test"],
  request: {
    method: "GET",
    url: "https://shop.test/api/{externalId}",
    headers: {},
  },
  fields: {
    title: "$.title",
    brand: "$.brand",
    price: "$.price",
    promoPrice: "$.promo",
    unit: "$.unit",
    availability: "$.available",
  },
} as const;
