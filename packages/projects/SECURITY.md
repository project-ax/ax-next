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
- No new npm dependencies.
