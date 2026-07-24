UPDATE products
SET canonical_url =
  substr(canonical_url, 1, instr(canonical_url, '/collections/') - 1)
  || '/products/'
  || substr(canonical_url, instr(canonical_url, '/products/') + 10)
WHERE retailer_id = 'st-marche'
  AND canonical_url LIKE 'https://marche.com.br/collections/%/products/%';
