# W2: shared folders (design)

**Status:** draft for review, 2026-10-12. **Owner:** Vinay.
**Work item:** W2 of the AX Work Model (`docs/plans/2026-10-11-ax-work-model-design.md`,
§5.1). It needs nothing, and it unblocks W3 (projects), which is its first user.
**Code cited at:** `c11b489e5`.

---

## 1. Why

Projects are shared folders (work model §5). Today every durable file belongs
to exactly one agent: the `/files` mount is the agent's own subtree of the
backing store (`subPath: agentId`). Two agents can't see the same folder.

W2 builds the generic building block: a folder that several agents can mount,
with owner, editor and viewer roles. Projects (W3) are a convention on top of
it. Per the "don't fold generic infra into a feature" rule, it's its own
plugin and knows nothing about projects.

## 2. What exists today

- **Mounts.** `sandbox:resolve-mounts (ctx, { owner, readOnly? }) → { mounts: MountSpec[] }`
  is a host-internal service, never an IPC action
  (`packages/sandbox-mount-protocol/src/mount-spec.ts`).
  - Like `system-prompt:augment` before W1, **one plugin holds it**:
    `@ax/workspace-filestore` in k8s (`packages/workspace-filestore/src/plugin.ts:50`)
    or `@ax/workspace-localdir` in dev and the canary. Exactly one loads per
    deployment.
- **What the resolvers emit today.** Each returns one mount, keyed off
  `owner.agentId`:
  - filestore: `{ kind: 'nfs', server, exportPath, subPath: agentId, mountPath: '/files', role: 'user-files' }`
  - localdir: `{ kind: 'localDir', hostPath: <root>/<agentId>, … }`
- **k8s already realizes a list of mounts.** `realizeMounts`
  (`packages/sandbox-k8s/src/pod-spec.ts:491`) turns each `nfs` spec into an
  inline pod volume plus a `subPath` volume mount. It checks subpaths
  (`validNfsSubPath`) and adds a chown step for writable `user-files` mounts,
  because the kubelet creates `subPath` directories root-owned. Under GKE
  Sandbox, `prepareAgentSandboxMounts` runs those chown steps as separate pods
  before the sandbox starts (`prepare-mounts.ts`).
- **Subprocess (dev and canary) shares the host filesystem.** It realizes
  `localDir` with `mkdir -p hostPath` and stamps the path as `AX_USERFILES_ROOT`
  (`packages/sandbox-subprocess/src/open-session.ts:412`). It can't enforce
  `readOnly`.
- **The runner learns its paths from env.** For example, `AX_USERFILES_ROOT`
  drives the "Keeping files" note in the system prompt
  (`packages/agent-runner-core/src/system-prompt.ts:263`).
- **Agent ids.** The resolvers accept any id matching `^[A-Za-z0-9_-]+$`
  (`workspace-filestore/src/agent-id.ts`). Real ids are minted as `agt_…`, but
  the check alone would accept `shared`.
- **Agent deletion.**
  - Each provider `rm -rf`s the agent's subtree on `agents:deleted`
    (`sandbox-subprocess/src/plugin.ts:108`, `sandbox-k8s/src/user-files-ops.ts`).
  - Every table with an `agent_id` column must be cleaned up: the k8s preset
    asks the database itself (`presets/k8s/src/__tests__/agent-delete-cleanup.test.ts`),
    and `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js` keeps the
    list honest.
- **Live sessions change only at a turn boundary.**
  - `system-prompt:augment-changed` bumps a per-agent generation, and that
    agent's live sessions restart at their next turn.
  - `connectors:deleted` marks the sessions that use a connector, and reaps
    idle ones (`chat-orchestrator/src/orchestrator.ts:1994`).
  - Nothing interrupts a turn in progress.
- **Plugins own their tables** through `database:get-instance` (Kysely), with
  their own migrations (for example `packages/teams`).
- **The shared pool is opt-in and disabled.** Its node helper binds only the
  claimed agent's own directory into a prewarmed pod
  (`docs/plans/2026-10-01-agent-sandbox-shared-pool-design.md`).
- **`/files` isn't metered.** `@ax/disk-quota` covers the git workspace and
  blobs only.

## 3. Design

### 3.1 A new plugin owns folders and grants

`@ax/shared-folders` holds two tables and the rules about them. It has no
storage-backend vocabulary: folders and grants are ids and roles (invariant 1).

- **`shared_folders_v1_folders`:** `folder_id` (minted `sf_<base64url>`, so it's
  a safe single path segment), `created_by_user`, `created_at`.
