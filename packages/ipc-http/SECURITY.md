# Security — `@ax/ipc-http`

This is the first plugin in the codebase to open an inbound TCP listener. It registers no service hooks and binds one process-wide HTTP server (default `0.0.0.0:8080`) on the host pod; runner pods reach it via a Kubernetes `Service`. Every request walks the same five-gate pipeline as `@ax/ipc-server`'s unix listener — method, `/healthz`, content-type, bearer auth, body-size — and lands in `@ax/ipc-core`'s dispatcher. We share that dispatcher with the unix listener on purpose: one Zod-validated handler set, two transports. This note is the `security-checklist` walk for the Week 9.5 landing.

## Security review

- **Sandbox:** New plugin opens a TCP listener on configurable host:port (default `0.0.0.0:8080`). Reach is bounded by Helm NetworkPolicy `host-network.yaml` (only runner-namespace pods + own-namespace pods may ingress). Bearer auth via `session:resolve-token` is the wall behind the perimeter. Cross-session escalation is blocked by token uniqueness (32 bytes of `crypto.randomBytes`, base64url-encoded; resolution returns the bound `sessionId`).
- **Injection:** Request bodies are JSON, parsed under `MAX_FRAME` (4 MiB) cap. Each handler's Zod schema rejects shape drift before the body reaches plugin code. Errors never echo body content (`writeJsonError` emits a fixed safe envelope).
- **Supply chain:** No new external deps. Node built-in `node:http` is the transport. Workspace deps only: `@ax/core`, `@ax/ipc-core`, `@ax/ipc-protocol`. DevDeps match the workspace standard.

## Sandbox / capability

The capability footprint is one inbound TCP port and zero of everything else.

### What capability we grant

`server.listen(port, host)` on the host process. The default is `0.0.0.0:8080`, which means "any client that can route a TCP connection to that address can attempt requests." Inside a Kubernetes pod, "anyone who can route to it" is whoever the cluster's NetworkPolicy lets through.

### What bounds it

Two layers, in order:

1. **NetworkPolicy `host-network.yaml`** (Helm chart, `deploy/charts/ax-next/templates/networkpolicies/agent-runtime-network.yaml`). Ingress is allowed from runner-namespace pods labeled `ax.io/plane: execution` AND from anyone in the host's own namespace (port-forward, in-cluster ingress). Everything else is denied at the CNI layer. This is the perimeter.
2. **Bearer auth via `session:resolve-token`** (`@ax/ipc-core/src/auth.ts`). Every request must carry `Authorization: Bearer <token>`. The token is resolved through the session plugin's hook; an unresolved token returns 401 with a fixed `unknown token` message — the offending value is never echoed (I9). This is the wall behind the perimeter.

### Path traversal — none

Request paths route through a fixed in-code map in `@ax/ipc-core/src/dispatcher.ts`: `/llm.call`, `/tool.list`, `/tool.pre-call`, `/tool.execute-host`, `/workspace.commit-notify`, `/session.next-message`, plus three event endpoints. Anything else hits the unknown-path branch and returns 404 with `unknown path: <pathname>`. There is no filesystem lookup keyed off the URL.

### Process spawn — none

This plugin imports `node:http`, `@ax/core`, `@ax/ipc-core`. No `child_process`, no `execa`, no shell. The dispatcher and handlers don't spawn either; they call hooks on the bus, which run in-process.

### Env exfiltration — none

We don't read `process.env` anywhere in this plugin. `host` and `port` come from caller config, not from env. The boot-time `[ax/ipc-http] listening on http://...` line is intentional observability for the chart's manual acceptance test.

### Handle leak — none

The per-request `ChatContext` is built from `auth.sessionId` and `auth.workspaceRoot` — both come from `session:resolve-token`'s vetted output. We do not pass raw sockets, file descriptors, or any other capability handles across hooks. The dispatcher hands handlers a `ChatContext` and a `HookBus`; that is all the reach a handler gets.

### Cross-session escalation — implicit in token resolution

