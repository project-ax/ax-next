# @ax/projects — security notes

A project is a shared folder plus a name. This plugin keeps the name, the
description and which folder it is; **who's in a project and who owns it live in
`@ax/shared-folders`' grants**, and we ask that plugin every time instead of
keeping a copy. (Design: `docs/plans/2026-10-12-w3-projects-design.md` §4, §13.)

## Who may do what

- **The actor is `ctx.userId`**, the authenticated person, never a payload
  field. Inputs are strict zod objects, so a payload that tries to carry a
  `userId` is rejected. A call with no real person (empty, `system`, an
  owner-less session id) is refused on every hook.
- **Manage a project** = manage its folder's owner agent
  (`agents:can-manage-sharing`): a personal agent's owner, or an admin of a team
  agent's team. Needed for `create`, `update` and `delete`. `create` checks it
  before it touches anything, and `shared-folders:create` checks again.
- **Use a project** = use (`agents:resolve`) an agent that has a live grant on
  its folder. Needed for `get`. A team member who isn't an admin can use a team
  project but can't change or delete it.
- **`projects:resolve { projectId, agentId }`** is the one check the
  conversations plugin, the orchestrator and the prompt block rely on: the actor
  can use `agentId`, **and** `agentId` holds a live grant on the folder
  (`shared-folders:authorize-mounts`). `readOnly` comes from that grant. The
  mount resolver checks the grant again when the session opens, so a wrong
  project id on a chat row can't mount anything the agent lacks.
- `projects:list` only shows projects whose folder is granted to an agent the
  actor can use, and each entry lists only those agents.

## Changing a project's files (W3c)

- **Edit a project's files** = use a member agent whose role is **editor or
  owner** (`loadEditable`). Someone who reaches the project only through
  viewer agents can still read it, and gets `forbidden` on
  `projects:write-file`, `delete-file` and `create-folder`.
- The rules live here, not only in the UI:
  - `sources/` and everything under it is read-only (`read-only-path`);
  - `instructions.md` and `memory/status.md` can be edited but never deleted
    (`protected-path`);
  - 10 MiB a file (`too-large`);
  - a path is relative with no empty, `.` or `..` segment and no NUL, checked
    here so `sources/` can't be reached by another spelling. The provider's
    walk re-checks every path and never follows a symlink.
- A save can carry `baseHash` (the sha256 `read-file` returned); anything
  else on disk is a `conflict`. Best effort; W3d's history catches the rest.
- Every change that passed the access check logs one `project_file_changed`
  line (`userId`, `projectId`, `path`, `op`, `outcome`, including refusals and
  failures). That's the audit trail until W3d records content.
- Seeding a new project and the lazy layout sweep are `ifAbsent` on every
  entry, so neither ever overwrites what a person or an agent wrote. The sweep
  can run on anyone's root listing (a viewer's too), because all it can do is
  create the fixed layout. A seed that fails rolls the whole create back (row,
  bytes, folder); no file storage at all just skips the seed.
- The person's display name lands in `memory/log.md`, a file agents read, so
  it's cut to one line of at most 80 characters with no control characters.

## File history (W3d)

History keeps earlier versions of a project's files so a person can see what
changed and put a file back. Its bytes are agent-written and untrusted: we store
them and hand them back, and never read meaning into them.

- **Who may do what.** `projects:file-history` and `projects:read-version` need
  what `read-file` needs (use the project, viewers included).
  `projects:restore-version` needs what `write-file` needs (an editor or owner
  member) and follows the same rules: a version under `sources/` is
  `read-only-path`. A version id that isn't this project's is `not-found`, with
  the same message as an unknown project. A deletion or a too-large version
  can't be restored (`not-restorable`).
- **`projects:snapshot`** is called by the orchestrator, as the person, before a
  writable project session opens. The person must be able to use the project.
- **The turn-end pass** takes the project from `ctx.projectId`, which the IPC
  server stamps from the session record, never from the runner's frame. It
  records only when the session's agent holds a **writable** grant
  (`projects:resolve`'s check, as the session's person); a viewer's turn
  records nothing. The payload's `reqId` / `turnId` are runner-written: they're
  used only as a dedupe key and a label, capped at 200 characters.
- **Who pays.** Every version's bytes are `blob:put` as the project's **owner**
  (the owner of its member agents: a person, or `team:<id>` for a team's
  agents, disk-quota's key), never as whoever triggered the pass. So an agent
  in someone's project can't fill a stranger's quota, and one person pays for
  one project. The owner is stored on each version, and that's who
  `blob:collect-refs` names.
- **Bounded work.** A pass scans at most 10,000 files, reads at most 500
  changed files, each up to 1 MiB (bigger ones are recorded as "too large",
  without bytes), and stops taking new files after 2 minutes (the next pass
  takes the rest). Host writes don't take the lease, so a save racing a pass
  can record a version twice or attribute it to the turn's agent. Nothing is
  lost.
- **One pass per project, and never a held connection.** A pass takes a
  **lease row** (`projects_v1_history_leases`), not a lock on a database
  connection: one `INSERT … ON CONFLICT … WHERE until < now() RETURNING
  token` takes it if it's free or expired, it lasts 3 minutes, and the pass
  deletes only its own token when it ends. A pass that can't take it skips.
  This replaced a session advisory lock that pinned one pool connection for the
  whole pass while the pass's own queries needed a second one: about ten
  passes at once (ten project chats ending a turn together) took every
  connection in the host's shared pool and deadlocked, taking every plugin's
  database access down with them. A pass now holds no connection while it
  waits on the folder or the blob store.
- **At most 2 passes at once per host process.** A third answers `locked`
  straight away; the turn-end path doesn't mark the turn seen, so a later turn
  retries, and a snapshot just answers "nothing recorded". So a burst of turn
  ends can't crowd the shared pool. If a pass outlives its lease (a single read
  hanging for minutes), a second pass may overlap it; both only record what
  differs from the latest version, so the worst case is a duplicate version.
