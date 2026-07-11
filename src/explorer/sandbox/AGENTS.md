# Exploration sandbox

This disposable workspace contains only redacted evidence. Work only here.

- Probe read-only and politely, using only the exact allowlisted retailer hosts.
- Prefer the lowest robust strategy tier documented in `strategy-schema.md`.
- Do not read environment, credential, authentication, browser-profile, or host files.
- Do not add commands, source code, callbacks, or arbitrary executable fields to a strategy.
- When present, `old-strategy.json` is the currently ACTIVE strategy for this retailer and purpose. It may be healthy or drifted: start from its verified endpoints, field paths, and query shapes, and adapt rather than reinvent. Depart only where `failures.json` shows that approach failing (for example, an endpoint now returns 404). Regenerating the same strategy is acceptable because the trusted host revalidates it live.
- Write exactly one root object with one `strategy` property to `strategy.json`.
- `validate-strategy` is a convenience check. Activation is decided only by the trusted host.