A subtle difference from the unix listener: `@ax/ipc-server` binds one socket per session and adds a listener-level cross-session check (the resolved sessionId must match the listener's owning session, else 403). The HTTP listener is **process-wide** — one socket serves every session. There is no listener-owning session to check against.

That's safe because the token resolution **is** the cross-session check. A token belongs to exactly one session; `session:resolve-token` returns the bound `sessionId` and that's the session this request operates as. There is no path by which a token for session A can be authenticated as session B. We documented this carefully in `listener.ts` so a future reviewer doesn't reflexively port the unix listener's 403 gate to a context where it has no second value to compare against.

## Prompt injection / untrusted content

The model can influence one thing this plugin sees: the bytes inside an HTTP request body sent by a runner pod. Nothing else from the model reaches us directly.

### Untrusted strings entering the slice

- **HTTP request bodies** from runner pods. Read by `readJsonBody` (`@ax/ipc-core/src/body.ts`) under the `MAX_FRAME` cap (4 MiB, defined once in `@ax/core/src/ipc/framing.ts`). The reader fails fast on `Content-Length > cap` (413 before any body bytes are buffered) and also enforces the cap mid-stream against clients that lie in `Content-Length` or use chunked encoding.
- **`Authorization` header** value. Compared case-insensitively to the literal prefix `bearer` followed by a space, and the rest is treated as opaque base64url. The token never appears in any log or error message.

### Bad destinations — gated by Zod

Each handler runs the action's Zod schema (`@ax/ipc-protocol/src/actions.ts`) before plugin code touches the payload. The schemas don't accept shell strings, filesystem paths, or anything we'd want to interpolate downstream — they accept the action's specific shape and reject everything else with 400 `VALIDATION`.

The handlers themselves are shared with `@ax/ipc-server`. The transport changed; the validation didn't.

### Errors never echo body content

`writeJsonError` (`@ax/ipc-core/src/response.ts`) emits a fixed envelope: `{ error: { code, message } }`, where `message` is whatever the handler chose. Auth errors emit short generic strings (`missing authorization`, `invalid authorization scheme`, `unknown token`) — never the offending token value. Per-handler errors include the action name and a sanitized cause; never a body excerpt. This is invariant I9.

### Worst case

A malicious runner pod sends:

- An oversized body → `TooLargeError` → 413, socket destroyed before memory fills.
- A body that `JSON.parse` rejects → `BadJsonError` → 400 with `invalid json: <parser error message>`. The parser's message is bounded — `JSON.parse` errors don't echo body content; they say things like `Unexpected token X in JSON at position N`.
- A well-formed JSON body with the wrong shape → Zod rejects → 400 `VALIDATION` with the action name and a sanitized error.
- A well-formed JSON body that passes Zod but encodes injection-flavored content (e.g. a tool name like `; rm -rf /`) → handler runs, but no handler interpolates inputs into a shell, an SQL string, or a filesystem path. The payload reaches `chat:end` / `tool:post-call` subscribers as untrusted bytes (per ax-conventions I5), and downstream subscribers are responsible for treating it as untrusted.

## Supply chain

No new external dependencies. The transport is `node:http`, a Node built-in.

### Runtime deps

- `@ax/core` — workspace, pinned via `workspace:*` (lockfile pins).
- `@ax/ipc-core` — workspace, `workspace:*`. Owns the dispatcher, handlers, body reader, auth middleware, response writers.
- `@ax/ipc-protocol` — workspace, `workspace:*`. Owns the Zod schemas and the wire-error envelope type.

### DevDeps (workspace standard)

`@ax/session-inmemory`, `@ax/test-harness`, `@types/node`, `typescript`, `vitest`. Same set every other workspace plugin uses.

### What we resisted

Express, Koa, Fastify, undici, body-parser, helmet, CORS middleware. Every one of them is a new attack surface (transitive deps, install hooks, parser edge cases) for capability we already have. The unix listener is framework-free for this reason; the HTTP listener mirrors that. A 165-line `node:http` server is auditable in one sitting; an Express app with five middleware libraries is not.

### Pinning

Workspace deps are `workspace:*` (lockfile pins the resolved versions). External deps: zero, so there's nothing to pin.

## Known limits

The honest list of what this slice doesn't do, and why.

### Plain HTTP within the cluster, no mTLS

We use plain HTTP between runner pods and the host. NetworkPolicy is the perimeter; bearer auth is the wall behind it. mTLS would be stronger, and we'll add it when a real adversary makes the math change.

This is a documented choice, not an oversight. NetworkPolicy + bearer auth is the same posture legacy v1 used in production, and on a properly-policied cluster it confines reach to the runner pods we just spawned. mTLS adds CA bootstrapping, cert rotation, and a chunk of operational surface; we'd rather get the transport landed and harden later than ship something we can't operate.

The threat we're explicit about: if NetworkPolicy is disabled or unsupported (some kind clusters' default CNI doesn't enforce policies), an attacker reachable on the cluster network could attempt requests against the listener. Bearer auth still blocks the call without a stolen token, and tokens don't leak from the host (they're held in the session store and minted per session). But "NetworkPolicy is the perimeter" is a real prerequisite — operators running this without policy enforcement should know it.

### In-flight requests not actively drained

The plugin's `Plugin.shutdown` slot calls `server.close()`, which stops accepting new connections and waits for in-flight requests to finish on their own. We do **not** call `server.closeAllConnections()` after a grace period, so a runner holding a long-poll past the per-plugin shutdown timeout (10 s) gets a TCP RST when the timeout fires.

For typical traffic this is fine — every endpoint except `/session.next-message` returns within ms. The long-poll cap is 30 s, which **matches** Kubernetes' default `terminationGracePeriodSeconds` (also 30 s). That's the binding constraint at the cluster level: a long-poll started right before SIGTERM lands won't finish within the kubelet's grace, and the pod gets a SIGKILL when the grace expires. Operators who want long-polls to drain cleanly during rolling deploys must explicitly raise `terminationGracePeriodSeconds`.

The 10 s per-plugin shutdown timeout is the tighter cap inside the pod — it fires first, sending a TCP RST to any long-poll still mid-flight, before the kubelet's 30 s grace expires. We picked "abrupt past the per-plugin timeout" so a misbehaving long-poll can't hold the process hostage. If a future host endpoint legitimately needs a longer grace, `server.closeAllConnections()` after a deadline is the next move — but the kubelet's `terminationGracePeriodSeconds` would also have to grow to match.

### No `crypto.timingSafeEqual` on token compare

A reviewer might glance at the auth path and notice we don't run `timingSafeEqual` over the bearer token. That's deliberate, not forgotten.

Token resolution is `Map.get(token)` in `@ax/session-inmemory` and `SELECT … WHERE token = $1` in `@ax/session-postgres`. Both are functionally constant-time given uniformly-distributed 256-bit base64url tokens — a timing attacker can't enumerate tokens by probing because the entropy is too high to bisect within any realistic number of requests. There's no second secret to compare against at the listener level — the token resolution **is** the comparison. Adding `timingSafeEqual` on top would compare the token to itself, which doesn't help anyone.

We'd rather document the reasoning here than have the next reviewer add a comparison that isn't doing what its name suggests.

### No rate limits, no IP allow-list

The auth boundary is the allow-list. A token is only mintable via `session:create`, which is an in-process call from the orchestrator. No outside party can mint tokens. Rate limiting against valid tokens is a noisy-neighbor knob (one runner could pummel the host with valid requests), but it's not an authn/authz issue, and it'd need cluster-aware metrics we don't have yet.

### Long-poll cap lives in the dispatcher, not here

`/session.next-message` long-polls. The 30 s cap (I12) is enforced inside the handler in `@ax/ipc-core`; this listener bumps Node's idle timeout to 60 s so the long-poll isn't killed mid-flight. If a future Node default changes either side, the test in `@ax/ipc-server` (and the analogous one we'll add for HTTP) catches it.

## Boundary review

- **Alternate impl this hook could have:** none — this plugin doesn't register a service hook. It binds a listener at init() and routes inbound requests to existing hooks (`session:resolve-token`, `llm:call`, `tool:list`, `session:claim-work`, plus the dispatcher-resolved `tool:execute:<name>`). The transport is the contribution; the hook surface is unchanged.
- **Payload field names that might leak:** none. The wire payloads are owned by `@ax/ipc-protocol`, which both transports (unix and HTTP) share. No `socket_path`, `port`, `bearer`, `Authorization`, or other transport vocabulary appears on hook payloads — those stay at the listener boundary.
- **Subscriber risk:** none new. Subscribers fire on the same hooks the unix listener already drives; `chat:end` / `tool:post-call` / `turn:end` payloads are identical regardless of transport.
- **Wire surface (IPC):** this plugin IS a wire surface. The schemas live in `@ax/ipc-protocol` (one schema set, two transports), not in this package, so there's no per-listener schema drift.

## What we don't know yet

- Whether 4 MiB is the right `MAX_FRAME` cap when image-bytes flow through tool calls. We picked it to match the unix listener; a future image-input feature may need a higher cap on a specific endpoint or a streaming alternative. Today, image-bytes-over-IPC isn't a code path.
- Whether the per-plugin 10 s shutdown timeout is the right cap for the long-poll case. The kernel-shutdown lifecycle landed; the listener now closes via `Plugin.shutdown` on SIGTERM. A runner holding a long-poll past 10 s gets a TCP RST instead of a clean 503. Operators with long-running long-polls (none today; cap is 30 s) may want either a longer per-plugin timeout or an explicit `server.closeAllConnections()` after a grace period.
- Whether the boot-time `process.stderr.write` for the bound address is the right shape once the chart's structured logging lands. It's currently one printf-style line for grep-ability in `kubectl logs`; a future structured-log pass may want to reformat.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
