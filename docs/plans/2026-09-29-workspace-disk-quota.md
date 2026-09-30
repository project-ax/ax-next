# Per-user storage quota (TASK-690)

Design note and build plan. Prod keeps every user's agent workspace (bare git
repos) and every uploaded or published file (`fs` blobs) on ONE shared volume,
and nothing limited how much of it one person could use. One user, or one
runaway agent, could fill the disk and stop writes for everyone. This adds a
per-person storage limit, checked where the bytes are written, with a usage view
for the person and for the operator, all changeable without a deploy.

## What the card claimed, and what reading showed

The card marked "no per-user or per-agent size limit anywhere on the write path"
as `INFERRED`. Verified by reading each write point:

| Write point | Existing limit | Per-user or per-agent? |
|---|---|---|
| Runner commits its turn (`workspace.commit-notify`, `@ax/ipc-core`) | The request is a JSON action, so the base64 thin bundle rides inside the 4 MiB `MAX_FRAME`: roughly 3 MiB of compressed new objects per commit | No. Nothing bounds how many commits, or the total |
| In-process `workspace:apply` (memory rules, agent bootstrap and identity, routines admin, drop-turn) | The caller's HTTP body cap (1 MiB default) | No |
| Message-send commits an upload (`attachments:commit` -> `blob:put`) | 25 MiB per file, 11-type MIME allowlist, 100 MiB per message (checked AFTER the write) | No. The 200 MiB per-user cap is on the Postgres temp rows and is released at commit |
| Runner `artifact_publish` (`blob.put` IPC) | 100 MiB per object | No. No cap on how many. `blob.put` also carries no ownership row, so a runner can write unreferenced blobs repeatedly |
| Skill bundle files (`POST/PUT /settings/skills`, catalog, propose, adopt) | 16 files, 512 KiB per bundle | No. No cap on how many skills |
| Branding logo (`PUT /admin/branding`, admin) | 1 MiB | n/a |

So the claim holds: there are per-object caps and no per-owner cap anywhere.

Two facts the card did not have, both of which shape the design:

1. **Almost nothing frees the bytes.** `blob:delete` has one caller (a replaced
   branding logo). Attachment and artifact rows cannot be deleted, deleting a
   conversation is a soft delete, and git history keeps every blob ever
   committed. The one thing that gives room back is deleting a whole agent: since
   TASK-719 that removes its repo and drops its workspace row (see "What changed
   in TASK-719" below). It still touches no blobs. A person cannot "delete
   something" small to get room back, and deleting an agent throws the agent
   away, so the friendly message does not say so. It says what is true: ask for
   more room.
2. **The volume is 100Gi in prod, and the chart used to say 20Gi.** Read-only
   `kubectl get pvc` showed 100Gi (a fact seen once, read-only; the override that
   set it is not in the repo) while `deploy/charts/ax-next/gke-values.yaml` said
   20Gi. TASK-719 made `gke-values.yaml` and `deploy/GKE.md` say 100Gi, with a
   note that the per-person limit multiplies across people. The chart default in
   `values.yaml` and the `kind-dev-values.yaml` file are untouched.
   The chart renders `storage` straight into the volume claim's request
   (`templates/host/pvc.yaml`), and `helm.sh/resource-policy: keep` only protects
   the claim from `helm uninstall`, not from an upgrade. So a default can grow an
   existing volume but cannot shrink one. Prod's is already 100Gi, so nothing
   changes there. What does change: an existing cluster that deploys from
   `gke-values.yaml` at the old 20Gi will ask for 100Gi on its next `helm
   upgrade`, and that cannot be undone. Whether the storage class grants the
   growth is something we did not check. The default limit below is chosen to be
   safe against either size.

## Unit, numbers, and how both stores are counted

**Unit: per owner.** A personal agent's workspace counts against its owner. A
team agent's workspace counts against the team (`team:<id>`), as one owner with
the same limit. Uploads, artifacts and skill bundles count against the person
whose action wrote them. One number per owner, workspace and blobs together
(they share a disk, so they share a budget).

**Numbers (admin-editable, stored as a setting, no env var):**

| Setting | Default | Meaning |
|---|---|---|
| `limitMb` | 1024 | Hard limit per owner, in MB. Above it, writes are refused |
| `warnPercent` | 80 | The "getting full" notice starts here |

1 GiB per person means 100 people at the ceiling fill a 100Gi volume, and real
use will sit far below the ceiling. It is easy to raise on the Settings screen
and easy to lower on a smaller disk.

**How each store is counted (honestly):**

- **Agent workspaces (git repos): measured, not estimated.** A new service hook
  `workspace:usage` asks the backend how many bytes the agent's workspace holds on
  its storage (allocated bytes, walking the repo directory). It is re-measured
  after every applied write, and again by a periodic sweep over all personal
  agents (which also picks up the repos that existed before this shipped and
  repairs drift). The measurement is the whole repo including history, because
  history is what fills the disk.
- **Blobs (attachments, artifacts, skill bundles): counted at write time.** The
  blob store is content-addressed with no owner, so a ledger row
  `(owner, sha256) -> size` is written when `blob:put` succeeds. The same bytes
  put twice by one owner count once (the blob exists once on disk). Two owners
  who upload identical bytes are each charged (an over-count by design: it keeps
  one person's usage independent of what anyone else did). **Each blob is charged
  in whole 4 KiB units, at least one:** the fs backend keeps one file per blob, so
  a 100-byte blob still costs a block and an inode, and charging logical bytes
  would let a looping agent create millions of tiny artifacts inside its quota
  and exhaust the shared volume's inodes (found by review). This is the same
  currency the workspace meter counts in (allocated bytes). On the S3 backend it
  over-counts by up to one unit per blob, which errs on the safe side. Worst
  case at the default 1 GB: about 262k tiny blobs per person.

## The two seams (hooks)

`bus.fire` and the hook bus give plugins no way to intercept a service hook, and
the workspace already learned this the hard way (`workspace-apply-facade.ts`:
any in-process `bus.call('workspace:apply')` bypassed the policy hooks). So the
blob store gets the same shape.

1. **`workspace:pre-apply` gains an optional `sizeBytes`** (payload additive).
   `workspace:pre-apply` is veto-capable and fires on BOTH write paths: the
   runner's commit (in `@ax/ipc-core`) and every in-process `workspace:apply`
   (the `@ax/core` facade). Both now say roughly how many bytes the write adds:
   the decoded bundle length on the runner path, the sum of the put contents on
   the in-process path. The existing policy subscribers ignore the field. A veto
   on the runner path already answers `accepted: false, recoverable: false`, so
   the runner discards the refused work (no re-submit loop). **Be precise about
   who hears the reason:** the runner hands `rejectionReason` to the agent only
   on the mid-turn flush before a host tool. The ordinary end-of-turn save runs
   after the reply is already shown, and its reason is dropped (a stderr line and
   a trace, for every veto, not just this one). So on its own a refused
   end-of-turn save is SILENT to the person. That is what the third gate is for.
2. **`blob:put` becomes a facade** (`@ax/core` `registerBlobPutFacade`), exactly
   like `workspace:apply`. Backends register `blob:put-internal`; the public
   `blob:put` fires the veto `blob:pre-put { size }`, calls the backend, then
   fires the observe-only `blob:stored { sha256, size }`. Every caller (all four
   above, plus any future one) keeps calling `blob:put` and cannot skip it.

3. **`chat:start` (the front door).** Once a person's storage is full, the
   plugin turns their NEXT message away at `chat:start` with the reason
   `storage-full`, which channel-web turns into "Your storage is full, so nothing
   new can be saved right now. Ask an admin for more room." That is how a person
   learns of the limit when the refusal happened silently at the end of a turn,
   and it saves running an agent whose work cannot be saved. Unlike the two write
   gates it fails OPEN (a storage hiccup must not stop people chatting; the write
   gates are the guard). Cost: a person who is full cannot chat at all, including
   read-only questions, until an admin raises the limit (or, since TASK-719, they
   delete an agent, which gives that workspace back). That is a deliberate trade:
   no small chore gives space back, so work started now could not be kept anyway.
   `chat:resume` (a parked agent woken by a decision) is not gated;
   its writes still hit the write gates.

Plus one new service hook so the quota plugin can measure without knowing the
backend layout: **`workspace:usage {} -> { bytes }`**, registered by
`@ax/workspace-git-core`. The multi-replica `@ax/workspace-git-server` backend
does not register it yet (see gaps).

## The plugin: `@ax/disk-quota`

Subscribes `workspace:pre-apply` (gate), `workspace:applied` (re-measure that
agent), `blob:pre-put` (gate), `blob:stored` (ledger row), `chat:start` (front
door) and, since TASK-719, `workspace:deleted` (drop that agent's row). Registers
no service hooks. Storage: one Postgres table `disk_quota_v1_usage (owner_id, source, kind,
bytes, updated_at)`, primary key `(owner_id, source)`; `source` is
`workspace:<agentId>` or `blob:<sha256>`. The limit setting is
`settings:disk-quota` through `storage:get`/`storage:set` (the `@ax/usage-limits`
and `@ax/branding` pattern, cached briefly, a corrupt value falls back to the
default per field).

The gate never throws: any error becomes a refusal (the same fail-closed rule as
the spend gate, because `bus.fire` treats a throwing subscriber as a clean pass).
A write is refused when `used + incoming > limit`. The owner of a workspace write
is resolved through `agents:resolve` (cached), falling back to the acting user.
A blob write by a non-person context (`system`, used by admin branding and by
skills paths that have no owner) is not attributed and not refused.

Surface (every route takes the user from the session, never from the URL):

- `GET /settings/storage` (any signed-in person): their used bytes, limit,
  breakdown, and status (`ok`, `near-limit`, `full`).
- `GET /admin/storage` (admin): limits, and the biggest owners with names.
- `PUT /admin/storage/limits` (admin): change the limits, takes effect at once
  on this host and within 15 seconds on any other.

UI: a "Storage" tab under Settings (everyone sees their own bar, admins also see
the limit form and the biggest-owners table, in the same tab so the nav does not
grow), the friendly sentence when a message with attachments is refused, and the
`chat:start:storage-full` sentence for a full person's next message.

## Known gaps (stated, not hidden)

- **The check is not a reservation.** N simultaneous writes by one owner can all
  pass the check before any lands, so the limit can be overshot by (concurrent
  writes x size of each). Each write is bounded (about 3 MiB per commit, 25 to
  100 MiB per upload) and the next check after they land refuses. Exactness would
  need a reservation row per write and a cleanup on failure; not worth it for a
  volume guard.
- **The workspace part of the ledger lags by one write.** It is re-measured after
  a write lands, off the write's critical path, so the next write may see the
  number from before.
- **Blobs uploaded before this ships are not counted** (no per-user index exists
  to backfill from without reading `@ax/attachments` tables). Workspace repos ARE
  backfilled by the sweep. Follow-up.
- **A re-upload of something you already hold can be refused near the limit.**
  `blob:pre-put` carries the size but not the sha256, so the gate cannot tell
  that a blob is already in the owner's ledger and always adds one more unit.
  It fails safe (a conservative refusal, only within one unit of the limit).
  Threading the sha into `blob:pre-put` would fix it if anyone ever hits it.
- **Team workspaces are not swept.** The periodic sweep enumerates
  `agents:list-personal-owners`, which excludes team agents, so a team workspace
  that pre-dates this feature is uncounted until its next write (per-write
  metering charges `team:<id>` correctly), and team-repo drift (gc, repack) is not
  repaired by the sweep. Follow-up (needs an owner-bearing team agent listing).
- **Deleting an agent frees its workspace, and only that.** Almost nothing frees
  blob bytes (`blob:delete` has one caller, the unmetered branding logo), so they
  stay counted against the owner: freeing them needs a blob GC and a blob ledger
  release, which is a separate design (see the list at the end).
  Agents deleted BEFORE TASK-719 shipped keep an orphan repo on disk and a counted
  row until an operator cleans them up by hand; nothing does that automatically.
  The multi-replica `@ax/workspace-git-server` backend does not subscribe to
  `agents:deleted` yet either.
- **`@ax/workspace-git-server` (multi-replica) does not register
  `workspace:usage`.** On that backend workspace bytes are not measured; blobs
  still are. Prod uses the `local` backend.
- **`memory-facts` lives on its own 10Gi volume** and the NFS user-files share is
  a different volume (the sandbox writes to it directly, so the host cannot meter
  it); neither is metered here.
- **A commit over about 3 MiB of compressed new objects already wedges
  persistence today**, independent of this card: the 413 on the 4 MiB JSON action
  is swallowed by `commitNotifyWithResync` as `kept`. Not changed here; returned
  as a follow-up.
- **The refused turn's file changes are removed.** The runner-commit refusal takes
  the existing `recoverable: false` answer (no re-submit loop); the cost is that
  the runner resets the tree to its last saved state. If the crossing commit is
  the end-of-turn save, the person is not told at that moment (see seam 1); they
  are told on their next message by the `chat:start` gate, and the Settings
  Storage tab shows the state. Making the end-of-turn reason reach the person is a
  runner-side change and a follow-up.
- **Some in-process writers still see a raw refusal.** Since TASK-719 the Rules,
  agent-identity and routines routes answer `413 { error: 'storage-full',
  message }` with a plain sentence. Still raw: the bootstrap seed (swallowed, so
  the agent silently skips the identity interview), the memory exporter,
  authored-skill promote (a 400 with the raw code), and the skills clients, which
  show a raw `413 {json}` string. Follow-up.
- **A write is refused only when it would go over.** A person already over the
  limit (limit lowered later) can read everything and is refused every write
  until they are back under it or the limit is raised.

## Tasks

1. **Core seams.** `sizeBytes` on `workspace:pre-apply` (facade and commit-notify),
   `registerBlobPutFacade`, both blob backends move to `blob:put-internal`,
   `workspace:usage` types. Load-bearing: this is the unbypassable chokepoint.
2. **`workspace:usage`** in `@ax/workspace-git-core` and `@ax/workspace-git`.
3. **`@ax/disk-quota`**: config, migration, store, service, routes, plugin.
4. **Consumers**: chat send maps a refused upload to a 413 `storage-full`; the IPC
   `blob.put` handler maps a refusal to a clear rejection; skills pass the owner
   through to the blob write and map the refusal.
5. **Wiring**: register in `@ax/preset-k8s`, tenant-table lint prefix, preset and
   bootstrap tests, canary acceptance test on the real path with a real Postgres.
6. **UI**: Storage tab and friendly copy.
7. **Docs and memory.**

Cut as YAGNI: per-owner limit overrides, an in-chat nudge before the limit,
admin-editable per-kind budgets, a storage-freeing flow for a person (almost
nothing frees blob bytes, and deleting an agent is not a chore to suggest),
reservations.

## What changed in TASK-719

The follow-ups the gaps above asked for, the ones that fit one PR. In short:
deleting an agent now gives its storage back, a full disk reads as plain words on
more screens, and two stale bits of deploy config are gone.

- **Deleting an agent frees its workspace.** `@ax/workspace-git` subscribes to
  `agents:deleted`, removes that agent's repo under the agent's write mutex, then
  fires `workspace:deleted { agentId }`. `@ax/disk-quota` subscribes and deletes
  the `workspace:<agentId>` row for every owner (personal or `team:<id>`), after
  waiting for any measurement of that agent already in flight. Until the host
  restarts, every workspace hook for that agent refuses with `agent-deleted`
  (the tombstone lives in memory, one per host process), so a warm runner's
  late commit cannot recreate the repo and a late measurement cannot bring the
  row back. If the removal fails, nothing is fired and the row keeps counting
  bytes that are still on disk. A canary in `presets/k8s` proves the chain on the
  real path (real git, real Postgres), including the write that holds the mutex
  when the delete arrives.
- **A full disk has a code.** A refusal because storage is full carries
  `code: 'storage-full'`, which both `@ax/core` facades forward as
  `PluginError.reasonCode`, so routes stop guessing from the sentence. The
  "could not check your storage" refusal has no code.
- **Plain sentences on more screens.** Rules, agent identity and routines answer
  `413 { error: 'storage-full', message }`, and their screens show the server's
  sentence instead of a raw error.
- **Chart housekeeping.** `gke-values.yaml` and `deploy/GKE.md` say 100Gi, and
  the dead `AX_SKILLS_BUNDLE_ROOT` host env is gone (a render test pins it absent).

Still open, and not hidden:

- **Almost nothing frees blob bytes.** `blob:delete` has one caller, the
  branding logo, which is not metered. Attachments and artifacts cannot be
  deleted. Blob GC and a blob ledger release are a separate design. Known
  constraints: nothing says which attachments, skills and branding still point at
  a sha; `put`'s already-stored fast path races `delete` and never touches the
  file's age; `blob.put` over IPC makes blobs with no ledger row; and
  `attachments_v1_artifacts.artifact_id` looks like a possible primary-key bug
  (it is a sha prefix, with a conflict rule only on `(conversation_id, path)`),
  which needs checking before per-row references.
- **Agents deleted before this shipped** keep an orphan repo and a counted row.
  Cleaning up is an operator job with a dry-run listing first (hash every live
  agent id, diff against the `ws-*.git` directories).
- **The deleted-agent refusal lasts until the host restarts.** The tombstone is an
  in-memory set in `@ax/workspace-git`, so a restart forgets it. The argument for
  why that is enough: after a restart no warm runner holding that agent's token
  remains, because the delete terminated the agent's sessions and killed its
  sandboxes, so nothing is left to send a late commit. We have not tested a
  restart in the middle of a delete.
- **Blobs from before the storage limit shipped are still not counted.** A
  backfill needs owner-bearing listing hooks from attachments and skills.
- **Team workspaces are not swept,** and `@ax/workspace-git-server` neither
  registers `workspace:usage` nor subscribes to `agents:deleted`. It already has a
  `deleteRepo`; wiring it in and firing `workspace:deleted` is a card of its own.
- **Two narrow races remain.** A periodic-sweep measurement already mid-walk when
  an agent is deleted can still write one stale row afterwards (the sweep does not
  go through the in-flight wait; one sweep per 6 hours). And a read that was
  already past the deleted-agent check when the repo was removed can leave an
  empty scaffold directory behind: a few KB, holding nothing, never counted.
- **Raw refusals remain** for the bootstrap seed, the memory exporter,
  authored-skill promote and the skills clients (see the gap above).
- **The end-of-turn refusal still does not reach the person** at that moment
  (runner-side, tracked with TASK-690).
