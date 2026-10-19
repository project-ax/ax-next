# W3d-1: file history, restore and undo — implementation plan

Spec: [`2026-10-12-w3-projects-design.md`](2026-10-12-w3-projects-design.md) §7, as
changed by §18 (host reads walk the read-only mount) and §20 (host writes go
through the storage helper). Decisions: `.claude/memory/decisions/2026-10-17-AXWM-3.md`.

W3d ships as two PRs (the person's choice, 2026-10-18):

- **W3d-1, this plan:** recording, plus History / Restore / Undo.
- **W3d-2:** the "Updated project memory" chip under a chat turn.

## Decisions made while planning

- **Versions count against the project owner's quota** (the person's choice).
  `blob:put` runs with a ctx whose `userId` is the owner of the project's owner
  agent, so disk-quota charges one person per project. Retention bounds the
  total.
- **`projectId` joins `source` on the session record** (§7.1, the TASK-181
  pattern, mirrored field for field):
  - the orchestrator's `owner.projectId` on `sandbox:open-session`;
  - both providers forward it to `session:create`;
  - session-postgres adds a nullable `project_id` column (additive);
  - session-inmemory keeps it too;
  - both IPC listeners stamp `ctx.projectId` from the auth record, never from a
    runner frame.

  `AgentContext.projectId` already exists and is documented as host-set.
- **A new `sandbox:scan-shared-folder`** gives a recursive, confined stat of a
  folder.
  - It returns `{path, size, mtimeMs, ino}` per regular file, capped at
    10,000 entries, with `truncated`. Directories aren't recorded, only files
    are.
  - It runs on the host through the same walk as reads (k8s: the read-only
    `hostReadPath` mount; subprocess: the local folder). No storage-helper
    route.
  - Library: `scanConfinedByWalk` in `@ax/user-files-read`. It never follows
    a symlink and skips special files.
- **The baseline is lazy, not a boot-time sweep.** The first pass over a
  project that has no manifest yet records every file up to 1 MiB with the
  label "Before history started". Its effect is the same as §7.2's sweep, but
  boot doesn't depend on the sandbox, and projects that are never touched cost
  nothing.
- **A pass** (one function; every trigger uses it):
  1. Take a per-project **lease row** (`projects_v1_history_leases`: one
     `INSERT … ON CONFLICT DO UPDATE … WHERE until < now() RETURNING token`,
     ours iff the token comes back), good for 3 minutes, released with
     `DELETE … WHERE token = ours`. If another pass or replica holds it,
     skip; that pass sees the same changes. *(Changed after the security
     review: the plan first said `pg_try_advisory_lock` on a pinned
     connection, but a pass then held that connection for its whole length
     while its own queries needed a second one from the host's small shared
     pool; about ten concurrent passes deadlocked every plugin's database
     access. A lease row holds no connection.)* At most **2 passes run at
     once per process**; past that a pass answers `locked` (the turn-end
     path retries on a later turn). A pass stops taking new files after 2
     minutes and leaves the rest to the next pass (always taking at least
     one, so a slow folder still moves).
  2. Scan, then diff against `projects_v1_file_manifest` by
     `(size, mtimeMs, ino)`.
  3. Read each changed file up to 1 MiB, then `blob:put` it as the owner.
     Larger files are recorded with `too_large`. A file that's gone gets a
     delete version.
  4. Update the manifest.

  It handles at most 500 changed files per pass; the rest wait for the next.
- **The triggers:**
  - **`chat:turn-end`** (subscriber): uses `ctx.projectId`; skipped when it's
    absent. The agent must have a writable grant, checked with
    `projects:resolve` as the agent; a viewer session can't write. Deduped per
    `(sessionId, reqId)`, because a turn can fire twice (tool, then
    assistant). Runs in the background and never blocks the turn. Versions
    are attributed to `ctx.agentId`, `ctx.conversationId` and the reqId.
  - **Before a writable project session opens:** the orchestrator calls a new
    `projects:snapshot { projectId }` with a 10 s budget before
    `sandbox:open-session`. On a timeout or failure the session still opens
    and a gap is recorded. Changes this pass finds are labeled "Changed
    outside history".
  - **Before every host write** (`applyChange`): a preimage check. The file's
    current bytes are compared with its latest version; if they differ, or
    there is no version, the current bytes are recorded first as "Changed
    outside history". After the change, the new bytes are recorded,
    attributed to the person. The manifest isn't updated; the next pass
    re-reads the file once and skips it as identical to the latest version. Seeding at create records versions the
    same way.
