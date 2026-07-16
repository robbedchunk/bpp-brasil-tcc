# Publication purge runbook

Operator runbook for making this repository publishable. The pre-pilot history
reachable from `origin/main` contains real committed secrets. This document is
a plan only; every step below is executed manually and deliberately by the
author. Order is mandatory: **inventory → rotate → purge → verify**. Per
`SECURITY.md`, credentials are rotated before any history handling, and
rewriting Git history requires the author's explicit approval.

Known secret-bearing objects (identifiers only; values are never reproduced in
this document or in any terminal output):

| Blob (prefix) | Historical path(s) | Nature |
| --- | --- | --- |
| `c28e53d2` | `experiments/discovery_cache/discovery_mercado_carrefour_com_br.json` (~line 8452); same blob also reachable under `_DEPRECATED/` | OpenAI-key-pattern credential |
| `061c4cfd` | `infrastructure/readme.md` line 52 | URI-embedded credentials |
| `2424f2fd` | `final-be/.env` | Committed environment file |

`npm run audit:publication` currently FAILS on these objects. That failure is
correct behavior: the audit walks `git rev-list --all`
(`src/publication/audit.ts`, `historicalEntries`), and the local
remote-tracking refs (`refs/remotes/origin/*`) make the blobs reachable. The
audit must be satisfied by removing the secrets' reachability in the
publication candidate, never by hiding refs from the audit.

## 1. Inventory

Goal: enumerate every secret-bearing blob and every ref that reaches it,
without printing secret values.

1. Machine-readable audit findings (reports rule, safe path, and object id
   only):

       npm run audit:publication -- --json > /tmp/audit-report.json
       jq '.historicalSecrets[] | {ruleId, location, objectId}' /tmp/audit-report.json

2. Resolve each reported object id to its full blob id and all historical
   paths:

       git rev-list --all --objects | grep '^c28e53d2'
       git rev-list --all --objects | grep '^061c4cfd'
       git rev-list --all --objects | grep '^2424f2fd'

3. Find every commit that carries each blob, and the paths at each commit
   (`--name-status` shows paths without showing content):

       git log --all --find-object=<full-blob-id> --oneline --name-status

4. Find every branch and tag that reaches those commits:

       git branch -a --contains <commit>
       git tag --contains <commit>

5. Record the resulting map (blob → paths → commits → refs) in a private note
   outside the repository. Expect the `c28e53d2` blob to appear at two paths
   (the `experiments/discovery_cache/` original and a copy under
   `_DEPRECATED/`); a purge that misses the second path fails verification.

Do not use `git cat-file -p <blob>` during inventory; content inspection is
needed only in step 2.3 below and is limited to variable names.

## 2. Rotation (BEFORE any history handling)

No purge step starts until every credential below is dead at its provider.
A purged-but-live key is still a live key: forks, clones, GitHub caches, and
local backups may retain the old history.

1. **OpenAI-pattern key** (blob `c28e53d2`): revoke the key in the OpenAI
   dashboard (platform.openai.com → API keys). If the project has migrated to
   a successor key, confirm the revoked key is not the one in current
   production `.env`. Verify deadness with an authorization-only request using
   the OLD key from a private shell (expects HTTP 401):

       curl -s -o /dev/null -w '%{http_code}\n' \
         -H "Authorization: Bearer $OLD_OPENAI_KEY" \
         https://api.openai.com/v1/models

2. **URI credentials** (blob `061c4cfd`, `infrastructure/readme.md:52`):
   identify the service the URI points at, rotate or delete that account's
   credentials at the provider, and verify the old URI no longer
   authenticates (connection attempt from a private shell must be rejected).

3. **Committed `.env`** (blob `2424f2fd`, `final-be/.env`): enumerate the
   variable NAMES it contained without printing values:

       git cat-file blob <full-blob-id> | sed -n 's/=.*//p'

   Rotate every credential named there at its provider; treat every entry as
   compromised. Verify each old value is dead the same way as above.

4. Record rotation evidence (credential name, provider, revocation timestamp,
   verification result) in a private note outside the repository. Publication
   is blocked until this note shows every item verified dead.

## 3. Purge options

Two viable paths. Option B is recommended.

### Option A — rewrite `main` with git-filter-repo

