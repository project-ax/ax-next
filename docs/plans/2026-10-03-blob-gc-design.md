# Blob GC and blob ledger release (TASK-723)

Design note. Nothing in ax-next ever frees blob bytes: attachments, published
artifacts, skill bundles and branding logos stay on the volume forever, and each
one stays charged to whoever uploaded it in `disk_quota_v1_usage` forever. So a
person who hits the storage limit (TASK-690) has no way back under it. Deleting
an agent gives back its git workspace (TASK-719) but not its files.

This doc decides how to free them without ever freeing a blob someone still
needs. That second half is the whole job. A wrong blob delete is unrecoverable:
the bytes are content-addressed and shared, so one bad delete can take a file
out from under a person who never touched the thing that was deleted.

Card: TASK-723 (parent TASK-719). Origin:
`docs/plans/2026-09-29-storage-freeing-followups.md`, "Explicitly not in this
PR". Related: `docs/plans/2026-09-29-workspace-disk-quota.md` (TASK-690).

Every fact below was read from code on 2026-10-03 at `d4ce10af`. None of it was
run. The plan's first task re-checks the ones marked **(verify)** against a real
Postgres before anything depends on them.

## What the card claimed, and what reading showed

All six card findings hold. Some details sharpen them:

| # | Card claim | What the code says |
|---|---|---|
| 1 | No one can answer "is sha X still referenced?" | Confirmed. References live in **seven columns across three plugins**: `attachments_v1_files.sha256` and `attachments_v1_artifacts.sha256` (`@ax/attachments`); `bundle_tree_sha` on `skills_v1_skills`, `skills_v1_user_skills`, `skills_v1_catalog_requests` and `skills_v1_authored` (`@ax/skills`); and the `light`/`dark` pointers in the `settings:branding` JSON (`@ax/branding`). None of those sha columns has an index. No hook takes a sha. |
| 2 | `blob:put` racing `blob:delete` loses data | Confirmed in both backends. fs `BlobStore.put` returns early when `fs.stat(finalPath)` finds a file; s3 `put` returns early when `HeadObject` succeeds. Neither touches a timestamp. So: put sees the file, delete removes it, put returns success, the caller writes a row pointing at nothing. |
| 3 | Unreferenced blobs exist by design | Confirmed, and there are more windows than the card listed. **Every** writer puts the blob first and writes its referencing row second, in a separate step with no transaction: `attachments:commit`, the runner's `blob.put` then `artifact.publish`, `writeTree` then the skills row insert, branding `blob:put` then `storage:set`. A blob is legitimately unreferenced for a moment after every put, not just on the runner's rowless path. `artifacts:publish-blob` still writes a row for a runner-supplied sha with no `blob:stat`. |
| 4 | No listing hook | Confirmed. Backends register `blob:put`, `blob:put-internal`, `blob:get`, `blob:stat`, `blob:delete`. Nothing calls `blob:stat` outside tests. |
| 5 | `blob:delete` has one caller: a replaced branding logo | Confirmed (`packages/branding/src/routes.ts`, "Phase 3"). It checks only the branding record's own two variants. A logo whose bytes match a person's attachment deletes that person's file. |
| 6 | Ledger release is per (owner, sha) | Confirmed. `disk_quota_v1_usage` is keyed `(owner_id, source = 'blob:<sha>')`. Re-putting the same bytes refreshes `updated_at` (the upsert sets it), which this design relies on. Blob rows are charged to the acting **user**, never to `team:<id>`. |

Three more facts that shape the design:

7. **The hook bus fails OPEN on a throwing subscriber.** `HookBus.fire` catches a
   subscriber's throw, logs it, and `continue`s
   (`packages/core/src/hook-bus.ts`, `fire`). Any design that asks "does anyone
   object to deleting X?" through `fire` reads a crashed reference holder as
   "no objection". For a delete, that is the data-loss direction. The design
   below cannot rely on a veto alone.
8. **References already disappear in a few places today.** Agent delete
   hard-deletes the agent's conversations, and `conversations:purged` makes
   `@ax/attachments` delete their file and artifact rows (TASK-718). Republishing
   an artifact at the same `(conversation, path)` overwrites the row's sha. A
   replaced branding logo, a deleted or updated user skill, and a decided
   catalog request also drop a sha. These are the real sources of reclaimable
   bytes. **A person deleting a conversation is still a soft delete**, so it
   frees nothing, and this design does not change that (see "Not in scope").