- **`shared_folders_v1_grants`:** `folder_id`, `agent_id`, `role`
  (`owner | editor | viewer`), `granted_by_user`, `created_at`.
  - Exactly one `owner` per folder.
  - At most one grant per (folder, agent).

**Same owner only in W2.** A grant may go only to an agent with the same owner
(the same person, or the same team) as the folder's owner agent. This is
checked through `agents:resolve`. Sharing across owners is W4.

**Hooks** (all host-internal services; none is an IPC action or agent tool):

| Hook | Does |
|---|---|
| `shared-folders:create { ownerAgentId }` → `{ folderId }` | Creates a folder with that agent as owner |
| `shared-folders:grant { folderId, agentId, role }` | Adds or changes a grant (same owner only); can't create a second owner |
| `shared-folders:revoke { folderId, agentId }` | Removes a grant; the owner can't be revoked, only transferred or the folder deleted |
| `shared-folders:list { agentId }` → grants | The folders an agent can use, with roles |
| `shared-folders:authorize-mounts { agentId, folderIds }` → `[{ folderId, readOnly }]` | Filters a requested list down to the agent's grants. Viewer → `readOnly: true`. A folder without a grant is left out, never an error. |
| `shared-folders:delete { folderId }` | Deletes the folder, its grants, and (through the provider, §3.6) its files |

Every call that creates, changes or removes access is made for a person,
records `granted_by_user`, and is audited.

### 3.2 Where the files live: a subtree no agent id can name

A shared folder lives in the same backing store as `/files`, at
**`.shared/<folderId>`**:
- NFS: `subPath: .shared/<folderId>` on the existing export.
- localdir: `<root>/.shared/<folderId>`.

The leading dot matters. The agent-id check (`^[A-Za-z0-9_-]+$`) can never
match `.shared`, so no agent's own `/files` subtree can ever be the parent of
the shared folders. With a plain `shared/`, an agent whose id happened to be
`shared` would mount every folder. It also keeps shared data out of the
per-agent `rm -rf` on agent deletion, which targets `<agentId>` only.

### 3.3 Where agents see them: `/shared/<folderId>`, not inside `/files`

The work model sketched `/files/projects/<id>`. W2 mounts at
**`/shared/<folderId>`** instead, outside `/files`:

- **`/files` is the agent's own writable subtree, so the agent controls
  whatever path a nested mount would land on.**
  - The container runtime would create `/files/projects/<id>` inside that
    subtree on NFS.
  - An agent that replaced `projects` with a file could make its own pods fail
    to start.
  - A symlink there turns mount-target resolution into an attack surface.
- **A top-level path keeps both properties the work model wanted:** every
  member sees the folder at the same path, and a path cited in a note works for
  all of them.
- W3 decides how a project is presented to the model (for example by naming the
  path in its prompt block). The umbrella doc's `/files/projects/<id>` gets
  updated to match.

### 3.4 Which folders a session mounts: chosen by the host, checked against grants

The work model requires "only the active project is mounted", so a session
mounts only the folders the host picked for it, never "everything the agent
can use":

1. **The host picks.** `sandbox:open-session`'s input gains an optional
   `sharedFolderIds: string[]`, set by host code (the orchestrator), never by
   the model or the sandbox. It's passed through to `sandbox:resolve-mounts` as
   `ResolveMountsInput.sharedFolderIds`.
2. **The grants decide.** The mount resolver (filestore or localdir) calls
   `shared-folders:authorize-mounts { agentId, folderIds }`. It emits a mount
   only for each folder that comes back, read-only where the grant is viewer.
   A folder the agent has no grant for is silently not mounted, and the
   resolver logs it.
3. **The backend stays in the resolver.** The resolver turns each authorized
   folder into its backend's spec: `nfs` with `subPath: .shared/<folderId>`, or
   `localDir` with `hostPath: <root>/.shared/<folderId>`. Both use
   `mountPath: /shared/<folderId>` and the new `role: 'shared-folder'`. Grants
   live in one place and backend details in the other (invariant 4).

`sandbox:resolve-mounts` stays single-provider. Shared folders don't need a
second provider, because the resolver that already owns the backend asks the
grants plugin which folders to add. The resolver lists
`shared-folders:authorize-mounts` in `optionalCalls`. Without the plugin it
emits no shared mounts, which is today's behavior.

**Telling the runner.** Each provider stamps `AX_SHARED_FOLDERS`, a JSON list
of `{ id, path, readOnly }` built from the realized `shared-folder` mounts,
next to `AX_USERFILES_ROOT`. The runner validates it like its other env
(host-controlled, never model input) and adds a short note to the system
prompt naming each folder's path and whether it's read-only. W3 replaces that
note with its project block.

### 3.5 Realizing the mounts