Work only in a disposable mirror clone, never in the live production checkout
(`/home/ubuntu-server/projects/tcc-ultra-super`):

    git clone --mirror <origin-url> /tmp/purge-mirror
    cd /tmp/purge-mirror
    git filter-repo \
      --invert-paths \
      --path experiments/discovery_cache/discovery_mercado_carrefour_com_br.json \
      --path infrastructure/readme.md \
      --path final-be/.env \
      --path _DEPRECATED
    # verify (section 4) BEFORE any push, then:
    git push --force --all && git push --force --tags

Tradeoffs, stated honestly:

- Rewrites published history: every commit id after the earliest touched
  commit changes; existing clones, forks, and any commit-id citations break;
  commit signatures are invalidated.
- GitHub retains old objects in forks and in its cache until GitHub Support is
  asked to run garbage collection; a force-push alone does not make the old
  blobs unreachable on the server.
- Path-based removal deletes whole files from history. For
  `infrastructure/readme.md` that erases the entire file's history, not just
  line 52; content-level redaction (`--replace-text`) would require writing
  the secret literals into an expressions file, which this runbook forbids.
- Easy to under-purge: any additional path carrying the same blob (the
  `_DEPRECATED/` copy) must be included, which is why the section 1 inventory
  is mandatory input here.
- Per `SECURITY.md`, this destructive rewrite proceeds only on the author's
  explicit, recorded decision.

### Option B — publish from a clean-history mirror (RECOMMENDED)

Prior analysis showed `feat/full-charter`'s own history is clean (the pilot
branch never contained the pre-pilot secret blobs). Publish that history into
a brand-new repository and leave the old repository private forever:

    git clone --no-tags --single-branch --branch feat/full-charter \
      <origin-url> /tmp/publication-candidate
    cd /tmp/publication-candidate
    # verification (section 4) runs HERE, where rev-list --all sees only the
    # candidate history
    git remote remove origin
    git remote add public <new-empty-repo-url>
    git push public feat/full-charter:main

Tradeoffs, stated honestly:

- The public repository carries only the pilot branch's history; pre-pilot
  commits are not publicly visible (for a thesis pilot this is acceptable and
  arguably desirable).
- The old repository must remain private permanently; it still contains the
  secret blobs and becomes a standing liability if its visibility ever
  changes.
- Stars, issues, and existing clone URLs do not carry over.

Why B is lower risk: nothing is rewritten, no force-push, no dependence on
GitHub-side garbage collection, no chance of a missed blob surviving a
rewrite — the secret-bearing objects are simply never pushed to the public
repository.

## 4. Verification

Run in the publication candidate (the Option B single-branch clone, or the
Option A rewritten mirror re-cloned to a working checkout), not in the live
checkout whose remote-tracking refs still reach the old history:

1. Project audit — expect PASS with zero historical findings:

       npm run audit:publication -- --json | jq '{status, historicalSecrets, findings}'

   Exit code must be 0; `historicalSecrets` must be `[]`.

2. Independent scanner (do not rely on a single tool); either or both:

       gitleaks git --redact .
       trufflehog git file://. --only-verified

3. Confirm none of the inventory blobs are reachable in the candidate:

       git rev-list --all --objects | grep -E '^(c28e53d2|061c4cfd|2424f2fd)' ; echo "exit=$?"

   Expect no matches (grep exit code 1).

4. Re-confirm rotation evidence (section 2.4) is complete and every old
   credential is verified dead. Only then change repository visibility.

## 5. DO-NOTs

- Do NOT prune or delete local remote-tracking refs (`git fetch --prune`,
  `git remote remove origin`, `git update-ref -d refs/remotes/origin/main`) to
  make `audit:publication` pass. The blobs would remain on GitHub; the audit
  failure is a correct signal, not a nuisance.
- Do NOT make the repository public before every rotation in section 2 is
  verified dead and recorded.
- Do NOT commit the author's personal `.docx` (currently untracked in the
  working tree) — not to the current repository and not to the publication
  mirror.
- Do NOT print, log, echo, or paste any secret value anywhere while executing
  this runbook — no `git cat-file -p` of secret blobs into terminals or files,
  no secret literals in `--replace-text` expression files.
- Do NOT run git-filter-repo (or any rewrite) inside the live production
  checkout; use a disposable clone.
- Out of scope here, but tracked separately as a publication blocker: the
  SQLite database size near GitHub's file-size cap is not addressed by this
  runbook.