- **A truncated scan never deletes.** A file missing from a scan that hit a cap
  may still exist, so it's never recorded as deleted.
- **Failures leave a gap, never a failed save or a stuck turn.** A preimage or
  version that can't be recorded writes a gap row ("history may be missing
  changes from around …") and the person's change goes ahead. The turn-end
  subscriber runs in the background and never throws.
- **Cleanup.** Deleting a project (or its folder being tombstoned) deletes its
  versions, manifest, gaps, history state and lease in the same transaction as
  the row. Every history table also declares `project_id REFERENCES
  projects_v1_projects ON DELETE CASCADE`, so a pass, snapshot or host write
  that was still running when the project went can't leave rows behind: its
  insert fails with a foreign-key violation, which we read as "the project is
  gone". The pass stops, no gap is written, and it's logged at debug/info, not
  as an error. Without this, those late rows outlived the project forever, and
  their blobs stayed held through `blob:collect-refs` (which answers from the
  versions table, so the cascade takes the refs with it). `agents:deleted` nulls `author_agent_id` and `conversations:purged`
  nulls `conversation_id`; the versions stay ("a removed agent"). A daily job,
  under a try-lock, keeps every version from the last 30 days plus the last 50
  of each file; blob-gc releases the bytes nobody holds. Retention keeps an
  advisory try-lock, and runs every statement on that lock's own connection,
  never asking the pool for a second one while holding it.
- **`sandbox:scan-shared-folder`** is called undeclared and `hasService`-guarded,
  like the reader: it does no grant check, and it's called only for a project
  already loaded and checked.

## Refusals: `not-found` vs `forbidden`

- Anything keyed on a project id that the actor can't **use** (unknown id, a
  deleted project, a project whose members the actor can't use, an agent with
  no grant) is `not-found`, with one message per hook. "Doesn't exist" and "not
  yours" look the same, so nobody can probe which projects exist.
- `forbidden` is only for someone who **can** use the project but can't manage
  it, or for a call with no real person. Neither says anything new about a
  project.
- Every refusal writes nothing and logs exactly one `projects_refused` warning
  (`hook`, `reason`, `actor`, ids). That log line is the audit trail; the thrown
  message never carries the reason.

## Untrusted text in the prompt

The name and description are written by people, but they end up in the system
prompt of every member agent, so we treat them as untrusted:

- The name is one line: 1–80 characters, trimmed, no control characters, no
  newlines, no Unicode line or paragraph separators.
- The description is at most 500 characters, trimmed, with no control
  characters except newlines and tabs. Blank means none.
- The block quotes the description line by line (`> `), so a line like
  `## Rules From Your User` stays inside the quote. The renderer re-sanitizes
  both fields, in case a row was written some other way.
- The block is `context` only, **never `rules`**, and it says outright that the
  folder's contents are information, not instructions.
- The block fails closed to `{}` (no block) on any failure. W2's one-line
  runner note about mounted folders is the floor.

## Deletion is idempotent

- `projects:delete` deletes the folder first (`shared-folders:delete`
  tombstones it and reaps live sessions), then the row.
- The row is deleted with `DELETE … RETURNING`, by `projects:delete` **or** by
  our `shared-folders:deleted` subscriber, whichever gets there first, and
  `projects:deleted` fires only for a row that was actually deleted. So it fires
  once per project, even though W2 delivers `shared-folders:deleted` at least
  once (its sweep re-fires it).
- The subscriber never throws. If its delete fails, the next re-fire retries it.
- If inserting a new project's row fails, `projects:create` deletes the folder it
  just made, so no orphan folder is left.

## Least privilege

- No agent tool or IPC action reaches any `projects:*` hook. Nothing here is
  callable from inside a sandbox.
- The plugin never calls `conversations:*`: conversations calls us, so that
  edge would make a call cycle, which bootstrap rejects.
- It declares no `sandbox:*` edge, but it does **call `sandbox:read-shared-folder`
  undeclared** (guarded by `hasService`): a declared edge closed a boot cycle
  through the subprocess provider (W3 spec §18). That hook does no grant check
  of its own; this plugin is its only caller, and it calls it only after
  `loadUsable` has checked that the person can use the project.
- W3c's **`sandbox:change-shared-folder`** (and `sandbox:delete-shared-folder`,
  for a failed create's rollback) are called the same way. The change hook
  does no grant check either: it's called only after `loadEditable` and the
  path rules, or by `projects:create` on the folder it just made.
- W3d's **`sandbox:scan-shared-folder`** is called the same way, only for a
  project already loaded. `blob:put` / `blob:get` are optional calls: without
  a blob store nothing is recorded.
- No new npm dependencies.
