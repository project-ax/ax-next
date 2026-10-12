# W2: shared folders (design)

**Status:** draft, revised after review 1 (2026-10-12); see §10. Built on branch
`feat/w2-shared-folders` (not merged — §4); §11 lists where the build differs
from this text. **Owner:** Vinay.
**Work item:** W2 of the AX Work Model (`docs/plans/2026-10-11-ax-work-model-design.md`,
§5.1). It needs nothing, and it is merged together with W3's first production
caller (§4).
**Code cited at:** `c11b489e5`.

---

## 1. Why

Projects are shared folders (work model §5). Today every durable file belongs
to exactly one agent: the `/files` mount is the agent's own subtree of the
backing store (`subPath: agentId`), so two agents can't see the same folder.

W2 builds the generic building block: a folder that several agents can mount,
with owner, editor and viewer roles. Projects (W3) are a convention on top of
it. Per the "don't fold generic infra into a feature" rule, W2 is its own
plugin and knows nothing about projects.

## 2. What exists today

- **Mounts.** `sandbox:resolve-mounts (ctx, { owner, readOnly? }) → { mounts: MountSpec[] }`
  is a host-internal service, never an IPC action
  (`packages/sandbox-mount-protocol/src/mount-spec.ts`). Like
  `system-prompt:augment` before W1, **one plugin holds it**:
  `@ax/workspace-filestore` in k8s (`packages/workspace-filestore/src/plugin.ts:50`),
  or `@ax/workspace-localdir` in dev. Each emits one mount keyed off
  `owner.agentId`.
- **The resolver owns the backing-store configuration** (NFS server and
  export, or local root). Providers don't: to find an agent's files for
  cleanup, they ask the resolver through `sandbox:resolve-mounts`.
- **k8s already realizes a list of mounts.**
  - `realizeMounts` (`packages/sandbox-k8s/src/pod-spec.ts:491`) turns each
    `nfs` spec into an inline pod volume plus a `subPath` volume mount.
  - It checks subpaths (`validNfsSubPath`).
  - It adds a chown step for writable `user-files` mounts, because the kubelet
    creates `subPath` directories root-owned. Under GKE Sandbox,
    `prepareAgentSandboxMounts` runs those steps as separate pods (`prepare-mounts.ts`).
- **Subprocess (dev only) shares the host filesystem.** It realizes `localDir`
  with `mkdir -p` and stamps `AX_USERFILES_ROOT`. It can't enforce `readOnly`.
- **The runners grant file access explicitly.**
  - The Claude runner passes `additionalDirectories` built from
    `workspaceRoot`, `ephemeralRoot`, `userFilesRoot` and `memoryRoot`
    (`packages/agent-claude-sdk-runner/src/main.ts:516`), and loads settings
    only from `settingSources: ['user']` (`main.ts:659`).
  - The aisdk runner's tool policy recognizes `[homeDir, ephemeralRoot]`
    (`packages/agent-aisdk-runner/src/main.ts:219`).
  - A new root reaches neither runner automatically.
- **Management authority already exists; use authority doesn't grant it.**
  - `agents:resolve` lets ordinary team members use a team agent.
  - Changing an agent goes through a separate check, `connectorsManageAllowed`
    (`packages/agents/src/plugin.ts:1049`), exposed as
    `agents:can-manage-routines` (`plugin.ts:494`). For a personal agent, only
    its owner. For a team agent, only a team admin. Workspace-admin status
    alone never grants it. Authority comes from the authenticated context.
- **Reducing access, the connector precedent.** `connectors:deleted` marks every
  session that uses the connector, reaps idle sessions immediately, and reaps
  active ones as soon as their turn ends (`onTurnEnd`)
  (`chat-orchestrator/src/orchestrator.ts:1994`). A generation bump
  (`system-prompt:augment-changed`) alone only retires a session when its next
  turn arrives.
- **Agent ids.** The resolvers accept any id matching `^[A-Za-z0-9_-]+$`
  (`workspace-filestore/src/agent-id.ts`). Real ids are minted `agt_…`, but the
  check alone would accept `shared`.
- **Agent deletion.**
  - Providers `rm -rf` the agent's subtree on `agents:deleted`
    (`sandbox-subprocess/src/plugin.ts:108`, `sandbox-k8s/src/user-files-ops.ts`).
  - Every `agent_id` column must be cleaned up: the k8s preset checks the whole
    schema (`presets/k8s/src/__tests__/agent-delete-cleanup.test.ts`, plus
    `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js`).
- **Acceptance harnesses.**
  - The `presets/memory` canary uses the filestore resolver and a **fake k8s
    API** (`presets/memory/src/__tests__/canary.test.ts:137`, `:305`). It can
    check pod specs, but it can't prove that one agent's write is readable by
    another.
  - A real subprocess + localdir end-to-end harness already exists:
    `packages/sandbox-subprocess/src/__tests__/userfiles-canary.acceptance.test.ts`.
