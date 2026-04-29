---
'@ax/storage-sqlite': minor
'@ax/audit-log': minor
'@ax/cli': minor
---

Smallest viable end-to-end: four plugins (`@ax/llm-mock`, `@ax/storage-sqlite`, `@ax/audit-log`, `@ax/cli`) that compose into a running CLI. Sending a message through `@ax/cli` invokes the kernel's `chat:run`, gets back a canned `"hello"` from the mock LLM, and the audit plugin persists the outcome to SQLite via `storage:set`. This is the first slice with multiple plugins wired through the hook bus; `@ax/sandbox-subprocess`, IPC primitives, and `ax.config.ts` discovery are deferred to Week 4+.
