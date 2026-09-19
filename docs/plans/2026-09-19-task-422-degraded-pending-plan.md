# TASK-422 — memory-facts: degraded-mode flags + pending/reindex drain

**Card:** `[TASK-422] memory-facts: degraded-mode flags + pending/reindex drain`
**Design:** `docs/plans/2026-09-18-dem-first-memory-design.md` §3.5, §4.4, §6.4
**Builds on:** TASK-421 (`@ax/memory-facts-contract`, `@ax/memory-facts-sqlite`, PR #603)

---

## 1. The scope decision the card could not make

The card's §4.4 acceptance reads *"embedder unavailable → dense channel skipped,
`degraded: ['semantic']`; reranker unavailable → lexical fallback,
`degraded: ['ranking']`"*. **Neither channel exists at this rung.** TASK-421 cut
free-text/dense/RRF/rerank recall entirely (decisions.md, 2026-09-18) and TASK-434
is the card that builds them — including, by its own card body, the embedder
config seam and the `sqlite-vec` dependency.

Adding an `embedder`/`reranker` config that nothing consumes, purely so a flag can
be raised about it, is exactly what the **Half-Wired Code Policy** forbids: a
dependency seam with no caller, which drifts until TASK-434 rewrites it anyway.

**Decision.** Build the degraded *mechanism* — a real accumulator, a typed flag
vocabulary shared by both backends, and contract cases that assert it surfaces —
with the **one degradation this engine can honestly observe today**, and reserve
`'semantic'`/`'ranking'` in the vocabulary for TASK-434 to push into the same
array. TASK-434 therefore inherits the mechanism rather than reinventing it, which
is what the handoff said this card had to deliver.

**The real degradation at this rung is `'pending'`.** §3.5: an embedder-unavailable
write lands `slot: pending`, and *"pending slot = under-closing, the safe
direction."* A tenant holding un-drained pending rows is a store whose supersession
is incomplete — `recall` can return a value that a later statement should already
have closed. That is a degraded answer in precisely §4.4's sense (*"a signal, not a
quieter answer"*), it costs no new dependency, and it is observable with one
indexed count.

Doc lines that asserted otherwise are corrected in this branch (task 7).

## 2. Also in scope, because the shipped code says so

`recall` currently rejects `activeOnly: false` with *"history not implemented yet
(**TASK-422**)"* — in `plugin.ts` and again in the contract's `RecallInput` doc
comment. Two shipped markers name this card, so leaving history unbuilt leaves two
stale lines behind (contract rule 5). It is ~10 lines and closes the rung-1
knowledge-update gap the design's §4.2 `history` decision was written for.

`record`'s **all-or-nothing** batch (§3.5 bullet 2) is in scope too, because
idempotency is not meaningful without it: a batch that dies halfway and is then
retried under the same `batchKey` would be permanently half-written.

## 3. Out of scope

- Any embedder / reranker / `sqlite-vec` / dense channel / RRF — **TASK-434**.
- `embedding: pending` as a stored column — there is no embedding column until
  TASK-434 adds one. Only `slot: pending` exists to drain here.
- Slot *derivation*. It lives in `@ax/memory` by design (§3.3) and by the
  contract's own stated boundary. `reindex` is told the resolved slots; it never
  computes one.
- `at` / `temporalAnchor` time travel — not built anywhere (§3.3, §4.2).
- The postgres backend and the `presets/k8s` canary — **TASK-423**.
- Repairing closures a RETRACTED row authored. `supersede` never re-settles, and
  `reindex` only re-settles groups a resolved pending row joined — so a victim of
  a retracted closer stays wrongly closed unless some later drain happens to touch
  that `(about, slot)` group. Pre-existing (TASK-421); its own card and boundary
  review, since fixing it changes a shipped hook's semantics.

---

## 4. Boundary review — `memory:facts:reindex` (new service hook)

- **Alternate impl this hook could have:** `@ax/memory-facts-postgres` (TASK-423),
  draining the same pending rows over a `tsvector`/`pgvector` store; plus a
  no-op in-memory backend for product-layer tests.
- **Payload field names that might leak:** none. Input `{ slots?: [{id, slot}] }`
  and output `{ resolved, resettled, pending, degraded }` are the same domain
  vocabulary already on `memory:facts:record`/`recall`. No `rowid`, `table`,
  `sha`, `bucket`, `vector`, `index`.
- **Subscriber risk:** none — service hook, no subscribers. A caller keying off
  `pending` keys off a design-level concept (§3.5), not a backend one.
- **Wire surface:** not an IPC action. No schema file needed.

Why a hook at all rather than a function: two backends must implement it
identically, and the only caller (`@ax/memory`) may not import either (Invariant 2).

---

## 5. Tasks

Each is independently testable. Contract cases land with the behavior they pin,
in `@ax/memory-facts-contract`, and run against the sqlite backend.

### Task 1 — typed degraded vocabulary + `PENDING_SLOT` (contract only)
`packages/memory-facts-contract/src/index.ts`:
- `export type DegradedFlag = 'semantic' | 'ranking' | 'pending'` with a doc
  comment stating which rung produces each.
- `RecallOutput.degraded: DegradedFlag[]` (was `string[]`).
- `export const PENDING_SLOT = 'pending'` — the reserved sentinel, so both
  backends agree on one spelling (Invariant 4). Document that the eight real
  slots (§3.3) cannot collide with it.
- `ReindexInput` / `ReindexOutput` types.
- Correct the now-stale doc comments on `RecordInput.batchKey`,
  `RecallInput.activeOnly` and `RecallOutput.degraded`.
**Load-bearing:** yes — every later task references these.

### Task 2 — store-unavailable → `PluginError` (§4.4 bullet 3)
`packages/memory-facts-sqlite/src/plugin.ts`:
- `requireDriver()` throws `PluginError({ code: 'store-unavailable' })` when the
  driver is absent or closed. Today a post-`shutdown` call throws a raw
  `TypeError` on `driver!`.
- Store-access regions wrapped so a sqlite-level failure surfaces as
  `PluginError({ code: 'store-unavailable', cause })` — never an empty result.
  `PluginError` (e.g. `invalid-payload`) passes through unwrapped; validation runs
  *before* the wrapped region so a bad payload can never be relabelled.
- All four existing hooks + `reindex`.
**Contract cases:** after `teardown()`, each hook rejects with `PluginError` /
`code: 'store-unavailable'`; `recall` specifically does **not** resolve `[]`.

### Task 3 — all-or-nothing batch + `batchKey` idempotency (§3.5 bullets 1–2)
`schema.ts`: add `batch_key TEXT` + `CREATE INDEX idx_facts_batch ON …(agent_key,
batch_key)`, with an additive `PRAGMA table_info`-guarded `ALTER TABLE` so a db
created by TASK-421 migrates rather than silently missing the column.
`plugin.ts` / `closure.ts`:
- The whole batch settles inside **one** `driver.transaction`.
- With a `batchKey`: if the tenant already holds rows for that key, write nothing
  and rebuild the `RecordedStatement[]` from the stored rows (`closes` is
  `SELECT id WHERE closed_by = <row.id>`), preserving input order.
- Without a `batchKey`: unchanged, no dedup.
- Dedup is scoped by `agent_key` — two agents may reuse a key independently.
**Contract cases:** same `batchKey` twice → row count unchanged and the second
call returns the *first* call's ids; a different `batchKey`, same statements →
two rows; no `batchKey` twice → two rows; same `batchKey` on a different agent →
independent; a mid-batch failure leaves **zero** rows (all-or-nothing).

### Task 4 — pending-slot semantics (§3.5 bullet 3)
`closure.ts`: a row whose `slot === PENDING_SLOT` is **inert** — it closes nothing
and nothing closes it (identical to no-slot), rather than forming a bogus
`(about, 'pending')` chain in which unrelated facts would close each other.
**Contract cases:** two pending rows with the same `about` and different relations
both stay active; a pending row neither closes nor is closed by a real-slot row of
the same `about`; a pending row is returned by `recall` like any active row.

### Task 5 — `memory:facts:reindex` (§3.5 bullet 3, §2.2)
`plugin.ts` registers `memory:facts:reindex`:
- `{ slots?: Array<{ id: string; slot: string | null }> }` → `{ resolved: number;
  resettled: string[]; pending: number; degraded: DegradedFlag[] }`.
- For each entry whose row is in this tenant **and currently `PENDING_SLOT`**:
  write the resolved slot (`null` = "no slot after all", legitimately inert).
  A foreign, missing or already-resolved id is ignored, not an error — same
  forgiving shape `supersede` already has.
- Then **re-settle every `(about, slot)` group touched by a resolved row**, in one
  transaction, by re-deriving §3.4's rules from the group's rows: order by
  `(valid_start, transaction_time)`; rows explicitly superseded (`closed_by IS
  NULL` with a finite `valid_end`) are retractions — left exactly as they are and
  excluded as bounding peers, matching `insertWithSlotClosure`'s peer query.
- With no `slots`: resolves nothing and re-settles nothing — it reports status
  (`pending`, `degraded`). Deliberate YAGNI cut: a whole-tenant repair sweep has
  no caller (§2.2's `{}` form stays meaningful as the status read).
**Contract cases:** a pending row resolved to a real slot now closes the older row
of that slot and reports it in `resettled`; resolving to `null` leaves it inert;
resolving a row **backdated into the middle** of an existing chain re-derives the
whole chain (the row it should close, and its own bound per rule 2); provenance
immunity still holds through a reindex; an explicit `supersede` survives a reindex
(a retraction is not resurrected); a foreign-tenant id resolves nothing; `pending`
counts down; a second identical reindex is a no-op.

### Task 6 — real `degraded` + `activeOnly: false` history
`plugin.ts` `recall`:
- Build `degraded` from a real probe: `['pending']` when the tenant holds any
  `slot = PENDING_SLOT` row, else `[]`.
- `activeOnly: false` → no validity filter (active **and** closed rows), per §4.2's
  `history` decision; `activeOnly` omitted or `true` → unchanged. Remove the
  `TASK-422` rejection in `plugin.ts` and the matching contract doc comment.
- `until`/`closedBy` already render on `FactRecord`, so a closed row is
  distinguishable without a new field.
**Contract cases:** `degraded: []` on a clean tenant and `['pending']` once a
pending row exists, dropping back to `[]` after `reindex` resolves it; the existing
"rejects `activeOnly: false`" case is **replaced** by one asserting a closed row
comes back with `until` + `closedBy` under `activeOnly: false` and is still absent
by default; `degraded` is per-tenant (agent A's pending rows do not flag agent B).

### Task 7 — wiring, docs, memory
- `packages/cli/src/__tests__/memory-facts-wiring.test.ts`: assert `memory:facts:
  reindex` is reachable from a real CLI boot too (Invariant 3 — the standard
  TASK-421 set for this package).
- Design doc §3.5/§4.4: annotate which degraded flags exist at which rung, so the
  next reader does not re-file this card's premise. §2.2: `reindex`'s real payload.
- `docs/plans/2026-09-19-dem-first-handoff.md` §3.1/§3.2: record what this card
  actually shipped and what TASK-434 inherits.
- Board card body: the re-scope, so the card and the code agree.
- `.claude/memory/decisions.md`: the §1 scope decision and each review response.

---

## 6. YAGNI pass

| Task | Load-bearing at MVP? |
|---|---|
| 1 vocabulary + `PENDING_SLOT` | Yes — one spelling for two backends (Invariant 4). |
| 2 store-unavailable | Yes — §4.4's third bullet, verbatim card acceptance. |
| 3 batch idempotency + atomicity | Yes — `chat:end` fires twice (§3.5); atomicity is what makes the retry safe. |
| 4 pending inertness | Yes — without it `slot: 'pending'` corrupts closure instead of deferring it. |
| 5 reindex | Yes — without it `pending` is a one-way trap and §3.5's drain does not exist. |
| 5 whole-tenant repair sweep | **No — cut.** No caller. |
| 6 degraded probe | Yes — the accumulator TASK-434 extends. |
| 6 `activeOnly: false` | Yes — two shipped code comments name this card for it. |
| — embedder/reranker config seam | **No — cut to TASK-434**, which owns the shape. |

## 7. Security

No sandbox boundary, no IPC, no plugin loading, **no new dependency**, no spawn, no
network, no caller-provided filesystem path. `reindex`'s only caller-provided values
are `id` (matched, never interpolated) and `slot` (a bound parameter). SQL stays
fully parameterized. `security-checklist` is therefore not triggered by this diff —
it *is* triggered by TASK-434 (`sqlite-vec`, embedder egress), which its card notes.
