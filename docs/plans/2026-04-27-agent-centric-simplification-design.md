# Agent-centric simplification — architecture-doc-2

**Date:** 2026-04-27
**Status:** Design — pre-implementation
**Supersedes (in part):** Section 4 of `2026-04-22-plugin-architecture-design.md` (chat:run loop, host-side llm:call, tool-dispatcher fan-out)

## TL;DR

The host shrinks from "turn-loop kernel + N LLM/tool plugins" to "credential broker + sandbox + observation bus." Two agent runners (claude-agent-sdk today, pi-coding-agent later) run their own loops in-sandbox; they reach LLM providers through a host-side MITM credential proxy that swaps placeholder stubs for real secrets at the network boundary. Real credentials never enter the sandbox.

Net result: ~14 active host plugins → ~13. **10 plugins delete outright**, 5 shrink, 4 are new. The delete list includes most of the v1 mental model — `@ax/llm-anthropic`, `@ax/agent-runner-core`, `@ax/agent-native-runner`, `@ax/tool-dispatcher`, `@ax/tool-bash`, `@ax/tool-file-io` — because their concerns are owned by the agent runtime now, not the host.

## Why we're doing this

The current architecture inherits a v1 mental model: *the host runs the conversation loop, calls llm:call, dispatches tool calls, collates results.* That made sense when the agent was code we wrote. With agent runtimes (claude-agent-sdk, future pi-coding-agent) that own their own loops, the host's loop is vestigial — `chat:run` reduces to "open a session, hand the agent a message, await completion." Keeping the loop on the host means duplicated abstractions, a lossy `LlmCallRequest` neutral schema, and a translation hop the SDK runner doesn't need.

The credential gateway is the thing the host genuinely owns. Real API keys and OAuth tokens never belong in the sandbox (Invariant I5); something host-side has to substitute them at the egress boundary. v1 already solved this with a generic MITM proxy. Porting that pattern collapses every per-provider concern into a single boundary feature.

## The five invariants under this design

1. **Hook surface stays transport- and storage-agnostic.** ✅ Improved. Host hooks lose `llm:call` (provider-leaking schema) and gain `event.http-egress` (provider-neutral observation) and `credentials:get` (opaque ref-based lookup). Per-kind dispatch keeps provider names out of the bus surface.
2. **No cross-plugin imports.** ✅ Unchanged. The credential proxy calls `credentials:get` via the bus; the credentials facade dispatches via the bus; runners reach the host via IPC. Same enforcement as today.
3. **No half-wired plugins.** ✅ Improved. Several plugins go from "wired but barely earning weight" (`@ax/agent-runner-core`, `@ax/llm-mock`, `@ax/tool-dispatcher`) to deleted.
4. **One source of truth per concept.** ✅ Improved. Credentials live in `@ax/credentials-store-db`; OAuth refresh in `@ax/credentials-anthropic-oauth`; egress security in `@ax/credential-proxy`. No more "which plugin owns Anthropic specifics?" — the answer is in the per-kind sub-service.
5. **Capabilities explicit and minimized.** ✅ Strongly improved. Real credentials live in exactly one process (the host), exposed only to the proxy at substitution time. Sandbox runtimes never see plaintext secrets.

## Architecture overview

```
sandbox-side                              │ host-side
──────────────────────────────────────────┼─────────────────────────────────────────
claude-agent-sdk runner                   │ @ax/core (kernel)
  ANTHROPIC_API_KEY=ax-cred:<hex>         │   HookBus, bootstrap
  HTTPS_PROXY=http://ax-proxy:8443        │   AgentContext, AgentOutcome
  NODE_EXTRA_CA_CERTS=/tmp/ax-mitm-ca.pem │
                                          │ @ax/ipc-server, @ax/ipc-core, @ax/ipc-http
pi-coding-agent runner (future)           │ @ax/sandbox-{subprocess,k8s}
  HTTPS_PROXY=http://ax-proxy:8443        │ @ax/session-{inmemory,postgres}
  per-provider modules use stub creds     │ @ax/agents (Week 9.5)
                                          │ @ax/credentials                ─┐
@ax/credential-proxy-bridge               │ @ax/credentials-store-db        │ split
  TCP↔Unix-socket relay (k8s only)        │ @ax/credentials-anthropic-oauth ─┘
                                          │ @ax/credential-proxy (MITM + substitution + audit)
                                          │ @ax/chat-orchestrator (thin RPC: agent:invoke)
                                          │ @ax/audit-log (subscribes to event.http-egress)
                                          │ @ax/mcp-client (host-mediated tools)
                                          │ @ax/http-server (web-chat + OAuth callback)
                                          │ @ax/channel-web, @ax/conversations
```

