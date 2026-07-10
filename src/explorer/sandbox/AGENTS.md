# Exploration sandbox

This disposable workspace contains only redacted evidence. Work only here.

- Probe read-only and politely, using only the exact allowlisted retailer hosts.
- Prefer the lowest robust strategy tier documented in `strategy-schema.md`.
- Do not read environment, credential, authentication, browser-profile, or host files.
- Do not add commands, source code, callbacks, or arbitrary executable fields to a strategy.
- Write exactly one root object with one `strategy` property to `strategy.json`.
- `validate-strategy` is a convenience check. Activation is decided only by the trusted host.
