# TASK-434 — full RRF recall on sqlite

**Card:** TASK-434, the last card of rung 2 (`docs/plans/2026-09-20-dem-first-handoff.md` §3.1).
**Spec:** `docs/plans/2026-09-18-dem-first-memory-design.md` §2.3, §4.2, §4.4, §6.5, Appendix B.
**Ports from:** `dem-memory/src/engine/recall.ts` + `dem-memory/src/db/memory-repository.ts`.
**Decisions:** `.claude/memory/decisions/2026-09-19-TASK-434.md`.

## Problem

`memory:facts:recall` is an `about`-only filtered listing ordered by `valid_start DESC, id DESC`.
It *rejects* `query` with `invalid-payload` in both backends. Rung 2's §8 gate passes on that,
but §2.1 defines the rung as "the engine (DEM's store + three-channel recall + RRF + rerank)",
so retrieval is the remainder of the rung — and no rung-4 accuracy number means anything through
a filtered listing.

## Approach

Bring the three surviving channels (sparse FTS5, dense `sqlite-vec`, temporal) plus RRF fusion
and an optional rerank into `@ax/memory-facts-sqlite`, faithfully to `dem-memory` so rung 4
measures the thing rung 1 measured. The graph channel is **not** ported — ablated at rung 0,
deleted in #587.

Two things the card must decide that TASK-421 deliberately left open, both settled in the
decisions shard:

1. **The embedder/reranker seam** is a **hook name + optional model** (`{ hook, model? }`)
   declared under `optionalCalls` with a `degradation` string — the `memory-strata`
   orchestrator / `llm-anthropic` `credentials:get` precedent. Verified: `bootstrap.ts`'s
   `verifyCalls` deliberately skips `optionalCalls`, so an absent producer is non-fatal at boot
   and does **not** drag the plugin into the preset canaries' `PLUGINS_TO_DROP` (the trap
   TASK-423 hit with `database:get-instance`). This also unifies rung 3's write-path embedder
   with this read-path one: one hook, one provider, one credential.
2. **The contract divergence.** `runFactsContract`'s factory gains a `capabilities`
   descriptor. sqlite declares `fusionRecall: true`; postgres stays `false` until TASK-457,
   which then flips one boolean and inherits every fusion case.

**No provider plugin ships here.** With nothing registered at the embedder hook the dense and
rerank channels are absent and `recall` reports `degraded: ['semantic', 'ranking']` — the
designed, observable state of §4.4, not dead code. The card still delivers live value on a
default boot: `query` goes from `invalid-payload` to a working **sparse + temporal RRF** answer.

### Flag semantics (fixing an ambiguity in §4.4)

- `'semantic'` — the dense channel did not contribute (no embedder producer, or the embed call
  failed/timed out).
- `'ranking'` — the rerank step did not run (no reranker producer, or the call failed/timed
  out); results keep RRF order, which is the lexical fallback §4.4 asks for.
- **Both are raised only on a `query` recall.** An `about`-only listing runs no channels, so
  flagging them there would be noise rather than signal.
- `'pending'` keeps its existing meaning and its existing derivation point.

### Timeouts (§4.4, provisional)

embed 1.5 s, rerank 2 s. A timeout degrades with the flag set; it never fails the call.
`store-unavailable` remains an error, never a flag.

## Tasks

Each is independently testable. Test-first throughout (Bug Fix Policy / TDD).

### T1 — `@ax/memory-facts-contract`: capabilities, shared constants, fusion cases

- Extend `FactsBackendFactory`'s return with `capabilities?: { fusionRecall?: boolean }`
  (absent = `false`, so postgres needs no change to keep its current behaviour).
- Make the existing "recall rejects `query` with `invalid-payload`" case run only when
  `fusionRecall` is false; add the fusion cases under the true branch.
- Export the shared constants so TASK-457 cannot drift: `DEFAULT_RRF_K = 60`,
  `DEFAULT_CHANNEL_LIMIT = 40`, `DEFAULT_POOL_SIZE = 40`, and `reciprocalRankFusion` itself
  (one implementation, both engines) — `score += 1/(k + rank + 1)`, ties broken by
  `id.localeCompare`. These are internal constants, not payload fields; Appendix B's "`RRF`,
  `vec0`, `FTS5`, `cosine` do not appear in any payload" still holds.
