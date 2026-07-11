# Classification review evidence

Human review is an explicit author action. The software selects and validates
the sample, but it never invents reviewed labels.

After a classification version contains at least 200 rows, export its stable
stratified template. The primary strata cross retailer, assigned/abstained
decision, and confidence band (`<0.80`, `0.80–0.89`, `>=0.90`); deterministic
round-robin selection within each stratum also balances predicted sub-item
labels before filling additional rows:

```bash
tsx scripts/classification-review.ts export \
  --version 1 \
  --output data/reviews/classification-review-v1.csv
```

Fill only the `reviewed_label` column. Each value must be an in-scope
seven-digit SNIPC sub-item code, `unclassified`, or `out_of_scope`; all other
columns are hash-bound and immutable. Then evaluate the completed file:

```bash
tsx scripts/classification-review.ts evaluate \
  --input data/reviews/classification-review-v1.csv \
  --reviewer-id opaque-review-session-id \
  --output data/acceptance/evidence/classification-review-v1.json
```

Use a non-identifying opaque review-session ID; the public result retains only
its SHA-256. The result also contains hashed classification references, labels, aggregate
precision/agreement, and per-stratum metrics. It omits product titles, reviewer
identity, free-text comments, URLs, and provider payloads. Acceptance checks the
result against the immutable classification rows and deterministic sample.
