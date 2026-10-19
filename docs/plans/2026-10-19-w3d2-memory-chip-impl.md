# W3d-2: the "Updated project memory" chip (implementation plan)

Spec: W3 spec §7.3, last two bullets. W3d-1 as built: §21.

> **"Updated project memory"** appears under a chat turn whose snapshot pass
> recorded changes under `memory/`. It lists the changed files, each with Undo.

## What already exists (W3d-1)

- **Version rows:** `projects_v1_file_versions` has `seq`, `version_id`, `project_id`, `path`, `blob_sha` (the sha256 hex of the bytes), `size`, `kind` (`write | delete`), `too_large`, `label` (`edit | agent | baseline | outside | restore | seed`), the author ids, `conversation_id`, `req_id` and `created_at`. There is an index on `conversation_id`.
- **When rows are written:** the `chat:turn-end` subscriber runs `turnEndPass` in the background, labelled `agent`, with `{agentId, conversationId, reqId}`. It runs once per `(session, reqId)`.
- **The client:** it has no reqId for a reloaded turn. Turn ids are positional (`"0"`, `"1"`, …).
- **The memory-used chip:** `server/memory-used.ts` `attachMemoryUsed` matches a receipt's time to the exchange that opened at or before it. A person turn opens an exchange, and the chip attaches to the exchange's last `agent`/`steps` message. `routes-workspace.ts` `withMemoryUsed` calls it from `agentDetail`.

## Decisions

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | **Match a turn's versions to the thread by `turn_at`.** Add a nullable `turn_at TIMESTAMPTZ` column, stamped when the subscriber first sees the turn-end (`new Date()` before the background pass). Then match it to the exchange the same way memory-used does. | `created_at` is when the pass finished. A slow pass can land after the person's next message and attach to the wrong turn. The turn-end is seen after the turn row is persisted and before the `done` frame, so it falls inside the right exchange. It's an additive column, and no reqId has to reach the client. | Persist reqId on turn rows (changes ipc-core, conversations and the transcript). Match by `created_at` (wrong when a pass is late). |
| D2 | **Handle late passes with a bounded re-load.** After `done`, in a chat that belongs to a project, the client runs its normal `load()` again at about 3 s and 10 s. It skips a re-load if a new turn is streaming or the conversation has changed. | The pass is fire-and-forget and usually ends after the `done` re-read. Two guarded re-reads are the smallest change. A pass that is later still shows on the next open. | A new SSE event from projects through channel-web (new hook plus stream plumbing; not earned yet). |
| D3 | **Undo is computed and applied on the host** by a new `projects:undo-change {projectId, versionId}`. It refuses if anything newer is recorded for that path, then applies the inverse with a content guard: <ul><li>**edited:** write the previous version's bytes with `ifMatch` = this version's `blob_sha`;</li><li>**deleted:** write the previous version's bytes with `ifAbsent`;</li><li>**created:** delete, after checking that the current bytes still hash to this version's sha.</li></ul> It is recorded as `restore`. | An agent can create a file, which `restore-version` can't undo. `ifMatch` and `ifAbsent` make the undo safe if the file changed after the pass. | Have the client compose `restore-version` and `delete-file` (no guard, and "created" has no version to restore). |
| D4 | **The read hook is `projects:conversation-changes {projectId, conversationId}`.** It returns that chat's agent-turn changes (label `agent`, `turn_at` not null) across all paths. channel-web keeps only paths under `memory/`. | The hook stays general: History could show "changed in this chat" later. The `memory/` rule is about what the UI shows. | Add a `pathPrefix` input (YAGNI). |
| D5 | **Undo is shown only when `canEdit` is true.** The hook reports `canEdit` for the calling person (the same rule as `loadEditable`). | Viewers see the chip but can't change files. | — |
| D6 | **The undo label is `restore`**, so History shows "Restored by ‹person›". | Avoids a CHECK-constraint change and a new label in the History UI. | A new `undo` label. |

## Contracts

### `@ax/projects`

**Migration.** `ALTER TABLE projects_v1_file_versions ADD COLUMN IF NOT EXISTS turn_at TIMESTAMPTZ NULL`. It is additive and idempotent, following the existing migrations.

**The turn-end subscriber.** Stamp `turnAt` when the turn-end is first seen and pass it in `Attribution`, so `recordPass` writes `turn_at`. Other labels leave it null.

**`projects:conversation-changes`**
- Input (strict): `{ projectId: string, conversationId: string }`.
- Gate: `requireActor` + `loadUsable` (viewers included, same as file-history). A denied caller gets not-found.
- Output:
  ```ts
  {
    canEdit: boolean,               // the actor can edit (loadEditable rule, but never throws)
    changes: Array<{
      versionId: string,
      path: string,
      change: 'created' | 'edited' | 'deleted',
      turnAt: string,               // ISO
      undo: 'available' | 'changed-since' | 'not-undoable',
    }>,                             // ordered by seq asc; cap 500 (newest 500 kept)
  }
  ```
- `change` comes from the previous version of the same path (the highest `seq` lower than this one):
  - `deleted` if this version is a delete;
  - `created` if there is no previous version, or the previous one is a delete;
  - `edited` otherwise.
