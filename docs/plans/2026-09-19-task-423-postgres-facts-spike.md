# TASK-423 spike — what `@ax/memory-facts-postgres` actually needs decided

**Date:** 2026-09-19 · **Status:** spike complete; TASK-423 recommended **un-gated** —
**recommendation EXECUTED 2026-09-19**. The card was un-gated, built, and merged:
`@ax/memory-facts-postgres` exists and `presets/k8s` loads it unconditionally. The
sparse/dense channels went to **TASK-457** exactly as §5 recommends. Implementation plan:
`docs/plans/2026-09-19-task-423-postgres-facts-plan.md`. Everything below is the spike as
written, kept for its reasoning — read §0's tense as historical.
**Card:** `[TASK-423] memory-facts-postgres engine (gated — needs FTS/vector design spike)`
**Reads:** `docs/plans/2026-09-18-dem-first-memory-design.md`, `docs/plans/2026-09-19-dem-first-handoff.md`

---

## 0. The headline: the gate is stale

TASK-423 sits in **Backlog** because its card says the FTS-equivalent
(`tsvector`/`pg_trgm`?) and vector-equivalent (`pgvector`?) choices must be made
before it is a PR-sized slice. **That premise no longer holds**, and it stopped
holding the moment TASK-421 shipped.

`runFactsContract` — the whole of what a second backend must satisfy — contains
**no free-text search and no dense search**. `recall` takes `about` + `limit` +
`activeOnly` and nothing else; `query` is *rejected* with `invalid-payload`
("not implemented yet (TASK-434)"), and a postgres backend must reject it
identically. There is no FTS5 in `@ax/memory-facts-sqlite` either — TASK-421 cut
the channels and TASK-434 is the card that builds them.

So the sparse/dense question for postgres is not merely undecided, it is
**premature**: it asks postgres to match a channel that does not exist on the
sqlite side yet. Deciding it now would be designing against `dem-memory`'s
implementation rather than against the contract postgres actually has to pass —
and TASK-434 may well change the shape when it ports those channels for real.

**Recommendation: move TASK-423 to To Do with the FTS/vector question removed
from its scope**, and let the card that ports TASK-434's channels to postgres own
that decision, when there is a sqlite implementation to match. That card does not
exist yet and is filed as part of this spike (§5).

This matters beyond tidiness: at the time of this spike `presets/k8s` loaded **no
facts backend at all**, so `memory:facts:*` was unreachable in production. TASK-423
was the only card that closed that window, and it had been blocked on a question it
does not need to answer. *(Closed: the preset now pushes `@ax/memory-facts-postgres`
unconditionally — not behind `config.hostLlmTools`, which gates the memory-strata
bundle because that bundle needs an `ANTHROPIC_API_KEY` and a facts engine needs no
LLM at all.)*

## 1. What TASK-423 *does* need decided

The real difficulties are not retrieval. They are that **`better-sqlite3` is
synchronous and `pg` is not**, and that two contract cases were written against a
driver the plugin owns.

### 1.1 `valid_start` / `valid_end`: **`TEXT`, not `timestamptz`** — DECIDED

Store both as `TEXT`, exactly as sqlite does, including the
`'9999-12-31T23:59:59.999Z'` sentinel.

The instinct is that postgres `TEXT` ordering is collation-dependent and therefore
dangerous. **It is not load-bearing here.** Every ordering comparison in the
closure rules runs **in JavaScript**, inside `settleArrival` — `peer.valid_start <=
arrival.when`, `peer.valid_end > arrival.when`, and a `localeCompare` tiebreak. So
the closure *rules* are collation-immune because they never reach the database.

> **Corrected during TASK-423's review.** This section originally added "the SQL only
> ever compares the sentinel by equality", and that is **false** — `recall` orders by
> `valid_start` in SQL, on both backends. The conclusion survives but the reason is
> different: what makes the ordering safe is that every stored instant is canonical
> fixed-width `YYYY-MM-DDTHH:MM:SS.sssZ` (enforced by `normalizeIsoInstant`), with
> the sentinel in the identical shape, so lexicographic order agrees with
> chronological order under any collation. It matters because the revisit trigger
> below was written as "if ordering moves into SQL" — which had *already happened*,
> so as written it could never fire. The accurate trigger, and the accurate reason,
> are in `packages/memory-facts-postgres/src/schema.ts`.

