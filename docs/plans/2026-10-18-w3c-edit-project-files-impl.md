# W3c: people edit project files — implementation plan

Spec: [`2026-10-12-w3-projects-design.md`](2026-10-12-w3-projects-design.md) §6 (W3c), as
changed by §18 (W3b used a host walk, not `nosymfollow`).
Decisions: `.claude/memory/decisions/2026-10-17-AXWM-3.md`.

## Decisions made while planning

- **On k8s, writes go through the storage node, not a host mount** (the person chose
  this on 2026-10-18). Three facts drove it:
  - The host's export mount is read-only, and the chart treats that as
    load-bearing.
  - `.shared` is root-owned and `0711`, so the host can't create a folder, and
    seeding a new project needs one.
  - Files must end up owned by `1000:1000` so agents can edit them.

  The privileged storage helper already creates `.shared/<id>` with the right
  owner, walks every component with `O_NOFOLLOW`, and does temp-file + rename.
  A new mTLS route, `/change-shared`, does the writes. Any Ready helper works:
  the export is one NFS volume, so there's no node routing.

  Rejected:
  - A read-write host mount: no folder creation, and standing write reach over
    every project.
  - A pod per save: seconds per Save.
- **One write implementation for both providers:** `changeConfinedByWalk` in
  `@ax/user-files-read`, beside `readConfinedByWalk`. The storage node and the
  subprocess provider both call it. The difference between them is injected:
  - k8s: chown to `1000:1000`, because the node runs as root;
  - subprocess: no chown.

  The storage node already depends on that package (via `@ax/sandbox-k8s`).
- **Spec §6.1 shape, plus two guards:**
  - `ifMatch` (sha256 of the current bytes) on a write. The conflict check runs
    on the node, right before the rename, which narrows the window. It's still
    best effort, and W3d's history catches the rest.
  - `ifAbsent` on a write and on `mkdir`. Seeding and the layout sweep never
    overwrite.
- **Delete removes a file or an empty directory only.** No recursive delete from
  the UI in W3c; an agent can still `rm -r` with its own tools.
- **The rules are enforced in `@ax/projects`, not only in the UI:**
  - who may write: a person who can use a member agent with role editor or owner;
  - `instructions.md` and `memory/status.md` can't be deleted;
  - `sources/` can't be changed.
- **The layout sweep (§6.2) for W3a projects runs lazily**, not at boot. The
  first write or file listing for a project whose top level is missing an entry
  runs `ensureLayout` (`ifAbsent` only). This avoids a boot-time dependency on
  the storage node, and it's idempotent.
- **Audit:** one structured host log line per change: `project_file_changed`
  with userId, projectId, path and op. W3d records content history.

## Shapes

```ts
// @ax/sandbox-mount-protocol (host-internal; providers register; projects calls it undeclared + hasService)
'sandbox:change-shared-folder' {
  folderId,
  changes: Array<
    | { op: 'write'; path; content: Uint8Array; ifMatch?: sha256hex; ifAbsent?: true }
    | { op: 'mkdir'; path; ifAbsent?: true }   // mkdir -p of missing parents too
    | { op: 'delete'; path }                    // file or empty dir
  >,                                            // ≤ 64 changes, ≤ 10 MiB per file, ≤ 25 MiB per call
  createFolder?: true,                          // projects:create seeding: create .shared/<id> if absent
} → { kind: 'done'; results: Array<{ path; outcome: 'written' | 'created' | 'exists' | 'deleted' | 'absent' | 'conflict' }> }
  | { kind: 'unavailable' }                     // no storage pool / no export
// The changes apply in order, and the call stops at the first refusal: a conflict, a non-empty
// directory, or a path under a symlink. Each write is atomic (temp file in the target dir,
// then fsync and rename).

// @ax/projects
'projects:read-file'   … file result gains `sha256`
'projects:write-file'  { projectId, path, content: Uint8Array, baseHash?: string, ifAbsent?: true } → { sha256 } | refusal
'projects:delete-file' { projectId, path } → {} | refusal
'projects:create-folder' { projectId, path } → {}
// PluginError reasonCodes: 'conflict' | 'protected-path' | 'read-only-path' | 'too-large' | 'files-unavailable'

// channel-web
PUT    /api/workspace/projects/:projectId/files/*   raw body (≤ 10 MiB), header `If-Match: <sha256>` optional, `If-None-Match: *` = create only
DELETE /api/workspace/projects/:projectId/files/*
POST   /api/workspace/projects/:projectId/folders/* (New folder)
```

