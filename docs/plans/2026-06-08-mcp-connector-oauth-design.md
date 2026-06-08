# MCP Connector OAuth — Design

**Date:** 2026-06-08
**Status:** Approved design (pre-plan)
**Scope:** Add interactive OAuth 2.0 authentication for **connector-based** MCP servers.

---

## 1. Problem

ax-next connectors can attach remote MCP servers, but the only way to authenticate
one today is to **paste a static token / API key**. There is no OAuth flow anywhere
in the MCP path:

- `@ax/mcp-client` transports (`transports.ts`) resolve `headerCredentialRefs` /
  `credentialRefs` into **static** headers or env vars. The MCP SDK's
  `authProvider` / `OAuthClientProvider` is never constructed.
- The connector connect dialog (`ConnectorConnectDialog.tsx`) renders a paste field
  (`CredentialSlotForm`). There is no "Sign in / Authorize" branch.
- The only `flow: 'oauth'` machinery that ever existed
  (`@ax/credentials-anthropic-oauth`) was for the Anthropic **LLM provider** and was
  deleted in PR #110. `flow: 'oauth'` is now a dangling shape with no live
  registrant.

So a remote MCP server that requires interactive OAuth (the Claude.ai/Desktop
"connector" model — `401 → protected-resource-metadata → dynamic client
registration → authorization-code → token`) **cannot be authenticated**: there is no
button to start the flow, and at runtime the transport sends a static token (or
nothing) and the server 401s.

**Observed symptom:** "No OAuth option at all" — the connect dialog only offers
paste-a-token.

---

## 2. Goals / Non-goals

### Goals

- Let an MCP **connector** authenticate via OAuth 2.0 (authorization-code + PKCE).
- **Dynamic by default:** discover + register against any spec-compliant remote MCP
  server with zero per-server setup (RFC 9728 protected-resource-metadata → RFC 8414
  auth-server metadata → RFC 7591 dynamic client registration).
- **Manual fallback:** allow an admin/owner to enter a `client_id`/`client_secret`
  (+ endpoints) for servers that do **not** support dynamic client registration (DCR).
- **Agent-bound reach by default:** the agent owner authorizes once; anyone who can
  use that (shared) agent rides on the owner's token, with the existing shared-key
  consent surfaced. (See §4 D2.)
- Token never enters the sandbox; refresh is automatic and invisible to the user.

### Non-goals (this slice)

- **Host-side admin `@ax/mcp-client` global servers.** OAuth for the admin-configured
  global MCP path is deferred. (Noted as a follow-up; it could use the SDK's
  in-transport `OAuthClientProvider` since it connects host-side — see §11.)
- **Workspace / global reach** (one admin authorizes a shared service identity for the
  whole workspace, `scope:'global'`). Deferred — it adds shared-refresh races + an
  admin service-account UX. `workspace` keyMode stays paste-only for OAuth.
- **Per-user reach** where each sharee acts as *themselves* on the service
  (`scope:'user'`, keyed on the chatter). Deferred — agent-bound is the default and
  only reach in this slice.
- **Background / keepalive refresh.** Lazy refresh-on-use only (see §7). No background
  daemon to keep refresh tokens alive across provider inactivity windows.

---

## 3. Background — what already exists (and is reused)

The single most important finding: **the runtime injection path is already built**,
and it never lets a credential into the sandbox. OAuth changes only *how a credential
is obtained, refreshed, and which scope/kind it has* — not how it reaches the MCP
server.

- **Connector → sandbox materialization** (`chat-orchestrator/connector-union.ts`):
  a connector's `mcpServers` become a per-dir `.mcp.json` in the sandbox; its
  credential slots become `baseCreds[env] = { ref: account:<connectorId>, kind }`, and
  the installed-entry carries a `placeholder?` "used to stamp per-connector credential
  placeholders after `proxy:open-session`." So the sandbox `.mcp.json` holds a
  **placeholder**, not the real token.
- **Credential-proxy** (`credential-proxy/listener.ts`): a MITM forward proxy that
  substitutes `placeholder → real secret` on the wire (`RequestFramer` +
  `registry.replaceAllBuffer`). The `classification` field already reserves
  `'mcp'` "for `'mcp-*'` kinds." The real token is injected host-side; the sandbox
  only ever holds the placeholder.
