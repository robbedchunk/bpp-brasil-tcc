# Security policy

This is a small research repository, not a hosted service. Security-sensitive
reports should be sent privately through GitHub's security-advisory mechanism
after the repository becomes public. Do not place credentials, retailer session
data, private raw pages, personal data, or exploitable details in a public issue.

If a key is exposed, revoke or rotate it before discussing history cleanup. The
publication auditor reports only a rule and safe path/object identifier; it does
not print the matched value. Rewriting Git history is destructive and requires
the author's explicit approval.

Supported runtime versions are those pinned in `package.json` and
`analysis/requirements.txt`. The project does not promise security fixes for
unreleased branches or unsupported runtimes.

The following material must remain outside Git:

- `.env`, OpenAI/Codex credentials, and ntfy topics;
- raw HTML/replay archives and browser profiles;
- local JSONL logs, alerts, locks, and backups;
- SQLite WAL/SHM and migration scratch files;
- raw acceptance-drill receipts;
- Control Room job state under `var/control-room/`.

The BPP Control Room is a local loopback application, not a hosted service. It
refuses non-local binding, CORS, arbitrary SQL/commands/paths, and browser-supplied
credentials. Observation uses a literal read-only SQLite connection and API
contracts omit product URLs, failure messages, replay references, JSON provider
payloads, private paths, PIDs, lock tokens, and raw logs. Mutation endpoints
require same-origin JSON plus an explicit intent header, short-lived preview,
state revalidation, and textual confirmation; the CLI remains the authority for
locks, admissions, budgets, and append-only evidence.

Do not reverse-proxy or expose the Control Room to a LAN/Internet. Remote access,
authentication, multiple users, and roles require a separate security design.

Run `npm run audit:publication -- --json` before sharing a commit or data
snapshot. A failed current-tree or historical scan blocks publication.
