# TASK-421 — `@ax/memory-facts-contract` + `@ax/memory-facts-sqlite`

Implementation plan. Scope: the closure/tenancy contract for the DEM-first memory
engine (design doc `docs/plans/2026-09-18-dem-first-memory-design.md` §2.1–2.2,
§3.4), sqlite backend only. Deferred (see `decisions.md`): slot derivation (lives in
`@ax/memory`, not the engine), full RRF/dense/rerank recall, postgres (TASK-423).

## Task 1 — `@ax/memory-facts-contract` scaffold + `runFactsContract`

New package `packages/memory-facts-contract`, modeled on
`packages/memory-strata-index-contract` (same `package.json`/`tsconfig.json` shape;
`vitest` as a runtime dependency since the package exports a test-suite function).

`src/index.ts` exports:
- Hook I/O types mirroring design doc §2.2's engine table: `RecordInput`
  (`{batchKey, statements: [{about, relation, value, when, slot?, provenance,
  ownerUserId, conversationId?}]}`), `RecallInput`/`RecallOutput`
  (`{about?, activeOnly?, limit} → {statements: [{id, about, relation, value, when,
  until?, provenance, closedBy?}], degraded: string[]}` — `query` accepted on the
  input type for forward-compat with TASK-424 but this contract never exercises it),
  `SupersedeInput` (`{ids}`), `ClearInput` (`{}`).
- `FactsBackendFactory` (mirrors `IndexBackendFactory`): `(bus: HookBus) =>
  Promise<{plugin: Plugin; teardown: () => Promise<void>}>`.
- `runFactsContract(label, factory)` — a `describe` block, same
  `beforeEach`/`afterEach` shape as `runIndexContract`, calling
  `memory:facts:record|recall|supersede|clear` over the bus.

**Cases, ported from `dem-memory/tests/slot-supersession.test.ts` (translate
`subject→about`, `predicate→relation`, `object→value`, `validStart→when`; drive
through `memory:facts:record` + `memory:facts:recall`, not direct SQL):**

- Rule 1 — closes exactly the previous row of the same `(about, slot)`; closes
  across different relations sharing a slot; leaves other slots/subjects alone;
  records `closedBy`; settles within one batch, arrival order.
- Rule 2 — two-sided: a backdated row closes itself at the earliest later row, not
  the latest; the returned record reports the closure, not just the store.
- The "one (subject, slot) history is a non-overlapping chain" property, all six
  arrival orders of three values (Boston/Seattle/Denver-shaped).
- Rule 3 — provenance immunity, both directions (extracted can't close/bound human;
  human closes extracted; agent closes extracted but not vice versa); defaults to
  `extracted`.
- Rule 4 — equal `when`: later write wins.
- "Closure reaches retrieval": a closed row drops out of `memory:facts:recall`'s
  default (activeOnly) results.
- `memory:facts:supersede` — closes named ids, reports which; leaves `closedBy`
  null (told apart from a rule-closure); refuses a foreign-tenant id (scoped by
  `ctx.agentId`, not a payload field); idempotent re-close reports nothing.
- Per-agent isolation, mirroring `memory-strata-index-contract` Tests 10–11
  (TASK-186/TASK-257 pattern): not-pooled (two agents' same-`about`/`slot` writes
  don't clobber or leak into each other's recall/supersede/clear), AND partition-is-
  `agentId`-alone (two users on the SAME agent share one history; the same user on a
  DIFFERENT agent is isolated) — pin this directly per the TASK-257 lesson in
  `patterns.md`: an isolation-only case is satisfied by the wrong partition.
- `invalid-payload` rejection: a malformed `record`/`recall` input (e.g. non-
  positive `limit`) throws `PluginError` with `.code === 'invalid-payload'`.

**Not ported** (see decisions.md): anything from `temporal-invalidation.test.ts`
(`invalidates-previous` mode, `temporalAnchor`) — not built here.

## Task 2 — `@ax/memory-facts-sqlite`