- **Credentials resolver + refresh seam** (`credentials/plugin.ts`): `credentials:get`
  walks a fixed precedence chain **user → agent → global**, and for any credential
  kind dispatches to a `credentials:resolve:<kind>` sub-service. A sub-service that
  returns `{ value, refreshed }` causes the credentials plugin to **re-store** the
  rotated credential under the same scope+ref. This is the exact seam the deleted
  `anthropic-oauth` plugin used; the cross-user refresh mutex even anticipates a
  shared OAuth blob.
- **MCP SDK OAuth helpers** (`@modelcontextprotocol/sdk@1.29.0`, already a dependency):
  exports the whole protocol as host-callable functions —
  `discoverOAuthProtectedResourceMetadata`, `discoverAuthorizationServerMetadata`,
  `registerClient`, `startAuthorization` (PKCE), `exchangeAuthorization`,
  `refreshAuthorization`, `extractResourceMetadataUrl`. We drive the protocol with the
  SDK's vetted code **without** adopting its in-transport `OAuthClientProvider` (which
  cannot work for connectors — the connection runs in the headless, untrusted sandbox).

---

## 4. Decisions

- **D1 — Dedicated host plugin `@ax/mcp-oauth` (Approach A).** A single-purpose plugin
  owns the interactive flow, a callback route, a small store, and the refresh resolver.
  Rejected alternatives: folding into `@ax/connectors` (mixes connector model + OAuth
  mechanism + credential storage into one already-large plugin); SDK in-transport
  `OAuthClientProvider` (the connector connection runs *inside* the sandbox — headless,
  network-locked, untrusted — so it cannot pop a browser, hold a client secret, or
  receive the callback).
- **D2 — Agent-bound reach by default.** The OAuth token is stored at
  `(scope:'agent', ownerId = agentId, ref = account:<connectorId>)`. The existing
  resolution precedence finds it at the agent scope for *any* chatter of that agent →
  "owner authorizes once, sharees ride as the owner." The shared-key consent
  (`requiresSharedKeyConsent`, true when the agent/connector is shared) is surfaced at
  connect time. For a private agent this degenerates to owner-only (no consent needed).
  Consequence: a token binds to one agent, so the same owner **re-authorizes per
  agent** (cross-agent token reuse is a possible later optimization). This sidesteps the
  private→shared token-migration problem and makes sharing work instantly.
- **D3 — Dynamic (DCR) default + manual client fallback.** Discover and register
  automatically; fall back to an owner/admin-entered `client_id`/`client_secret` (+
  endpoints) when the server doesn't support DCR.
- **D4 — Injection unchanged.** Reuse the placeholder → proxy substitution path. The
  access token never enters the sandbox; the refresh token and client secret never
  touch the sandbox **or** the MCP-server wire at all.
- **D5 — Lazy refresh-on-use.** `credentials:resolve:mcp-oauth` refreshes on resolve
  and re-stores the (possibly rotated) refresh token. "Authenticate once, works days
  later" is carried entirely by the long-lived refresh token; no background work.
- **D6 — Agent-scoped connect.** Because the token binds to an agent, the "Connect"
  action is performed where the owner manages that agent's connectors; connected/not
  status is per-agent. A sharee cannot initiate the flow.

---

## 5. Architecture — components & boundaries

### New plugin: `@ax/mcp-oauth` (host-side only)

Responsibilities:

1. **Begin-authorization route** — `POST /api/connectors/oauth/begin`
   (`auth:require-user`). Body `{ connectorId, agentId }`. Authorizes the caller
   against the agent (owner/admin only), resolves the connector's bound MCP server URL
   (the OAuth *resource*), runs discovery, ensures a registered client (DCR or pinned),
   builds the PKCE authorization URL via `startAuthorization`, persists a pending record
   keyed by `state`, returns `{ authorizationUrl }`.
2. **Callback route** — `GET /api/connectors/oauth/callback?code&state`
   (`auth:require-user`). Validates `state` (single-use, unexpired, `userId`-bound) and
   `iss`; `exchangeAuthorization`; writes the `mcp-oauth` envelope at `scope:'agent'`;
   redirects back to the connector UI with a success/failure marker.
3. **Refresh resolver** — registers `credentials:resolve:mcp-oauth`. Refreshes near
   expiry via `refreshAuthorization`, returns `{ value, refreshed }` so the credentials
   plugin re-stores the rotated token.
4. **Store** (its own table via storage hooks): registered clients per
   `(connectorId, authServerUrl)`; pending authorizations
   `state → { userId, agentId, connectorId, codeVerifier, authServerUrl, clientRef,
   resource, scope, createdAt }`.

