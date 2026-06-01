# TASK-105 — memory-strata contract.test: shut down plugin pools to silence benign 57P01 log noise

Parent: TASK-104 (durable `stopPostgresContainer()` fix). This is the explicit
followup that note left open.

## Problem

`packages/memory-strata-index-postgres/src/__tests__/contract.test.ts` defines an
`IndexBackendFactory` that `runIndexContract` invokes **per test** (in `beforeEach`).
Each invocation creates a fresh `createDatabasePostgresPlugin({ connectionString })`
and calls `dbPlugin.init(...)`, which opens a `pg.Pool` with a `pool.on('error')`
listener that LOGS the pg `57P01` ("terminating connection due to administrator
command") when the testcontainer is stopped in `afterAll`.

Because the factory never calls `dbPlugin.shutdown()`, every per-test pool stays open
until `stopPostgresContainer` stops the container. The plugin pool's error listener
then logs `database_postgres_pool_error` once per orphaned pool. This is **handled**
log noise (the listener catches it; the suite stays green) — NOT the uncaught 57P01
flake TASK-104 root-fixed. Log noise only.

## Root cause

`dbPlugin.shutdown()` (which calls `kysely.destroy()` → drains the `pg.Pool`
gracefully) is never invoked for the per-iteration plugin instances. The contract's
`teardown` callback only truncates the table; it doesn't own/close the db plugin.

## Fix (test-harness only, no production change)

In `contract.test.ts`, have the `factory` capture the `dbPlugin` it just created and
`await dbPlugin.shutdown()` inside the returned `teardown` callback (after the
truncate, or before — order doesn't matter since shutdown only drains the plugin's own
pool, while the truncate uses the separate `adminDb`). Each per-test plugin is shut
down at the end of its own test, so the pool is drained gracefully (no SIGTERM-induced
57P01) well before the container stops.

This mirrors the sqlite sibling (`memory-strata-index-sqlite/contract.test.ts`), whose
`teardown` cleans up the per-iteration resource (its tmpdir).

## Tasks

1. **Track + shut down the per-iteration db plugin in `teardown`.**
   - Hoist `dbPlugin` so the `teardown` closure can reference it (it already lives in
     the factory scope).
   - In `teardown`: `await dbPlugin.shutdown?.();` alongside the existing truncate.
   - `shutdown` is best-effort/idempotent (the plugin guards `kysely !== undefined`),
     so a missing-table or already-stopped container won't throw a new error.

2. **Verification = no 57P01 log noise at teardown.**
   - Run the suite and capture stdout/stderr; assert NO `database_postgres_pool_error`
     / `57P01` line appears. (Before the fix it appears once per test iteration.)
   - This is a test-file change, so the "test that would have caught it" is the
     observable: the suite output is clean. Document the before/after capture in the
     PR. There is no production unit under test to add a vitest assertion to — the
     contract suite itself is the harness; a green run with clean logs is the evidence.

## Out of scope / YAGNI

- No change to `createDatabasePostgresPlugin` (production) — it already exposes
  `shutdown()` and the `pool.on('error')` logger is correct/intentional for prod
  (idle-pool socket failures during a real k8s postgres restart must be logged, not
  crash the process).
- No change to `runIndexContract` — the contract is storage-agnostic; pool lifecycle
  is the backend factory's concern, exactly where this fix belongs.
- No change to `stopPostgresContainer` — it already handles the uncaught case; this is
  the orthogonal handled-noise case.

## Acceptance

- `contract.test.ts` shuts down every plugin it creates; no 57P01 log noise at teardown.
- `pnpm build`, `pnpm test` (the package), `pnpm lint` (changed files) green.
