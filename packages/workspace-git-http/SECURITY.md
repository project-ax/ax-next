# Security — `@ax/workspace-git-http`

This package puts `@ax/workspace-git-core` behind an HTTP transport so multiple host replicas can share one workspace store. Two surfaces ship together: a **pod-side server** (a Node `http` listener bound to `0.0.0.0:7780` by default, run as the `ax-git-server` binary in the chart's git-server Deployment) and a **host-side plugin** (the `workspace:*` service hook implementations the host pod registers, which forward each call to the server over HTTP).

It looks structurally similar to `@ax/ipc-http` — same five-gate listener, same wire-error envelope shape, same `MAX_FRAME` body cap, same defensive `crypto.timingSafeEqual` on the bearer compare. But the auth model is meaningfully different: where `@ax/ipc-http` resolves a per-session token through `session:resolve-token`, this package uses one **static service token** shared between every host pod and the git-server pod. There's no session boundary at the workspace layer (a workspace is owned by the cluster, not a session), so the static token is the gate. We unpack what that means below.

This note is the `security-checklist` walk for this slice. Sandbox / capability is the section with the most to say; injection and supply chain are short because we share the validation chokepoint and dependency set with `@ax/workspace-git-core` and `@ax/ipc-core`.

## Security review

- **Sandbox:** Two new surfaces. The pod-side server opens an inbound TCP listener (default `0.0.0.0:7780`); reach is bounded by the chart's NetworkPolicy (Task 17 — host pods only, runner pods MUST NOT reach), the bearer-token wall behind that perimeter (`crypto.timingSafeEqual` against an env-loaded service token), and the pod's own SecurityContext (non-root UID 1000, all caps dropped, `readOnlyRootFilesystem: true` per Task 15). The host-side plugin opens **outbound** HTTP only to one configured `baseUrl` and reads no filesystem, spawns no processes, and reads no env. Neither side imports `child_process`.
- **Injection:** Every request body is Zod-validated (`@ax/workspace-protocol`) before any handler touches it. The path-validation chokepoint lives in `@ax/workspace-git-core/src/impl.ts` and runs server-side as the canonical gate. Errors never echo body content; auth errors emit short fixed strings (`missing authorization`, `invalid authorization scheme`, `unknown token`) and the token never appears in any log or error message.
- **Supply chain:** No new external runtime dependencies. The transport is `node:http`. The runtime deps are all workspace packages (`@ax/core`, `@ax/ipc-core`, `@ax/workspace-protocol`, `@ax/workspace-git-core`) plus `zod` (already in the workspace). DevDeps match the workspace standard.

## Sandbox / capability

This is the first plugin we ship that opens an HTTP connection between two non-runner pods (host pod talks to git-server pod). It also widens what "workspace pod compromise" means, so it gets its own walk.

### Pod-side server: inbound TCP listener

The capability footprint is one inbound TCP port and zero of everything else.

#### What capability we grant

`server.listen(port, host)` on the git-server process. The default is `0.0.0.0:7780`, configurable via `AX_GIT_SERVER_HOST` / `AX_GIT_SERVER_PORT`. Anyone who can route a TCP connection to that address can attempt requests; inside a Kubernetes pod, "anyone who can route" is whoever the cluster's NetworkPolicy lets through.

#### What bounds it

Three layers, in order:

1. **NetworkPolicy** (Task 17 — `deploy/charts/ax-next/templates/networkpolicies/git-server-network.yaml` once it lands). Ingress is allowed only from host-pod labels in the same namespace; runner pods MUST NOT be permitted, ever — runners don't speak workspace protocol and there's no legitimate reason for one to reach the git-server. This is the perimeter.
2. **Bearer auth via `crypto.timingSafeEqual`** against an env-loaded token (`AX_GIT_SERVER_TOKEN`, sourced from the Helm Secret `<release>-git-server-auth`). Missing, malformed, or wrong token returns 401 with a fixed message — the offending value is never echoed (invariant I9, carried over from `@ax/ipc-http`). This is the wall behind the perimeter.
3. **Pod SecurityContext** (Task 15's chart). Non-root UID 1000, all caps dropped, `readOnlyRootFilesystem: true`, the PVC is the only writable mount and it's the bare-repo's own gitdir. So even if an attacker pops the process, they're a non-root user with no shell, no writable rootfs, and one PVC-bound mount under their feet.

#### Blast radius if this pod is compromised

Worth calling out explicitly: if the git-server pod is compromised, the attacker can read **every workspace's content**. Every session, every user, all the bytes ever committed. That's a meaningful escalation from `@ax/workspace-git`'s blast radius (one host pod's PVC, one repo). We trade a smaller-blast-radius single-pod design for a larger-blast-radius shared-store design because multi-replica scaling needs the canonical store somewhere — and "somewhere" with a bare repo behind it is here.

The mitigation is depth: NetworkPolicy keeps the listener unreachable from non-host pods, the bearer token keeps it unreachable without credentials, the SecurityContext keeps a compromised process from doing much locally, and the chart's PVC is sized and labeled like the production-grade-storage thing it is. The paranoia adds up.

#### Cross-session escalation: not applicable here

A subtle but important difference from `@ax/ipc-http`. The IPC HTTP listener uses `session:resolve-token` because a token belongs to exactly one session and the resolved `sessionId` becomes the session this request operates as.

There's no session boundary at the workspace layer. A workspace is owned by the cluster, not by a session — multiple sessions share a workspace store, and the host process decides which session is asking. Static service token gates everything. **If the token leaks, every workspace leaks.** That's a trade we're making explicitly: one secret to rotate, one wall to defend, no per-session token plumbing across the workspace API.

(If you skim the auth code looking for the cross-session check that lives in the unix listener — there isn't one. The token resolution would normally be it, but there's no second value to compare against here.)

#### Process spawn — none

The server process imports `node:http`, `node:crypto` (for `timingSafeEqual`), `@ax/core`, `@ax/ipc-core` (for `readJsonBody` / response writers), `@ax/workspace-protocol`, and `@ax/workspace-git-core`. No `child_process`, no `execa`, no shell. `isomorphic-git` (transitively, via `@ax/workspace-git-core`) is pure JavaScript by design.

#### Path validation chokepoint

Lives in `@ax/workspace-git-core/src/impl.ts` (function `validatePath`, lines 84-136). Runs server-side because the host plugin doesn't import core — only the wire shape crosses the boundary, and the wire shape never carries unvalidated bytes (Zod schemas in `@ax/workspace-protocol` reject shape drift before the dispatcher hands the request to handlers).

This is defense-in-depth: the server re-validates as the canonical gate even though Zod has already accepted the shape. If a future client (third-party plugin, bug, what have you) sends a path like `../../../etc/passwd`, Zod accepts it as a string, and `validatePath` rejects it because `..` is on the explicit deny list.

### Host-side plugin: outbound HTTP, that's it

The host-side plugin's capability footprint:

- **Outbound HTTP** to one configured `baseUrl` (validated to be `http:`, no `userinfo`, no other schemes — same posture as `parseRunnerEndpoint` in `@ax/ipc-protocol`). The hostname goes to Node's resolver and the port is bound to `[1, 65535]`. There is no DNS-rebinding mitigation; we trust the cluster's internal DNS.
- **Filesystem reach:** none. The plugin doesn't `require('fs')` and doesn't pass paths to anything that does.
- **Env reads:** none. `baseUrl` and `token` are passed as plugin-config arguments by the caller (the preset builder reads them from env and constructs the plugin — that env access lives in the preset, not in this plugin).
- **Process spawn:** none.

The host-side plugin's blast radius is "one outbound TCP socket can be opened to one URL." That's about as small as a network-capable plugin gets.

### Handle leak — none

The host-side plugin builds a `WorkspaceGitHttpClient` inside `init()` and closes over it in the four hook handlers. Sockets are opened per-request inside `requestOnce` (`client.ts:143`) and torn down at the end of each request via the AbortController + the timer. No socket, file descriptor, or capability handle crosses any hook boundary — handlers receive a `ChatContext` and a payload, and that's all.

## Prompt injection / untrusted content

The model can influence one thing this transport sees: the bytes inside an HTTP request body sent by a host pod, which originate from `workspace:apply` calls driven by tool output. Nothing else from the model reaches us directly.

### Untrusted strings entering the slice

- **Wire request bodies** from host pods. The pod-side listener uses `readJsonBody` (`@ax/ipc-core/src/body.ts`) under the `MAX_FRAME` cap (4 MiB, defined once in `@ax/core/src/ipc/framing.ts`). Fail-fast on `Content-Length > cap` (413 before any body bytes are buffered), mid-stream enforcement against clients that lie or use chunked encoding.
- **Wire response bodies** on the host side. Capped the same way (`client.ts:182-191`) so a malicious or compromised server can't OOM the host by sending a multi-gigabyte response.
- **`Authorization` header** value, on both sides. Compared via `crypto.timingSafeEqual` after a length check; the token never appears in any log or error message.
- **Path strings inside `WorkspaceApplyRequest`**. Zod-validated for type, then `validatePath` rejects `..`, absolute, NUL, backslash, empty segments, and `.git` segments before any blob is written. Same chokepoint as the in-process backend.
- **Content bytes** inside `WorkspaceApplyRequest.changes[].contentBase64`. Decoded via `base64ToBytes` and written to `git.writeBlob` as opaque `Uint8Array`. Never decoded as text, never interpreted as JSON or a shell command, never logged, never interpolated.

### Bad destinations — gated by Zod and `validatePath`

Every handler runs the action's Zod schema (`@ax/workspace-protocol`) before plugin code touches the payload. The schemas accept the action's specific shape and reject everything else with 400 `VALIDATION`. After Zod, `validatePath` runs server-side as the canonical gate.

The wire schema doesn't accept shell strings, command-line flags, or anything we'd want to interpolate downstream. The handlers themselves don't shell out or build SQL — they call `bus.call('workspace:apply', ...)` which lands in pure-JS git plumbing.

### Errors never echo body content

The custom `writeWireError` (`listener.ts:111-131`) emits a fixed envelope: `{ error: { code, message, expectedParent?, actualParent? } }`. The `message` field is whatever the handler chose; it's bounded to the action name + a sanitized cause + (for parent-mismatch) the structured rebase coordinates from the core's error message. We never include a body excerpt or the offending input bytes.

Auth errors emit short generic strings (`missing authorization`, `invalid authorization scheme`, `unknown token`) — never the offending token value. This is invariant I9, carried over verbatim from `@ax/ipc-http`.

### Worst case

A malicious host pod (one that's already authenticated — i.e., already holds the static service token) sends:

- An oversized body → `TooLargeError` → 413, socket destroyed before memory fills.
- A body that `JSON.parse` rejects → `BadJsonError` → 400 with `invalid json: <parser error message>`. The parser's message is bounded.
- A well-formed JSON body with the wrong shape → Zod rejects → 400 `VALIDATION` with the path-of-error and the issue message (no body excerpt).
- A well-formed JSON body that passes Zod but encodes injection-flavored content (e.g., a path of `../../etc/passwd` or a `reason` of `$(rm -rf /)`) → `validatePath` rejects the path with 400 `invalid-path`; the `reason` flows into the git commit message verbatim (no shell, no template, no `eval`) and ends up in `WorkspaceDelta.reason` for any subscriber to handle as untrusted bytes per ax-conventions I5.
- A well-formed apply that races another replica's apply → 409 `parent-mismatch` with structured rebase coordinates; this is expected behavior, not an exploit.

## Supply chain

No new external runtime dependencies. The transport is `node:http`, a Node built-in.

### Runtime deps

- `@ax/core` — workspace, `workspace:*`. `MAX_FRAME`, `PluginError`, hook bus types.
- `@ax/ipc-core` — workspace, `workspace:*`. `readJsonBody`, `writeJsonOk`, `TooLargeError`, `BadJsonError`. Reused on the server side; the host-side plugin doesn't import this.
- `@ax/workspace-protocol` — workspace, `workspace:*`. The Zod schemas, the path constants, the timeout map. One schema set, one source of truth.
- `@ax/workspace-git-core` — workspace, `workspace:*`. The actual implementation behind the four `workspace:*` hooks. Server-side only — the host-side plugin doesn't import this (invariant I2: no cross-plugin imports across the transport).
- `zod` — already in the workspace at `^3.23.8`. No new entry.

### DevDeps (workspace standard)

`@ax/test-harness`, `@types/node`, `typescript`, `vitest`. Same set every other workspace plugin uses.

### What we resisted

Express, Koa, Fastify, undici, body-parser, helmet, axios, got. Every one of them is a new attack surface (transitive deps, install hooks, parser edge cases) for capability we already have. `@ax/ipc-http` is framework-free for this reason; this listener mirrors that. Both the listener and the client are short enough to audit in one sitting.

### Pinning

Workspace deps are `workspace:*` (lockfile pins the resolved versions). External deps: zero new, so there's nothing new to pin.

## Known limits

The honest list of what this slice doesn't do, and why.

### Token rotation is operationally painful

The token lives in a Helm-managed Secret (`<release>-git-server-auth`, key `token`). Generated at install time via the lookup-or-generate pattern (Task 15 will implement). Operators rotate by writing a new value into the Secret and rolling-restarting **both** Deployments:

1. The git-server Deployment so the server's expected-token env updates.
2. Every host Deployment so each host plugin reads the new token at boot.

During rotation there's a window where some pods have the old token and some have the new one. Token mismatch → 401 → host plugin's retry budget exhausts → workspace operations fail loudly until rollouts converge. This is real operational pain, and we'd rather flag it than hide it.

A future improvement is **dual-token acceptance**: the server accepts `tokenOld OR tokenNew` for the rotation window, the operator rolls hosts to `tokenNew` while the server still honors both, then the operator drops `tokenOld` from the server config. That's not in this slice — listed here so the next person who has to rotate a token doesn't think they're missing something.

### No disaster recovery

The git-server PVC is now the **single source of workspace truth**. If the PVC dies, every workspace is lost. This slice ships zero DR primitives — no backup, no replication, no `git bundle` cron, no snapshot lifecycle.

Operators are responsible for storage-class-level backup. Concrete options:

- Volume snapshots via the cluster's CSI driver (e.g., AWS EBS snapshots, Longhorn snapshots).
- Cross-zone or cross-region replication if the storage class supports it (e.g., Longhorn with replica count > 1 across nodes).
- A `git bundle` cron that ships the bare repo to off-cluster object storage on a schedule.

Pick at least one. We're being upfront about this because "the database is on one PVC and there's no backup" is the kind of detail that's easy to miss until the day it matters and impossible to retrofit afterward.

### Plain HTTP within the cluster, no mTLS

We use plain HTTP between the host pods and the git-server pod. NetworkPolicy is the perimeter; bearer auth is the wall behind it. Same posture as `@ax/ipc-http`, same trade-off, same future work.

The threat we're explicit about: if NetworkPolicy is disabled or unsupported (some kind clusters' default CNI doesn't enforce policies), an attacker reachable on the cluster network could attempt requests against the listener. Bearer auth still blocks the call without a stolen token. But "NetworkPolicy is the perimeter" is a real prerequisite — operators running this without policy enforcement should know it.

### One git-server replica only

The chart pins the git-server Deployment to `replicas: 1`. The per-repo mutex inside `@ax/workspace-git-core` is in-process; if two server replicas wrote to the same gitdir, the mutex would no longer serialize them and we'd get races on `refs/heads/main`. The chart enforces single-writer by construction. If a future deployment shape ever runs more than one replica against the same PVC, we need an external lock (advisory lock in a sidecar, or move the storage to something that gives us real CAS).

### No GC for failed applies

Inherited from `@ax/workspace-git-core`. Failed applies leave dangling blobs and trees in `objects/`. Disk grows monotonically with churn; for the MVP this is fine, but a long-lived deployment will eventually want a sweeper.

## Boundary review

- **Alternate impl this hook could have:** `@ax/workspace-postgres-http` would be the same wire surface backed by Postgres-stored snapshots instead of git. The four `workspace:*` hooks don't change shape; the implementation behind them does. The wire schema in `@ax/workspace-protocol` is deliberately git-vocabulary-free — `before` / `after` / `parent` are opaque version strings, not SHAs.
- **Payload field names that might leak:** none. The wire schema uses `before`, `after`, `parent`, `version`, `path`, `kind`, `contentBase64`, `contentBeforeBase64`, `contentAfterBase64`, `reason`, `author`. No `commit`, `sha`, `oid`, `tree`, `ref`, or `gitdir`. The `actualParent` / `expectedParent` fields on the parent-mismatch error envelope use the abstract "parent" vocabulary, not "commit" or "sha".
- **Subscriber risk:** subscribers must continue to treat `WorkspaceVersion` as opaque (per the workspace-git-core SECURITY note). The HTTP transport doesn't change that contract.
- **Wire surface (IPC):** this plugin IS a wire surface. The schemas live in `@ax/workspace-protocol`, not in this package, so there's no per-listener schema drift between the two transports we already share.

## What we don't know yet

- Whether dual-token acceptance is worth the complexity. The cleaner answer is "rotate during a maintenance window, accept the brief outage." The bigger the deployment gets, the less acceptable that becomes.
- Whether the git-server pod's SIGTERM grace period is long enough for in-flight `workspace:apply` draining. The host plugin (this package's `createWorkspaceGitHttpPlugin`) is just an HTTP client and has nothing long-lived to clean up — verified during the kernel-shutdown slice. The git-server pod runs as its own process with its own SIGTERM handler in `src/server/main.ts` that calls `server.close()` and waits for in-flight requests. If a future apply takes longer than the kubelet grace period (default 30 s), we may need `server.closeAllConnections()` after a deadline.
- Whether the per-repo mutex inside `@ax/workspace-git-core` will hold up under the load the multi-replica deployment will throw at it. Today's test exercises 4 concurrent applies; production may see hundreds.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