Hooks it **calls** (all via the bus — invariant #2):
`credentials:set`, `credentials:get`; `http:register-route`, `auth:require-user`;
a connector **read** hook for OAuth-relevant config (MCP server URL, scopes, pinned
client) — confirm the existing `connectors:resolve` / `connectors:get` suffices; if
not, add a small additive read hook owned by `@ax/connectors`.
Hooks it **registers:** `credentials:resolve:mcp-oauth` (a registrant of the existing
credentials resolver contract — **not** a new cross-plugin hook shape).

### Boundary review (new surfaces)

- **Alternate impl:** the OAuth flow could be folded into `@ax/connectors` — rejected
  (§4 D1). The refresh resolver could be in `@ax/credentials` — rejected (it's a
  mechanism, kept out of the storage-agnostic core, same posture as the old
  `anthropic-oauth` plugin).
- **Wire surface:** the begin/callback HTTP schemas live in this plugin's directory.
  `state`/`code` are caller-supplied → validated, single-use, session-bound.
- **Field leaks:** none new — the connector read hook stays storage-agnostic (OAuth
  specifics live inside the `Capabilities`/`mcpServers` spec, never as first-class hook
  fields, consistent with the `@ax/connectors` `types.ts` banner).
- **Subscriber risk:** `credentials:resolve:mcp-oauth` carries the same payload shape as
  every other resolver kind; no backend-specific field a subscriber could key off.

---

## 6. Model changes

- **Connector OAuth declaration.** A credential slot gains an OAuth auth-method —
  `kind: 'oauth'` on the slot — optionally carrying the non-DCR config
  `{ clientId, clientSecretRef?, authServerUrl?, tokenUrl?, scopes? }`. The slot binds
  to one of the connector's `mcpServers[]` HTTP entries (that URL is the OAuth
  *resource*). DCR needs none of the extra fields. OAuth specifics stay inside the
  `Capabilities` spec, never leaked as first-class connector fields.
  **Terminology:** the connector-facing slot *auth-method* is `'oauth'`; the
  credentials-vault *kind* the token is stored/resolved under is `'mcp-oauth'` (§6 next
  bullet). The orchestrator maps slot-`'oauth'` → vault-`'mcp-oauth'`.
- **New credential kind `mcp-oauth`.** Vault envelope payload (JSON):
  `{ access_token, refresh_token?, token_type, scope, resource, authServerUrl,
  clientRef }`; envelope `expiresAt` set from `expires_in` so the resolver refreshes
  proactively; `clientRef` points at the stored client registration so refresh needs no
  re-discovery. Encrypted at rest by the existing credentials envelope.
- **Storage scope & resolution.** Written at `(scope:'agent', ownerId = agentId, ref =
  account:<connectorId>)`; the existing `user → agent → global` precedence finds it at
  the agent scope for any chatter (the "sharee rides" behavior). OAuth slots ignore the
  connector `keyMode` (only meaningful for paste slots in this slice; `workspace` +
  OAuth is deferred).
- **Orchestrator.** One change in `connector-union.ts`: an OAuth slot maps to
  `baseCreds[env].kind = 'mcp-oauth'` instead of the hardcoded `kind: 'api-key'`, so the
  stamped placeholder resolves through `credentials:resolve:mcp-oauth`. The proxy session
  `classification` becomes `'mcp'`.

---

## 7. Data flows

### 7a. Connect + callback (happy path)

