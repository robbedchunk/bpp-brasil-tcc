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
