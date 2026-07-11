# Exploration sandbox

This disposable workspace contains only redacted evidence. Work only here.

- Probe read-only and politely, using only the exact allowlisted retailer hosts.
- Prefer the lowest robust strategy tier documented in `strategy-schema.md`.
- Do not read environment, credential, authentication, browser-profile, or host files.
- Do not add commands, source code, callbacks, or arbitrary executable fields to a strategy.
- When present, `old-strategy.json` is the currently ACTIVE strategy for this retailer and purpose. DEFAULT to reproducing it exactly, including `regionalContext`, query parameters (such as `sc`), headers, and field paths. Its `regionalContext` values and store/channel query parameters are public runtime configuration, not credentials or secrets: copy them verbatim. Nothing in `old-strategy.json` is sensitive because it is already sanitized. Depart ONLY in the specific parts that `failures.json` shows failing (for example, an endpoint now returns 404), and keep every other part unchanged. Regenerating the same strategy is acceptable because the trusted host revalidates it live.
- Write exactly one root object with one `strategy` property to `strategy.json`.
- `validate-strategy` is a convenience check. Activation is decided only by the trusted host.
