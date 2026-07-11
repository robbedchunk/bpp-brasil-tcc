# Trusted strategy-validation activation

Active discovery and extraction strategies require a 30-reference schema-v2
receipt signed by this host. The Ed25519 private signing key is runtime state at
`var/operations/validation-attestation-private.pem`: it is mode 0600, ignored by
Git, never printed, and included in the private operational backup alongside the
SQLite database. Its public verification key is tracked at
`ops/validation-attestation-public.pem`, so a fresh clone can verify historical
receipts without receiving the private signer.

One-time (and safely idempotent) initialization is:

```sh
npm run strategies:key:init
```

The receipt `keyId` is the SHA-256 digest of the canonical public key. Losing the
private key prevents this host from signing successor receipts but does not make
tracked historical receipts unverifiable. Replacing it creates a different
public key and key ID and is an explicit signing-key rotation, never a silent
receipt rewrite.

`ops/setup.sh` verifies an already-restored pair or creates a pair only when no
tracked public key exists. On an ordinary fresh clone it stays verification-only
instead of inventing a signer that cannot match the tracked key. Only for a
database with no strategy rows does setup register retailer and strategy
identities in safe inactive bootstrap mode; it never silently activates from
config summaries. A new host can verify the database and receipts with the
tracked public key and must restore the matching private key only before signing
a new validation. An empty bootstrap must first import or independently populate
an authoritative catalog of at least 30 in-scope references per retailer.

From a clean implementation commit, the complete activation command is:

```sh
npm run strategies:validate -- --retailer all --purpose all --update-config --activate
```

The command uses the real Node 24, Playwright, and Chromium host executors. It
paces logical requests by at least 500 ms, writes each previously absent receipt
without headers or bodies, signs it only after execution, updates config
timestamps/aggregates/digests only after all selected validations finish, and
then registers immutable receipt evidence before setting a strategy active.
Injected test transports, clocks, browsers, or runtimes always produce signed
`test` receipts with `activatable=false`.

The command is restartable. It writes a signed, content-bound private journal
under ignored `data/validation/rollouts/` before the first request. The journal
contains host-local config paths and is never published. A retry verifies and
reuses an already-published receipt only when its signature, strategy version,
exact independent challenge, source commit, and validator-bundle digest still
match. It then reconciles the config binding and exact database activation
idempotently. After an interruption that has modified retailer validation
metadata, the launcher deliberately reuses the original `dist` bundle instead
of rebuilding from a dirty tree. Missing or mismatched evidence is never
overwritten. Trusted-host attempts below 27/30 are preserved automatically in
`data/validation/attempts/` and require a successor strategy version.

The exploration/healing path uses the same runner from the committed bundled
`dist/scripts/validate-strategies.js`. Each candidate is checked against a
preselected authoritative challenge in a private temporary config directory;
only an activatable receipt is atomically published to its canonical path. The
receipt signature and all sample hashes are reverified inside the strategy
activation transaction, which inserts `strategy_validation_evidence` before
the inactive candidate can become active. An aggregate-only validator report,
test-mode receipt, wrong key, missing receipt, or direct active SQL insert fails
closed without retiring the previous strategy.

Receipt paths are immutable per retailer, purpose, and strategy version. An
existing different file is never overwritten, and an activated database row
cannot be rebound to a different receipt. Revalidation with different evidence
therefore requires a successor strategy/evidence version. Commit the resulting
receipt and config metadata together; never add the private signing key to Git.

To inspect without activating, omit `--update-config --activate`. To initialize
identities without a key or receipts, use:

```sh
npm run retailers:register -- --bootstrap-inactive
```