- **k8s.** `realizeMounts` already handles a list. `shared-folder` mounts become
  inline `nfs` volumes with `subPath: .shared/<folderId>`. Writable ones get the
  same chown step as `user-files`, so the non-root runner can write a directory
  the kubelet created root-owned. Under GKE Sandbox that runs through the
  existing `prepareAgentSandboxMounts`, which picks up chown steps by name.
  Viewer mounts are `readOnly: true` and need no chown.
- **Subprocess (dev and canary only).** `mkdir -p` the `hostPath`. Read-only
  can't be enforced without a real mount; that's an existing limit of this
  provider, which isn't a security boundary, and it's documented on the spec.
- **Shared pool (disabled today).** Its node helper binds only the agent's own
  directory. Until the helper learns to bind shared folders, a pool session
  asked to mount any shared folder **fails to open with a clear error** rather
  than starting without the folder. Enabling shared folders in pool mode is an
  explicit follow-up on the pool's acceptance checklist.

### 3.6 Lifecycle

- **Revoking access.**
  - `shared-folders:revoke` (and `delete`) fires
    `sandbox:mounts-changed { agentId }` for every agent that lost access.
  - The orchestrator subscribes and treats it like `augment-changed`: it bumps
    that agent's generation, so its live sessions restart at their next turn,
    and the new session no longer mounts the folder.
  - **A turn in progress keeps access until it ends**, the same posture as
    `connectors:deleted`, because a mid-turn kill hangs the stream. As with
    Drive, nothing un-reads what an agent already saw.
- **Agent deleted** (`agents:deleted`): its grants are removed.
  - If it owned a folder, ownership passes to the editor with the oldest grant.
  - If there's no editor, the folder is deleted, files included. A viewer is
    never promoted to owner, because that would widen its access.
- **Deleting a folder's files.**
  - `@ax/shared-folders` fires `shared-folders:deleted { folderId }` after its
    rows are gone.
  - The sandbox provider that realizes mounts removes `.shared/<folderId>` with
    the same machinery it uses for an agent's subtree:
    - subprocess: `rm -rf` of the resolved `hostPath`;
    - k8s: the short-lived cleanup job in `user-files-ops.ts`.
  - It confines the path the same way, refusing anything that isn't
    `.shared/<one safe segment>`.
- **Agent-keyed table cleanup.** `shared_folders_v1_grants.agent_id` is covered
  by the k8s preset's whole-schema check, and the table is added to
  `agent-keyed-tables-are-cleaned`.

### 3.7 Not in W2

- **Projects:** the fixed layout, `instructions.md`, the project prompt block,
  conversations' `projectId` (W3). W3 is also where the orchestrator starts
  setting `sharedFolderIds`.
- **Sharing across owners and accepting a share (W4).**
- **Per-file history and undo (W3).**
- **A web view of a shared folder's files.** The host-read path
  (`sandbox:read-user-files`) gets a shared-folder variant in W3, alongside the
  file browser.
- **Metering shared folders.** `/files` isn't metered today either.

## 4. The half-wired window (named on purpose)

W2 has no production caller until W3: nothing sets `sharedFolderIds` on a real
session. Per the half-wired policy, the window is named and closed rather than
left open:

- **Loaded in both presets** (`packages/cli/src/main.ts`, `presets/k8s/src/index.ts`)
  in the W2 PR.
- **Reached by acceptance tests:**
  - the `presets/memory` canary (subprocess + localdir) creates a folder, grants
    two same-owner agents, opens a session for each with `sharedFolderIds`, and
    checks that a file written by one is read by the other;
  - after a revoke, the next session doesn't mount it;
  - the k8s preset tests cover the pod spec (volume, `subPath`, read-only for a
    viewer, chown for an editor).
- **Closed by W3,** which sets `sharedFolderIds` from the conversation's
  project. W3 is next in the order (work model, "Resume here"). If W3 slips,
  W2 stays unused but tested, never dead.

## 5. Changes by package

- **New `@ax/shared-folders`:**
  - tables, migrations and the hooks in §3.1;
  - the same-owner check;
  - `agents:deleted` handling (§3.6);
  - fires `sandbox:mounts-changed` and `shared-folders:deleted`.
- **`@ax/sandbox-protocol`:** optional `sharedFolderIds` on `OpenSessionInput`.
- **`@ax/sandbox-mount-protocol`:**
  - `sharedFolderIds` on `ResolveMountsInput`;
  - `role: 'shared-folder'` and a `folderId` on both mount kinds;
  - consumers keep branching on `kind`.
