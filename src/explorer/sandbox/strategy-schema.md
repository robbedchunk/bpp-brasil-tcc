# Strategy artifact schema

The artifact is a strict JSON object: `{ "strategy": Strategy }`. Unknown fields are invalid.

Every strategy has `schemaVersion: 1`, a matching `purpose`, an ordered tier tag, and one or more exact `allowedDomains` hostnames. URLs are HTTP(S) templates and may use only documented placeholders.

Extraction tier order:

1. `api`: declarative request plus JSON paths for title, brand, price, promo price, unit, and availability.
2. `embedded-json`: declarative HTML request, embedded source (`json-ld`, `next-data`, or selected script), and JSON paths.
3. `dom`: URL template plus ordered selector lists for all six fields.
4. `script`: only the closed, typed operation list documented by the host schema; never arbitrary JavaScript.

Discovery tier order is `sitemap`, `api`, `dom-crawl`, then the same restricted operation-list `script` tier. Do not include shell commands, code strings, callbacks, imports, scoring claims, or validation claims.
