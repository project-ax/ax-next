# Security — `@ax/workspace-filestore`

This package answers one host-internal question: *"what durable per-agent mount
should this session get?"* It registers `sandbox:resolve-mounts` and, for a
session whose owner has a valid `agentId`, returns a single `nfs` `MountSpec`
pointing at a per-agent `subPath` inside a shared Google Cloud Filestore
(managed NFS) export. It does NOT itself talk to NFS, mount anything, or spawn a
process — the sandbox provider (`@ax/sandbox-k8s`) realizes the spec into a real
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

## Prompt injection / untrusted content

N/A — this resolver handles no model output, tool output, user-uploaded content,
or external-API responses. Its only input is the session `owner` (a host-minted
struct), and its only output is a typed `MountSpec` consumed by the provider, not
interpolated into a prompt, shell, path, SQL, or URL. The `agentId` it does read
is validated to `^[A-Za-z0-9_-]+$` (the base64url alphabet — single segment, no
`/`, no `.`) regardless.

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
(kernel) and `@ax/sandbox-mount-protocol` (the pure-types contract), both
workspace-internal. No `package.json` entry pulls a new external dep, and there
are no install-time scripts.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on
Hacker News. Please email `vinay@canopyworks.com`.