- **`@ax/workspace-filestore`, `@ax/workspace-localdir`:**
  - call `shared-folders:authorize-mounts` (optional) and emit the folder mounts
    (§3.4);
  - reject any `folderId` that isn't one safe segment.
- **`@ax/sandbox-k8s`:**
  - realize `shared-folder` mounts with chown for writable ones;
  - stamp `AX_SHARED_FOLDERS`;
  - refuse shared folders in pool mode;
  - delete a folder's files on `shared-folders:deleted`.
- **`@ax/sandbox-subprocess`:** `mkdir -p` and `AX_SHARED_FOLDERS`, plus
  deletion on `shared-folders:deleted`.
- **`@ax/agent-runner-core`:** parse `AX_SHARED_FOLDERS`, and add the
  shared-folders note.
- **`@ax/chat-orchestrator`:** subscribe to `sandbox:mounts-changed`. In W2 it
  doesn't set `sharedFolderIds` yet (§4).
- **Presets:** load the plugin in both.

## 6. Tests

**Plugin**
- Grant rules: one owner, same owner only, no second owner, the owner can't be
  revoked.
- Ownership transfer to the oldest editor; delete when there's no editor.
- A viewer is never promoted.
- `authorize-mounts` filters out ungranted folders and maps a viewer to
  read-only.
- `agents:deleted` removes grants.

**Resolvers**
- They emit nothing for shared folders without the plugin.
- They emit only authorized folders, with the correct backend spec, and reject
  an unsafe `folderId`.
- `isValidAgentId('.shared')` is false.

**k8s pod spec**
- Volume and `subPath: .shared/<id>`.
- Read-only and no chown for a viewer; chown for an editor.
- Pool mode with shared folders refuses to open.

**Lifecycle**
- A revoke fires `sandbox:mounts-changed`, and the next turn's session doesn't
  mount the folder.
- `shared-folders:deleted` removes only `.shared/<id>`.

**Acceptance** (§4), plus the k8s whole-schema agent-delete check.

## 7. Boundary review

- **New hooks:** the six `shared-folders:*` services, plus the
  `sandbox:mounts-changed` and `shared-folders:deleted` events.
- **Alternate implementation:** grants kept in an external system (a Drive-like
  ACL service) behind the same hooks; or folders on object storage through a
  FUSE mount kind, with no change to `@ax/shared-folders`.
- **Payload fields that might leak:** none in `shared-folders:*` (`folderId`,
  `agentId`, `role`, `readOnly`). The backend words (`subPath`, `hostPath`,
  `.shared/`) stay in the resolvers and in `@ax/sandbox-mount-protocol`, which
  exists to hold them.
- **Subscriber risk:** `sandbox:mounts-changed` carries only `agentId`, and
  `shared-folders:deleted` only `folderId`.
- **Wire surface:** none. Nothing here is an IPC action.

## 8. Security note (run `security-checklist` on the PR)

- **Sandbox escape.**
  - Shared mounts go through the same `subPath` confinement and checks as
    `/files`.
  - The `.shared` subtree can't be named by any agent id (§3.2).
  - Mounting outside `/files` keeps mount targets out of agent-controlled
    directories (§3.3).
  - Folder ids are minted single segments and are checked again in every
    resolver and in the delete job.
- **Least privilege.**
  - A session mounts only host-chosen folders that its agent has a grant for.
  - Viewers get read-only mounts (in k8s).
  - There's no agent tool or IPC action to share, revoke or mount: agents can't
    share by themselves (work model §10).
- **Prompt injection.** Files in a shared folder may be written by another
  agent, which may itself be prompt-injected. In W2 all those agents have the
  same owner. Framing shared content as untrusted belongs to W3's prompt block.
- **Open item for W4, flagged now: symlinks across agents.**
  - An agent can plant a symlink in a shared folder, for example
    `report.md → /files/secret.txt`.
  - When another agent opens it, the link resolves in the reader's own sandbox,
    so it reads the reader's own private file. An injected reader could then be
    led to copy that file back into the shared folder.
  - That matters once agents with different owners share (W4).
  - Candidate fixes: NFS `nosymfollow` through PV mount options (needs a check
    under gVisor), or a symlink policy in the file tools.
  - This doesn't block W2, which is same owner only, but W4 can't ship without
    an answer.
- **Revocation latency:** up to the end of the current turn (§3.6).
- **Supply chain:** no new dependencies.

## 9. Size

Two PRs, in order:
1. `@ax/shared-folders` with its tables, hooks and lifecycle, the protocol
   fields, and the orchestrator subscription.
2. Resolvers, providers, the runner note, presets and acceptance tests.

Each PR passes the canary on its own: the first adds the plugin with unit tests
and loads it in both presets, and the second reaches it end to end.
