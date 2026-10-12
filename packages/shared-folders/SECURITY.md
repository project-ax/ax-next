# @ax/shared-folders — security notes

This plugin decides which agents may mount which shared folders. It's a small
plugin guarding a big door, so here's what it does and doesn't promise.
(Full threat walk: `docs/plans/2026-10-12-w2-shared-folders-design.md` §8.)

## Who may change what

- **The actor is `ctx.userId`** — the authenticated person — never a payload
  field. Inputs are strict zod objects, so a payload that tries to smuggle a
  `userId` in is rejected outright.
- **No person, no change.** An empty user, the `system` stand-in, and owner-less
  session ids are refused on every changing hook and on `list`.
- **Authority comes from `agents:can-manage-sharing`**: a personal agent's owner,
  or an admin of a team agent's team. Workspace-admin status alone grants
  nothing. Being able to *use* an agent never implies being able to *share* it.
- **Grant** needs management of the folder (its owner agent) **and** of the
  target agent, and the two agents must have the same owner. Cross-owner
  sharing is W4.
- **Revoke** needs management of the folder **or** of the target agent — an
  agent's manager can always pull it out of a folder.
- Every refusal throws `forbidden`, writes nothing, and logs a structured
  `shared_folders_refused` warning (`hook`, `reason`, ids). The thrown message is
  the same for every reason, so a refused caller can't probe which folders exist.

## Least privilege

- `shared-folders:authorize-mounts` is host-internal and person-less. It can only
  *narrow* a host-chosen list of folder ids to the agent's live grants. Malformed
  ids are dropped; tombstoned folders are never returned; a viewer gets
  `readOnly: true`.
- There is no agent tool or IPC action to share, revoke or mount. Nothing here
  is reachable from inside a sandbox.
- Any narrowing (revoke, editor→viewer, delete, agent deletion) fires
  `shared-folders:access-reduced` after commit, so the orchestrator can reap
  sessions that still hold the old mount.

## Deletion

- Deleting a folder tombstones it and removes every grant in one transaction,
  *then* asks `sandbox:delete-shared-folder` to remove the bytes. If that fails
  (or no provider is loaded) the tombstone stays and a sweep retries with
  exponential backoff. The tombstone keeps the folder unmountable and
  ungrantable the whole time.
- When an agent is deleted, its grants go with it. A folder it owned passes to
  its oldest **editor**; a viewer is never promoted (that would widen its
  access). With no editor, the folder is deleted.

## Known gaps

- **Symlinks across agents (W4 blocker).** A file planted in a shared folder can
  be a symlink that resolves inside the *reader's* sandbox. W2 is same-owner
  only, so this doesn't cross a trust boundary yet; it must be fixed before W4.
- **Prompt injection.** Files in a shared folder may have been written by
  another (possibly injected) agent with the same owner. Treat them as
  untrusted input, always.
- **Revocation latency.** An idle session loses access immediately; an active one
  at the end of its current turn. Nothing un-reads what an agent already saw.
