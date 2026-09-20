# TASK-423 — `@ax/memory-facts-postgres` + `presets/k8s` wiring

**Status:** EXECUTED 2026-09-19 — Tasks A, B and C all shipped. `presets/k8s` now pushes
`@ax/memory-facts-postgres` unconditionally, so the "loads no facts backend today" framing
below is historical.
**Card:** `[TASK-423]` · **Spike:** `docs/plans/2026-09-19-task-423-postgres-facts-spike.md`
**Design:** `docs/plans/2026-09-18-dem-first-memory-design.md` §2.1, §3.4, §3.5, §4.2, §4.4, §6.1

The second backend behind `memory:facts:*`, and **the card that makes the engine
reachable in production** — `presets/k8s` loads no facts backend today.

---

## 1. Settled before this plan (do not re-litigate)

From the spike, already merged as #615:

- **No FTS, no vector, no RRF.** `runFactsContract` has none; `recall` must *reject*
  `query` with `invalid-payload` exactly as sqlite does. TASK-457 owns the channels.
- **`valid_start`/`valid_end` are `TEXT`**, sentinel included. Every ordering
  comparison runs in JS inside `settleArrival`; the SQL only compares the sentinel by
  equality in the closure rules, which run in JS. (Corrected during review: `recall`
  DOES order by `valid_start` in SQL — what makes that safe is the canonical
  fixed-width shape of every stored instant, not the absence of SQL ordering. See
  `schema.ts`'s comment for the accurate version and the real revisit trigger.) Put the revisit-trigger in a comment.
- **The plugin does not own the pool.** Borrow the Kysely via `database:get-instance`
  at `init`, no `shutdown()` — copy `@ax/memory-strata-index-postgres`.

## 2. The one thing the spike got slightly wrong, in our favour

The spike framed "the contract tears the store down mid-test" as needing a *new*
factory shape. It doesn't: `memory-strata-index-postgres`'s contract factory
**already** creates a per-test `createDatabasePostgresPlugin({connectionString})`,
inits it on the contract's bus, and `await dbPlugin.shutdown?.()` in teardown.

So the shape is a straight copy. The only *new* requirement is that the facts
contract actually **calls hooks after that teardown** and demands
`store-unavailable`. Two consequences to verify rather than assume:

1. The plugin must capture the Kysely **at `init`** (strata does). A destroyed
   Kysely then throws on use, which `inStore` maps to `store-unavailable`.
2. `teardown()` is called **twice** for the store-unavailable cases — once by the
   test, once by `afterEach`. It must be idempotent.

## 3. Tasks

### Task A — the package (scaffold → contract green)

`packages/memory-facts-postgres/`, modelled on `memory-strata-index-postgres` for
plumbing and `memory-facts-sqlite` for behaviour.

- **Scaffold:** `package.json` (deps `@ax/core` + `kysely` pinned `0.28.17`;
  devDeps `@ax/database-postgres`, `@ax/memory-facts-contract`, `@testcontainers/postgresql`
  `11.14.0`, `pg`, `@types/pg`, `@ax/test-harness`), `tsconfig.json`, `vitest.config.ts`,
  and a reference in the root `tsconfig.json`.
- **`agent-scope-key.ts`** — byte-identical derivation, its own copy (Invariant 2),
  with the **pinned-vector test** using the same literal inputs/digests as its siblings.
  The isolation cases cannot catch derivation drift; only the pins can.
- **`schema.ts`** — table `memory_facts_v1`, same columns, `INFINITY_SENTINEL`. All
  `TEXT`. Idempotent DDL at `init` via Kysely's `sql` tag (`CREATE TABLE IF NOT
  EXISTS` + three `CREATE INDEX IF NOT EXISTS`), **no migrations table** (repo
  convention). `ADD COLUMN IF NOT EXISTS` for `batch_key`/`batch_seq` — no
  `PRAGMA table_info` dance.
- **`closure.ts`** — async port. **`settleArrival` is pure JS and ports unchanged**;
  that is the payoff of TASK-422 extracting it. `insertWithSlotClosure`,
  `resettleSlotGroups`, `supersedeIds` become async and take a transaction handle.
- **`pending.ts`** — `pendingStatus`, async.
- **`plugin.ts`** — the five hooks, async `inStore`, manifest
  `calls: ['database:get-instance']`, **no `shutdown()`**.
- **`__tests__/contract.test.ts`** — one container per file; per-test
  `createDatabasePostgresPlugin` + `dbPlugin.shutdown()` in an **idempotent** teardown;
  `TRUNCATE` at **setup**, not teardown (a test may have consumed the teardown).
  `runFactsContract('@ax/memory-facts-postgres', factory)`.

**The three traps the card names — each would pass a careless test:**

| Trap | Why it bites | What to do |
|---|---|---|
| `.changes === 0` is the **sole authority** on what `supersede` closed — and since TASK-448 it drives the re-settle too | Kysely returns `numUpdatedRows` as a **`bigint`**; `bigint > 0` works but `=== 0` against a number does not | Use `RETURNING`, or compare `numUpdatedRows` as bigint deliberately. Same for `reindex`'s `resolveSlot` |
| `COUNT(*)` comes back a **bigint rendered as a string** | `ReindexOutput.pending` is typed `number`, compared `toBe(0)`; uncast you get `"0"` — truthy, wrong type, and `degraded` silently inverts | Cast in SQL (`::int`) or `Number()` at the edge, and assert the type |
| `rebuildBatch` runs a per-row query inside `.map()` | Free on better-sqlite3, **N network round-trips** on postgres | One grouped query |

**Gate for Task A:** `pnpm --filter @ax/memory-facts-postgres test` green, with the
**same case count** the sqlite backend gets from `runFactsContract` — a lower number
means cases were skipped, which is a finding, not a pass.

### Task B — `presets/k8s` wiring + canaries

- `presets/k8s/src/index.ts`: **unconditional** `plugins.push(createMemoryFactsPostgresPlugin())`,
  **not** behind `config.hostLlmTools`. That gate exists for the host-LLM-tools bundle;
  a facts engine has no LLM dependency, and the CLI pushes its sqlite twin
  unconditionally.
- `presets/k8s/src/__tests__/preset.test.ts` — the 43-name literal sorted array, plus a
  canary asserting the plugin registers **all five** hooks
  `memory:facts:record|recall|supersede|clear|reindex`, modelled on
  `packages/cli/src/__tests__/memory-facts-wiring.test.ts`.
- `prod-bootstrap.test.ts` — `REQUIRED_PROD_PLUGINS`.

### Task C — retire the stale lines this card closes (contract rule 5)

The half-wired window is closed by this PR, so the prose saying it is open must go:

- `packages/cli/src/main.ts` — the "(b) no K8S BACKEND yet … unreachable in production
  until TASK-423 ships" comment block.
- `docs/plans/2026-09-19-dem-first-handoff.md` §3.3 and its §6 board table.
- `docs/plans/2026-09-19-task-423-postgres-facts-spike.md` — mark the spike's
  recommendation as executed.
- Grep the **prose** spellings too: `unreachable in production`, `no facts backend`,
  `half-wired window`, `TASK-423 ships`.

## 4. Boundary review

**No hook signature changes.** This is a second implementation of an existing
surface — `memory:facts:record|recall|supersede|clear|reindex`, already boundary-
reviewed under TASK-421/422/448. The payloads are untouched.

The alternate-impl question those reviews answered is *this card*: the contract now
has two backends, which is the test that the abstraction was real. Anything that
cannot be expressed on both is the leak, and `runFactsContract` is where it shows.

`calls: ['database:get-instance']` is an existing hook, consumed the same way
`memory-strata-index-postgres` consumes it.

## 5. YAGNI

| Item | Load-bearing? |
|---|---|
| The five hooks, async | Yes — the contract. |
| `TEXT` columns | Yes, and cheaper than the alternative (spike §1.1). |
| Per-test db instance in the factory | Yes — the `store-unavailable` cases are the §4.4 rule. |
| `presets/k8s` wiring + both canaries | Yes — the card's whole point. |
| A migrations table | **No — cut.** Repo convention is idempotent DDL at init. |
| FTS / tsvector / pgvector | **No — cut to TASK-457.** |
| A `shutdown()` on the plugin | **No — cut.** The pool is not ours. |

## 6. Security

No new **direct** dependency that isn't already in the repo (`kysely`, `pg`,
`@testcontainers/postgresql` all present). No sandbox, IPC, plugin-loading or
untrusted-content boundary. All SQL parameterized; DDL fully static. Tenancy is
`agentScopeKey(ctx)` on every read and write, identical to sqlite.

One thing genuinely new: this is the first time facts data lands in the **shared
production postgres** rather than a per-deployment sqlite file. Tenancy is therefore
load-bearing in a way it was not before — the contract's isolation cases plus the
pinned derivation vectors are what prove it, and both must run here.