New package `packages/memory-facts-sqlite`, modeled on
`packages/memory-strata-index-sqlite`'s `plugin.ts`/`schema.ts`/`agent-scope-key.ts`
shape (better-sqlite3, Kysely optional — raw driver is enough here, no FTS/vec
needed since recall doesn't search).

- **`agent-scope-key.ts`** — hand-copy `agentScopeKey(ctx) =>
  sha256(JSON.stringify([ctx.agentId])).slice(0,16)` byte-for-byte from
  `memory-strata-index-sqlite`'s copy (same derivation, Invariant 2 forbids
  importing it). Own pinned-vector test (`__tests__/agent-scope-key.test.ts`) with
  the SAME literal digests as the sibling copies, per the TASK-257 lesson.
- **`schema.ts`** — one table, better-sqlite3, own close-on-exit safety net (copy
  the `openDrivers` Set + `process.once('exit', ...)` pattern verbatim — it's what
  keeps an unclosed better-sqlite3 handle from SIGABRT on teardown):
  ```sql
  CREATE TABLE IF NOT EXISTS memory_facts_v1 (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL,
    about TEXT NOT NULL,
    relation TEXT NOT NULL,
    value TEXT NOT NULL,
    slot TEXT,
    provenance TEXT NOT NULL CHECK(provenance IN ('extracted','agent','human')),
    owner_user_id TEXT,
    conversation_id TEXT,
    valid_start TEXT NOT NULL,
    valid_end TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z',
    transaction_time TEXT NOT NULL,
    closed_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_facts_slot ON memory_facts_v1(agent_key, about, slot, valid_end);
  ```
- **`closure.ts`** — port `insertWithSlotClosure` from
  `dem-memory/src/db/memory-repository.ts` (rules 1–4, the `bound`/`closed`
  transaction) verbatim in shape, scoped by `agent_key` instead of `bank_id`,
  `PROVENANCE_RANK` copied from `dem-memory/src/types.ts` (small enough to
  duplicate, not worth a shared package per Invariant 2).
- **`plugin.ts`** — registers the four services on `bus`:
  - `memory:facts:record` — per statement with a `slot`, call the closure insert;
    without one, plain insert (mirrors dem-memory: "a statement with no slot skips
    all of it"). `batchKey` accepted on the payload, stored nowhere yet (TASK-422
    adds idempotent-batch dedup — see decisions.md).
  - `memory:facts:recall` — `SELECT ... WHERE agent_key = ? [AND about = ?] AND
    valid_end = INFINITY_SENTINEL ORDER BY valid_start DESC LIMIT ?` (the
    activeOnly-only cut; `degraded` always `[]` here — TASK-422 adds real
    degraded-mode). Throws `invalid-payload` on `limit <= 0`.
  - `memory:facts:supersede` — the explicit-close UPDATE (`closed_by` stays
    NULL), scoped by `agent_key`, silently no-ops a foreign/missing id (reports it
    absent from the returned list, per dem-memory's `supersede`).
  - `memory:facts:clear` — delete all rows for `agent_key`.
- **`index.ts`** — factory export, `MemoryFactsSqliteConfig` (databasePath).

## Task 3 — wire + gate

- Add both packages to root `tsconfig.json`'s `references`.
- `pnpm build && pnpm --filter @ax/memory-facts-sqlite test && pnpm --filter @ax/memory-facts-contract build`
- Whole-repo `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts` +
  `pnpm lint` (Phase 4 gate — full command per CLAUDE.md, not the bail-prone short form).
- File the TASK-424 follow-up card (full RRF/dense/rerank recall + embedder config
  seam) on the board in Phase 4/6, per decisions.md.

## YAGNI pass

- Postgres backend: explicitly out (TASK-423, gated in Backlog).
- `query`/dense/sparse/RRF/rerank recall: out (new TASK-424 follow-up).
- `memory:facts:reindex`, pending-row handling, degraded flags: out (TASK-422).
- `batchKey` idempotency: out (TASK-422) — accepted on the payload but unused this
  task, which is safe (no dedup ≠ wrong dedup).
