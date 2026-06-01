# TASK-104 — Fix postgres-testcontainer teardown 57P01 flake at root

## Problem

Under parallel full-suite CI load, packages that start a `PostgreSqlContainer`
intermittently emit an **uncaught** `error: terminating connection due to
administrator command` (Postgres `57P01`) during `afterAll`/teardown. When
`container.stop()` sends SIGTERM to postgres, the server kills any connection
still bound to a pool. A `pg.Pool` created in a test has **no `'error'`
listener**, so Node re-emits that connection error as an `uncaughtException`,
and vitest counts an uncaught exception during teardown as a suite failure even
though every assertion passed.

Confirmed error shape (reproduced locally):
`{ code: "57P01", message: "terminating connection due to administrator
command", name: "error" }`, arriving as an **uncaughtException**.

TASK-103 only raised the startup `hookTimeout` (a band-aid for a different,
container-START flake). TASK-8 fixed one *specific* source (unawaited
better-auth adapter-init). This card fixes the *general* teardown race at root.

## Approach

A single **shared teardown helper** in `@ax/test-harness`, used by every
postgres-testcontainer suite, so there is no per-package drift:

```ts
await stopPostgresContainer(container);   // replaces `await container.stop()`
```

`stopPostgresContainer`:

1. Installs a temporary `uncaughtException` + `unhandledRejection` guard that
   **swallows only** the benign 57P01 shape (`code === '57P01'`, or the
   "terminating connection due to administrator command" message). Anything
   else is re-thrown (re-emitted) so real errors still fail the suite.
2. `await container.stop()`.
3. Waits one macrotask tick so a straggler socket error that surfaces just
   *after* stop() resolves is still caught, then removes the guard (restoring
   any pre-existing listeners untouched).
4. No-ops when `container` is undefined (matches the existing
   `if (container) await container.stop()` guard).

This is the card's preferred "shared teardown helper" and the "swallow the
benign 57P01 during teardown" option combined — pools that *are* drained in
`afterEach` keep working as before; pools that race the stop no longer fail the
suite.

We keep the existing `afterEach` pool-draining as-is (it's correct and reduces
the window); the helper is the deterministic backstop the card asks for.

## Tasks

### Task 1 — `stopPostgresContainer` helper + unit test (TDD)

- `packages/test-harness/src/stop-postgres-container.ts` — the helper.
  Typed against a minimal `{ stop(): Promise<unknown> } | undefined` so it does
  NOT add a runtime dependency on `@testcontainers/postgresql` in the harness
  package (test-harness must not pull a test-only container lib into its prod
  deps). Export from `src/index.ts`.
- `packages/test-harness/src/__tests__/stop-postgres-container.test.ts`:
  - swallows a 57P01 uncaughtException raised during stop() → resolves, no
    process crash, returns normally.
  - swallows a 57P01 by message even when code is absent.
  - re-throws / does NOT swallow a non-57P01 uncaughtException.
  - removes its listeners afterward (no leak: listener count back to baseline)
    and leaves pre-existing listeners intact.
  - no-ops on `undefined`.

### Task 2 — Migrate every postgres-testcontainer suite to the helper

Mechanically replace `await container.stop()` / `await container?.stop()` in
`afterAll` with `await stopPostgresContainer(container)` across all
postgres-testcontainer packages (audit-log/database/eventbus/session/
storage-postgres, memory-strata-index-postgres, agents, channel-web,
attachments, auth-better, conversations, connectors, host-grants, onboarding,
routines, skills, teams, cli, mcp-client, credentials-store-db — every file in
the `grep PostgreSqlContainer` set). Add the `stopPostgresContainer` import to
each touched file. ~100 files, ~106 call sites.

Leave non-postgres `.stop()` calls (bridge/listener/handle) untouched.

### Task 3 — Whole-suite verification

Repair the stale worktree node_modules (`pnpm install --frozen-lockfile` — the
`tmp@0.2.5` dangling symlink predates this work). Build + lint + run a
representative set of the migrated suites (agents, channel-web, storage/
database/eventbus/session-postgres) and confirm clean teardown.

## YAGNI pass

- Helper kept to exactly the 57P01 guard + stop — no configurable matchers, no
  retry logic. Load-bearing only.
- Do NOT refactor the per-package `afterEach` pool-draining — it's correct and
  out of scope; touching ~100 afterEach blocks is churn with no added safety
  over the helper backstop.

## Boundary review

Test-harness-only; no hook surface, no IPC, no plugin manifest change, no
production code path. No boundary review required. Security-checklist not
required (no sandbox/IPC/untrusted-input/dependency surface — the helper adds
no new dependency).