- Add `poolSize?: number` to `RecallInput` (§2.2 names it; Appendix B records it was renamed
  from `rerankPool` precisely to avoid leaking).
- Fusion contract cases (backend-agnostic, no FTS5/vec vocabulary): a `query` returns rows
  ranked by relevance not recency; a term matching nothing returns empty; agent isolation and
  owner scoping hold under `query`; `activeOnly` still filters; FTS operator neutralization
  (a `-`-prefixed token is literal, not boolean NOT — mirror
  `memory-strata-index-contract`'s Test 8c); `degraded` carries `'semantic'`/`'ranking'` when
  no producer is registered and does **not** carry them on an `about`-only listing.
- Correct the stale doc comment on `RecallInput.query` ("a backend rejects any non-`undefined`
  value with `invalid-payload`") — false the moment T3 lands.

### T2 — sqlite schema: FTS5 + vec0, additive migration, backfill

- FTS5 shadow table over `about`/`relation`/`value`, `id UNINDEXED`, `tokenize = 'porter
  unicode61'` (matches both `dem-memory` and `memory-strata-index-sqlite`).
- `vec0` virtual table, `float[384]`, embeddings stored as `Float32Array` blobs.
- Load `sqlite-vec` via `sqliteVec.load(db)` with `allowExtension: true`, **guarded** — a load
  failure must degrade to sparse+temporal, never fail `openDatabase`. Keep the existing
  exit-safety driver-tracking net.
- Extend the existing `PRAGMA table_info`-guarded `migrateAddColumns` rather than writing a
  second migration helper. Note FTS5/vec0 are separate tables, so the pragma guard applies to
  base-table columns; virtual tables use `CREATE VIRTUAL TABLE IF NOT EXISTS`.
- Populate FTS on `record`, inside the existing transaction. **FTS rows are append-only**;
  staleness is filtered by joining back to the base table at query time, so closure stays the
  base table's sole authority (Invariant 4).
- `reindex` backfills FTS rows and (when an embedder is available) missing vectors — it already
  promises to "rebuild derived indexes", so this is its job, not a new hook.
- Tests extend `schema-migration.test.ts`: an old db gains the new tables; a second
  `openDatabase` is a no-op; a db opened with the extension unavailable still works.

### T3 — sqlite recall: channels, fusion, rerank, degraded probes

- `sparseChannel` — `ORDER BY bm25(...)` **ASC** (native orientation, best first; no negation
  needed since we rank, not surface, the score). Query built by a quoting/dedup sanitizer
  capped at 24 tokens, ported from `buildFtsMatchQuery`.
- `denseChannel` — `WHERE embedding MATCH ? AND k = ?`, over-fetched at `channelLimit * 4`,
  then validity-filtered in application code and truncated to `channelLimit` (vec0 cannot take
  arbitrary predicates alongside `MATCH`).
- `temporalChannel` — the existing recency ordering, reused.
- Fuse with the contract's `reciprocalRankFusion`; rerank the top `poolSize` when a producer
  exists, appending the un-reranked tail; select `limit`.
- Stop rejecting `query`. Keep rejecting it when... nothing: sqlite now implements it.
- **New degraded probes go beside `pendingStatus()` in `pending.ts`**, same shape
  (check → `DegradedFlag[]`), so `recall` stays the single place that assembles the array
  (Invariant 4).

### T4 — the embedder/reranker seam

- `MemoryFactsSqliteConfig` gains `embedder?: { hook: string; model?: string }` and
  `reranker?: { hook: string; model?: string }`.
- Manifest declares each under `optionalCalls` with a real `degradation` string.
- Guard every call with `bus.hasService(hook)`; wrap in the §4.4 timeouts; any failure sets the
  flag and continues. A store failure still throws `store-unavailable`.
- Embedding happens at **both** `record` (task `document`) and `recall` (task `query`) — the
  engine owns the vec0 table, so it owns the document embedding. This is a *different* embedder
  use from §3.3's slot-normalization one, which stays in `@ax/memory`; same hook, different
  caller.
- Payload shape must stay vendor-neutral: `{ texts, task }` → `{ vectors }`, no `cosine`, no
  dimension vendor names. Boundary review goes in the PR body.
- Tests register a deterministic FNV-1a hash embedder (port `hashEmbedder`) on the bus, so the
  dense channel is exercised for real without a network.

### T5 — postgres: declare the capability, correct the stale comments

- Contract factory declares `fusionRecall: false`. No behaviour change.
- Fix the comment divergence the exploration found: sqlite's `query` rejection cites TASK-434
  while postgres's prose cites TASK-457 as owning "those channels". Post-T3 the accurate
  statement is "sqlite implements this; postgres gets it in TASK-457". **Contract rule 5** —
  the stale lines that would regenerate this card get fixed here, not deferred.

### T6 — supply chain + security checklist

- Add `sqlite-vec` **pinned exact** (design §6.5), not `^0.1.6`. Audit the install path
  (prebuilt platform binaries via optional deps) and record it in the security note.
- Run the `security-checklist` skill: new native dependency, untrusted query text reaching a
  query parser, and a new (declared, unregistered) egress-capable hook. Produce the structured
  PR security note.

### T7 — docs

- `docs/plans/2026-09-20-dem-first-handoff.md` §6 board table and §3.1 describe TASK-434 as
  outstanding; add an as-built note rather than rewriting history.
- Design §4.4's "`'semantic'` and `'ranking'` are reserved but never raised until TASK-434" is
  satisfied — record the flag semantics decided above, since the design left "reranker
  unavailable → lexical fallback" underspecified.

## YAGNI pass

| Task | Load-bearing at MVP? |
|---|---|
| T1 capabilities | **Yes** — without it the contract cannot hold both engines. |
| T1 shared RRF | **Yes** — the only thing stopping TASK-457 drifting. |
| T2 FTS5 | **Yes** — the one channel that works with zero providers. |
| T2 vec0 | **Yes** — the card is "full RRF recall"; sparse-only is TASK-434 half-done. |
| T2 reindex backfill | **Yes** — without it, rows recorded before a provider exists are permanently invisible to the dense channel. |
| T3 rerank | **Yes** — named in §2.1's definition of the rung. |
| T4 seam | **Yes** — the dense channel cannot exist without it. |
| T5 | **Yes** — contract rule 5. |
| **Graph channel** | **CUT** — ablated at rung 0, deleted in #587. |
| **Provider plugin** | **CUT to a follow-up card** — needs credential store + egress lock + `PROVIDER_ENDPOINTS`; own security review. |
| **`history`/`at` on the tool** | **CUT** — §4.2 decides against; `activeOnly:false` already exists. |
| **Postgres channels** | **CUT** — TASK-457, gated on TASK-458's pgvector question. |

## Follow-up cards to file

1. **Embeddings provider plugin** registering the embedder hook — credential-store key, egress
   allowlist, `PROVIDER_ENDPOINTS` entry, bearer token + `fetch` (no `google-auth-library`,
   §6.5). Until it lands every deployment reads `degraded: ['semantic','ranking']`.
2. **Reranker provider plugin** — same shape. Note `dem-memory` measured Cohere
   `rerank-v4.0-pro` as **not reproducible** (~22% of top-15 reorders on identical input),
   which matters for any test that pins ordering.
3. **Re-pin `packages/memory-strata`'s `sqlite-vec`** from `^0.1.6` to exact — pre-existing,
   out of scope here, but now inconsistent with this package.

## Gate

`pnpm build && pnpm --filter @ax/memory-facts-sqlite test && pnpm --filter
@ax/memory-facts-postgres test && pnpm --filter @ax/memory-facts-contract build && pnpm lint`,
then the repo gate `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.
Baseline before any change: **111** sqlite / **107** postgres, captured green in this worktree.
