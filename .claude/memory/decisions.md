# Decisions

Architectural / process decisions. Never deleted — strikethrough if reversed.

| Date | Decision | Rationale | Alternatives |
|---|---|---|---|
| 2026-04-23 | Ship `storage:get` / `storage:set` without `database:get-instance` abstraction | YAGNI until a second backend exists; architecture doc Section 6 defers this until `@ax/storage-postgres` lands | Introduce the abstraction now (rejected: premature, no second impl to validate shape) |
| 2026-04-23 | Ship `storage:get` without a runtime consumer in Week 3 | Symmetric API with `storage:set`; consumer (session lookup) lands Week 4+. Documented waiver in PR #2 | Wait until Week 4 to register `storage:get` (rejected: half-wired feels worse than a one-slice-early symmetric pair) |
| 2026-04-23 | `@ax/audit-log` owns the `chat:<reqId>` key namespace in storage | One-source-of-truth invariant — any other plugin wanting to read audit records does so through a future service hook, not by reading the key directly | Shared key convention across plugins (rejected: violates invariant #4) |
