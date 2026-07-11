# Reproducible thesis analysis

The analysis reads a verified CSV snapshot under `data/exports/`; it never opens
the live SQLite database. Run the complete export and analysis pipeline with:

```bash
npm run research:snapshot
```

Direct invocation is also available after `npm run analysis:setup`:

```bash
var/analysis-venv/bin/python analysis/generate.py \
  --input data/exports \
  --output analysis/output
```

Outputs are immutable per input snapshot: `success-rate.png`,
`healing-events.csv`, `index-vs-ipca.png`,
`index-coverage-and-dispersion.csv`, and `manifest.json`. Empty but schema-valid
inputs produce labelled no-data figures. The retailer range is descriptive and
is not a confidence interval; the experimental index makes no statistical
validation claim.

The input `latest.json` is accepted only when its snapshot ID, relative path,
and manifest hash all identify the same immutable snapshot. Reusing an existing
analysis snapshot re-verifies every output byte count, row count, and SHA-256
before republishing its pointer. The analysis manifest records the five
consumed CSVs with their required columns and integrity evidence as well as the
four generated artifacts.

The healing table retains onset-run, drift-start, detection, and recovery
timestamps. The coverage/dispersion table retains source coverage rows even
when no aggregate index point exists and includes covered weights, sample
counts, descriptive bounds, and every exclusion count. Figure annotations label
drift detection and recovery separately; the index footnote documents promo
preference, seven-day product carry, equal retailer weighting, renormalized POF
weights, the non-validation caveat, and the CEP/SNIPC geography difference.

`ops/setup-analysis.sh` rebuilds the pinned environment whenever the
requirements digest or Python major/minor version changes. Destructive rebuilds
are restricted to the project `var/analysis-venv` path or an explicitly
identified disposable test root.
