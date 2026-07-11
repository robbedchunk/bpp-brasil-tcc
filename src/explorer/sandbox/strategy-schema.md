# Strategy artifact schema

The artifact is a strict JSON object: `{ "strategy": Strategy }`. Unknown fields are invalid.

Every strategy has `schemaVersion: 1`, a matching `purpose`, an ordered tier tag, and one or more exact `allowedDomains` hostnames. URLs are HTTP(S) templates and may use only documented placeholders.

Extraction tier order:

1. `api`: declarative request plus JSON paths for title, brand, price, promo
   price, unit, and availability. A VTEX API may additionally declare
   `regionalContext: { "kind": "vtex-segment", "regionId": "v2.…", "salesChannel": "2", "catalogSellerId": "1" }`;
   the trusted host derives the public region selector at request time and, when
   declared, selects the externally validated catalog seller by identity. Never
   store Cookie, Authorization, Set-Cookie, or Proxy-Authorization headers.
2. `embedded-json`: declarative HTML request, embedded source (`json-ld`, `next-data`, or selected script), and JSON paths.
3. `dom`: URL template plus ordered selector lists for all six fields.
4. `script`: only the closed, typed operation list documented by the host schema; never arbitrary JavaScript.

Extraction API and URL templates may use only `{productUrl}`, `{externalId}`, and
`{sourceCategory}` placeholders, for example
`https://host/api/products/{externalId}/offers`. An extraction request template
MUST reference the sampled product through one of these placeholders: each of
the 30 validation samples binds to a different product.

Discovery tier order is `sitemap`, `api`, `dom-crawl`, then the same restricted
operation-list `script` tier. API discovery may use `{page}`, `{pageSize}`,
`{offset}`, `{from}`, `{to}`, `{cursor}`, and `{segment}` placeholders. When
`{segment}` is used, declare bounded `segments` entries with `value`,
`maxProducts`, and (when the response lacks category data) `sourceCategory`;
the allocations together must not exceed `maxProducts`. Prefer exhaustive
food-category segments over a narrow keyword search. Do not include shell
commands, code strings, callbacks, imports, scoring claims, or validation claims.