`timestamptz` would buy collation-independent `ORDER BY` — but it costs more than it
buys:

- `rowToFactRecord` decides whether to emit `until` by comparing `valid_end !==
  INFINITY_SENTINEL` **as a string**. A `timestamptz` round-trip returns a JS `Date`,
  so that predicate has to be re-derived. Getting it wrong makes **every active row
  report `until`** — the contract catches it, but it is a gratuitous trap.
- `normalizeIsoInstant` hands the caller back a canonical string verbatim as `when`.
  A `timestamptz` round-trip must reproduce it **byte-for-byte, including the
  trailing `.000Z`**, or the contract's `JAN`/`JUN`/`SEP` comparisons fail.

Both stored instants are already canonical fixed-width (`YYYY-MM-DDTHH:MM:SS.sssZ`,
enforced at the write door), so lexicographic order agrees with chronological order
under any collation anyway.

**Revisit if and only if** a future card pushes an ordering or range comparison down
into SQL — which TASK-434's temporal channel plausibly will. At that point
`timestamptz`, or a `C`-collated column, becomes the right call. Write that trigger
into the code, not just here.

### 1.2 The `store-unavailable` contract cases vs. "the plugin must not own the pool"

This is the one genuine architectural conflict, and it is resolved in the **test
factory**, not the plugin.

`@ax/memory-strata-index-postgres` deliberately has **no `shutdown()`**: it borrows a
Kysely instance via `database:get-instance` and the pool belongs to
`@ax/database-postgres`. Correct, and the facts backend must do the same.

But `runFactsContract` tears the store down *mid-test* and then requires all five
hooks to reject with `store-unavailable` rather than return an empty result. That is
one of the most valuable things the contract asserts — it is the §4.4 rule that a
failed store is never a quiet empty answer — so it must not be weakened for postgres.

**Resolution:** the postgres factory gives **each test its own
`@ax/database-postgres` instance** whose `shutdown()` really destroys the Kysely,
rather than sharing one pool across all cases (which is what the strata-postgres
contract does — it only `TRUNCATE`s). Reset state at **setup**, not teardown, because
a test may have consumed the teardown already. Then verify that Kysely's
post-`destroy()` error maps to `store-unavailable` through `inStore` — and
specifically that it is **not already a `PluginError`**, since `inStore` passes those
through untouched.

### 1.3 Three silent-translation traps, all load-bearing

- **`.changes === 0` is the sole authority on what `supersede` closed.** Postgres
  needs `RETURNING` or Kysely's `numUpdatedRows` — which is a **`bigint`**. Same for
  `reindex`'s `resolveSlot.run(...).changes`. Get this wrong and `supersede` reports
  closing rows it did not, which now also drives the re-settle (TASK-448).
- **`COUNT(*)` comes back from `node-postgres` as a `bigint` rendered as a string.**
  `pendingStatus` feeds `ReindexOutput.pending`, typed `number` and compared with
  `toBe(0)`. An uncast count yields `pending: "0"` — truthy, wrong type, and
  `degraded` derived from it silently inverts.
- **`rebuildBatch` does a per-row `closesOf.all(...)` inside a `.map()`.** Free in
  better-sqlite3, N network round-trips on postgres. Make it one grouped query.

### 1.4 Async reshaping

`inStore<T>(hookName, run: () => T): T` becomes async, and every call site awaits.
`insertWithSlotClosure`, `resettleSlotGroups`, `supersedeIds` and `pendingStatus` are
all synchronous and all use prepared-statement reuse inside loops. The **replay logic
itself (`settleArrival`) is pure JS and ports unchanged** — that is the payoff of
TASK-422 having extracted it.

Note Invariant 2 means the postgres package carries its **own copy** of these
helpers, as `agent-scope-key.ts` already does. Keep the pinned-vector parity test.

### 1.5 Schema