The host-side LLM concept entirely disappears from the bus surface. There is no `@ax/llm-anthropic`. There is no `llm:call`. Provider knowledge lives where it belongs — inside the agent runtime that uses it.

### Sandbox env layout (corrected)

The agent uses real Anthropic URLs; `HTTPS_PROXY` does the redirection. The agent code is unaware of the proxy.

```bash
# Auth — stub the credential, real value substituted by proxy mid-flight
ANTHROPIC_API_KEY=ax-cred:abc123…           # API-key sessions
CLAUDE_CODE_OAUTH_TOKEN=ax-cred:def456…     # OAuth sessions

# URLs — real backends, NOT loopback
# (ANTHROPIC_BASE_URL unset; SDK defaults to https://api.anthropic.com)

# Routing — SDK's HTTP client honors these
HTTPS_PROXY=http://ax-proxy:8443
HTTP_PROXY=http://ax-proxy:8443

# Trust — sandbox processes accept the MITM CA's minted certs
NODE_EXTRA_CA_CERTS=/tmp/ax-mitm-ca.pem      # Node only (additive)
SSL_CERT_FILE=/tmp/ax-ca-bundle.pem          # curl/openssl/python (replaces)
REQUESTS_CA_BUNDLE=/tmp/ax-ca-bundle.pem
CURL_CA_BUNDLE=/tmp/ax-ca-bundle.pem
```

Direct port of v1's setup at `~/dev/ai/ax/src/agent/runner.ts:485-542`.

## Section 1 — `@ax/credential-proxy` plugin

One host-side listener per process (Unix socket on the host filesystem, mountable into k8s sandbox pods); one CA per host, generated on first run and persisted under `~/.ax/proxy-ca/{ca.key,ca.crt}`. Sessions are entries in a `SharedCredentialRegistry`.

### Hook surface

```ts
@ax/credential-proxy registers:
  proxy:open-session(ctx, input) → output
    input  = {
      sessionId, userId, agentId,
      allowlist: string[],                  // hostnames the session may reach
      credentials: {                         // env-var → credential ref + kind
        [envName]: { ref, kind }
      },
      bypassMITM?: string[],                 // cert-pinning hosts (raw tunnel)
      canaryToken?: string
    }
    output = {
      proxyEndpoint: 'unix:///var/ax/proxy.sock' | 'tcp://127.0.0.1:<port>',
      caCertPem: string,
      envMap: { [envName]: 'ax-cred:<hex>' } // injected into runner env
    }

  proxy:rotate-session(ctx, { sessionId }) → { envMap }   // per-turn rotation
  proxy:close-session(ctx, { sessionId }) → {}

@ax/credential-proxy calls:
  credentials:get(ref, { userId }) → currentValue       // per ref at open + rotate

@ax/credential-proxy fires:
  event.http-egress (subscriber, every request)
```

### Per-session lifecycle

`proxy:open-session` resolves every credential ref via `credentials:get` (which dispatches internally to the per-kind `:resolve:<kind>` sub-service for refresh), mints fresh `ax-cred:<hex>` placeholders, registers the (placeholder → real-value) pairs in the shared registry. Returns the env map for chat-orchestrator to inject into the runner's env at sandbox launch, plus the CA cert PEM for the runner to write to `/tmp/ax-mitm-ca.pem`.

`proxy:rotate-session` is called once per turn boundary by chat-orchestrator (when long-running rotations are needed). Re-resolves credentials, mints fresh placeholders, swaps the registry entry. Stale placeholders silently fail to match — post-rotation requests with old stubs die with 401 from upstream, which is the right outcome (forces the runner to use the new env).

### Per-request flow

