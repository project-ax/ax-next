# TASK-444 — "Not now" is a durable, need-triggered deferral

**Date:** 2026-09-20 · **Branch:** `auto-ship/TASK-444-durable-decline`

## The defect

`GrantRow.reject()` (`packages/channel-web/src/components/workspace/GrantRow.tsx`)
clears the local draft and drops the row. Nothing reaches the server. The pending
card is still in `ChunkBuffer`'s `skillCards` map, so the next mount fetch of
`GET /api/workspace/grants` (TASK-373's read-back) hands it straight back. The
person is re-asked a question they already answered, and the only way they can
tell is by reloading.

The file's own comment asserts the opposite is fine — *"Turning a grant down is
PURELY LOCAL — no network call … There is nothing to tell the server"*. That
sentence is the stale line this card was filed against, so rewriting it ships
here (yolo-ship autonomy rule 5).

## The product decision (settled 2026-09-19, not re-litigated)

"Not now" is a **deferral, need-triggered — never time-triggered**.

- Record the refusal **durably, server-side**, on the `(user, agent, grant)`
  triple, so it survives a reload *and* a sign-out.
- The prompt returns **only when an agent action genuinely requires that grant
  again**. No timer, no `deferred_until`, no "on next login".
- Keep the label "Not now"; add a hint so the copy matches the behaviour.
- No half-typed secret survives the decline (cross-check TASK-389).

## What re-raises a grant today (the mechanism the design keys off)

| Path | When | Is it a genuine need? |
|---|---|---|
| `chat:permission-request` → `appendPermissionCard` → SSE frame | the agent just asked | **yes** |
| `GET /api/workspace/grants` → `pendingGrantsForUser` | every workspace mount | **no** — a replay of an already-answered question |

So the deferral is expressed as: **a decline suppresses the replay, and a newer
raise outranks an older decline.** Nothing else is needed, and in particular no
timer is.

`pendingGrantsForUser` returns `skill` and `connector` cards only — `host` cards
are turn-scoped and deliberately unenumerable (chunk-buffer.ts:210-222). A host
"Not now" therefore *cannot* come back on reload and stays purely local; making
it durable would be actively wrong, because a later session that hits the same
wall is a genuine new need.

## Design

### 1. `raisedAt` on the pending card (`server/chunk-buffer.ts`)

`skillCards` holds `PermissionRequest[]`. Change the internal element to
`{ card, raisedAt }`, stamped from an injectable clock on **both** insert and
replace-in-place — a re-proposal for the same subject is a fresh need, so it
gets a fresh instant. `tailPermissionCards` keeps its public shape;
`pendingGrantsForUser` gains `raisedAt`.

### 2. The durable marker (`server/grant-declines.ts`, new)

Stored through the existing generic KV hooks `storage:get` / `storage:set` /
`storage:list-prefix` — the same substrate `@ax/branding` and `@ax/audit-log`
already persist through, and present in **both** presets (`@ax/storage-sqlite`
in the CLI, `@ax/storage-postgres` in k8s).

```
key   grant-decline:<enc(userId)>:<enc(agentId)>:<enc(kind)>:<enc(subjectId)>
value TextEncoder().encode(JSON.stringify({ declinedAt: <epoch ms> }))
```

Every segment is `encodeURIComponent`'d, so a `:` or `/` in an id (all of which
come from a manifest the agent authored — untrusted at every hop, invariant 5)
cannot escape its own namespace or forge another user's prefix.

Rejected alternative: a new `@ax/grant-declines` plugin with its own postgres
table. It is the conventional shape and it is the right answer if declines ever
need enumerating in Settings — but it costs a migration, a testcontainers
suite, and ten registration points (root + preset tsconfig, preset
package.json, preset index, the exhaustive `preset.test.ts` name list, two
`PLUGINS_TO_DROP` sets, `prod-bootstrap.test.ts`, a changeset) for one
timestamp. Logged as a follow-up rather than built.

### 3. `POST /api/workspace/grants/decline`

Body: `{ agentId, kind: 'skill' | 'connector', subjectId }`. **No storage key on
the wire** (invariant 1) and no client-supplied timestamp.

1. `authOr401`.
2. Look the grant up in `buffer.pendingGrantsForUser(userId)` and require an
   exact `(agentId, kind, subjectId)` match. The request can therefore only
   decline something that is genuinely pending *for the caller* — the client's
   `agentId` is validated against authoritative state, never trusted.
   No match → `404 { error: 'grant-not-pending' }`.
3. No `storage:set` service → `503 { error: 'declines-unavailable' }`. Never a
   silent success: a refusal we failed to record is one that will come back.
4. Write `{ declinedAt: now() }` and answer `200 { declined: true }`.

### 4. The filter in `GET /api/workspace/grants`

One `storage:list-prefix` on `grant-decline:<enc(userId)>:`, then drop any
pending grant whose marker has `declinedAt >= raisedAt`. A grant re-raised after
the decline has the newer `raisedAt` and comes straight back — that is the
need-trigger, and it needs no write and no timer. Both instants come from the
same host process (channel-web is single-replica by construction, plugin.ts J8).

Without `storage:list-prefix` the route answers exactly as it does today and the
degradation is declared in the manifest.

### 5. Client

- `workspace-api.ts`: `declineGrant(agentId, kind, subjectId)`.
- `GrantRow.reject()` becomes async for the `skill`/`connector` arm. It clears
  the draft **and the in-render `values`** first — the person's intent is
  withdrawal, so the half-typed secret goes whether or not the POST lands — then
  POSTs. Success → `resolveAndReturnFocus()`. Failure → `setError(...)` and the
  row **stays**, because a decline the server never heard is a decline that will
  come back and saying so is the honest ending. `host` keeps today's purely
  local path.
- `grant-copy.ts`: `GRANT_REJECT_HINT = "We'll only ask if it's needed again."`,
  rendered beside the button on both arms (it is true of both). Label unchanged.

## Tasks

1. **T1 (server, chunk-buffer)** — `raisedAt` + clock seam + tests.
2. **T2 (server, declines)** — `grant-declines.ts`, the POST route, the filter,
   manifest `optionalCalls`, route tests. Depends on T1.
3. **T3 (client)** — api client, `GrantRow.reject`, copy, tests. Independent of
   T1/T2 at the file level.
4. **T4** — gate, memory shard, PR.

## Boundary review

No new **hook** is added and no hook signature changes — `storage:get/set/
list-prefix` are consumed as they stand. The new **IPC/wire** surface is
`POST /api/workspace/grants/decline`, whose schema lives in this plugin
(`routes-workspace.ts` + `lib/workspace-api.ts`).

- *Alternate impl:* the marker could move to a `@ax/grant-declines` plugin
  behind a `grant-declines:record|list` hook without the wire payload changing
  one field — which is the test that the payload is storage-agnostic.
- *Fields that might leak:* none. `agentId`, `kind`, `subjectId` are product
  vocabulary; no `key`, no `prefix`, no timestamp crosses the wire.
- *Subscriber risk:* none — no subscribers.

## Out of scope (follow-ups)

- A first-class `@ax/grant-declines` plugin/table if declines ever need to be
  listed or revoked from Settings.
- `PermissionCard.tsx` (chat) keeps its local-only reject: TASK-360 deletes that
  tree, and giving it the hint would promise durability it does not have.
