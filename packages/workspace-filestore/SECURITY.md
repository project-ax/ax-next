# Security — `@ax/workspace-filestore`

This package answers one host-internal question: *"what durable mounts should
this session get?"* It registers `sandbox:resolve-mounts` and, for a session
whose owner has a valid `agentId`, returns an `nfs` `MountSpec` pointing at a
per-agent `subPath` inside a shared Google Cloud Filestore (managed NFS) export,
plus (W2 shared folders, below) one more per authorized shared folder. It also
registers `sandbox:locate-shared-folder`, a deletion-only lookup. It does NOT
itself talk to NFS, mount anything, or spawn a process — the sandbox provider (`@ax/sandbox-k8s`) realizes the spec into a real
pod volume. So the security walk here is short, but the capability it *hands the
provider* is real (a writable network filesystem inside the untrusted sandbox),
so we walk all three threat models.

## Sandbox escape / capability leakage

- **What we grant:** one `nfs` `MountSpec` — `{ server, exportPath, subPath:
  <agentId>, mountPath, readOnly:false, role:'user-files' }`. The provider mounts
  the export at `subPath=<agentId>`, so the runner sees **only its own agent's
  subtree** — other agents' subtrees are not even mounted. Cross-tenant isolation
  is the `subPath` confinement.
- **Path-segment safety (the load-bearing check):** `agentId` becomes the NFS
  `subPath` — a path segment on the server. A `..` or `/` in it would widen the
  mount past the agent's own subtree. We validate `agentId` against
  `^[A-Za-z0-9_-]+$` (`agent-id.ts`) before it ever reaches the spec; anything
  else yields `[]` (no mount), never a traversal. That charset is the base64url
  alphabet — exactly how real ids are minted (`agt_<base64url>` in `@ax/agents`).
  It deliberately contains **no `/`, no `.`, and no whitespace**, so a validated
  id is always a single confined segment: `..`, `/`, absolute paths, and the
  empty string are still rejected. (The earlier `^[a-z0-9-]+$` was tighter but
  *wrong* — it rejected every real agent and left the whole user-files mount
  inert; TASK-175.) This is defense in depth — the host upstream already
  constrains `agentId`, but this resolver re-checks at its own boundary
  (invariant I2: no trust-by-import).
- **No host config reaches the model.** `server` / `exportPath` come from
  preset/operator config, not from the session, the model, or tool output. They
  ride inside the `kind:'nfs'`-discriminated spec and are read only by the
  provider after it narrows on `kind` — they never cross into the sandbox as
  data the runner can read.
- **`readOnly:false`** is deliberate (the runner needs to write user files). A
  future host-read realization sets `readOnly:true` on the same spec shape; the
  field exists from day one.

## Shared folders (W2)

- **Folders live at `.shared/<folderId>`** in the same export, mounted at
  `/shared/<folderId>`. `.shared` is not a valid agent id (the leading `.` is
  outside the `^[A-Za-z0-9_-]+$` alphabet — `shared-folders.test.ts` pins it), so
  no agent's `/files` subtree can ever be the parent of the shared folders, and
  an agent whose id happens to be `shared` cannot mount all of them.
- **A request is not a grant.** `input.sharedFolderIds` is the host's request.
  We emit a mount only for ids that (a) pass `isValidSharedFolderId`
  (`sf_` + base64url — one segment, no `/`, `.` or NUL) and (b) come back from
  `shared-folders:authorize-mounts`. Ids the authorizer returns that were never
  requested are ignored. Only an explicit `readOnly: false` yields a writable
  mount; a missing or duplicated answer can only narrow access. `input.readOnly`
  forces every shared mount read-only, like the user-files mount.
- **Fails closed.** No `@ax/shared-folders` loaded means no shared mounts (and a
  warn log), never unchecked ones. If the authorizer THROWS, the error propagates
  and the session fails to open.
- **`sandbox:locate-shared-folder` has no grant check, on purpose.** It exists so
  the provider can delete a folder's bytes after its grants are gone. It is a
  host-internal location lookup, not an access path: it never mounts or reads
  anything, and it refuses (`invalid-folder-id`) any id that is not exactly one
  `sf_<base64url>` segment, so its answer is always `.shared/<one safe segment>`.

## Prompt injection / untrusted content

N/A — this resolver handles no model output, tool output, user-uploaded content,
or external-API responses. Its only inputs are the session `owner` and the
host-picked `sharedFolderIds` (host-minted values), and its only output is a
typed `MountSpec` consumed by the provider, not interpolated into a prompt,
shell, path, SQL, or URL. The `agentId` and every folder id it reads are validated
(`^[A-Za-z0-9_-]+$` / `sf_` + base64url — single segment, no `/`, no `.`)
regardless, and ids are bounded before they are logged.

## Network capability

The realized NFS mount is a **new outbound network capability** for the sandbox:
the runner pod must reach the Filestore server on NFS (TCP/UDP `:2049`) and
rpcbind (`:111`). This is a deliberate, documented widening of the otherwise
locked-down runner egress, scoped in the deploy chart's `sandbox-restrict`
NetworkPolicy to the **single Filestore IP on those two ports only** — not a CIDR,
not the internet. See `deploy/charts/ax-next/templates/networkpolicies/sandbox-restrict.yaml`.
A Filestore server-unreachable failure surfaces as a sandbox-open error, not a
silent hang (design §9).

## Supply chain

N/A — no third-party runtime dependencies. The package depends only on `@ax/core`
(kernel), `@ax/sandbox-mount-protocol` (the pure-types contract) and
`@ax/sandbox-protocol` (the shared-folder id check), all workspace-internal. No `package.json` entry pulls a new external dep, and there
are no install-time scripts.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on
Hacker News. Please email `vinay@canopyworks.com`.
