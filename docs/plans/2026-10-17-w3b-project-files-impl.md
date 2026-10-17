# W3b: the project's files, read-only — implementation plan

Spec: [`2026-10-12-w3-projects-design.md`](2026-10-12-w3-projects-design.md) §5, §11 (W3b), §13.
Decisions: `.claude/memory/decisions/2026-10-17-AXWM-3.md`.

## The change from the spec: a host walk, not `nosymfollow`

The spec gated W3b on proving `nosymfollow` on an NFS mount. On kind (2026-10-17)
it doesn't hold where it matters:

- kubelet mounts the PV with `ro,relatime,nosymfollow`, and a plain `mount.nfs`
  on the node honours it (`ELOOP`);
- but the container runtime bind-mounts the volume into the pod **without** the
  flag (`/sh ro,relatime`), and a planted absolute symlink was followed
  (`TOPSECRET` read back).

The person chose the **host walk** (option A): the host opens every path
component relative to the previous one's descriptor, through
`/proc/<pid>/fd/<n>/<name>` with `O_NOFOLLOW` (the storage node's
`openDirectory` pattern, `sandbox-k8s/src/storage-node/confined-directory.ts`).
A symlink at any level, swapped in at any time, fails to open (`ELOOP` /
`ENOTDIR`); nothing outside the folder is reached. This is the spec's fallback
walk without the pod and without a new binary. Reads go through the existing
read-only export mount (`sandbox.filestore.hostReadPath`, `/user-files` on prod).

`.shared` is created root `0700` by the storage node, so the host (uid 1000)
can't traverse it. The storage node sets it to **`0711`**: uid 1000 can open a
folder whose id it knows, but can't list `.shared`. Runners never mount
`.shared` itself, so nothing else gains anything. Without the shared pool
(`sharedPool.enabled: false`) nothing sets `0711`, and reads answer
`unavailable`; no deployment runs that way today (documented, not built).

No PV/PVC, no chart change for reads. `projects` still loads without
`hostReadPath`; its file features answer `unavailable` (the spec's "refuse to
start projects" would break W3a chats on such deployments).

## Shapes

```ts
// @ax/sandbox-mount-protocol
interface ReadSharedFolderInput { folderId: string; relPath?: string; limitBytes: number }
type ReadSharedFolderOutput = ReadUserFilesOutput & // file | dir | absent | unavailable
  ({ kind: 'file'; contents: Uint8Array; truncated: boolean; size: number } | ...);
// `size` (bytes on disk) lets the UI show an over-10-MiB file without a download.

// @ax/projects (host-internal, not IPC)
'projects:read-file'     { projectId, path }  → { kind:'dir', entries:[{name, kind, size?, updatedAt?}] }
                                               | { kind:'file', contents, truncated, size }   // 1 MiB
                                               | { kind:'absent' } | { kind:'unavailable' }
'projects:download-file' { projectId, path }  → { contents, size } | refuses 'too-large' (> 10 MiB),
                                                 'not-a-file', 'not-found', 'unavailable'

// channel-web wire (folderId never leaves the server)
GET /api/workspace/projects/:projectId/files[/*]   → UserFilesAnswer (the /files shape)
GET /api/workspace/projects/:projectId/download/*  → bytes | 413 too-large | 404 | 503
```

## Tasks

Each task: tests first, then code; `pnpm build` + the package's tests green.

1. **The walk** (`@ax/user-files-read`): `readConfinedByWalk(root, parts, {limitBytes, maxEntries})`
   — open `root` (trusted), then each component with
   `O_RDONLY|O_NOFOLLOW` (+`O_DIRECTORY` for directories) via `/proc/<pid>/fd`;
   leaf: `fstat` → dir listing (`readdir` of the fd path, symlinks listed as
   neither file nor dir and never opened) or file read up to `limitBytes+1`.
   Components validated lexically (no `''`, `.`, `..`, `/`, NUL; ≤ 32 segments).
   Tests: plain read/list, caps, `..`/absolute refused, symlink leaf, symlink
   intermediate, symlinked dir, FIFO/device refused, and the **race test**: a
   loop swaps an intermediate dir for a symlink to an outside secret while
   another reads; thousands of iterations, the secret is never returned.
2. **The contract and providers**: `sandbox:read-shared-folder` in
   `@ax/sandbox-mount-protocol`; registered by `sandbox-k8s` (root =
   `userFilesHostReadRoot`, parts `['.shared', folderId, ...rel]`; no root →
   `unavailable`; `EACCES` on `.shared` → `unavailable` + a log naming the
   fix) and `sandbox-subprocess` (root = the localdir root, same parts).
   Folder id checked with `isValidSharedFolderId`. Storage node: `.shared`
   `0711` (on startup and on each prepare). Tests per provider.
3. **`@ax/projects`**: `projects:read-file` / `projects:download-file`, gated by
   `loadUsable` before any read; limits 1 MiB / 10 MiB (`too-large`, never
   truncated). `sandbox:read-shared-folder` becomes the one allowed `sandbox:*`
   optional call (update `plugin.test.ts` and `preset.test.ts` guards to allow
   exactly it). The block: `brief` unchanged; a new **`context`** body
   (agent-written text never goes in `brief`): `instructions.md` first 6,000
   chars, the tree (top level + one level under each, ≤ 60 lines, then
   "…and N more"), `memory/status.md` first 3,000 chars; all quoted with
   `quote(noControls())`; a failed part says so; whole block < 12,000 chars.
4. **channel-web server**: the three routes in `routes-projects.ts`, mapping
   like `readUserFilesPath` / `agentUserFileDownload` (share the helpers by
   moving them to a small server module); manifest optional calls. Tests:
   auth, foreign = 404, 413, 503 without the hook or without the mount,
   folderId never in a response.
5. **channel-web UI**: extract a single-tree `FileBrowser` from `AgentFiles`
   (data via a fetcher, copy via props; `AgentFiles` keeps its behaviour and
   tests); route kind `project-files` (`/workspace/projects/:id/files/*`);
   the files card on `ProjectPage` (Instructions, Memory, Playbooks, Sources,
   Work; counts / updated; empty rows); the full-page browser with
   "Projects › name › Files › …"; files over 10 MiB show size, no download;
   mobile tap-through. Invoke the `shadcn` skill.
6. **Acceptance**: the W3a block in `presets/k8s/src/__tests__/acceptance.test.ts`
   gains W3b checks (the block carries instructions/status; a planted symlink
   isn't followed through `projects:read-file`); prod-bootstrap still boots
   (no cycle).
7. **On kind**: the race test against real NFS (a throwaway dir on the dev NFS
   server, the walk run in a pod as uid 1000), then a browser walk of the
   files card and browser.
8. **Docs**: W3 spec §5.1 and §13 rewritten as built, §17-style "As built:
   W3b"; umbrella Resume here + Status + §14; a decisions shard row; a Backlog
   card for the `/files` reader race (pre-existing, §13).

YAGNI: no PV/PVC, no fallback pod, no non-pool `0711` path — all dead code
for today's deployments.