- **Tables** (one additive migration in `@ax/projects`):
  - `projects_v1_file_versions`: `version_id`, `project_id`, `path`,
    `blob_sha` (null when deleted or too large), `size`, `kind`
    (`write | delete`), `too_large`, `label`
    (`edit | agent | baseline | outside | restore | seed`), `author_user_id`,
    `author_agent_id`, `conversation_id`, `req_id`, `created_at`. Indexed on
    `(project_id, path, created_at desc)`.
  - `projects_v1_file_manifest`: `project_id`, `path`, `size`, `mtime_ms`,
    `ino`, `sha256`.
  - `projects_v1_history_gaps`: `project_id`, `at`, `reason`.
  - `projects_v1_history_state` (history started) and
    `projects_v1_history_leases` (`project_id`, `token`, `until`).
  - Every one of these declares `project_id REFERENCES
    projects_v1_projects(project_id) ON DELETE CASCADE` (same plugin, so
    allowed). A pass, snapshot or host write still running when its project
    is deleted then fails its insert with a foreign-key violation, which is
    read as "project gone": the pass stops, no gap is written, nothing is
    logged above debug/info. Without it those late inserts left orphan rows
    that retention never removed and whose blobs `blob:collect-refs` kept
    holding forever (security review).
- **Agent- and chat-keyed columns** (the agent-keyed-tables guard):
  - `agents:deleted` sets `author_agent_id` to null; the version shows "a
    removed agent";
  - `conversations:purged` sets `conversation_id` to null.

  Deleting a project, or its folder being tombstoned, deletes its history,
  manifest and gaps.
- **Blob references:** `@ax/projects` answers `blob:collect-refs` (via
  `answerBlobCollectRefs`) for every `blob_sha` it still holds. The `userIds`
  are the project owner.
- **Retention:** a daily job under an advisory try-lock (every statement on
  the lock's own pinned connection, never the pool) keeps every version from the last
  30 days plus the last 50 of each file, and deletes the rest. Blob-gc then
  releases the unheld blobs.
- **Restore** writes through `applyChange` with the version's bytes, labeled
  "Restored by …". A deleted version can't be restored. Restoring a version
  of a deleted file recreates the file. **Undo** is the UI restoring the
  version just before the latest one; there's no separate hook.

## Hooks

```ts
// @ax/sandbox-mount-protocol (host-internal; projects calls it undeclared + hasService)
'sandbox:scan-shared-folder' { folderId, maxEntries? }
  → { kind: 'done'; files: Array<{ path; size; mtimeMs; ino }>; truncated: boolean } | { kind: 'unavailable' }

// @ax/projects
'projects:snapshot'      { projectId } → { recorded: number; gap: boolean }   // the orchestrator's pre-spawn pass
'projects:file-history'  { projectId, path } → { versions: Version[]; gaps: Gap[] }   // the same access as read-file
'projects:read-version'  { projectId, versionId } → { contents: Uint8Array; size } | refusal
'projects:restore-version' { projectId, versionId } → { sha256 }               // the same access as write-file
```

## Tasks

1. **Session `projectId`:** the orchestrator, `sandbox-protocol`, both
   providers' open-session, session-postgres (migration, schemas,
   `resolveToken`), session-inmemory, and the ipc-server and ipc-http
   listeners. Tests mirror the `source` tests at every hop.
2. **Scan:**
   - `scanConfinedByWalk` with tests (symlinks, caps, special files);
   - protocol types;
   - k8s provider (host walk over `hostReadPath`) and subprocess provider;
   - tests.
3. **`@ax/projects` recording:**
   - migration;
   - the pass;
   - the triggers: `chat:turn-end` subscriber, `projects:snapshot`, the
     preimage and post-write hook in `applyChange`, seeding;
   - owner-quota blob puts, collect-refs, agent/conversation nulling, delete
     cleanup, retention;
   - the history, read-version and restore hooks;
   - manifest declarations and SECURITY.md;
   - tests.
4. **Orchestrator:** call `projects:snapshot` with a 10 s budget before a
   writable project session opens (it already calls `projects:resolve`).
   Tests.
5. **channel-web server:** `GET …/projects/:id/history/*`,
   `GET …/projects/:id/versions/:versionId`,
   `POST …/projects/:id/versions/:versionId/restore`; manifest and snapshot.
   Tests.
6. **channel-web UI** (invoke `shadcn`):
   - **History** in the file viewer's menu opens a `Sheet` listing who, when,
     a link to the chat, the label and "Too large to keep history". Gaps show
     as a row.
   - **Preview** of a version.
   - **Restore this version** with an `AlertDialog`.
   - **Undo the last change**, which restores the version before the latest
     one.
   - Viewers see History read-only.
   - Tests.
7. **Acceptance** (subprocess, Linux): an agent turn writes a file, and a
   version attributed to the agent appears. A person's edit gets a preimage
   when the agent changed the file outside a tracked turn. Restore brings the
   bytes back and records "restored". The first pass records the baseline.
8. **Docs:** W3 spec §21 "As built: W3d-1"; Resume here; the decisions shard.