- `undo`:
  - `changed-since` if any version of that path has a higher `seq`;
  - `not-undoable` if the inverse is impossible. That covers four cases:
    - for an edit or delete, the previous version is too large or has no blob;
    - the path is under `sources/`;
    - the inverse is a delete of a protected path;
    - this version is too large (a "created" can't be content-checked).
  - otherwise `available`.

**`projects:undo-change`**
- Input (strict): `{ projectId: string, versionId: string }`.
- Gate: `requireActor` + `loadEditable`, the same as restore-version.
- Errors:
  - not-found: an unknown version, or one from another project;
  - `changed-since`: a newer version exists, or the content guard fails (`conflict`, `exists`, or a hash mismatch);
  - `not-undoable`: the cases above.
- It applies the change through `applyChange` with `{label:'restore', actor, members}`, then fires `AUGMENT_CHANGED_HOOK` for a protected path, like restore-version.
- Output: `{}`.
- To check that the current bytes still hash to this version's sha before deleting, read through the same host read path that `read-file` uses. If the file is absent, return `changed-since`.

Both hooks go in `types.ts` (zod) and the plugin manifest. Update any manifest snapshot or canary-listed hook arrays. W3e failed CI on a stale manifest entry, so grep for `projects:restore-version` everywhere and add the new names next to it.

### `@ax/channel-web`, server

- **Thread messages:** `ThreadMessage` gets `projectMemory?: ProjectMemoryUpdate` on the `agent` and `steps` variants, in `lib/workspace-types.ts`:
  ```ts
  interface ProjectMemoryUpdate {
    projectId: string;
    canEdit: boolean;
    files: Array<{ versionId: string; path: string; change: 'created'|'edited'|'deleted'; undo: 'available'|'changed-since'|'not-undoable' }>;
  }
  ```
- **`server/project-memory.ts`** follows `memory-used.ts`:
  - a hand-checked reply parser;
  - `attachProjectMemory(thread, turns, projectId, reply)`, which keeps `memory/…` paths only, matches by `turnAt` using the same exchange rule, and dedupes by path (the last version per path per answer wins).
  - Extract the exchange builder from `memory-used.ts` into a shared helper rather than copying it.
- **`routes-workspace.ts` `withProjectMemory`:**
  - It runs only when the conversation has a `projectId` (already read from `conversations:get` in `agentDetail`) and `projects:conversation-changes` is on the bus.
  - It calls the hook with `actorCtx(userId)`, the same ctx that `routes-projects` uses for the person's history calls. Check what `routes-workspace` already uses for `projects:list` and match it.
  - On any failure it returns the thread unchanged.
  - Chain it after `withMemoryUsed`.
- **The undo route:** `POST /api/workspace/projects/:projectId/versions/:versionId/undo` in `routes-projects.ts`, next to the restore route. It maps errors the way restore does: `changed-since` → 409 `{error:'changed-since'}`, `not-undoable` → 409 `{error:'not-undoable'}`, not-found → 404, and the rest through `changeRefused`. Add the wire types to `wire/projects.ts`.

### `@ax/channel-web`, client

- `workspaceApi.undoProjectChange(projectId, versionId)`. It throws `ProjectFileChangeError`, like `restoreProjectFileVersion`.
- `components/workspace/ProjectMemoryChip.tsx` is a shadcn Collapsible, closed by default, in the same visual language as `MemoryUsedChip`:
  - Header: "Updated project memory · N files".
  - Each row shows the path (minus `memory/`), the change ("added", "edited", "removed"), and an Undo button when `canEdit && undo === 'available'`.
  - The row's state after Undo is "Undone". `changed-since` reads "Changed since". On failure it shows an inline `role="alert"` message via a mapper like `restoreFailureMessage`, adding `changed-since` and `not-undoable`.
  - No dialogs (the lesson from #997 and #998).
  - It links to the project page.
- `AgentConversation.tsx` `Message` renders it next to `MemoryUsedChip`.
- `AgentView.tsx` handles the D2 re-load after `done` when the detail's `project` is not null.

## Tasks

1. **projects:** migration, `turn_at` stamping, the two hooks, manifest, tests. These are plugin tests with the in-memory or postgres harness already used in `plugin.test.ts`. Mutation-check the `changed-since` guard and the created/edited/deleted classification.
2. **channel-web server:** the shared exchange helper, `project-memory.ts`, `withProjectMemory`, the undo route, wire types and tests (`project-memory.test.ts`, a routes-workspace thread test, a routes-projects undo test).
3. **channel-web client:** api method, chip, `Message` placement, the `AgentView` re-load, tests (chip states, Undo success and failure, viewer sees no Undo, the re-load guard).
4. **Docs:** W3 spec §22 "As built: W3d-2", the decisions shard rows, and "Resume here".

YAGNI check: every task is needed for the chip. No routine or W3f work is included.

## Boundary review

- `projects:conversation-changes`:
  - Alternate implementation: a git-backed project store listing the commits whose trailer names the chat.
  - Leaky fields: none. `versionId` is opaque, and `turnAt` is a time.
  - Subscribers: none, since it's a service hook.
- `projects:undo-change`:
  - Alternate implementation: a `git revert` of that path in that commit.
  - Leaky fields: none.

## Security

- A viewer can't undo (`loadEditable`).
- The conversation list doesn't leak:
  - the hook answers only for project users;
  - the paths it reveals are already visible to them in History;
  - channel-web calls it only for a conversation `conversations:get` already confirmed is the caller's.
- Undo writes go through `applyChange` (the confined walk, `sources/` read-only, protected paths).
