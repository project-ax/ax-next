# DB-backed routines — design decisions, 2026-10-09

Status: written spec proposed for review, not implemented. See `docs/plans/2026-10-09-db-backed-routines-design.md` on `codex/db-backed-routines`.

User-confirmed choices: DB-only definitions and host tools; agent create/edit approval by default; Allow once and durable Always Allow for this agent only; patch updates with revision checks; short routine instruction plus tool descriptions without injected live definitions. The user explicitly cancelled authored-routine import: delete existing authored routines, while preserving DB-only defaults. No product code until written-spec approval, implementation-plan review, and execution-method selection.

Design references: Figma file `yDka46zOpwgipUxTBWiXuo`, Agent settings page `37:8`, Routines frame `52:877`. Current forms include Enabled, conversation mode, structured optional settings, and a draft webhook URL preview whose path becomes active only on Save.

Code observations for implementation: routine identity/fires/shared conversation keys still carry path; default materialization IDs can be retained as opaque identities. Default editor/catalog retain sourceMd despite being DB-only. IPC redacts ordinary PluginError messages, while decisions host replay treats every returned value as success. Expected tool failures must remain explicit failures without leaking host exceptions. tool.pre-call and tool.execute-host are separate endpoints; routine effects need host-side approval enforcement. Existing personal-owner reconciliation and real-user agents:resolve checks must stay; team agents cannot be pruned from absence in personal-owner enumeration.

Proposals awaiting review: existing scheduler/store evolution, generic token-to-agent/DB-path webhook route, per-human binding within agent-only consent, team admin/owner management policy, offline bounded file retirement plus future-put veto, durable exact-ref credential cleanup, and structured default-editor transport. Do not treat these as already-shipped behavior.

Follow-up: the user approved the written design after commit `b10579304`. The implementation plan is in `docs/plans/2026-10-09-db-backed-routines-implementation-plan.md`, awaiting written-plan review and execution-method selection. Planning clarified logical request IDs for every mutation, stable subscriber priority for preflight before holds, serialized human secret set/delete, revocation-safe idempotent grant delivery, and exact approved-call settlement. No product code or deployment changes have been made.