9. **Prod is a single host replica** (`values.yaml`, `replicas: 1`) on the `fs`
   backend. The design must still be correct for S3 with several replicas,
   because both backends ship and nothing stops an operator scaling out. So no
   in-process locks as the safety mechanism.

## The decisions

### D1. Ask every holder at GC time (a collector), not a reference registry

**Decision.** At sweep time the GC asks every plugin that stores blob references
which of a batch of candidate shas it still references, and who for. Each holder
answers from its own tables. There is no central reference table.

**Why.** A registry (`blob:ref` / `blob:unref` on every write and delete) is a
second copy of facts that already live in the holders' rows. That is invariant 4
(one source of truth) broken on purpose. It would also be a dual write with no
shared transaction: a row insert that commits while its `blob:ref` call fails,
or the reverse, makes the registry lie, and a registry that under-counts deletes
live data. It would need a backfill over every existing row before the first
sweep could trust it. A collector reads the truth each time, needs no backfill,
and cannot drift.

**Cost.** A sweep issues one batched query per holder table per batch. That needs
an index on each of the seven sha columns (additive migrations, see D7). Sweeps
are hourly and batched, so the load is small.

### D2. The collector fails CLOSED, through a holder roster

Because `fire` swallows a throw (fact 7), the collector is not a veto. It is a
**transform** hook. Each holder appends its own answer to the payload, and the GC
checks who answered:

```ts
// subscriber hook, fired by @ax/blob-gc (and by @ax/disk-quota, D6)
interface BlobCollectRefsPayload {
  candidates: string[];            // ≤ 1000 lowercase-hex sha256
  answers: Array<{
    holder: string;                // the answering plugin's own name
    ok: boolean;                   // false = "I could not check" → caller aborts
    refs: Array<{ sha256: string; userIds: string[] }>;  // userIds may be []
  }>;
}
```

The GC then fails closed in three ways:

- **A holder that answers `ok: false`** (its query threw; the holder catches its
  own error and says so) aborts the whole sweep. Nothing is retired.
- **A holder that throws anyway** never appends an answer. The GC keeps a
  persisted **roster**: the set of holder names that have ever answered. A sweep
  in which a roster member is missing aborts and logs `blob_gc_holder_missing`.
  This catches a crashed holder, and it also catches a preset change that stops
  loading a plugin whose rows are still in the database.
- **A ref for a sha that was not a candidate** is ignored. A ref with an empty
  `userIds` means "held, but not by a person" (global skills, branding). The
  bytes are kept, and nothing is released from the ledger for it.

Removing a holder from the roster on purpose (a plugin really retired) is an
operator action, `POST /admin/storage/blob-gc/roster/forget { holder }`, logged
and admin-only. That is the only way a roster shrinks.

**Bootstrapping the roster.** On a fresh install the roster is empty, so the
first sweep has nothing to compare against. A static test pins the expected set
(below), and the GC starts in **report mode** (D8). The roster gets populated
long before anything is ever deleted.

**Static guard.** A test in the canary/preset suite loads the prod preset and
asserts that every plugin whose manifest `calls` `blob:put` also `subscribes`
`blob:collect-refs`. The exception list is exactly `@ax/ipc-core`, which puts on
the runner's behalf; the runner's references are the rows `@ax/attachments`
writes. A new blob writer that forgets to become a holder fails CI before it can
cause a delete.

**Trust note.** A `fire` transform subscriber can rewrite or drop earlier
answers, and the GC cannot see that happen. Dropping one is caught by the
roster. Rewriting one is not. All holders are in-process, first-party plugins,
so this is the same trust any transform hook already grants. Accepted and
stated here.

### D3. Deleting is two-phase: retire, then purge, and a read restores

The put/delete race (fact 2) and the put-then-row window (fact 3) can both be
closed with a lock. But the lock would have to span replicas (a Postgres
advisory lock per sha) and every put, and still not cover a put whose fast path
ran before the lock was taken. Instead, a delete is made **recoverable** until
it is provably safe:

1. **Retire.** Move the blob out of the live namespace into a retired one. fs:
   `rename(<root>/<aa>/<bb>/<sha>, <root>/.retired/<aa>/<bb>/<sha>)` (same
   volume, atomic). s3: `CopyObject` to `<prefix>retired/<key>`, then
   `DeleteObject` on the live key. Nothing is gone yet.