1. Validate Host header against the session's `allowlist`. Reject with 403 if absent. Per-session DNS resolve cache + private-IP block (SSRF defense — explicitly blocks 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, and 169.254.0.0/16 cloud metadata range).
2. For HTTPS CONNECT: mint or fetch-from-cache a domain cert signed by the host CA, terminate TLS with that cert. Decrypt the inner HTTP. (`bypassMITM` hostnames get a raw TCP tunnel — used for cert-pinning CLIs.)
3. Scan request headers + body buffer for any session's `ax-cred:<hex>` placeholder via `SharedCredentialRegistry.replaceAllBuffer`, substitute in place.
4. Optional canary scan (configurable per session — fires `event.http-egress` with `blockedReason: 'canary'` and aborts if matched).
5. Forward to upstream over fresh HTTPS. Stream response back unmodified (real credentials don't come back from upstream). No substitution on the response path.

Auth-header construction stays SDK-side. API-key sessions: SDK reads `ANTHROPIC_API_KEY` and sends `x-api-key: ax-cred:…`. OAuth sessions: SDK reads `CLAUDE_CODE_OAUTH_TOKEN` and sends `Authorization: Bearer ax-cred:…` plus the SDK's automatic `anthropic-beta` header. The proxy never rewrites header structure — only substitutes the stub for the real token.

### Cert lifecycle — three decoupled timescales

- **CA cert** — generated once on first proxy start, persisted to `~/.ax/proxy-ca/{ca.key,ca.crt}` (key mode 0600). Reused across host restarts. ~10-year validity. Sandboxes trust it via `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`.
- **Domain cert** — minted on first CONNECT to a hostname, cached in memory for the proxy process lifetime. ~1-year validity. Subsequent CONNECTs to the same host reuse the cached cert. First-mint cost ~50ms (one-time per hostname per process).
- **Placeholders** — rotated per turn via `proxy:rotate-session`. Cert-independent.

Per turn: no cert work. Per CONNECT: O(1) cache hit after the first mint.

### Observation event

```ts
event.http-egress {
  sessionId, userId, method, host, path, status,
  requestBytes, responseBytes, durationMs,
  credentialInjected: boolean,
  classification: 'llm' | 'mcp' | 'other',     // by credential kind, not hostname
  blockedReason?: 'allowlist' | 'private-ip' | 'canary' | 'tls-error',
  timestamp
}
```

Audit-log subscribes. Future redaction / token-usage / rate-limit subscribers attach identically. Classification is by credential kind: a request that substituted a credential of `kind: 'anthropic-oauth'` is classified `'llm'`; a `kind: 'mcp-github-pat'` is classified `'mcp'`; no-substitution requests are classified `'other'`. Adding a hostname classifier later is non-breaking if needed.

### Multi-tenant aggregation

`SharedCredentialRegistry` (ported from v1's `credential-placeholders.ts`) maps (sessionId → CredentialPlaceholderMap). The proxy consults all registered maps on every request — substitution succeeds for the matching session's placeholder regardless of which session sent the request. Cross-session collisions are statistically impossible because placeholders are 16 bytes of `randomBytes`. This is the load-bearing primitive that makes one proxy listener per host-process work for k8s deployments serving N concurrent sandbox sessions.

## Section 2 — `@ax/credential-proxy-bridge`

Sandbox-side TCP-to-Unix-socket relay for k8s pods that can't reach host TCP. Subprocess sandbox doesn't need it — TCP loopback to the host listener works directly.

The bridge is **not a host hook plugin**. It runs inside the sandbox process, started by the runner during sandbox bootstrap. The "plugin" framing is organizational (own package.json, own tests, ships from this repo) — there's no kernel registration because there's no host hook bus inside the sandbox.

### Public API

```ts
export interface WebProxyBridge { port: number; stop(): void }
export function startWebProxyBridge(unixSocketPath: string): Promise<WebProxyBridge>
```

### Two transport flavors handled (both ported from v1)

```
HTTP forwarding (regular HTTP request):
  agent → 127.0.0.1:<bridge-port>  GET http://example.com/foo
  bridge reads full request, forwards via undici with { socketPath }
  → host proxy on Unix socket

HTTPS CONNECT tunneling:
  agent → 127.0.0.1:<bridge-port>  CONNECT api.anthropic.com:443
  bridge opens raw socket to Unix socket, writes CONNECT through
  reads "HTTP/1.1 200 Connection Established"
  bidirectional pipe: client socket ↔ Unix socket
  (TLS handshake + MITM happen host-side, in the proxy)
```

### Lifecycle (called from runner startup)

```ts
if (process.env.AX_PROXY_UNIX_SOCKET) {
  const bridge = await startWebProxyBridge(process.env.AX_PROXY_UNIX_SOCKET);
  process.env.HTTP_PROXY  = `http://127.0.0.1:${bridge.port}`;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${bridge.port}`;
}
// Subprocess sandbox: AX_PROXY_UNIX_SOCKET unset, HTTP_PROXY already
// pointing at the host's TCP listener (set by chat-orchestrator at spawn).
```

Subprocess vs. k8s switching is transparent via env: presence of `AX_PROXY_UNIX_SOCKET` selects bridge mode, absence selects direct loopback.

### Why the bridge stays (despite NetworkPolicy alternatives)

K8s NetworkPolicy could theoretically replace the bridge — sandbox pods get a NetworkPolicy allowing egress only to the proxy Service + DNS. Reasons to keep the bridge instead:

- **NetworkPolicy enforcement is CNI-dependent.** kind, k3s default, Docker Desktop k8s, and some EKS configurations silently ignore NetworkPolicy. The failure mode is "everything looks fine until isolation breaks." Unix-socket-mounted-into-sandbox is kernel-level enforcement — bypass-proof regardless of CNI.
- **Bridge is portable.** Same wiring works for subprocess sandbox, k8s with any CNI, future Docker `--network=none`, future Apple-container, future Firecracker microVM. NetworkPolicy is k8s-only.
- **Cost is small.** ~175 LOC of v1 code that has been running in production.

The trade-off is documented and accepted: one extra plugin in exchange for CNI-agnostic isolation.

### What does NOT live in the bridge

No policy. No inspection. No credential awareness. The bridge is a pure relay — putting policy in the bridge would mean trusting sandbox-side code with security decisions, which I5 forbids. All checks (allowlist, private-IP block, canary scan, credential substitution) live host-side in the proxy proper.

## Section 3 — `@ax/credentials` (redesigned, three plugins)

The credentials concept splits into a facade + a default storage backend + per-kind resolvers. The split makes the pluggable-storage seam real today (it's not aspirational; the default backend exercises it) and keeps OAuth lifecycle code separable from generic credential storage.

### Facade — `@ax/credentials`

Exposes the consumer-facing hook surface. Owns AES-256-GCM (when the storage backend doesn't do at-rest encryption). Owns per-kind dispatch.

```ts
@ax/credentials registers:
  credentials:get(ref, { userId }) → string
    // returns current usable value (refreshed if needed)
    // dispatches internally to credentials:resolve:<kind> for kind-specific logic
  credentials:set(ref, kind, blob, { userId, metadata? }) → {}
  credentials:delete(ref, { userId }) → {}
  credentials:list({ userId, kind? }) → CredentialMeta[]   // metadata only, never blobs
  credentials:rotate(ref, { userId }) → {}                 // force refresh

@ax/credentials calls:
  credentials:store-blob:put(row) → {}                     // pluggable backend
  credentials:store-blob:get(id, userId) → blob
  credentials:store-blob:list(userId, kind?) → CredentialMeta[]
  credentials:store-blob:delete(id, userId) → {}
  credentials:resolve:<kind>(blob) → { value, refreshed? } // per-kind sub-service
```

### Default backend — `@ax/credentials-store-db`

Registers `credentials:store-blob:*`. Owns the `credentials` table + Kysely migrations. Dialect-agnostic — works against either sqlite or postgres depending on which `@ax/database-*` connection plugin is loaded. Mirrors the existing `@ax/storage-{sqlite,postgres}` pattern.

### Storage schema

```ts
interface CredentialRow {
  id: string;                    // opaque primary key
  ref: string;                   // user-facing identifier
  userId: string;                // owner — required for multi-user web-chat
  kind: string;                  // 'api-key' | 'anthropic-oauth' | future
  encryptedBlob: Buffer;         // AES-256-GCM, key from AX_CREDENTIALS_KEY
  createdAt: Date;
  updatedAt: Date;               // bumped on every refresh
  expiresAt: Date | null;        // OAuth access expiry; null for api-key
  metadata: Record<string,unknown> | null;  // unencrypted, queryable
}
// Unique key: (userId, ref)
```

Three points worth naming:

- **`(userId, ref)` is the unique key**, not `ref` alone. Different users can each have an `anthropic-personal` credential pointing at their own blob.
- **`expiresAt` is unencrypted.** A background sweep can find tokens about to expire without decrypting any blobs.
- **`metadata` is unencrypted, freeform.** Useful for things like "which Anthropic email this OAuth belongs to" — display data, not secrets.

### Per-kind resolvers

`@ax/credentials-anthropic-oauth` registers `credentials:resolve:anthropic-oauth(blob) → { value, refreshed? }`. Receives decrypted blob, checks `expiresAt` against a 5-minute refresh-buffer window, refreshes via Anthropic's token endpoint if needed, returns the current access token plus an updated blob if rotation happened. The credentials facade handles re-encryption + storage update; the sub-service is pure logic.

Kinds without a sub-service (`api-key`, future "static bearer", etc.) get a default path in `@ax/credentials`: decrypt blob, return value directly.

### Concurrency

The credentials facade holds a per-row mutex during `credentials:get` so two simultaneous calls for the same ref serialize — only one refresh happens; the other waits and gets the post-refresh token. Cross-process coordination (multiple host processes refreshing the same ref in a multi-replica deployment) defers to postgres row locks when storage migrates from sqlite.

### Pluggable backends — future-readiness

`credentials:store-blob:*` is the seam where vault backends slot in:

- `@ax/credentials-store-gke-secret-manager` — registers `credentials:store-blob:*`, delegates to GKE Secret Manager API.
- `@ax/credentials-store-aws-sm`, `@ax/credentials-store-vault`, etc.

The kernel's "one registrar per service hook" rule means deployments pick exactly one storage backend at boot. Vault backends own at-rest security; the credentials facade's AES-GCM step is conditional on a `backendDoesAtRestEncryption: boolean` flag declared by the backend at init time. One conditional in the facade, no special-casing per backend.

For MVP: ship only `@ax/credentials-store-db`. Document the seam. Add vault backends when a concrete deployment needs one.

## Section 4 — OAuth lifecycle

PKCE (RFC 7636) — public-client OAuth without a client secret. Same code-exchange logic for CLI and web-chat; they differ only in where the redirect callback lands.

### CLI variant

`ax-next credentials login anthropic` starts an ephemeral HTTP listener on `127.0.0.1:<random-port>`, opens a browser to the authorize URL with `redirect_uri=http://127.0.0.1:<port>/callback`, waits for the redirect, exchanges code for tokens, calls `credentials:set('anthropic-personal', 'anthropic-oauth', blob, { userId })`. Browser shows "you can close this tab." Localhost listener exits.

### Web-chat variant

User clicks "Connect Claude Max" in the UI. `@ax/http-server`'s `POST /auth/oauth/start` generates verifier + challenge, stashes them in a cookie keyed to the authenticated session, redirects browser to the authorize URL with `redirect_uri=https://<host>/auth/oauth/callback`. Anthropic redirects back; `GET /auth/oauth/callback` validates state from the cookie, exchanges the code, stashes the blob against the authenticated user's ID via `credentials:set`. Redirects to web-chat home with a success flag.

### Hook surface (per-kind, registered by `@ax/credentials-anthropic-oauth`)

```ts
credentials:resolve:anthropic-oauth(blob) → { value, refreshed? }
  // refresh-if-needed; returns current access token

credentials:login:anthropic-oauth({ redirectUri, userId? }) → { authorizeUrl, codeVerifier }
  // step 1: prepare the authorize URL + remember the verifier

credentials:exchange:anthropic-oauth({ code, codeVerifier, redirectUri }) → blob
  // step 2: exchange auth code for token blob
```

CLI's login command and `@ax/http-server`'s callback both dispatch to these sub-services by `kind`. Adding OpenAI later is a sibling plugin (`@ax/credentials-openai-oauth`) registering the same three hooks with `:openai-oauth` namespace; CLI and HTTP routes don't change.

### Refresh + per-turn rotation interaction

`proxy:rotate-session` is the trigger. At every turn boundary, the proxy calls `credentials:get` for each session credential ref. That call dispatches into `credentials:resolve:anthropic-oauth(blob)`, which checks `expiresAt` (with the 5-minute buffer), refreshes if needed via Anthropic's token endpoint, returns `{ value: <current-access-token>, refreshed?: <new-blob> }`. Credentials facade re-stores if rotated. Per-blob mutex serializes concurrent refreshes.

So: refresh is lazy (no background timer), happens at most once per turn per ref, and cross-session concurrent calls for the same blob serialize cleanly.

### What MVP doesn't ship

- **Custom OAuth client_ids.** One client_id per provider, baked into the per-kind plugin. Multi-tenant deployments wanting their own OAuth app override later.
- **Granular scopes.** Always the full scope set the provider requires. Refine when we need to.
- **Silent refresh-failure recovery.** If refresh fails (revoked access, network error), the resolve sub-service throws structured error → proxy returns 401 to upstream → user sees failure and re-runs `ax-next credentials login`. Re-login is an explicit action, not silent retry.

## Section 5 — Kernel changes & `agent:invoke`

### `@ax/core` exports after the cut

```ts
// Stays
HookBus, registerService, registerSubscriber
bootstrap, Plugin, PluginManifest
PluginError, PluginErrorCode
encodeFrame, FrameDecoder, MAX_FRAME       // IPC primitives — generic
Logger

// Renamed (chat → agent)
AgentContext, makeAgentContext
  // { sessionId, agentId, userId, workspace: { rootPath }, turnId? }
AgentOutcome
  // { kind: 'complete', messages: AgentMessage[] }
  // | { kind: 'terminated', reason: string }
AgentMessage = { role: 'user' | 'assistant', content: string }

// Deleted
registerChatLoop                           // chat-orchestrator's job
ChatMessage, LlmRequest, LlmResponse
ToolCall, ToolDescriptor
ToolPreCall*, ToolExecuteHost*             // tied to deleted hooks
```

`AgentOutcome.messages` is the *host-visible transcript* — user input + final assistant message. Internal model turns (model→tool→model→tool inside the agent's loop) don't surface here; they flow through `event.http-egress` for observation. Keeps the host's view simple; pushes verbose transcripts to subscribers that opt in.

### `agent:invoke` — registered by `@ax/chat-orchestrator`

```
agent:invoke(ctx, { message }) → AgentOutcome
  1. agents:resolve(ctx.agentId, ctx.userId)
       returns { allowedHosts, requiredCredentials, providerConfig, ... }
  2. proxy:open-session({ sessionId, userId, agentId,
                          allowlist: agent.allowedHosts ∪ session.augment,
                          credentials: agent.requiredCredentials })
       returns { proxyEndpoint, caCertPem, envMap }
  3. sandbox:open-session({ sessionId, env: envMap + proxy/CA paths,
                            workspace: ctx.workspace })
  4. session:queue-work({ sessionId, message })
  5. await chat:end on the IPC bus (signaled by agent runner)
  6. proxy:close-session, sandbox:close-session
  7. return { kind: 'complete', messages: [user, finalAssistant] }
```

That's the entire orchestration. ~80 lines vs. today's ~250-line `chat-orchestrator`. Most of what today's plugin does (driving the turn loop, fanning tool calls, retry logic) has migrated *into the agent runtime itself* — which is where the agent-centric model wants it.

### Per-turn rotation seam

For long-running agent invocations where the agent runs many internal turns over hours, OAuth tokens may need refreshing mid-flight. Two options:

- **Coarse:** open once, close once, no rotation. Simplest. Fine if turn duration < access token expiry (~1 hour Anthropic OAuth).
- **Fine:** chat-orchestrator subscribes to a sandbox-side "agent-turn-boundary" event and fires `proxy:rotate-session` between internal turns. Adds latency at every turn boundary; gains hour+ session capability.

MVP ships the coarse path; the fine path slots in as `proxy:rotate-session` already exists in the proxy contract — adding it to the orchestrator is a 5-line change behind a config flag once it earns its weight.

### Egress allowlist sourcing

Per-agent baseline (from `agents:resolve`) + per-session augmentation (passed by chat-orchestrator at session-open time). Augmentation has no global ceiling at MVP — agent definitions are the ceiling. Add a ceiling in `ax.config.ts` if/when augmentation abuse becomes a concern.

`agents:resolve` return shape (the parts relevant to this design):

```ts
{
  agentId, userId,
  allowedHosts: string[],                // baseline egress allowlist
  requiredCredentials: {                  // env-var → ref + kind
    [envVarName]: { ref: string, kind: string }
  },
  providerConfig: {                       // for pi-coding-agent: which provider
    provider: 'anthropic' | 'openai' | ...,
    model: string
  },
  ...
}
```

## Section 6 — What dies / stays / shrinks

### Deletes (10 plugins)

| Plugin | Reason |
|---|---|
| `@ax/llm-anthropic` | Host-side `llm:call` contract goes away. Translation + retry + stop-reason logic migrates into agent runtimes that need them or is unneeded (claude-sdk owns its own). |
| `@ax/llm-mock` | Test-harness fake replaces it; library-mode tests register a fake `agent:invoke` directly. |
| `@ax/llm-proxy-anthropic-format` | Replaced by `@ax/credential-proxy`. The translator role disappears; the credential-gateway role generalizes. |
| `@ax/agent-runner-core` | One production runner shape. Abstraction has one impl; not earning weight. |
| `@ax/agent-native-runner` | The native turn loop was the v1 mental model; agent-centric runners replace it. |
| `@ax/tool-dispatcher` | Host-side fan-out for sandbox-side tools is gone. `tool:execute-host` for *host-mediated* tools (MCP) lives in `@ax/mcp-client` instead. |
| `@ax/tool-bash` + `@ax/tool-bash-impl` | Sandbox-side built-in. Owned by the agent runtime now. |
| `@ax/tool-file-io` + `@ax/tool-file-io-impl` | Same — agent runtime concern. |

### Shrinks (5 plugins)

| Plugin | Change |
|---|---|
| `@ax/core` | Drops `registerChatLoop`, chat-message and tool/llm types. Renames `Chat*` → `Agent*`. ~30% smaller. |
| `@ax/chat-orchestrator` | Turn loop → thin RPC. `agent:invoke` becomes ~80 lines (vs. today's ~250). |
| `@ax/credentials` | Split into facade only. Storage to `@ax/credentials-store-db`. OAuth resolve to `@ax/credentials-anthropic-oauth`. |
| `@ax/ipc-server` | Drops `llm.call`, `tool.execute-host`, `tool.pre-call` IPC actions. Keeps IPC primitives, `chat:end` signal, MCP tool gating. |
| `@ax/ipc-protocol` | Drops schemas for deleted IPC actions. |

### New (4 plugins for MVP)

| Plugin | Purpose |
|---|---|
| `@ax/credential-proxy` | Host-side MITM proxy with credential substitution. Ports v1's `web-proxy.ts` + `proxy-ca.ts` + `credential-placeholders.ts`. |
| `@ax/credential-proxy-bridge` | Sandbox-side TCP↔Unix-socket bridge for k8s. Ports v1's `web-proxy-bridge.ts`. |
| `@ax/credentials-store-db` | Default Kysely-backed credential storage. Owns `credentials` table + migrations. |
| `@ax/credentials-anthropic-oauth` | PKCE login + refresh for Anthropic OAuth. First of `@ax/credentials-<provider>-oauth` family. |

### Stays as-is or near-as-is (~24 plugins)

`@ax/agents`, `@ax/audit-log` (subscribes to `event.http-egress` instead of `chat:end`), `@ax/auth-oidc`, `@ax/channel-web`, `@ax/conversations`, `@ax/database-postgres`, `@ax/eventbus-inprocess`, `@ax/eventbus-postgres`, `@ax/http-server` (gains 2 OAuth routes), `@ax/ipc-core`, `@ax/ipc-http`, `@ax/mcp-client`, `@ax/sandbox-k8s`, `@ax/sandbox-subprocess`, `@ax/session-inmemory`, `@ax/session-postgres`, `@ax/static-files`, `@ax/storage-postgres`, `@ax/storage-sqlite`, `@ax/teams`, `@ax/test-harness` (updated for `AgentContext`/`AgentOutcome`), `@ax/workspace-git`, `@ax/workspace-git-core`, `@ax/workspace-git-http`, `@ax/workspace-protocol`, `@ax/agent-claude-sdk-runner` (sheds runner-core dependency, internal restructure).

### Net counts

- Total packages: ~40 today → ~34 after cut.
- Active host plugins loaded by CLI: ~14 today → ~13 after the credentials split.

The 4 new plugins replace 10 deleted plugins; net active-plugin reduction is small but each new plugin is structurally simpler than what it replaces.

## Section 7 — Migration order

Hard cut, but sequenced — each phase leaves the tree in a working, testable state. Old + new code coexists temporarily during phases 1–3 because additive PRs are easier to review and roll back than mid-cut snapshots.

### Phase 1a — New proxy infrastructure (additive)

**Lands:** `@ax/credential-proxy` + `@ax/credential-proxy-bridge`. Ported from v1's `web-proxy.ts` + `proxy-ca.ts` + `credential-placeholders.ts` + `web-proxy-bridge.ts`. New tests; no existing consumer.

**Risk:** Low. New plugins, not loaded anywhere yet.

**Verification:** Plugin tests pass; integration test stands up a proxy listener, sends a mock HTTPS request, confirms cert minting + substitution + audit event.

### Phase 1b — Split `@ax/credentials` into facade + store (refactor)

**Lands:** `@ax/credentials-store-db`, internal split of credentials plugin. Behavior identical; consumer-facing hooks unchanged.

**Risk:** Low. Mechanical refactor.

**Verification:** Existing credentials tests pass; new `credentials:store-blob:*` hook surface tested.

### Phase 2 — Wire proxy + bridge into `agent-claude-sdk-runner`

**Lands:** Runner startup reads `AX_PROXY_UNIX_SOCKET` / `HTTP_PROXY`, sets up bridge if needed, sets `HTTPS_PROXY` + CA env vars. CLI's `cli/main.ts` loads `@ax/credential-proxy` and wires `proxy:open-session` into the chat-orchestrator. Old `llm-proxy-anthropic-format` still loaded but unused for SDK runner.

**Risk:** Medium. End-to-end test against real Anthropic API with an API key (the easy auth case first).

**Verification:** `ax-next "list this directory"` runs through the new proxy with a real API key; audit-log shows `event.http-egress` with `classification: 'llm'`.

### Phase 3 — OAuth lifecycle

**Lands:** `@ax/credentials-anthropic-oauth`, `ax-next credentials login anthropic` CLI command, `/auth/oauth/{start,callback}` HTTP routes. Per-blob mutex, refresh-buffer window.

**Risk:** Medium. PKCE flow correctness, token-endpoint integration, refresh under load.

**Verification:** Login flow completes end-to-end; subsequent `ax-next` invocations use OAuth without re-login; refresh fires when access token is within 5 minutes of expiry.

### Phase 4 — `chat:run` → `agent:invoke` rename

**Lands:** Mechanical rename across kernel + all consumers. `ChatContext` → `AgentContext`, `ChatOutcome` → `AgentOutcome`, `makeAgentContext`. `@ax/test-harness` updated.

**Risk:** Low. Pure rename; tests catch breakage.

**Verification:** All existing tests pass with new names.

### Phase 5 — Shrink `@ax/chat-orchestrator`

**Lands:** Turn-loop logic deleted; `agent:invoke` becomes the thin RPC described in Section 5 (~80 lines). The agent runner now drives the loop end-to-end.

**Risk:** Medium-high. The runner must be self-sufficient (drive turns, fan tools, signal `chat:end` correctly). Catches any latent host-side dependency on the loop.

**Verification:** End-to-end CLI test passes; multi-turn tool-use scenarios run without host-side coordination.

### Phase 6 — Delete old plugins

**Lands:** Removes the 10 plugins from the Deletes table. Removes their entries from `cli/main.ts`. Updates lockfile.

**Risk:** Low (if previous phases landed cleanly). High if anything still depends on them — in which case the dependency surfaces as a build failure.

**Verification:** `pnpm build` + `pnpm test` clean; canary acceptance test passes; `pnpm why` shows no dangling references.

### Phase 7 — Kernel & protocol cleanup

**Lands:** Drops `ChatMessage` / `LlmRequest` / `LlmResponse` / `ToolCall` / `ToolDescriptor` / `ToolPreCall*` / `ToolExecuteHost*` from `@ax/core` and `@ax/ipc-protocol`. Audit-log switches subscription from `chat:end`-based to `event.http-egress`-based. `@ax/ipc-server` drops the deleted IPC actions.

**Risk:** Low. Final tidy-up.

**Verification:** Kernel exports list matches Section 5 spec; bundle sizes drop; no dead types remain.

### Cumulative landing pattern

```
Phase 1a + 1b: additive, can land independently or together
Phase 2:        depends on 1a + 1b
Phase 3:        depends on 2
Phase 4:        independent of 1–3 (can land in parallel with phase 3 in a different worktree)
Phase 5:        depends on 4 (and 3 for full claude-sdk runner self-sufficiency)
Phase 6:        depends on 5
Phase 7:        depends on 6
```

Total: ~7 PRs. Most can be reviewed independently; only phases 5–7 are tightly coupled and want to land in close succession to avoid leaving deletion-flagged code in the tree.

## Section 8 — Open questions / what we don't know yet

A few things this design takes positions on that we should expect to revisit:

- **Does `claude-agent-sdk@0.2.119`'s subprocess CLI honor `CLAUDE_CODE_OAUTH_TOKEN` with `settingSources: []` set?** Section 4 assumes yes (the SDK reads the OAuth env var and sends the right headers, no fallback to `~/.claude/credentials.json`). Five-minute verification; if no, we need a thin SDK shim before Phase 3 lands. The proxy substitution logic doesn't change either way — only the question of "does the SDK send the right header to substitute into."
- **Mid-turn refresh under heavy load.** The 5-minute refresh-buffer window plus per-blob mutex should prevent thundering-herd refreshes, but we haven't tested this under realistic concurrency. Phase 3's verification criteria should include a stress test.
- **K8s NetworkPolicy as a defense-in-depth layer.** The bridge handles isolation, but a sandbox pod that knows the proxy URL could still try to reach other in-cluster services. A NetworkPolicy *in addition to* the bridge (locking sandbox egress to the proxy + DNS) is belt-and-suspenders worth doing once the k8s deployment shape is concrete. Not required for MVP.
- **Cross-replica OAuth refresh coordination.** Per-blob mutex is in-process. Multi-replica deployments need postgres advisory locks (or similar) to prevent two replicas refreshing the same token simultaneously. Not blocking until the first multi-replica deployment.
- **Canary token integration.** v1's proxy supports canary scanning on outbound bodies. Plumbing this into `agents:resolve` (per-agent canary tokens? per-session?) is unclear. Defer until the threat model that justifies it is concrete.
- **Audit-log subscription latency.** `event.http-egress` fires synchronously per request. If audit-log's storage path is slow (postgres write under load), it could backpressure the proxy. The subscriber should be either async or backed by a queue. Worth measuring at Phase 1a verification.

## References

- v1 helpers ported in this design:
  - `~/dev/ai/ax/src/host/web-proxy.ts` (~656 LOC) → `@ax/credential-proxy`'s listener + MITM
  - `~/dev/ai/ax/src/host/proxy-ca.ts` (~125 LOC) → CA management
  - `~/dev/ai/ax/src/host/credential-placeholders.ts` (~122 LOC) → placeholder maps + `SharedCredentialRegistry`
  - `~/dev/ai/ax/src/agent/web-proxy-bridge.ts` (~174 LOC) → `@ax/credential-proxy-bridge`
  - `~/dev/ai/ax/src/agent/runner.ts:485-542` → sandbox-side env setup pattern (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, etc.)
- ax-next docs this design supersedes or refines:
  - `2026-04-22-plugin-architecture-design.md` — Section 4 (host-side LLM plugins, chat:run loop, tool-dispatcher fan-out) is superseded by this design.
  - `2026-04-24-week-6.5d-claude-sdk-runner.md` — the `@ax/llm-proxy-anthropic-format` translator role is superseded; the runner's env-injection contract evolves per Section 1.
- ax-next plugins/specs that remain authoritative:
  - `2026-04-23-week-7-9-k8s-deployment.md` — k8s deployment shape; this design adds the bridge plumbing on top.
  - `2026-04-23-observability-design-note.md` — `event.http-egress` is the new primary observation event for LLM and tool calls.