1. **Launch.** Owner (in the agent's connector settings) clicks **Connect with
   \<Service\>**. If the agent is shared, the shared-key consent line is shown *before*
   anything leaves the browser.
2. **Begin.** `POST /api/connectors/oauth/begin { connectorId, agentId }` →
   authorize caller against agent → resolve resource URL →
   `discoverOAuthProtectedResourceMetadata` → `discoverAuthorizationServerMetadata` →
   ensure client (DCR `registerClient` with our fixed `redirect_uri`, or pinned
   client) → `startAuthorization` (PKCE) → persist pending by `state`
   (random, single-use, TTL ~10 min, bound to `userId`) → return `{ authorizationUrl }`.
3. **Consent.** Browser opens `authorizationUrl` in a **popup** (default; full-page
   redirect fallback). User approves at the provider.
4. **Callback.** `GET /api/connectors/oauth/callback?code&state` → validate `state`
   (exists/unexpired/unused, `pending.userId === session.userId`) + `iss` → mark used →
   `exchangeAuthorization` → `credentials:set` (`mcp-oauth`, `scope:'agent'`,
   `expiresAt`, metadata `{ authServerUrl, clientRef, resource, scope }`) → 302 back to
   the connector UI (popup posts `message` to opener with validated origin, closes).
5. **Done.** UI refreshes connector status → *Connected*.

The `redirect_uri` is one fixed absolute URL from the configured public origin (the
origin config auth-better/onboarding already use). DCR registers exactly that URI;
pinned clients require the operator to allow-list it at the provider.

### 7b. Runtime injection + refresh

At chat time the orchestrator opens a sandbox session for `(user, agent)`, folds the
agent's connectors, sets `baseCreds[env] = { ref: account:<connectorId>, kind:
'mcp-oauth' }`, and stamps the proxy-registry placeholder after `proxy:open-session`.
Stamping calls `credentials:get(ref, ctx{userId, agentId})` → walks `user→agent→global`
→ hits the agent-scope token → `credentials:resolve:mcp-oauth` refreshes if near expiry
→ returns a fresh access token registered as the placeholder's real value. The
`.mcp.json` carries `Authorization: Bearer <placeholder>`; the proxy substitutes the
real token on the wire. **Token never enters the sandbox.**

**Freshness over a warm session.** Access tokens are ~1h; idle-keepalive can keep a
warm runner across turns. Requirement: a long-lived session must not serve a stale
token. Mechanism: **re-resolve + re-stamp the OAuth placeholder at each turn's
session-attach** — `credentials:get` auto-refreshes via the resolver and shares one
refresh across concurrent callers via the existing mutex, so this is a near-free read
on the warm path and a single refresh when expiry is crossed. No timer.

**Lazy refresh across long idle gaps (D5).** The access token is *expected* to be
expired after days; it is not kept fresh in the background. On the next use,
`credentials:resolve:mcp-oauth` exchanges the still-valid **refresh token** for a new
access token (re-storing any rotated refresh token). The user re-consents in a browser
only when the refresh token itself is dead (provider absolute expiry, inactivity
window exceeded, revoked, or a security event).

---

## 8. Error handling

Governing rule: **never silently fall back to "no auth" or a stale token.** A dead
grant surfaces loudly as *Reconnect needed*.

| Failure | Behavior |
|---|---|
| Discovery fails (no PRM / AS unreachable) | `begin` returns a clear UI error; if the server simply doesn't advertise OAuth, route to the pinned-client form. |
| DCR unsupported / registration 4xx | "Doesn't support automatic registration — enter a client ID/secret"; route to the non-DCR form. |
| User denies consent (`access_denied`) | Discard pending; "Authorization was cancelled"; store nothing. |
| `state` invalid/expired/replayed/user-mismatch | 400, no token write, audit (CSRF/replay defense). |
| Token exchange fails | "Couldn't complete authorization"; nothing stored; retry. |
| Refresh `invalid_grant` (refresh token dead) | Typed `needs-reconnect`; status → *Reconnect needed*; never write a blank/stale token. |
| Refresh transient network error | Bounded retry inside the resolve mutex; on persistent failure, a temporary tool error — keep the stored refresh token. |
| Token revoked mid-session | In-flight MCP call 401s → SDK tool error the model reports; next turn re-resolves → refresh → if also dead, *Reconnect needed*. No crash. |
| Rotation | Every refresh re-stores the rotated refresh token atomically via the `refreshed` seam; SDK preserves the old one when not rotated. |
| Agent deleted / connector detached | The agent-scoped token is tombstoned with the agent (fold into the existing agent-delete cascade — verify it covers agent-scope creds). |
| Non-owner hits `begin` | 403 before any flow starts. |

---

## 9. Security threat model

The implementing PR(s) must run the `security-checklist` skill to produce the formal
PR security note (adds IPC/HTTP surface, handles untrusted third-party metadata, touches
credentials). Design-time model:

- **Token / secret exposure (sandbox-escape lens).** Access token never enters the
  sandbox (placeholder → proxy substitution). The **refresh token and client secret
  never touch the sandbox or the MCP-server wire at all** — host→auth-server only,
  encrypted at rest. A fully compromised sandbox sees a placeholder. ✓ invariant #5.
- **Untrusted metadata (prompt-injection / SSRF lens).** Discovery metadata (AS URL from
  PRM; authorize/token/registration endpoints from AS metadata) is
  attacker-influenceable. **All** discovery/registration/token fetches go through an
  SSRF-guarded fetch: `https`-only, private-IP/link-local blocked (reuse the proxy's
  `resolveAndCheck` posture), constrained to the connector's declared `allowedHosts` /
  the resource's registrable domain — never blindly fetch an arbitrary URL named by
  metadata. **Fixed `redirect_uri`** + **PKCE** + single-use **`state`** defeat code
  interception and CSRF; validate **`iss`** on callback (RFC 9207) to defeat AS mix-up.
  Scopes come from connector config / PRM (not arbitrary) and are shown at consent.
- **Authoring trust.** Only an admin or the agent's owner can create/approve an OAuth
  connector; model-authored drafts still hit the existing approval wall. (Today the
  connector-card excludes `mcp` from auto-approve — reconcile in planning.)
- **Supply chain.** **No new dependency** — protocol code is `@modelcontextprotocol/sdk`
  (already present); PKCE/state use Node `crypto`. Only new package is first-party
  `@ax/mcp-oauth`.
- **Audit.** Emit events for authorization-begun, token-stored, refresh,
  refresh-failure/needs-reconnect.

---

## 10. Testing & rollout

### Tests

- **Unit:** SSRF guard on every discovery/token URL; pending-store TTL + single-use +
  `userId` binding + `iss`/`state` rejections; envelope build; resolver refresh **and
  rotation re-store**; the non-DCR pinned-client branch.
- **Integration:** in-process fake auth-server + fake MCP resource server driving the
  full `begin → callback → store → resolve → refresh` loop; the reach assertion —
  a *different* chatting user resolves the owner's agent-bound token.
- **Orchestrator:** connector-fold passes the `mcp-oauth` kind through and stamps the
  placeholder; proxy `classification` = `'mcp'`.
- **Canary (invariant #3 — no half-wired):** the connectors acceptance canary gains an
  OAuth connector reachable end-to-end against the in-process fakes, proving sandbox
  calls succeed via proxy injection. Not merged unless reachable from the canary.
- **Bug-fix policy:** any walk-found bug gets its regression test first.

### Manual acceptance walk (`(walk)` card; k8s-acceptance-loop + Playwright on `ax-next-dev`)

Owner clicks Connect → completes consent at a test provider → token stored; a **sharee**
chats the shared agent and the MCP tool works *as the owner*; revoke the token →
*Reconnect needed* surfaces.

### Rollout / half-wired window

The new plugin is loaded in **both** the CLI and k8s presets, routes registered,
connect-UI wired, and canary-covered **in the same PR** — no "wire later." If too big
for one PR, phase so each phase is independently fully-wired + canary-green and closes
its own window (likely Phase 1 = plugin + flow + storage + resolver + canary; Phase 2 =
connect-dialog UI). `security-checklist` runs on each.

---

## 11. Open questions / follow-ups

- **Workspace / global reach** (admin authorizes one shared service identity;
  `scope:'global'`; shared-refresh races + service-account UX). Deferred.
- **Per-user reach** (each sharee acts as themselves; `scope:'user'`). Deferred.
- **Host-side admin `@ax/mcp-client` OAuth** — could adopt the SDK in-transport
  `OAuthClientProvider` since it connects host-side. Deferred.
- **Background / keepalive refresh** for providers that expire refresh tokens on
  inactivity. Out of scope (D5).
- **Cross-agent token reuse** so an owner doesn't re-authorize per agent. Possible
  optimization on top of agent-bound storage.
- **Exact connectors read hook** for OAuth config — confirm `connectors:resolve` /
  `connectors:get` suffices or add a small additive read hook.
- **`redirect_uri` origin config** — confirm the canonical public-origin source.
- **Connector-card `mcp` auto-approve** exclusion — reconcile with OAuth connectors.
- **Agent-delete cascade** — verify it tombstones agent-scope credentials.
- **PR phasing** — finalize in the implementation plan (writing-plans).

---

## 12. Summary

A focused host-side `@ax/mcp-oauth` plugin drives the interactive OAuth dance with the
MCP SDK's vetted protocol helpers, stores **agent-bound** tokens in the existing
credentials vault, and refreshes them lazily through the existing resolver seam. The
runtime injection path is unchanged — the access token reaches the MCP server via the
credential-proxy's placeholder substitution and never enters the sandbox. The new
surface is small (the OAuth flow, one callback route, the `mcp-oauth` kind, an
agent-scoped connect UI) because ~80% of the machinery — proxy injection, credential
vault, refresh/rotation re-store, connector materialization — already exists.