- **The shared warm pool is on in production** (Helm rev 32, 2026-10-02;
  `deploy/SHARED-POOL.md`). It serves a session whose runner binary has a pool
  class and that folds no connectors. Its node helper binds only the claimed
  agent's own `/files` and `/memory`, deriving both paths itself.
- **The half-wired policy.** A plugin merges only when it's fully registered,
  tested and reachable. The agent-owned sign-ins epic was developed as a stack
  and merged as one squash (#978).

## 3. Design

### 3.1 A new plugin owns folders and grants

`@ax/shared-folders` holds the tables and the rules. It has no storage-backend
vocabulary (invariant 1).

- **`shared_folders_v1_folders`:**
  - `folder_id` (minted `sf_<base64url>`, a safe single path segment);
  - `created_by_user`, `created_at`;
  - `deleted_at` (a tombstone while files are being removed, §3.7);
  - `cleanup_attempts`, `next_cleanup_at` (the sweep's backoff, §3.7).
- **`shared_folders_v1_grants`:** `folder_id`, `agent_id`, `role`
  (`owner | editor | viewer`), `granted_by_user`, `created_at`. Exactly one
  `owner` per folder, at most one grant per (folder, agent). The owner grant is
  the only record of a folder's owner (no `owner_agent_id` column; §11).

**Same owner only in W2.** Every grant goes to an agent with the same owner
(the same person or the same team) as the folder's owner agent. Sharing across
owners is W4.

### 3.2 Who may change what

Recording who made a change and auditing it isn't authorization. Every
changing hook checks authority before writing.

- **The actor** is the authenticated person on the context (`ctx.userId`), never
  a field in the payload. A call without a real person is refused, so there's
  no ownerless or synthetic actor.
- **New hook `agents:can-manage-sharing { agentId } → { allowed }`.** `@ax/agents`
  registers it with the same rule as `agents:can-manage-routines`:
  - personal agent: only its owner;
  - team agent: only a team admin;
  - workspace-admin status alone never grants it.
- **"Manage a folder"** means "manage its owner agent".

| Hook | Allowed when the actor… | Refused when |
|---|---|---|
| `shared-folders:create { ownerAgentId }` | can manage `ownerAgentId` | otherwise |
| `shared-folders:grant { folderId, agentId, role: editor\|viewer }` (add, or change a role) | can manage the folder **and** can manage `agentId` | the target has a different owner; the target is the owner agent; the folder is unknown or tombstoned. `role: 'owner'` is rejected by the input schema (`invalid-payload`) |
| `shared-folders:revoke { folderId, agentId }` | can manage the folder, **or** can manage `agentId` (an agent's manager can always take it out) | the target is the owner (transfer or delete instead); the folder is unknown or tombstoned |
| `shared-folders:delete { folderId }` | can manage the folder | otherwise; the folder is unknown or already tombstoned (a delete that loses a race with another delete returns `{ deleted: true }`) |
| `shared-folders:list { agentId }` | can use `agentId` (`agents:resolve`) | otherwise |

Two operations have no person, and neither goes through these hooks:

- **`shared-folders:authorize-mounts { agentId, folderIds } → { folders: [{ folderId, readOnly }] }`** (at most 256 ids).
  Mount resolvers call it during session open. It's host-internal and never
  reachable from the sandbox. It only filters a requested list down to the
  agent's live grants. Viewer → `readOnly: true`; a tombstoned folder is never
  returned.
- **Cleanup after an agent is deleted** (§3.7) runs inside the plugin's
  `agents:deleted` subscriber. It isn't a call made on anyone's behalf.

Unauthorized calls throw `forbidden`, write nothing, and are audited as refused
(`shared_folders_refused`, with the reason). Every refusal carries the same
message (`<hook>: not allowed`), so a caller can't tell "doesn't exist" from
"not yours". A malformed payload fails the strict input schema
(`invalid-payload`) before any authority check, and isn't audited.

### 3.3 Where the files live: a subtree no agent id can name

A shared folder lives in the same backing store as `/files`, at
**`.shared/<folderId>`**:
- NFS: `subPath: .shared/<folderId>`;
- localdir: `<root>/.shared/<folderId>`.

The agent-id check can never match `.shared`, so no agent's `/files` can be the
parent of the shared folders. A plain `shared/` would let an agent whose id is
`shared` mount every folder. The leading dot also keeps shared data out of the
per-agent `rm -rf`, which targets `<agentId>` only.

### 3.4 Where agents see them: `/shared/<folderId>`, not inside `/files`

The work model sketched `/files/projects/<id>`. W2 mounts at
**`/shared/<folderId>`**, outside `/files`:

- `/files` is the agent's own writable subtree, so the agent would control the
  mount target. The runtime would create the target inside that subtree. An
  agent that replaced it with a file could stop its own pods from starting, and
  a symlink there turns target resolution into an attack surface.
- A top-level path keeps what the work model wanted: the same path for every
  member.

W3 decides how a project is presented to the model, and the umbrella doc's path
gets updated to match.

### 3.5 Which folders a session mounts

1. **The host picks.** `sandbox:open-session` gains an optional
   `sharedFolderIds: string[]`, set by host code (the orchestrator) and never by
   the model or the sandbox. It's passed through to
   `ResolveMountsInput.sharedFolderIds`.
2. **The grants decide.** The mount resolver calls
   `shared-folders:authorize-mounts` and emits a mount only for each folder
   that comes back, read-only for a viewer. Anything else isn't mounted, and
   the resolver logs it.
3. **The backend stays in the resolver.** It turns each authorized folder into
   its backend's spec:
   - `nfs`, `subPath: .shared/<folderId>`; or
   - `localDir`, `hostPath: <root>/.shared/<folderId>`;

   both at `mountPath: /shared/<folderId>` with the new
   `role: 'shared-folder'` and a `folderId`.

`sandbox:resolve-mounts` stays single-provider, and the resolver lists
`shared-folders:authorize-mounts` in `optionalCalls`.

### 3.6 Giving the runners access

Each provider stamps `AX_SHARED_FOLDERS`, a JSON list of
`{ id, path, readOnly }` built from the realized `shared-folder` mounts. It's
host-controlled; the runner validates it like its other env and rejects
anything that isn't an absolute path.

- **Claude runner.** Add each shared path to `additionalDirectories` (`main.ts:516`),
  so the native Read, Edit, Write, Glob and Grep tools can reach it. (Measured 2026-10-12: this list is the CLI's own directory check, and the
  runner's PreToolUse hook skips it by answering `allow` for every call the host
  approves. So the real bounds are the host's `tool.pre-call` verdict and the
  sandbox's mounts, as they already were for `/files`; a real-SDK e2e drives
  Read and Edit on a shared path.)
  - Shared folders must not become a source of settings, memory or skills:
    `settingSources` stays `['user']`, and nothing in a shared folder is read as
    `CLAUDE.md`, `.claude/settings*.json` or `.claude/skills/`.
  - A test plants all three in a shared folder and checks that none is loaded.
- **aisdk runner.** Its file tools already accept any absolute path. The shared
  paths are deliberately **not** added to the tool policy's `recognizedRoots`
  (`main.ts:219`): that list is where a top-level `.ax/` or `.claude/` path is
  re-rooted onto `/agent`, which is exactly what must not happen. A `.ax/` or
  `.claude/` path inside a shared folder is an ordinary project file: it's never
  re-rooted onto the agent's governed `/agent` tree, and never loaded as a skill.
- **Read-only.** For a viewer, the k8s mount is read-only, so a write fails with
  `EROFS`. The runner's note says the folder is read-only, but the mount is
  what enforces it.
- **Prompt note.** A short note names each folder's path and whether it's
  read-only. W3 replaces it with its project block.

### 3.7 Lifecycle

**Reducing access: revoke, downgrade or delete.**

- Any change that removes or narrows access fires
  `shared-folders:access-reduced { folderId, agentIds }`. That covers a revoke,
  a downgrade from editor to viewer, a delete, and the grants removed when an
  agent is deleted. An increase (a new grant, or viewer to editor) fires
  nothing; the next session picks it up.
- **The orchestrator follows the connector precedent exactly:**
  - it remembers which `sharedFolderIds` it requested for each session;
  - on `access-reduced` it marks every live session of those agents that
    requested that folder;
  - it **reaps idle sessions immediately**, closing their proxy sessions first;
  - it **reaps active sessions as soon as their turn ends** (`onTurnEnd`).

  A generation bump alone isn't enough, because an idle warm sandbox would keep
  a writable mount until its next turn.
- The next session is built from the current grants: no mount after a revoke,
  a read-only mount after a downgrade. A turn in progress keeps its access until
  it ends, because a mid-turn kill hangs the stream. As with Drive, nothing
  un-reads what an agent already saw.

**Deleting a folder's files: cleanup that doesn't depend on grants.**

1. `shared-folders:delete` (or the agent-deletion case below) removes the
   grants, sets `deleted_at` on the folder row, and fires `access-reduced`. The
   folder can no longer be mounted or granted.
2. The plugin then calls **`sandbox:delete-shared-folder { folderId }`**, a new
   service registered by the sandbox provider that realizes deletes.
3. The provider locates the folder through **`sandbox:locate-shared-folder { folderId } → MountSpec`**,
   a new service registered by the mount resolver, because the resolver owns
   the backing-store configuration.
   - It answers from the folder id alone, with no grant check, because by now
     there are no grants. It's host-internal and used only for deletion.
   - It confines the location to `.shared/<one safe segment>`.
4. The provider removes the folder with its existing confined machinery:
   - subprocess: `rm -rf` of the resolved `hostPath`;
   - k8s: the short-lived cleanup job in `user-files-ops.ts`.
5. On success, the plugin removes the folder row. If the call fails, or no
   provider is loaded, the tombstone stays, and a periodic sweep in the plugin
   retries tombstoned folders with backoff: every 5 minutes, 50 per pass, and
   after the n-th failure the next try is 30 s × 2^(n−1) later, capped at 1 h.
   No cleanup depends on rows that have already been deleted.
6. Step 2 never runs inside the caller's request. `shared-folders:delete`
   returns `{ deleted: true }` once the tombstone commits and `access-reduced`
   fires, then starts the cleanup in the background (a k8s reclaim can take up
   to 180 s). The agent-deletion path does the same. The sweep skips a folder
   whose cleanup is already running.

**When an agent is deleted** (`agents:deleted`), its grants are removed and
`access-reduced` fires.
- If it owned a folder, ownership passes to the editor with the oldest grant
  (a role change keeps the grant's original `created_at`). The subscriber locks
  the agent's folder rows first, in `folder_id` order, the same folder-then-grant
  order every other change uses, and a promotion only counts if it updated
  exactly one editor row.
- If there's no editor, the folder is deleted through the steps above.
- A viewer is never promoted to owner, because that would widen its access.
- **If that purge fails** (its transaction rolls back and is logged), the sweep
  heals it: each pass asks `agents:list-ids`, finds grants older than 60 s
  whose agent no longer exists (at most 50 agents a pass), and runs the same
  purge for them, with the same events. A failed or malformed `list-ids`
  answer purges nothing.
- `shared_folders_v1_grants.agent_id` (the only agent-keyed column) is covered
  by the whole-schema cleanup check and by `agent-keyed-tables-are-cleaned`.

### 3.8 Realizing the mounts

- **k8s.** `shared-folder` mounts become inline `nfs` volumes with
  `subPath: .shared/<folderId>`. Writable ones get the same chown step as
  `user-files`, which runs through `prepareAgentSandboxMounts` under GKE Sandbox.
  A viewer's runner volume is read-only at the NFS level (`nfs.readOnly`) as
  well as at the mount. Its folder is still created and chowned before the
  runner starts, through a separate writable `-prep` volume that only the chown
  init mounts (under GKE Sandbox only the prep pod gets it), so a viewer that
  opens a folder before any editor sees a readable empty folder.
- **A user-files mount's `subPath` must be one safe segment**
  (`^[A-Za-z0-9_-]+$`), checked at realize, so a buggy resolver can't hand one
  agent `.shared` as its `/files`.
- **Subprocess (dev only).** `mkdir -p` the `hostPath`. Read-only isn't
  enforced; that's an existing limit of this provider, which isn't a security
  boundary.
- **Shared pool.** Almost every agent will mount a project folder, and the
  pool is on in production, so pooled sessions bind shared folders too (§3.8.1).

#### 3.8.1 Shared folders on the shared warm pool

A pooled pod is started before anyone claims it, so its volumes are fixed. The
pool already late-binds `/files` and `/memory` through the trusted node helper
(`packages/sandbox-k8s/src/storage-node/`): the helper bind-mounts each source
under the pod's memory-backed `ax-late` emptyDir, and the bind reaches the gVisor
pod through `Bidirectional` (helper) → host → `HostToContainer` plus the
force-shared annotation (runner). Shared folders use the same path. Nothing
about the standby pod spec changes.

1. **Host, mount check** (`shared-pool.ts`). A `shared-folder` mount is
   accepted when its export is the pool's user-files export, its `subPath` is
   `.shared/<folderId>` and its `mountPath` is `/shared/<folderId>`, with a
   valid id. Anything else still throws. The host collects
   `[{ folderId, readOnly }]`, sorted by id.
2. **Host, the claim carries the list.** The SandboxClaim gets the annotation
   `ax.io/shared-folders` with that list as canonical JSON, next to the
   existing `ax.io/agent-id` label. The host is already the authority for the
   agent's identity; the list comes from the resolver's
   `shared-folders:authorize-mounts` answer for that agent.
3. **Host, the assignment carries the list.** `storage.assign` gains an
   optional `sharedFolders: [{ folderId, readOnly }]` (at most 16). It's
   omitted when empty, so a session without shared folders sends what it sends
   today. An empty list is refused on the wire, so "no folders" has one
   form.
4. **Helper, authorization.** Besides today's checks, the request's
   `sharedFolders` must equal the claim's annotation exactly (both empty when
   the annotation is absent). A mismatch is refused like an agent-id mismatch.
5. **Helper, the source path comes from the id, never from the request.** For
   each folder the helper opens `.shared/<folderId>` under the user-files
   backing export, pinning each component with `O_NOFOLLOW` (the existing
   confined-directory code), creating `.shared` and the folder if missing.
   The folder is chowned to the runner uid, as `/files` is, for viewers too
   (the bind is still remounted read-only), so a viewer-first folder is
   readable.
6. **Helper, the bind.** Target `ax-late/shared/<folderId>`. Viewers get the
   same second `remount,bind,ro` that `/memory` gets. All binds happen before
   the bootstrap file is published, so the runner never starts without them.
   The helper creates `ax-late/shared` itself with mode `0755`: the pod's
   emptyDir hides the image's own `/ax/late/shared`, and nothing is mounted over
   `shared`, so a root-only directory would lock the runner out. It refuses the
   assignment if that directory exists and isn't owned by root (the runner
   created it), on a held descriptor, before any bind and again per folder. A
   failed activation keeps its cause (redacted) instead of a bare
   `storage activation failed`.
7. **Helper, ledger and release.** The ledger record and the recovery
   annotation carry the folder list (both stay under their 8 KiB caps at 16
   folders). Release and recovery unmount every shared target and verify it in
   `mountinfo`, the same way as `/files` and `/memory`.
8. **Runner bootstrap.** `AX_SHARED_FOLDERS` joins the bootstrap control names.
   Its value must be a JSON list of at most 16 `{ id, path, readOnly }` with
   `path` exactly `/shared/<id>`; anything else rejects the assignment.
9. **Image.** `/ax/late/shared` exists and `/shared` is a symlink to it, next
   to the existing `/files` and `/memory` links.
10. **Open-session.** The `shared-folders-unsupported-in-pool` refusal goes.
    The pool's existing cold-pod fallback (service sidecars, a binary with no
    pool class) is unchanged.

**What stays the same.** The helper still has no database and checks no
grants: the host decides which folders an agent may mount, exactly as it
decides which agent a claim is for, and the helper refuses anything the claim
doesn't name. `backingProfile` is unchanged because the export is the same.

**Before the squash: a GKE acceptance run.** `/files` and `/memory` bind one
level below the `ax-late` root; shared folders bind two levels below
(`ax-late/shared/<id>`). Propagation into gVisor at that depth is covered by
unit tests with simulated mounts only, so `deploy/SHARED-POOL-ACCEPTANCE.md`
gets an item, and the squash waits for it: on GKE, a pooled editor session
writes a file another agent's pooled session reads, and a pooled viewer's write
fails.

**Rollout order.** The helper DaemonSet uses `OnDelete`, and an old helper
rejects an assignment with an unknown field. The image (runner and helper)
rolls first, then the helper pods, then the host.

### 3.9 Not in W2

- **Projects:** the fixed layout, `instructions.md`, the project prompt block,
  and conversations' `projectId`. That's W3, except for the minimal caller W2
  merges with (§4).
- **Sharing across owners and accepting a share (W4).**
- **Per-file history and undo, and the web file view of a shared folder (W3).**
- **Metering shared folders.** `/files` isn't metered either.

## 4. Merged with a reachable caller, not a named window

Naming a half-wired window doesn't close it. W2 is developed as a **dependent
PR stack** and merged **as one squash** together with its first production
caller, following the sign-ins precedent (#978).

- **The caller is W3's first slice:**
  - a conversation can belong to a project;
  - the project names its shared folder;
  - **the orchestrator sets `sharedFolderIds` from the conversation's project**
    when it opens a session.

  The W3 spec defines that slice exactly. W2's PRs sit under it in the stack.
- **Nothing in the stack merges on its own.** The squash lands when:
  - every PR in it is approved and green;
  - both presets load `@ax/shared-folders`;
  - the acceptance tests below pass.
- **Acceptance: real files, real providers.** A new
  `packages/sandbox-subprocess/src/__tests__/shared-folders-canary.acceptance.test.ts`
  follows the existing `userfiles-canary` pattern: the real subprocess
  provider, the real localdir resolver, the real `@ax/shared-folders`, and a
  runner stub. It checks:
  - agent A writes a file in a shared folder and a fresh session of agent B
    reads it;
  - after a downgrade, B's next session gets a read-only mount spec (the
    write failure itself is k8s-only and is covered by the pod-spec checks);
  - after a revoke, B's next session has no mount;
  - after a delete, the folder's directory is gone, even though its grants were
    removed first.
- **The end-to-end caller test lives in the W3 slice.** A session opened for a
  conversation in a project mounts that project's folder through the
  orchestrator.
- **Pod-spec checks stay separate.** The `presets/memory` canary (filestore plus
  fake k8s) and the k8s preset tests assert the pod spec:
  - volume and `subPath`;
  - read-only and no chown for a viewer, chown for an editor;
  - pool mode (`packages/sandbox-k8s/src/__tests__/shared-pool.test.ts`).

  They don't claim to prove file access across agents.

## 5. Changes by package

- **New `@ax/shared-folders`:**
  - tables, migrations and hooks (§3.1, §3.2), with authorization on every
    changing hook;
  - `agents:deleted` handling, ownership transfer and the tombstone sweep;
  - fires `shared-folders:access-reduced`.
- **`@ax/agents`:** `agents:can-manage-sharing`, using the same rule as
  `agents:can-manage-routines`.
- **`@ax/sandbox-protocol`:** optional `sharedFolderIds` on `OpenSessionInput`.
- **`@ax/sandbox-mount-protocol`:**
  - `sharedFolderIds` on `ResolveMountsInput`;
  - `role: 'shared-folder'` and `folderId` on both mount kinds;
  - the `sandbox:locate-shared-folder` and `sandbox:delete-shared-folder`
    contracts.
- **`@ax/workspace-filestore`, `@ax/workspace-localdir`:**
  - call `shared-folders:authorize-mounts` (optional) and emit folder mounts;
  - register `sandbox:locate-shared-folder`;
  - reject any `folderId` that isn't one safe segment.
- **`@ax/sandbox-k8s`:**
  - realize `shared-folder` mounts with chown for writable ones;
  - stamp `AX_SHARED_FOLDERS`;
  - refuse in pool mode;
  - register `sandbox:delete-shared-folder`.
- **`@ax/sandbox-subprocess`:** `mkdir -p`, `AX_SHARED_FOLDERS`, and
  `sandbox:delete-shared-folder`.
- **`@ax/agent-runner-core`:** parse `AX_SHARED_FOLDERS`, and the prompt note.
- **`@ax/agent-claude-sdk-runner`:** shared paths in `additionalDirectories`,
  never in settings or skill discovery.
- **`@ax/agent-aisdk-runner`:** shared paths kept out of `recognizedRoots`,
  so nothing in them is re-rooted.
- **`@ax/chat-orchestrator`:**
  - remember each session's requested `sharedFolderIds`;
  - subscribe to `shared-folders:access-reduced` with the reap-idle-now and
    reap-active-at-turn-end lifecycle;
  - the caller itself arrives with the W3 slice.
- **Presets:** the k8s preset loads the plugin, and the memory preset gets it
  through `createK8sPlugins`. The dev CLI preset can't: it has no Postgres and no
  `@ax/agents` (§11).

## 6. Tests

**Authorization (review 1, finding 1)**
- A team member who isn't an admin can't create, grant, revoke or delete on a
  team agent's folder.
- A person can't grant a folder to an agent they don't manage, or to an agent
  with a different owner.
- Workspace-admin status alone grants nothing.
- A call with no real person is refused.
- Every refusal writes nothing and is audited as refused.
- The manager of a target agent can revoke that agent's own grant.

**Reducing access (finding 2)**
- A downgrade from editor to viewer and a revoke each fire `access-reduced`.
- An idle session that requested the folder is reaped immediately; an active
  one is reaped at turn end.
- Sessions that didn't request the folder are untouched.
- The next session mounts read-only after a downgrade, and nothing after a
  revoke.

**Cleanup (finding 3)**
- Deleting a folder removes its directory after its grants are gone,
  resolving the location through `sandbox:locate-shared-folder`.
- A failed delete keeps the tombstone and the sweep retries it.
- A tombstoned folder can't be mounted or granted.
- Locate refuses anything outside `.shared/<segment>`.

**Runners (finding 4)**
- With `AX_SHARED_FOLDERS` set, Claude's native Read and Edit work on a shared
  path, and the aisdk runner's file tools do too.
- A `CLAUDE.md`, `.claude/settings.json` and `.claude/skills/x/SKILL.md` planted
  in a shared folder are not loaded.
- A `.ax/` path inside a shared folder isn't re-rooted.

**Acceptance (findings 5 and 6):** §4.

**Rules and resolvers**
- One owner, same owner only.
- Ownership transfer to the oldest editor, delete when there's none, and a
  viewer is never promoted.
- `authorize-mounts` filters correctly.
- `isValidAgentId('.shared')` is false.
- Resolvers emit nothing for shared folders without the plugin.

## 7. Boundary review

- **New hooks:**
  - the `shared-folders:*` services and the `shared-folders:access-reduced`
    event;
  - `agents:can-manage-sharing`;
  - `sandbox:locate-shared-folder` and `sandbox:delete-shared-folder`.
- **Alternate implementation:**
  - grants kept in an external ACL service behind the same hooks;
  - folders on object storage through a FUSE mount kind, with no change to
    `@ax/shared-folders`.
- **Payload fields that might leak:** none in `shared-folders:*` or
  `agents:can-manage-sharing` (`folderId`, `agentId`, `role`, `readOnly`). The
  backend words (`subPath`, `hostPath`, `.shared/`) stay in the resolvers and in
  `@ax/sandbox-mount-protocol`, which exists to hold them.
- **Subscriber risk:** `access-reduced` carries only `folderId` and `agentIds`.
- **Wire surface:** none. Nothing here is an IPC action.

## 8. Security note (run `security-checklist` on the PR)

- **Authorization:** every change requires management authority over the
  folder, and over the target agent for a grant. That authority comes from the
  authenticated person, using the existing manage rule. Use authority never
  implies it (§3.2).
- **Sandbox escape:**
  - the same `subPath` confinement as `/files`;
  - a `.shared` subtree no agent id can name;
  - mounts kept out of agent-controlled directories;
  - folder ids checked in every resolver, in locate and in delete.
- **Least privilege:**
  - a session mounts only host-chosen folders that its agent has a grant for;
  - viewers get read-only mounts (in k8s);
  - access reductions reap sessions (idle now, active at turn end);
  - there's no agent tool or IPC action to share, revoke or mount.
- **Runners:** shared folders are file-tool roots only, never a source of
  settings, memory or skills (§3.6).
- **Prompt injection:** files in a shared folder may be written by another,
  possibly injected, agent with the same owner. W3's prompt block frames them
  as untrusted.
- **W4 blocker: symlinks across agents.**
  - A planted `report.md → /files/secret.txt` resolves in the reader's own
    sandbox, and an injected reader could be led to copy its own private file
    back into the shared folder.
  - Candidate fixes: NFS `nosymfollow` through PV mount options (needs a check
    under gVisor), or a symlink policy in the file tools.
  - This doesn't block W2, which is same owner only.
- **Revocation latency:** idle sessions immediately; active sessions at the end
  of their current turn.
- **Supply chain:** no new dependencies.

## 9. Size and order

A dependent stack, merged as one squash with W3's first slice (§4):

1. `@ax/shared-folders` (tables, authorization, lifecycle, tombstone sweep),
   `agents:can-manage-sharing`, and the protocol fields and contracts.
2. Resolvers, providers, locate and delete, runner access, and the
   orchestrator's reap lifecycle.
3. The subprocess shared-folders acceptance test and the pod-spec checks.
4. *(W3's first slice, on top: the conversation's project and the
   orchestrator setting `sharedFolderIds`, with its end-to-end test.)*

As built, the layers are one branch with one draft PR (#989), because a PR whose
base isn't `main` gets no CI run. The commits interleave the layers rather than
stacking them strictly (AXWM-3).

## 10. Review log

**Review 1 (2026-10-12)**, six findings, all accepted:

1. **[P1] The authorization for managing folders was unspecified.** Resolved
   in §3.2: an actor from the authenticated context, a new
   `agents:can-manage-sharing` that uses the existing manage rule, a per-hook
   permission table, and tests for unauthorized changes.
2. **[P1] Reducing access didn't reliably retire mounts.** Resolved in §3.7:
   downgrades fire `access-reduced` as well, and the orchestrator applies the
   connector lifecycle (reap idle now, active at turn end).
3. **[P2] Cleanup lost the information needed to find the files.** Resolved in
   §3.7: a tombstone, a backend-owned `sandbox:locate-shared-folder` that
   doesn't depend on grants, a provider-owned `sandbox:delete-shared-folder`,
   and a retry sweep.
4. **[P2] The runner change missed Claude's file-tool permissions.** Resolved in
   §3.6: `additionalDirectories` (Claude) and `recognizedRoots` (aisdk), kept out
   of settings and skill discovery, with tests.
5. **[P2] The acceptance harness didn't match the current canary.** Resolved in
   §4: a real subprocess + localdir acceptance test following
   `userfiles-canary`. Pod-spec checks stay separate.
6. **[P2] Naming the half-wired window didn't close it.** Resolved in §4 and §9:
   a dependent stack merged as one squash with W3's first production caller,
   following #978.

## 11. As built (2026-10-12)

Branch `feat/w2-shared-folders`; decisions in
`.claude/memory/decisions/2026-10-12-AXWM-3.md`. Where the build differs from
the text above:

1. **aisdk `recognizedRoots`.** §3.6 originally said to add the shared paths.
   That list is the re-rooting set, so adding them would have re-rooted
   `/shared/<id>/.claude/...` onto `/agent`. They're left out, and a test pins it.
2. **No `owner_agent_id`.** The owner lives only in the owner grant (invariant
   4), which also means a tombstone never carries a deleted agent's id.
3. **`sandbox:delete-shared-folder` is called undeclared** (guarded by
   `hasService`). Declaring it closes a call-graph cycle (shared-folders →
   provider → `sandbox:locate-shared-folder` → `shared-folders:authorize-mounts`),
   which bootstrap rejects.
4. **The dev CLI doesn't load the plugin** (Postgres-only); without it the
   localdir resolver emits no shared mounts.
5. **The Claude runner strips `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`**
   from the SDK env. Measured against the pinned CLI, that flag alone loads
   `CLAUDE.md` from every additional directory even with
   `settingSources: ['user']`, and a credential-placeholder-shaped value could
   carry it through the runner's env filter.
6. **The subprocess provider stamps host paths** in `AX_SHARED_FOLDERS` (it has
   no mount namespace); k8s stamps `/shared/<id>`.
7. **Until W3, the orchestrator's folder list comes from a plugin option**
   (`sharedFolderIdsFor`, default none). W3's first slice supplies it from the
   conversation's project. The orchestrator records the requested folders
   *before* the sandbox opens, so a reduction that lands mid-open still reaps
   the session.
8. **Ill-formed folder ids are rejected at open, not dropped.** §3.5 says ids
   that aren't mounted are logged and skipped. That holds for well-formed ids
   with no grant. An ill-formed id never reaches a resolver: the
   `sandbox:open-session` schema rejects the whole open (`invalid-payload`; at
   most 16 ids, no duplicates), and the orchestrator drops and logs ill-formed
   ids before it calls open. Stricter on purpose; the acceptance canary pins it.
9. **Schema failures aren't audited.** §3.2's "every refusal is audited" covers
   authority refusals. A payload that fails the strict schema
   (`invalid-payload`, e.g. `role: 'owner'` on grant) is rejected before any
   authority check and writes no audit line.
10. **The pool was refusing shared folders, and the pool is on in production.**
    §3.8's "disabled" was wrong when written. Once W3a sets `sharedFolderIds`,
    a refusal would hit most project chats, so pool support is now part of this
    stack (§3.8.1).

**Details the text above leaves out** (all deliberate, all tested):

- Caps: 16 folders per session (orchestrator, `sandbox:open-session`, runner
  env); 256 ids per `authorize-mounts` call.
- Resolvers fail closed when the authorizer throws, ignore folders they didn't
  request, treat anything but an explicit `readOnly: false` as read-only, and
  force every shared mount read-only when the caller asks for a read-only
  realization.
- The k8s provider refuses a malformed shared mount, the same folder twice, a
  mount path that overlaps another mount, and a `folderId` on any other role.
- The subprocess provider refuses unrequested or duplicate shared mounts; its
  delete refuses a symlinked `.shared` and only unlinks a symlinked folder
  directory.
- The `access-reduced` event for a delete includes the owner agent.


## 12. What W3a adds to this stack

W3a (W3 spec §4.2, §4.5; not yet approved) stacks on this branch. Nothing here
is built yet; W2 leaves these points open for it:

- **`shared-folders:get { folderId } → { folderId, members }`** (W3 §4.2). One
  new store query over `shared_folders_v1_grants` joined to live folders; no
  schema change. Authorization is W3's rule (the actor can use at least one
  member agent; otherwise `not-found`).
- **`shared-folders:deleted { folderId }`** (W3 §4.2). It fires at the two
  tombstone points that already exist:
  - `shared-folders:delete`, right after the tombstone commits and before the
    byte cleanup. A delete that loses a race with another delete returns before
    this point, so the event fires once.
  - The `agents:deleted` path, for each folder in its `tombstoned` list (an
    owner with no editor left). A folder that passed to an heir never appears
    there.
  Like `access-reduced`, it's fired after the commit with no outbox, so a crash
  in between loses it. **W3a must therefore have the tombstone sweep re-fire
  it for every tombstone it still sees** (W3's subscriber is meant to be
  idempotent). Decided 2026-10-12: this lands with the event in W3a, not in W2.
- **Replacing `sharedFolderIdsFor`** (W3 §4.5). Its one call site is
  `sharedFolderIdsForSpawn` in the orchestrator's open step, after the prompt
  augment. W3a moves the project lookup before the augment and hands
  `[folderId]` to the same open step; record-before-open, the reap lifecycle and
  the resolver's grant check stay as they are. `shared-folders-access-reduced.test.ts`
  re-points from the option to the new source. (W3 §4.5 cites
  `orchestrator.ts:2902` and `:3760`; on this branch they're about `:3094` and
  `:3958`.)
- **No call cycle.** W2's declared edges: `@ax/shared-folders` →
  `database:get-instance`, `agents:can-manage-sharing`, `agents:resolve`
  (`sandbox:delete-shared-folder` undeclared, §11); resolvers →
  `shared-folders:authorize-mounts` (optional); providers →
  `sandbox:resolve-mounts`, `sandbox:locate-shared-folder` (optional). None of
  them reaches `@ax/conversations` or a future `@ax/projects`, so W3's
  conversations → projects → shared-folders direction adds no loop.