Same columns, same three indexes. Postgres gets `ADD COLUMN IF NOT EXISTS`, so the
`PRAGMA table_info` dance is unnecessary — `schema-migration.test.ts` already says so
in a comment. Follow the repo-wide convention: idempotent DDL at `init()`, no
migrations table, version by table name.

## 2. Wiring, which the card already owns

Unconditional `plugins.push` in `presets/k8s/src/index.ts` — **not** behind
`config.hostLlmTools`. The strata indexer sits behind that gate because it is part of
the host-LLM-tools bundle; a facts engine has no LLM dependency, and the CLI pushes
its sqlite twin unconditionally.

Two canaries must be updated together, and both are literal lists that will fail
loudly: `presets/k8s/src/__tests__/preset.test.ts` (a 43-name sorted array) and
`prod-bootstrap.test.ts`'s `REQUIRED_PROD_PLUGINS`.

**Card correction:** TASK-423's acceptance says the canary asserts
`memory:facts:record|recall|supersede|clear`. That is **stale** — TASK-422 added a
fifth hook. It must assert `reindex` too, matching
`packages/cli/src/__tests__/memory-facts-wiring.test.ts`.

## 3. What this spike deliberately does NOT decide

The sparse and dense channels, because nothing needs them yet (§0). For the record,
when that card comes, the precedent is already in the repo and is good:
`@ax/memory-strata-index-postgres` uses a `GENERATED ALWAYS … STORED` `tsvector` with
a GIN index and `websearch_to_tsquery` + `ts_rank`, mirroring its sqlite twin's FTS5 +
`bm25()`, with score orientation normalized in the mappers and operator neutralization
pinned by a shared contract case. `pg_trgm` is used nowhere in the repo.

## 4. A finding worth its own card: pgvector is assumed, never verified

`deploy/charts/ax-next/templates/postgresql-init-job.yaml` runs
`CREATE EXTENSION IF NOT EXISTS vector` as a post-install hook — and swallows failure:

```
|| echo "pgvector not available in this image (non-fatal — memory plugins requiring
   vector will fail later if needed)."
```

Nothing in the repo proves `bitnamilegacy/postgresql:17.6.0-debian-12-r4` ships
pgvector. No chart test references `EXTENSION` or `vector`; `MANUAL-ACCEPTANCE.md`
has no step for it. And **no test lane could exercise it anyway** — every
`PostgreSqlContainer` in the repo is `postgres:16-alpine`, which has no `vector`.

So the default embedded deployment may have no vector capability at all, and the
`||` makes that indistinguishable from success. That is a silent failure in exactly
the class this project cares about, and it will be discovered by whoever builds the
dense channel unless it is checked first. Filed separately (§5).

> **Resolved by TASK-458 (2026-09-26).** The image *does* ship pgvector — 0.8.0,
> measured with a `docker run` against
> `sha256:926356130b77d5742d8ce605b258d35db9b62f2f8fd1601f9dbaef0c8a710a8d`. The Job no
> longer swallows the answer: it fails the install when `CREATE EXTENSION` fails or no
> `pg_extension` row appears, and `deploy/charts/ax-next/__tests__/pgvector-bootstrap.test.ts`
> runs the rendered script against the chart's image (must succeed) and against
> `postgres:16-alpine` (must fail) in CI's `helm-render` lane. The "no test lane could
> exercise it" line is still true of the `PostgreSqlContainer` lanes — TASK-457 needs a
> pgvector-capable image there.

Also noted: tests run postgres **16**, both deployments run **17**. `websearch_to_tsquery`
parameter parsing has already bitten once on 16.

## 5. Cards this spike produces

- **TASK-423** — un-gate to To Do, FTS/vector removed from scope, canary corrected to
  five hooks, §1's decisions folded into the body. **DONE** — un-gated, built and
  merged 2026-09-19; the canary asserts all five hooks.
- **New** — port TASK-434's sparse + dense channels to postgres. Gated on TASK-434,
  and *that* is where the `tsvector`/pgvector decision belongs. **Filed as TASK-457.**
- **New** — prove or disprove pgvector on the embedded image, and stop the init Job
  swallowing the answer (§4).
