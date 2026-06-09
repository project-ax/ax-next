# MCP Connector OAuth — Phase 2 Design (channel-web connect UI)

**Date:** 2026-06-08
**Status:** Approved design (pre-plan)
**Scope:** The user-facing surface for connector OAuth — connect, status,
consent, and authoring — plus the small backend changes that surface requires.
**Builds on:** Phase 1 (PR #341, merged) — the `@ax/mcp-oauth` plugin, the
`/api/connectors/oauth/{begin,callback}` routes, the `mcp-oauth` credential kind,
the refresh resolver, and the orchestrator fold. Design: `2026-06-08-mcp-connector-oauth-design.md`.

---

## 1. Problem

Phase 1 shipped a working OAuth backend with **no way for a human to drive it**:

- No button starts the flow. `begin` exists but nothing calls it.
- No way to see whether a connector is connected, or that a grant has gone dead
  (the resolver throws `NeedsReconnectError` only mid-chat).
- No way to author an `oauth` credential slot — the connector schema accepts one
  (Phase 1 widened `CapabilitySlotSchema`), but `ConnectorEditDialog` / the
  `connector-form` model still only produce `api-key` slots.
- Two Phase-1 backend facts block a real UI and must be reconciled here:
  1. The callback **hardcodes `scope:'agent'`**, which is one specific sharing
     model. Once a human is choosing where a connection lives, we need the scope
     to follow the *kind of agent* (see §4 D1).
  2. The configured `connectorReturnPath` defaults to `/settings/connectors`,
     which **collides with the connectors REST GET route** — a browser redirect
     there returns the connector-list JSON, not the SPA. Never exercised in
     Phase 1 (no UI), but a hard blocker the moment a popup lands on it.

So today an MCP connector that needs OAuth can be declared by the schema and
authenticated by the routes, but a person can't actually *do* any of it.

---

## 2. Goals / Non-goals

### Goals

- **Connect.** A "Connect with `<Service>`" action that drives
  `begin → provider → callback → status refresh`, popup-first.
- **Connect once, reuse across your agents.** A personal connection is a
  *user-level* thing: connect a connector once, every agent you attach it to
  uses it. (See §4 D1.)
- **Shared agents still ride the owner.** A team agent's connection is set up
  once (by the owner, from the agent editor) and every member of that agent
  rides it.
- **Status.** Per-surface Connected / **Reconnect needed** / Not connected,
  accurate to what the runtime would actually resolve.
- **Consent.** The shared-key consent moment at connect time for a team agent.
- **Author an `oauth` slot.** `ConnectorEditDialog` can declare an `oauth` slot
  (server + scopes), with the non-DCR pinned client behind an advanced
  disclosure.
- Hosted in `channel-web`, shadcn primitives + semantic tokens (invariant #6).

### Non-goals (this slice)

- **Workspace / global OAuth reach**, per-user reach, host-side admin
  `@ax/mcp-client` OAuth, background refresh — all still deferred (Phase-1 §11).
- **A second connect surface for shared connections.** A team agent's connection
  is set up in the agent editor only; we do **not** add an agent-picker to the
  Connectors tab.
- **Connect-time DCR-fallback form.** The pinned (non-DCR) client is entered at
  *authoring* time on the slot, not pasted mid-flow when discovery fails.

---

## 3. Background — what already exists (and is reused)

- **`begin` / `callback` routes** (`packages/mcp-oauth/src/routes.ts`) — the flow
  works; we generalize the scope it writes and the return target.
- **The refresh resolver + proxy injection are untouched.** `credentials:resolve:mcp-oauth`
  refreshes on resolve; the credential-proxy substitutes the token on the wire.
  Phase 2 changes only *where a connection is stored* and *how a human sees its
  status* — never how the token reaches the MCP server.
- **The credentials resolution precedence is the load-bearing constraint.**
  `credentials:get` walks a fixed `user(chatter) → agent → global` chain, keyed on
  whoever is chatting (`packages/credentials/src/plugin.ts` `doResolve`). This is
  why §4 D1's scope split is *forced*, not chosen.
- **`agents:resolve`** returns `{ ownerId, visibility: 'personal' | 'team' }` —
  exactly what the begin route needs to pick the storage scope.
- **`@ax/static-files`** serves `index.html` for any unclaimed path
  (`spaFallback: true`), so a dedicated SPA return path (`/oauth/connected`)
  reaches the SPA bridge while leaving the connectors REST routes alone.
- **Existing UI surfaces we extend** (not rebuild):
  - `ConnectorsTab` → `ConnectorConnectDialog` → `CredentialSlotForm` — today's
    paste flow. We add an OAuth branch.
  - `AgentForm` connector checkbox section (`components/admin/AgentForm.tsx`) —
    per-user, owner-scoped agent editor (every user manages their own agents).
  - `ConnectorEditDialog` + `lib/connector-form.ts` — the mechanism-first
    authoring form.
  - `lib/connectors.ts` — the connector REST client + the local
    credential-plan/consent re-declarations.

---

## 4. Decisions

### D1 — Hybrid storage scope (the sharing model). **Personal agent → user-scope; team agent → agent-scope.**

The fixed `user → agent → global` precedence, keyed on the chatter, forces this:

- "Connect once, all **my** agents use it" requires **user-scope** (reachable by
  *me* across every agent I drive).
- "A shared agent's members ride **one** connection" requires **agent-scope** —
  a sharee's lookup can reach an agent-scoped token, but it can **never** reach
  another user's user-scope. The owner's user-scope is private to the owner.

A single token can't be both, so we split on agent visibility:

- **Personal agent** (only the owner drives it) → `scope:'user'`, `ownerId = userId`.
  Connect once; every personal agent attached to the connector reuses it. (This
  also matches today's paste model: `keyMode:'personal'` → credential `scope:'user'`.)
- **Team agent** (members drive it) → `scope:'agent'`, `ownerId = agentId`.
  One member (the owner) connects once; all members ride.

This **reopens the merged Phase 1 callback** (which hardcoded `scope:'agent'`).
The change is contained: scope is chosen at `begin` from the resolved agent and
persisted in the pending row; the callback writes that scope; the resolver and
proxy injection are unchanged (the existing precedence walk just finds the right
one).

**Accepted edge (the "shadow" case):** a member who has their *own* personal
connection to a connector, and is also a member of a team agent on the same
connector, resolves their *personal* token when chatting the team agent
(`user` beats `agent` in precedence) — i.e., they act as themselves, not as the
shared identity. We accept this ("use your own access when you have it") rather
than rewrite precedence.

### D2 — Two connect homes, by scope.

- **Connectors tab** — the single home for **personal** (user-scope) connect +
  status. A connector you connect here is usable by every agent you attach it to.
  No agent dimension.
- **Agent editor** — a **one-time** connect affordance that appears **only when
  editing a team agent**, for its attached `oauth` connectors, behind the
  shared-key consent line. One member (the owner) connects; everyone else rides
  and sees "Connected" — *nobody re-connects*. This is the only surface with a
  specific shared agent in context, which an agent-scoped connection needs.
- **Personal agent in the editor** — no connect button (the connection is
  user-level, managed in the Connectors tab). A **read-only status hint** sits
  next to the attach checkbox ("Connected" / "Not connected — connect in
  Connectors") so an attached-but-unconnected connector is legible.

### D3 — Status is a live authoritative probe, not a persisted signal.

A new read endpoint resolves `(scope, ownerId)` the **same way begin does** and
derives status from the **same resolution path the runtime uses**: a resolvable
token ⇒ Connected, a typed `NeedsReconnectError` ⇒ **Reconnect needed**, no
credential ⇒ Not connected. Because it walks the real `credentials:get`
path, the status the user sees is exactly what a chat turn would resolve —
including the D1 shadow edge — with no separate persisted flag and no resolver
change. The only side effect is the same refresh-if-near-expiry the next turn
would do anyway (a net win — it leaves the token fresher).

### D4 — Popup-first, with a dedicated SPA return path + bridge.

`begin` returns `{ authorizationUrl }`; the browser opens it in a **popup**. The
callback redirects the popup to a dedicated SPA path `/oauth/connected?...`. A
small **SPA bridge** (fires early in `main.tsx`) detects the return, and if it's
a popup (`window.opener`), `postMessage`s the outcome to the opener (origin-
validated) and closes; otherwise (full-page fallback) it strips the params,
toasts, and routes to Connectors. **No token is ever in the message** — only the
connector id + `success|error`. `connectorReturnPath` is reconfigured to
`/oauth/connected` (fixing the Phase-1 REST-route collision).

### D5 — Author the `oauth` slot, pinned client behind an advanced disclosure.

`ConnectorEditDialog` + `connector-form` gain an `oauth` credential-slot type:
it references one of the connector's `mcpServers[]` entries (`server`) + `scopes`.
The non-DCR pinned client (`clientId` / `clientSecret`) lives behind a collapsed
**Advanced** disclosure — blank ⇒ DCR default; filled ⇒ pinned. The
`client_secret` is written to the vault and referenced as `clientSecretRef`
(never stored on the connector record). The channel-web client types widen to
the discriminated union the Phase-1 server schema already accepts.

---

## 5. Architecture — components & boundaries

### Layer A — backend (`@ax/mcp-oauth`, reopening Phase 1)

- **`begin`** (`routes.ts`): body `{ connectorId, agentId? }`.
  - `agentId` present → `agents:resolve` (the existing authz gate) → if
    `visibility === 'team'` then `(scope:'agent', ownerId: agentId)` else
    `(scope:'user', ownerId: user.id)`.
  - `agentId` absent → `(scope:'user', ownerId: user.id)`; authz is connector
    ownership (the existing `connectors:get` succeeds).
  - The resolved `(scope, ownerId)` is persisted on the pending row.
- **Pending store + migration** (`store.ts`, `migrations.ts`): additive
  `scope` + `owner_id` columns on `mcp_oauth_v1_pending` (rows are ephemeral,
  ~10-min TTL — no backfill concern).
- **`callback`**: writes `credentials:set` at the pending row's `(scope, ownerId)`
  instead of hardcoded agent-scope; redirects to the new `connectorReturnPath`.
- **`GET /api/connectors/oauth/status`** (NEW, `auth:require-user`): query
  `{ connectorId, agentId? }` → resolves `(scope, ownerId)` exactly as `begin`
  does (same authz: `agents:resolve` for an agent, connector ownership otherwise)
  → probes via the runtime resolution path → `{ status: 'connected' |
  'needs-reconnect' | 'not-connected' }`. Never returns the token.
- **Preset** (`presets/k8s` + CLI): `connectorReturnPath: '/oauth/connected'`.

### Layer B — SPA OAuth bridge (`channel-web`)

- **`lib/oauth-callback-bridge.ts`** (NEW) — a synchronous check run at the top
  of `main.tsx` *before* the React app boots. On `/oauth/connected?oauth=…&connector=…`:
  popup ⇒ `window.opener.postMessage({ type:'ax:oauth-callback', connector, oauth },
  window.location.origin)` + `window.close()`; non-popup ⇒ strip params
  (`history.replaceState`), surface a toast, route to Connectors.

### Layer C — connect + status UI (`channel-web`)

- **`lib/connectors-oauth.ts`** (NEW) — typed wrappers: `beginOAuth({connectorId, agentId?})`
  → `{ authorizationUrl }`; `getOAuthStatus({connectorId, agentId?})` → `{ status }`.
  CSRF posture mirrors `lib/connectors.ts` (`credentials:'include'`, `x-requested-with`).
- **`ConnectorOAuthConnect`** (NEW component) — button + status badge + (for a
  team agent) consent gate + popup orchestration (open → await `postMessage` /
  detect popup-closed → refetch status). Origin-validates inbound messages.
  Reused by both homes; the only difference is whether it passes an `agentId` and
  whether it shows consent.
- **`ConnectorConnectDialog`** — for an `oauth`-slot connector, render
  `ConnectorOAuthConnect` (user-scope, no `agentId`) instead of the paste
  `CredentialSlotForm`.
- **`AgentForm`** connector section — for a **team** agent, render
  `ConnectorOAuthConnect` (with `editing.id`, consent) per attached `oauth`
  connector; for a **personal** agent, render the read-only status hint.
- **`ConnectorEditDialog` + `lib/connector-form.ts`** — `oauth` slot authoring
  (D5).

### Boundary review

- **New hook surface:** none. The status endpoint is HTTP-only; it calls
  existing hooks (`auth:require-user`, `agents:resolve`, `connectors:get`,
  `credentials:get`). No new cross-plugin hook shape.
- **Wire surface:** the status route schema lives in `packages/mcp-oauth/`.
  `connectorId` / `agentId` are caller-supplied → validated; authz is the same
  `agents:resolve` / connector-ownership gate as `begin`.
- **Field leaks:** none — the status response is a neutral enum; no token,
  no backend vocabulary.
- **postMessage surface:** origin-validated both ways; payload is non-secret
  (connector id + outcome).

---

## 6. Model / type changes

- **`mcp_oauth_v1_pending`** gains `scope` + `owner_id` (the resolved binding).
- **channel-web `ConnectorCredentialSlot`** (`lib/connectors.ts`) widens from a
  single `api-key` shape to a discriminated union matching the Phase-1 server
  schema: `{ slot, kind:'api-key', description? }` |
  `{ slot, kind:'oauth', server, scopes?, clientId?, clientSecretRef?, authServerUrl?, tokenUrl? }`.
- **`connector-form` `CredentialSlotRow`** widens to carry the oauth fields (and
  a `kind`), with (de)serialization to/from the union; an `api-key` row stays
  byte-identical on the wire (back-compat).
- **No change** to the `mcp-oauth` token blob, the resolver, the proxy
  classification, or the orchestrator fold.

---

## 7. Data flows

### 7a. Connect (personal, from the Connectors tab)

1. User opens a connector with an `oauth` slot → `ConnectorOAuthConnect` shows
   its status (via `getOAuthStatus({connectorId})` → user-scope).
2. Click **Connect with `<Service>`** → `beginOAuth({connectorId})` (no agentId)
   → `{ authorizationUrl }` → open popup.
3. Provider consent → callback writes `scope:'user', ownerId:userId` →
   302 `/oauth/connected?connector=…&oauth=success`.
4. SPA bridge in the popup `postMessage`s success + closes; the opener refetches
   status → **Connected**. Every personal agent attached to this connector now
   resolves it.

### 7b. Connect (shared, one-time, from the agent editor)

1. Owner edits a **team** agent → its attached `oauth` connectors show
   `ConnectorOAuthConnect` with status (via `getOAuthStatus({connectorId, agentId})`
   → agent-scope).
2. The **consent line** ("Authorizing lets anyone using this agent act as you on
   `<Service>`.") gates the button. Accept → `beginOAuth({connectorId, agentId})`
   → callback writes `scope:'agent', ownerId:agentId`.
3. Every member chatting this agent now rides the token; their editor shows
   **Connected** — they never connect.

### 7c. Status & reconnect

`getOAuthStatus` resolves `(scope, ownerId)` like `begin` and probes the runtime
path: Connected / Reconnect needed / Not connected. A dead refresh token
(`invalid_grant`) surfaces as **Reconnect needed** with a re-Connect button that
re-runs 7a/7b.

---

## 8. Error handling (UI surfaces of design §8)

| Condition | UI |
|---|---|
| `begin` 502 (discovery / DCR unsupported) | Inline: "couldn't reach this service" / "this service needs a manual client — add one in the connector's Advanced settings." Never silently connected. |
| Popup closed without callback, or `oauth=error` | "Authorization was cancelled." Status unchanged. |
| Status `needs-reconnect` | Amber "Reconnect needed" + re-Connect. |
| Status fetch fails | Soft "couldn't check status" — never a false "Connected." |
| `begin`/status 403 (not permitted on the agent) | "You don't have access to connect this agent." |

Governing rule (from the design): **never imply connected when we aren't.**

---

## 9. Security threat model

Run the `security-checklist` skill on the implementing PR(s) — this adds an HTTP
read route, a cross-window `postMessage`, and reopens the credential-write path.

- **Token exposure.** Unchanged from Phase 1: the access token never enters the
  sandbox; the status endpoint reads it host-side and discards it (never
  returned). The `postMessage` carries no secret.
- **CSRF / origin.** `begin`/`callback` keep the Phase-1 single-use, user-bound
  `state` + `iss` checks. The SPA bridge validates `event.origin ===
  location.origin` on inbound messages and posts only to `location.origin`.
- **Authz on the new read.** The status endpoint reuses `begin`'s gate: a
  personal agent admits only its owner, a team agent any member, an agentless
  read requires connector ownership. A non-member gets 403 and learns nothing.
- **Scope-confusion.** The pending row binds `(scope, ownerId)` at `begin`; the
  callback can't be tricked into writing a different scope (single-use, user-
  bound `state`).
- **Authoring trust.** The pinned `client_secret` is browser-supplied →
  validated, written to the vault as a credential, referenced (never echoed).
  An `oauth`-slot connector still hits the existing connector approval wall.
- **Supply chain.** No new dependency.

`ax-code-reviewer` reviews the security-relevant wiring specifically: the begin
scope-selection + callback write, the new status read endpoint, and the
postMessage/origin handling.

---

## 10. Testing & rollout

### Tests

- **Backend:** scope selection in `begin` (personal→user, team→agent,
  no-agent→user); callback writes the stored `(scope, ownerId)`; pending
  additive columns; status endpoint maps the three outcomes (resolvable /
  NeedsReconnect / absent) under each scope.
- **Canary (invariant #3):** extend the Phase-1 e2e to assert a **personal**
  connect resolves for the owner's *other* agent (user-scope reuse) alongside
  the existing team sharee-rides case.
- **Frontend:** `ConnectorOAuthConnect` (popup open, message handling, consent
  gate fires for team / not for personal); the SPA bridge (popup
  postMessage+close vs full-page fallback; origin rejection); `oauth`-slot
  authoring round-trip in `connector-form`; the personal read-only status hint.
- **Bug-fix policy:** any walk-found bug gets its regression test first.

### Rollout / half-wired window (per `feedback_half_wired_window_pattern`)

PR split, each independently fully-wired + green (mirrors Phase 1's 1a/1b):

- **2a — backend:** hybrid scope (`begin`/pending/`callback`) + status endpoint +
  `connectorReturnPath` config + extended canary. Routes mounted, resolver
  unchanged. Fully usable via HTTP on its own.
- **2b — UI:** SPA bridge + `ConnectorOAuthConnect` + ConnectorsTab/AgentForm
  wiring + `oauth`-slot authoring. Closes the user-facing window.

`security-checklist` runs on each. Manual-acceptance is **Phase 3** (separate
`(walk)` card; k8s-acceptance-loop + Playwright on `ax-next-dev`).

---

## 11. Open questions / follow-ups

- **Connector-card `mcp` auto-approve** exclusion vs. oauth-slot connectors —
  the authoring form produces them; the existing approval wall handles them as
  any mcp connector. No new behavior here; reconcile only if the walk surfaces a
  gap.
- **Multi-slot connectors with an oauth slot** stay rejected at `begin`
  (Phase-1 limitation: the callback writes the collapsed `account:<id>` ref).
  Authoring should steer single-oauth-slot connectors; surfacing a friendly
  guard is a follow-up if needed.
- **Cross-agent reuse across personal *and* team** (one connection covering both
  a user's personal agents and a team agent on the same connector) is out of
  scope — the scope split means the two are connected independently.
- **`client_secret` storage scope** for a pinned client — finalize in the plan
  (mirror the connector's keyMode → credential scope, so the `begin`-time
  `credentials:get(clientSecretRef)` resolves under the right identity).

---

## 12. Summary

Phase 2 turns the Phase-1 backend into a usable feature with a small, focused
surface: a popup-first **Connect** action with accurate **status**, a one-time
**shared-agent** connect in the agent editor, **consent** for team agents, and
**oauth-slot authoring** with the pinned client tucked behind Advanced. The one
real architectural choice — the hybrid storage scope — isn't invented here; it's
*forced* by how credential resolution already works, and it delivers both
"connect once for my agents" and "shared agents ride the owner" by storing each
where the resolver can actually find it. The backend reopening is contained
(scope-at-begin, a status read, a return-path fix); the resolver, the proxy
injection, and the token blob are untouched.