2. **Read restores.** `blob:get` and `blob:stat` that miss the live key check the
   retired one. If it is there, they move it back (fs `rename`; s3 copy then
   delete) and serve it. A restore that loses a race with another restore and
   sees `ENOENT` / `NoSuchKey` re-reads the live key once.
3. **Purge** happens no sooner than `retentionMs` (default **7 days**) after
   retire, and only after a **second** collector pass over that sha says nobody
   holds it. If someone does hold it now, the GC restores it instead.
   Purge only ever deletes the **retired** key, never the live key.

Why this closes the race without a lock:

- *Put's fast path sees the file, then retire moves it, then put returns
  success.* The caller writes its row. The blob is in `retired/`. Any read
  restores it. If nothing reads it for 7 days, the purge pass sees the new row
  and restores it. Nothing is lost.
- *Retire happens first, then a put of the same bytes.* Put misses the live key
  and writes a fresh copy. Purge later deletes only the retired copy.
- *Two sweeps at once* (two replicas). Retire, restore and purge are each
  idempotent. A sweep also takes `pg_try_advisory_lock(<blob-gc key>)` and skips
  if another replica holds it. That is for efficiency, not for safety.

The one remaining loss case: a holder writes a reference to a sha **more than
`retentionMs` after the put it came from**, and nobody reads the blob in between.
No writer behaves like that today (each writes its row seconds after its put).
The runner's rowless `blob.put` with no conversation is unreachable already
("degraded path" in `artifact-publish-executor.ts`), so losing it loses nothing
a person could open.

### D4. A grace window keyed on the last put, recorded by the GC itself

A blob is only a **candidate** if it has not been put for `graceMs` (default
**24 h**). That covers the put-then-row window (fact 3) by a wide margin.

The "last put" time has to survive the backends' fast path, which writes no
timestamp. So `@ax/blob-gc` records it itself, from the facade's `blob:stored`
notify, which `registerBlobPutFacade` fires after **every** put, fast path
included:

```sql
CREATE TABLE IF NOT EXISTS blob_gc_v1_blobs (
  sha256        TEXT PRIMARY KEY,
  size          BIGINT NOT NULL CHECK (size >= 0),
  last_put_at   TIMESTAMPTZ NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('live', 'retired')),
  retired_at    TIMESTAMPTZ NULL
);
CREATE TABLE IF NOT EXISTS blob_gc_v1_roster (
  holder        TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

A put of a retired sha sets `state = 'live'` and refreshes `last_put_at`.

This is not the same concept as the disk-quota ledger, so invariant 4 holds. The
ledger is "what each person is charged". This table is "when each blob was last
written and whether it is retired". They have different keys and different
lifetimes.

**Blobs the table has never seen** (everything stored before this ships, or a
put whose `blob:stored` was lost to a crash) are found by listing (D5). They get
inserted with `last_put_at = now()`. So their grace starts when the GC first sees
them, never earlier. That is safe by construction.

### D5. A listing hook on the backends: `blob:list`

```ts
// service hook, registered by @ax/blob-store-fs and @ax/blob-store-s3
interface BlobListInput  { state: 'live' | 'retired'; after?: string; limit: number } // limit ≤ 1000
interface BlobListOutput { items: Array<{ sha256: string; size: number }>; next?: string }
```

The output is ordered by sha. `after` is the last sha of the previous page.
s3 maps onto `ListObjectsV2` with `StartAfter` (already lexicographic). fs walks
the two shard levels in sorted order and skips `*.tmp.*` files.

The GC lists `live` to discover blobs its table has never seen. It lists
`retired` to find retired blobs whose `blob_gc_v1_blobs` row was lost (a crash
between the backend retire and the table update) and treat them as retired now.

### D6. Ledger release is disk-quota's own sweep, per (owner, sha)

`@ax/disk-quota` already runs a periodic `reconcile`. It gains a blob pass:

1. Take its own `kind = 'blob'` rows with `updated_at < now() - graceMs`, in
   batches.
2. Fire `blob:collect-refs` with those shas. It applies the same fail-closed
   rules (D2), and keeps its **own** roster, because two plugins must not share
   rows.
3. Delete `(owner, blob:<sha>)` where no answer lists `owner` in that sha's
   `userIds`.

This releases the charge exactly when **that person's** reference goes away
(card item 6). It does that whether or not the bytes are freed: someone else may
still hold the same bytes, and they were charged too. It needs no new hook
between the GC and disk-quota, and it does not depend on the GC running at all,
so a person gets their quota back even with byte deletion still in report mode.

`updated_at` is refreshed on every re-put (fact 6), so the grace window protects
a put whose row has not landed yet, the same way it does for bytes.

### D7. What each holder answers

| Holder | Tables / source | `userIds` per ref | New index |
|---|---|---|---|
| `@ax/attachments` | `attachments_v1_files.sha256`, `attachments_v1_artifacts.sha256` | `user_id` | `(sha256)` on both |
| `@ax/skills` | `skills_v1_skills.bundle_tree_sha` | `[]` (global, system) | `(bundle_tree_sha)` on all four |
| | `skills_v1_user_skills.bundle_tree_sha` | `owner_user_id` | |
| | `skills_v1_authored.bundle_tree_sha` | `owner_user_id` | |
| | `skills_v1_catalog_requests.bundle_tree_sha` | `source_owner_user_id` when set, else `[]` | |
| `@ax/branding` | `settings:branding` `light` / `dark` | `[]` | none (one JSON value) |

Each query is `WHERE <col> = ANY($1)` over the batch. **(verify)** that
`skills_v1_skill_files` holds no blob sha. The migration comment says it held git
tree entries and is no longer read. If it holds anything sha-shaped, it becomes
a holder too, until it is dropped.

**Soft-deleted conversations still hold their files.** `@ax/attachments` answers
for every row it has, whatever state the conversation is in. Soft delete exists
so a conversation can come back. Freeing its files would break that promise
silently. Hard-purging soft-deleted conversations after a while is a separate
product decision (see "Not in scope").

### D8. Ship in report mode; deleting is an admin switch

`settings:blob-gc` (admin-editable, no env var, the same pattern as
`settings:disk-quota`) holds `{ mode: 'report' | 'enforce', graceMs,
retentionMs }`. The default is `report`.

In **report** mode the sweep runs the whole pipeline (listing, grace, collector,
roster) but does not retire anything. It logs `blob_gc_report` with counts and
bytes for: candidates, held, would-retire, and the per-holder answer counts. The
admin Storage tab gets one line: "Files no longer used by anyone: N (X GB). Not
removed yet." That is enough for an operator to read prod and decide.

Disk-quota's ledger release (D6) is **not** behind this switch. Releasing a
charge loses no data. The worst case of a bug there is that someone gets more
room than they should, until the next put re-charges them.

### D9. Branding stops deleting; `blob:delete` goes away

Branding's "Phase 3" best-effort delete is removed, and branding becomes a
holder (D7). The GC frees a replaced logo like any other unreferenced blob. That
fixes card item 5: a logo that matches a person's attachment is no longer
deleted out from under them.

With branding gone, `blob:delete` has no callers. It is **removed** from both
backends and replaced by `blob:retire` and `blob:purge`, which only the GC calls.
A raw, immediate, unconditional delete on the bus is exactly the footgun this
card is about. Leaving it registered invites the next caller to repeat the
branding bug.

```ts
interface BlobRetireInput { sha256: string }  // → {}   idempotent; missing live key = no-op
interface BlobPurgeInput  { sha256: string }  // → {}   deletes the RETIRED key only; idempotent
```

`blob:restore` is not a hook. Restore happens inside the backends' `get`/`stat`
(D3). The GC's "someone holds it again" path calls `blob:stat`, which restores
as a side effect.

### D10. `artifacts:publish-blob` checks the blob exists

Before writing the row, `@ax/attachments` calls `blob:stat` and refuses with
`not-found` if the sha is not stored (card item 3). Otherwise a runner could
publish a row pointing at a sha that was already purged, and the person would
get a broken download link.

It does **not** check that this runner put the sha. A sha256 cannot be guessed:
a runner that can name one already has the bytes, and could put them itself.
Referencing someone else's identical bytes is the same as dedup. One side effect
is stated plainly: such a reference keeps those bytes alive, and they stay
charged only to whoever put them. This is the same accepted cost as card item 6.

## The sweep, end to end

`@ax/blob-gc`, every `sweepIntervalMs` (default 1 h), holding the advisory lock:

1. **Discover.** Page `blob:list { state: 'live' }`. Insert unseen shas with
   `last_put_at = now()`, `state = 'live'`. Page `blob:list { state: 'retired' }`.
   Mark unseen ones `retired` with `retired_at = now()`.
2. **Retire pass.** Take `state = 'live' AND last_put_at < now() - graceMs`, up to
   1000 at a time. Fire `blob:collect-refs`. If any roster member is missing or
   any answer says `ok: false`, stop the whole sweep. Each candidate no answer
   holds gets: report mode, counted; enforce mode, `blob:retire`, then
   `state = 'retired', retired_at = now()`.
3. **Purge pass** (enforce only). Take `state = 'retired' AND retired_at <
   now() - retentionMs`. Fire `blob:collect-refs`, under the same abort rules.
   - Held: `blob:stat` (which restores), then `state = 'live', last_put_at =
     now()`.
   - Not held: `blob:purge`, then delete the row.
4. **Log** `blob_gc_sweep { mode, discovered, candidates, held, retired,
   restored, purged, bytesPurged, aborted? }`.

A sweep that aborts partway leaves every earlier step's work valid. Each step is
idempotent, and the next sweep starts over.

## Boundary review

| Hook | Kind | Alternate impl | Field names that might leak | Subscriber risk | IPC? |
|---|---|---|---|---|---|
| `blob:list` | service (backends) | fs (directory walk) and s3 (`ListObjectsV2`). Both ship in this card. | None. `after` is a sha, not an S3 continuation token or a path. | A caller cannot key off a backend field. There is none. | No |
| `blob:retire` / `blob:purge` | service (backends) | fs (`rename` / `unlink`) and s3 (copy+delete / delete) | None. "Retired" is a state, not a directory or prefix. | n/a | No |
| `blob:collect-refs` | subscriber (transform) | Any plugin that stores a sha: attachments, skills and branding today, and a future Drive-style file plugin. | `userIds` is the bus's own user identity, not storage vocabulary. | A holder that keys off another holder's answer would break. Holders must only append. Stated in the hook's doc comment. | No |
| `blob:get` / `blob:stat` | unchanged signature; restore-on-miss is internal | — | — | — | already IPC (`blob.get`), unchanged wire |
| `blob:delete` | **removed** | — | — | Its one caller (branding) is removed in the same PR. | No |

## Security note (three threat models)

- **Sandbox escape / capability.** The runner gains nothing. It cannot call
  retire or purge: neither is an IPC action, and `@ax/ipc-core`'s manifest does
  not list them. IPC `blob.get` can now restore a retired blob. That gives the
  runner no new reach: it could already read any blob whose sha it knows, and
  restoring only undoes a not-yet-final delete.
- **Prompt injection / untrusted input.** The model can only influence
  references through rows that host code writes (`artifact.publish`). The new
  `blob:stat` check (D10) closes the dangling-row case. A runner looping
  `blob.put` to make unreferenced blobs now gets them collected instead of
  stored forever. The runner-supplied `size` on `artifact.publish` is still
  trusted for display. That is unchanged and out of scope.
- **Supply chain.** No new dependencies. The s3 backend uses `CopyObjectCommand`
  and `ListObjectsV2Command` from the already-pinned `@aws-sdk/client-s3`.
- **Data-loss review (this card's own threat).** These are the ways a held blob
  could be deleted, and what stops each one:
  - a holder crashes (roster);
  - a holder is not loaded (roster, plus the static guard);
  - a new blob writer is not a holder (static guard);
  - put races the delete (D3, restore);
  - a row lands after the put (D4, grace; D3, re-check before purge);
  - two replicas sweep at once (idempotent steps);
  - branding deletes a shared sha (D9);
  - an operator flips to enforce too early (report mode first, D8).

## What this frees, honestly

After it ships, and once `enforce` is on, bytes come back for:

- agent delete (its conversations' files and artifacts);
- an artifact republished at the same path (the old version);
- a replaced logo;
- a deleted or updated personal skill;
- a decided catalog request;
- runner blobs that never got a row.

The ledger release (D6) runs whatever the mode is.

**It is not instant.** At the defaults, bytes come back after at least 24 h
(grace), and a ledger charge drops after 24 h plus one reconcile interval. Any
copy that tells a person how to free space has to say "within a day", not
"now".

**It does not free a deleted conversation's files**, because conversation delete
is soft. So the storage-full copy still cannot say "delete a conversation". It
can only say "delete an agent", and that destroys the agent and its memory,
which is a heavy thing to suggest. The copy change is therefore its own card,
written after `enforce` is on in prod and has been measured. That card updates
the three guards that forbid the words today:

- `packages/disk-quota/src/__tests__/messages.test.ts:79`
- `packages/channel-web/src/lib/__tests__/storage-copy.test.ts:185`
- `packages/channel-web/src/lib/__tests__/storage-copy.test.ts:249`

## Not in scope (each becomes a card)

- **Hard-purging soft-deleted conversations** after N days. That is the change
  that would make "delete this conversation" free space. It is a product
  decision (is a deleted conversation restorable, and for how long?) before it
  is a code one.
- **The storage-full copy change** (above). It depends on enforce running in
  prod.
- **Blob backfill into the ledger** (the TASK-719 card). Pre-quota blobs are
  still uncharged. The collector's `userIds` answers are the owner-bearing
  listing that card was missing, so it becomes much cheaper after this ships.
  The dependency is noted on that card.
- **Git history inside workspaces.** Separate store, separate meter.

## Build plan (cards)

Every card ships fully wired: no hook lands without a caller (the Half-Wired
Code Policy).

1. **`[TASK-723a]` Holders, collector, ledger release.** Adds
   `blob:collect-refs`, the three holders plus their sha indexes, the
   `artifacts:publish-blob` stat check (D10), and disk-quota's blob pass with
   its roster (D6). Adds the static holder guard. The first step re-checks the
   **(verify)** items against a real Postgres. The caller is disk-quota's
   reconcile, so it is reachable on day one, and it is the one piece that gives
   people quota back.
2. **`[TASK-723b]` `@ax/blob-gc` in report mode.** Adds `blob:list` on both
   backends, the new plugin and its tables, the sweep (D4, D5, steps 1, 2 and 4),
   `settings:blob-gc` with `mode: 'report'`, and the Storage tab line. The plugin
   is loaded in the k8s preset and the CLI preset in the same PR. Depends on a.
3. **`[TASK-723c]` Retire, restore, purge, enforce.** Adds `blob:retire` and
   `blob:purge` on both backends, restore-on-miss in `get`/`stat`, the purge
   pass, the enforce switch, and the roster-forget admin route. Removes
   `blob:delete` and branding's delete (D9). Depends on b. Tests in the
   "Tests that must exist" list below.
4. **`[TASK-723d]` (walk) Read prod report, flip enforce.** Operator: read a
   week of `blob_gc_report`, spot-check a sample of would-retire shas by hand
   against the holders, then flip to `enforce`. Dry-run first. Depends on c, and
   on someone with prod access.
5. **`[TASK-723e]` Storage-full copy.** Covered above. Depends on d.

### Tests that must exist (beyond unit coverage)

- **The race, for real, both backends.** Run 1000 rounds of a concurrent
  `put(same bytes)` and `retire`, then `get`. Every round must return the bytes.
  A mutant that skips restore-on-miss must fail it.
- **Roster.** A holder that throws makes the sweep abort, with nothing retired.
  A holder answering `ok: false` aborts it too. A holder removed from the preset
  after it has answered once aborts the sweep.
- **Grace.** A blob whose row lands 10 s after its put is never retired. A
  re-put refreshes `last_put_at`.
- **Purge re-check.** Retire, then a row appears, then the purge pass runs: the
  blob is restored and not purged.
- **Ledger per owner.** Users A and B put the same bytes, and A's row goes away.
  A's charge is released, B's stays, and the bytes stay.
- **Branding regression.** A logo whose sha matches an attachment, replaced:
  the attachment still downloads after a full enforce sweep.
- **Static guard.** A fake plugin that calls `blob:put` without subscribing
  `blob:collect-refs` fails the preset test.

## Open questions for review

1. **Are 24 h grace and 7 days retention right?** Both can be changed at runtime.
   The real constraint is retention ≥ the longest put-to-row gap any writer will
   ever have. Today that gap is seconds.
2. **Does the admin Storage tab line ("not removed yet") earn its place in
   report mode,** or are logs enough for the walk? A log line is cheaper, but an
   operator without log access cannot do card d.
3. **Should report mode also report the bytes that soft-deleted conversations
   hold?** That would turn the "Not in scope" product decision into one backed
   by a number. It costs a join that `@ax/attachments` would have to expose, and
   no hook for that exists. Leaning no for now.
