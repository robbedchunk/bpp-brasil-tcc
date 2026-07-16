-- Operator-imported cold-start catalog seeds. Trusted strategy validation
-- preselects its 30-reference challenge from the products catalog, but a
-- brand-new (inactive) retailer has no catalog and no active strategy that
-- could discover one. These append-only tables record the authoritative
-- operator import that populated such a catalog, so seeded rows remain
-- permanently distinguishable from discovery evidence
-- (product_scope_decisions, which requires a running discovery run).

CREATE TABLE catalog_seed_imports (
  id TEXT PRIMARY KEY,
  retailer_id TEXT NOT NULL
    REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  -- A short file label only: private absolute host paths never enter the
  -- database (publication boundary).
  source_label TEXT NOT NULL CHECK (
    length(source_label) > 0
    AND source_label NOT LIKE '/%'
    AND source_label NOT LIKE '%..%'
  ),
  file_sha256 TEXT NOT NULL CHECK (
    length(file_sha256) = 64
    AND file_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  ref_count INTEGER NOT NULL CHECK (ref_count >= 30),
  imported_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', imported_at) IS NOT NULL
    AND imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', imported_at)
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (retailer_id, file_sha256)
) STRICT;

CREATE INDEX catalog_seed_imports_by_retailer_time
  ON catalog_seed_imports (retailer_id, imported_at DESC);

-- Cold-start only: an active retailer's catalog is discovery-owned evidence.
CREATE TRIGGER catalog_seed_imports_cold_start_only
BEFORE INSERT ON catalog_seed_imports
WHEN EXISTS (
  SELECT 1 FROM retailers
  WHERE retailers.id = NEW.retailer_id AND retailers.active = 1
)
  OR EXISTS (
    SELECT 1 FROM strategies
    WHERE strategies.retailer_id = NEW.retailer_id AND strategies.active = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'operator catalog seeds are cold-start only');
END;

CREATE TRIGGER catalog_seed_imports_no_update
BEFORE UPDATE ON catalog_seed_imports
BEGIN
  SELECT RAISE(ABORT, 'catalog seed imports are immutable');
END;

CREATE TRIGGER catalog_seed_imports_no_delete
BEFORE DELETE ON catalog_seed_imports
BEGIN
  SELECT RAISE(ABORT, 'catalog seed imports are append-only');
END;

CREATE TABLE catalog_seed_refs (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL
    REFERENCES catalog_seed_imports(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  product_id TEXT NOT NULL
    REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  retailer_id TEXT NOT NULL
    REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  canonical_url TEXT NOT NULL,
  retailer_product_id TEXT,
  source_category TEXT,
  -- Only in-scope references may be seeded; out-of-scope entries are rejected
  -- before persistence, so this evidence never legitimizes off-scope rows.
  in_scope INTEGER NOT NULL CHECK (in_scope = 1),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  decided_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) IS NOT NULL
    AND decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', decided_at)
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (import_id, product_id)
) STRICT;

CREATE INDEX catalog_seed_refs_by_product_time
  ON catalog_seed_refs (product_id, decided_at DESC, id DESC);

CREATE TRIGGER catalog_seed_refs_identity_guard
BEFORE INSERT ON catalog_seed_refs
WHEN NOT EXISTS (
  SELECT 1
  FROM catalog_seed_imports AS seed_import
  JOIN products ON products.id = NEW.product_id
  WHERE seed_import.id = NEW.import_id
    AND seed_import.retailer_id = NEW.retailer_id
    AND products.retailer_id = NEW.retailer_id
    AND products.canonical_url = NEW.canonical_url
    AND products.active = 1
    AND products.in_scope = 1
)
BEGIN
  SELECT RAISE(ABORT, 'catalog seed reference must match its import and product');
END;

CREATE TRIGGER catalog_seed_refs_no_update
BEFORE UPDATE ON catalog_seed_refs
BEGIN
  SELECT RAISE(ABORT, 'catalog seed references are immutable');
END;

CREATE TRIGGER catalog_seed_refs_no_delete
BEFORE DELETE ON catalog_seed_refs
BEGIN
  SELECT RAISE(ABORT, 'catalog seed references are append-only');
END;