## Tasks

1. **`changeConfinedByWalk`** (`@ax/user-files-read`).
   - Walk with `O_PATH` for directories it only passes through and `O_NOFOLLOW`
     everywhere; create missing directories one level at a time.
   - Temp file `O_CREAT|O_EXCL|O_NOFOLLOW` in the target directory, then
     write, fsync, and `renameat` through `/proc/self/fd/<dirfd>/…`.
   - `ifMatch` hashes the current file through its fd; `ifAbsent` uses `O_EXCL`
     semantics, so a write never overwrites.
   - Hooks: `chown(fd)` and modes (files 0644, directories 0755).
   - Tests: a symlink at each level is refused, so a planted link can't
     redirect the write; the size caps; ordering and stop-at-first-refusal; no
     temp file is left behind on error.
2. **Protocol:** `ChangeSharedFolder*` zod schemas plus `Handler` in
   `sandbox-mount-protocol/src/mount-spec.ts`, with the limits as constants.
   Content travels as base64 only on the storage-node wire.
3. **sandbox-k8s:**
   - Storage node:
     - `/change-shared` route with its own body cap (25 MiB of content,
       base64-inflated, plus overhead);
     - an engine method that walks `userFilesRoot → .shared → <id>`, creating
       the folder with `0700` and chowning it to `1000:1000` when
       `createFolder` is set;
     - the walk call, with chown to 1000.
   - Client: `changeShared(input)` sends to any Ready helper.
   - Plugin: registers `sandbox:change-shared-folder` with a 60 s timeout. It
     answers `unavailable` without `sharedPool`.
   - Tests: engine (a temp root standing in for the export), server routing and
     caps, client selection.
   - **The chart is unchanged.** A prod deploy must delete the `ax-next-storage`
     pod.
4. **sandbox-subprocess:** registers the same hook. It uses
   `sandbox:locate-shared-folder` plus `checkSharedFolderMount`, as reads do,
   creates the folder when `createFolder` is set, then calls the walk with no
   chown. Tests.
5. **projects:**
   - `write-file` / `delete-file` / `create-folder`, with access (editor or
     owner member the person can use), protected paths, `sources/` read-only
     and the size cap;
   - fires `system-prompt:augment-changed` per member agent for
     `instructions.md` and `memory/status.md`;
   - the `project_file_changed` audit line;
   - `read-file` returns `sha256`;
   - seeding in `create`, with full rollback (`sandbox:delete-shared-folder`
     when available, the folder row, the project row);
   - the lazy `ensureLayout`;
   - templates.
   - Tests.
6. **channel-web server:** the routes above, the client functions, manifest
   declarations and snapshot, raw-body limits and the CSRF-gated server. Tests
   cover ACL, 404s, 409 conflict, 403 protected / read-only, 413 and 503.
7. **channel-web UI** (invoke `shadcn`):
   - Edit (`Textarea`) for text/Markdown ≤ 1 MiB; Save sends the base hash. On
     conflict, an `AlertDialog`: "Someone changed this file. Reload, or save
     over it?"
   - The `+` menu: "Upload files" and "New text file", into `work/` by default
     (the current folder if it's inside `work/`, `memory/` or `playbooks/`).
   - Delete with a confirm. It isn't offered for protected paths or under
     `sources/`, and viewers get the read-only browser.
   - Tests.
8. **Acceptance + kind walk:**
   - subprocess acceptance: a person writes, an agent edits that file;
   - k8s e2e or kind walk: a person creates a file, an agent edits it
     (ownership), and a seeded layout on a new project.
9. **Docs:** W3 spec §20 "As built: W3c" and fix §6.1's `nosymfollow` text;
   the umbrella's Resume here; the decisions shard.

Security: the new root-run route and untrusted paths, so run `security-checklist`
at task 3 and on the PR.
