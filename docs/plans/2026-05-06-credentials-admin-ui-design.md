# Credentials Admin UI — Design

**Date:** 2026-05-06
**Status:** Approved (brainstorm); pending implementation plan
**Supersedes:** the `Phase 9.5` placeholder for `POST /admin/credentials` referenced in `presets/k8s/src/index.ts:387`

---

## 1. Goal

Stand up the admin and per-user surfaces for managing credentials in
both the channel-web UI and the underlying HTTP API. Today the
`@ax/credentials` facade exists end-to-end (set / get / delete with
AES-256-GCM, per-kind resolve sub-services, the `anthropic-oauth` PKCE
plugin, and the CLI `ax-next credentials set/login` commands), but the
**only** way to seed a credential is the CLI. There is no HTTP API and
no UI. Operators relying on the env-fallback shim
(`ANTHROPIC_API_KEY`) have no per-user / per-agent / per-scope path.

This design adds:

- A **scope axis** to the credentials data model: `global | user | agent`.
- HTTP routes at `/admin/credentials*` (admin-only, manages global +
  agent scope) and `/settings/credentials*` (per-user, manages own bag).
- React UI: `AdminPanel` "Credentials" tab + a new `SettingsPanel`
  ("My credentials") modal in channel-web.
- A web-paste OAuth flow for `anthropic-oauth` that does not require
  binding `127.0.0.1:1455` (the CLI flow's redirect target).
- A general per-kind OAuth contract (already established by
  `@ax/credentials-anthropic-oauth`) made explicit so future GitHub /
  MCP / etc. OAuth providers slot in by registering the same three sub-
  services under a different `<kind>`.

### Out of MVP scope (deferrable)

- Audit log of credential admin actions (per-row "who/when/what").
- Bulk operations (multi-select delete, etc.).
- Search / filter in the credentials list view.
- Per-credential "Test" button (probe the secret against the provider).

---

## 2. The five invariants — how this design respects them

1. **Hook surface is transport-agnostic and storage-agnostic.** New
   hooks (`credentials:list`, `credentials:list-kinds`,
   `credentials:oauth:stash-pending`, `:claim-pending`) use only domain
   vocab (`scope`, `ownerId`, `ref`, `kind`, `pendingId`,
   `codeVerifier`, `state`). No `storageKey`, `blob`, `pod_name`, etc.
2. **No cross-plugin imports.** The new
   `@ax/credentials-admin-routes` plugin calls every other plugin
   through the bus. Channel-web's `lib/credentials.ts` only knows the
   wire shape, never imports server packages.
3. **No half-wired plugins.** Each phase wires its new infrastructure
   to a real consumer in the same PR. The CLI keeps working as the
   bottom-of-stack consumer through Phase 1; the OAuth state-holder is
   wired by routes in the same phase that introduces it.
4. **One source of truth.** Credentials live in
   `@ax/credentials-store-db` (or a future vault sibling). The OAuth
   pending state lives in `@ax/credentials-oauth-pending`. The UI
   never caches secrets — it only displays metadata.
5. **Capabilities explicit and minimized.** New plugins request only
   the capabilities they need (see §9). Untrusted content (user-pasted
   secrets, OAuth codes from external providers) is treated as
   untrusted at every hop.

---

## 3. Architecture & data model

### 3.1 The scope axis

A credential is identified by a triple: `(scope, ownerId, ref)`.

| scope    | ownerId      | who writes              | who reads (via `credentials:get`)        |
|----------|--------------|-------------------------|------------------------------------------|
| `global` | `null`       | admins                  | any session via fallback chain           |
| `agent`  | agent id     | admins                  | sessions whose `ctx.agentId` matches     |
| `user`   | user id      | the user (and admins)   | sessions whose `ctx.userId` matches      |

### 3.2 Resolution precedence

A session calls `credentials:get({ ref, userId })` (existing input
shape; no `scope`). The facade walks the chain, first hit wins:

1. `(user, input.userId, ref)` — uses the existing required `userId` input field
2. `(agent, ctx.agentId, ref)` — read from the `AgentContext` passed to the service handler (already populated by `makeAgentContext({ sessionId, agentId, userId })`)
3. `(global, null, ref)`
4. Legacy `envFallback[ref]` lookup (existing single-tenant shim)
5. Throw `credential-not-found`

Rationale: a user can override a global key with their own (e.g.,
bring-your-own-OpenAI-key); an agent's secrets are scoped to that
agent's sessions; global is the safety-net default.

### 3.3 Plugin / hook map

Additions are in **bold**.

```
@ax/credentials (modified)
  registers: credentials:get, credentials:set, credentials:delete,
             credentials:list, credentials:list-kinds
  calls:     credentials:store-blob:get, credentials:store-blob:put,
             credentials:store-blob:list

@ax/credentials-store-db (modified)
  registers: credentials:store-blob:get, credentials:store-blob:put,
             credentials:store-blob:list
  calls:     storage:get, storage:set, storage:list-prefix

@ax/credentials-anthropic-oauth (unchanged contract; reused by web flow)
  registers: credentials:resolve:anthropic-oauth,
             credentials:login:anthropic-oauth,
             credentials:exchange:anthropic-oauth

@ax/credentials-admin-routes (NEW)
  mounts /admin/credentials*  +  /settings/credentials*
  registers: -
  calls:     credentials:list, credentials:set, credentials:delete,
             credentials:list-kinds,
             credentials:login:*, credentials:exchange:*,
             credentials:oauth:stash-pending,
             credentials:oauth:claim-pending,
             auth:require-user, http:register-route

@ax/credentials-oauth-pending (NEW)
  registers: credentials:oauth:stash-pending,
             credentials:oauth:claim-pending
  state:     in-memory Map; TTL 5 min; cap 1000 entries
  calls:     -
```

### 3.4 Storage migration

`@ax/credentials-store-db` keys today: `credential:${userId}:${ref}`.
New format: `credential:v2:${scope}:${ownerId ?? "_"}:${ref}`.

- `v2:` prefix is a clean break — no in-place rewrite.
- During a deprecation window, the facade reads BOTH formats; writes
  go to v2 only.
- A one-shot migration command, `ax-next credentials migrate`, copies
  v1 → v2 with `scope='user'`. v1 keys are tombstoned only after the
  operator confirms (the migrate command prompts).

### 3.5 New facade types

```ts
// CredentialsSetInput grows scope + ownerId
export interface CredentialsSetInput {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;     // null iff scope='global'
  ref: string;
  kind: string;
  payload: Uint8Array;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

// CredentialsGetInput stays as { ref, userId } today; the facade reads
// ctx.agentId from the AgentContext passed to the service handler.
// (No new field; precedence is computed from ctx.)

// CredentialsDeleteInput grows scope + ownerId
export interface CredentialsDeleteInput {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
}

// New: credentials:list returns metadata only — never plaintext / blob.
export interface CredentialsListInput {
  // Either filter by exact (scope, ownerId), or list everything (admin).
  scope?: 'global' | 'user' | 'agent';
  ownerId?: string | null;
}
export interface CredentialMeta {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
  kind: string;
  createdAt: string;             // ISO-8601
  expiresAt?: string;            // ISO-8601
  metadata?: Record<string, unknown>;
}
export interface CredentialsListOutput {
  credentials: CredentialMeta[];
}

// New: credentials:list-kinds — what the UI offers in the "Add" dropdown.
export interface CredentialsListKindsOutput {
  kinds: Array<{ kind: string; flow: 'paste' | 'oauth' }>;
  // 'paste' means api-key-style; 'oauth' means use the start/finish flow.
}
```

---

## 4. HTTP routes

Mounted by the new `@ax/credentials-admin-routes` plugin. Two prefixes,
one plugin (mirroring how `@ax/agents` mounts `/admin/agents*` from one
file).

### 4.1 `/admin/credentials*` — global + agent scope (admin only)

| Method | Path                                              | Body                                                      | Returns                        |
|--------|---------------------------------------------------|-----------------------------------------------------------|--------------------------------|
| GET    | `/admin/credentials`                              | —                                                         | `{ credentials: CredentialMeta[] }` (all scopes, all owners) |
| POST   | `/admin/credentials`                              | `{ scope, ownerId?, ref, kind, payload (base64), expiresAt?, metadata? }` | `201 { credential: CredentialMeta }` |
| DELETE | `/admin/credentials/:scope/:ownerId/:ref`         | —                                                         | `204`                          |
| POST   | `/admin/credentials/oauth/start`                  | `{ scope, ownerId?, ref, kind }`                          | `{ pendingId, authorizeUrl, instructions }` |
| POST   | `/admin/credentials/oauth/finish`                 | `{ pendingId, code }`                                     | `201 { credential: CredentialMeta }` |

### 4.2 `/settings/credentials*` — user scope only (any signed-in user)

| Method | Path                                       | Body                                          | Returns                        |
|--------|--------------------------------------------|-----------------------------------------------|--------------------------------|
| GET    | `/settings/credentials`                    | —                                             | `{ credentials: CredentialMeta[] }` (filtered to scope='user' AND ownerId=ctx.userId) |
| POST   | `/settings/credentials`                    | `{ ref, kind, payload (base64), expiresAt?, metadata? }` | `201 { credential: CredentialMeta }` |
| DELETE | `/settings/credentials/:ref`               | —                                             | `204`                          |
| POST   | `/settings/credentials/oauth/start`        | `{ ref, kind }`                               | `{ pendingId, authorizeUrl, instructions }` |
| POST   | `/settings/credentials/oauth/finish`       | `{ pendingId, code }`                         | `201 { credential: CredentialMeta }` |

### 4.3 ACL & validation

Mirrors `packages/agents/src/admin-routes.ts:183-260`:

- Every route calls `auth:require-user` first → 401 on failure.
- `/admin/credentials*`: requires `actor.isAdmin === true` → 403 otherwise.
- `/settings/credentials*`: any authed user. The handler **forces**
  `scope='user'`, `ownerId=actor.id` server-side — body fields for
  these are ignored if present.
- Body cap: 64 KiB before zod parsing (matches `ADMIN_BODY_MAX_BYTES`).
- CSRF: writes carry `X-Requested-With: ax-admin` (existing convention).
- Zod schemas mirror the facade's regex constraints
  (`REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/`,
  `KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/`,
  scope is `z.enum(['global','user','agent'])`).
- `payload` is base64-decoded into `Uint8Array` server-side. Bad
  base64 → 400 `invalid-payload`.
- Wildcard rejection: `scope='agent'` with `ownerId` missing → 400
  `agent-credential-requires-ownerId`. `scope='global'` with `ownerId`
  set → 400 `global-credential-must-not-have-ownerId`.

### 4.4 Error mapping

| `PluginError code`              | HTTP status |
|---------------------------------|-------------|
| `not-found`                     | 404         |
| `forbidden`                     | 403         |
| `invalid-payload`               | 400 (message echoed) |
| `credential-not-found` (oauth/finish, expired pendingId) | 410 Gone |
| Anything else                   | 500 (caught at http-server's catch-all; raw error not echoed) |

### 4.5 Plaintext never on the wire

No HTTP route returns a credential's `payload`. `GET` returns
`CredentialMeta` only. The only path through which plaintext reaches a
process is the in-process `credentials:get` bus call.

---

## 5. OAuth scaffold & anthropic-oauth web-paste flow

### 5.1 The per-kind plugin contract (already established)

A per-kind OAuth plugin registers three bus services:

```
credentials:login:<kind>     → produces { authorizeUrl, codeVerifier, state }
credentials:exchange:<kind>  → swaps { code, codeVerifier, state } → blob+expiry
credentials:resolve:<kind>   → refresh-if-needed during credentials:get
```

This contract is **not** documented as a formal scaffold spec until a
second concrete impl exists (e.g., `@ax/credentials-github-oauth`).
Per Approach A's tweak (CLAUDE.md half-wired-code policy), we don't
abstract before the second consumer exists.

### 5.2 `@ax/credentials-oauth-pending` plugin (NEW)

The web-paste flow needs PKCE `codeVerifier` + `state` to live somewhere
between the **start** and **finish** requests. Sending the verifier to
the client kills PKCE's security property — an attacker who intercepts
the auth code could also intercept the verifier. So the verifier stays
server-side, keyed by a `pendingId` token.

```ts
interface PendingEntry {
  codeVerifier: string;
  state: string;
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
  kind: string;
  userId: string;        // bound at start; verified at finish
  expiresAt: number;     // Unix ms; 5 min after creation
}
```

Storage: in-memory `Map<pendingId, PendingEntry>`.
TTL: 5 minutes (auth flow has plenty of slack; longer = larger blast radius).
Capacity: hard cap at 1000 entries; oldest-by-`expiresAt` evicted on overflow.
`pendingId`: 32 bytes from `crypto.randomBytes()`, base64url-encoded.

**Single-replica only.** Documented in the plugin manifest's
description. Multi-replica deployments need either (a) a sticky-session
cookie pinning the user to one replica for 5 minutes, or (b) a
DB-backed sibling plugin (`@ax/credentials-oauth-pending-db`). Both
post-MVP.

### 5.3 End-to-end web-paste flow (anthropic-oauth)

```
Browser              Host                     @ax/credentials-*       Anthropic
   │                  │                              │                    │
   │ POST /settings/  │                              │                    │
   │  credentials/    │                              │                    │
   │  oauth/start     │                              │                    │
   │ ────────────────>│                              │                    │
   │                  │ credentials:login:           │                    │
   │                  │  anthropic-oauth             │                    │
   │                  │ ────────────────────────────>│                    │
   │                  │ ←─{authorizeUrl,verifier,    │                    │
   │                  │   state}─────────────────────│                    │
   │                  │                              │                    │
   │                  │ credentials:oauth:           │                    │
   │                  │  stash-pending               │                    │
   │                  │  → pendingId                 │                    │
   │                  │                              │                    │
   │ ←{pendingId,     │                              │                    │
   │   authorizeUrl,  │                              │                    │
   │   instructions}  │                              │                    │
   │                  │                              │                    │
   │── (user opens authorizeUrl in new tab) ──────────────────────────────>
   │                                                                       │
   │ ←─ Anthropic shows code on its page                                  ─│
   │   user copies code, pastes into our UI                                │
   │                                                                       │
   │ POST /settings/  │                              │                    │
   │  credentials/    │                              │                    │
   │  oauth/finish    │                              │                    │
   │ {pendingId,code} │                              │                    │
   │ ────────────────>│                              │                    │
   │                  │ credentials:oauth:           │                    │
   │                  │  claim-pending {pendingId}   │                    │
   │                  │  ← {codeVerifier,state,...}  │                    │
   │                  │  (verify entry.userId ==     │                    │
   │                  │   ctx.userId; 403 else)      │                    │
   │                  │                              │                    │
   │                  │ credentials:exchange:        │                    │
   │                  │  anthropic-oauth             │                    │
   │                  │ ─────────────────────────────│───────────────────>│
   │                  │ ← {blob,expiresAt,kind}                            │
   │                  │                              │                    │
   │                  │ credentials:set              │                    │
   │                  │  (scope='user',              │                    │
   │                  │   ownerId=ctx.userId,        │                    │
   │                  │   ref,kind,payload=blob,     │                    │
   │                  │   expiresAt)                 │                    │
   │                  │                              │                    │
   │ ←201 {credential:│                              │                    │
   │   CredentialMeta}│                              │                    │
```

Admin variant (`POST /admin/credentials/oauth/*`) is identical except
`scope` + `ownerId` come from the start-request body and require
`actor.isAdmin === true`.

### 5.4 Things this design intentionally does NOT do

- **No client-side PKCE.** Verifier never leaves the server.
- **No webhook / push from Anthropic to our server.** The whole point
  of the paste flow is we don't need an inbound URL.
- **No long-lived pending state.** 5min TTL + capacity cap. A stuck
  flow fails closed (410 Gone), not hangs.
- **No cross-user pendingId reuse.** `claim-pending` verifies the
  `ctx.userId` matches the entry's `userId`.

---

## 6. UI (channel-web)

### 6.1 Surfaces

Two new entry points in the user menu:

- **Admin → Credentials** (admin only) — adds `'credentials'` to
  `AdminPanel`'s `AdminView` type. Shows everything (global + agent +
  user across all users).
- **My credentials** (any signed-in user) — opens a new
  `SettingsPanel.tsx` modal. Shows just the current user's bag.

### 6.2 Components (shared between both panels)

```
packages/channel-web/src/components/credentials/
  CredentialsList.tsx        — table: scope, ownerId, ref, kind, expires, [delete]
  CredentialAddMenu.tsx      — "Add" button → kind dropdown (driven by listKinds)
  ApiKeyForm.tsx             — kind='api-key' form (ref + secret textarea + scope/owner picker if admin)
  OAuthFlowForm.tsx          — kind ending '-oauth': "Sign in" button + paste-code input + Submit
  CredentialsScopeSelector.tsx  — admin-only: scope picker (global/agent) + agent picker
```

Both panels render `<CredentialsList scope={...}>` with different
props:

- `AdminPanel`'s Credentials tab: `scope="all"` → calls
  `adminCredentials.list()` → shows everything.
- `SettingsPanel`: `scope="user-only"` → calls
  `myCredentials.list()` → shows just the user's.

The forms are entirely shared. Their props determine which endpoint
namespace they POST to.

### 6.3 Wire client (`packages/channel-web/src/lib/credentials.ts`, new)

Mirrors `lib/admin.ts` style:

```ts
export const adminCredentials = {
  list, create, delete: del, oauthStart, oauthFinish, listKinds
};
export const myCredentials = {
  list, create, delete: del, oauthStart, oauthFinish
};
```

Each namespace hits its own endpoint prefix.

### 6.4 Form shapes — what the user sees

**Add `api-key` (admin):**
```
+-------------------------------------------+
| Add credential                            |
| Kind:   [ api-key             ▾ ]         |
| Scope:  ( ) global  ( ) agent  ( ) user   |
|   Agent: [ pick agent ▾ ] (if scope=agent)|
|   User:  [ pick user  ▾ ] (if scope=user) |
| Ref:    [ anthropic-api-key            ]  |
| Secret: [ ••••••••••••••••••••••••••• ]   |
| [Cancel]                       [Save]     |
+-------------------------------------------+
```

**Add `api-key` (user, in SettingsPanel):** same minus scope picker
(forced to `user`).

**Add `anthropic-oauth` (either panel):**
```
+-------------------------------------------+
| Sign in with Claude                       |
| Ref: [ anthropic-personal              ]  |
| Step 1: [ Open Anthropic sign-in ↗ ]      |
| Step 2: After signing in, copy the code   |
|         shown on the page and paste:      |
| Code: [                                ]  |
| [Cancel]                       [Submit]   |
+-------------------------------------------+
```

The "Open" button calls `oauthStart()`, opens `authorizeUrl` in
`target="_blank"`, and stashes `pendingId` in component state. Submit
calls `oauthFinish({ pendingId, code })`. The `pendingId` never
leaves component state — no `localStorage`, no URL params.

### 6.5 In MVP / out of MVP

In: list, add, delete, OAuth start/finish.

Out: edit (rotation = delete + add), bulk select, search,
"Test" button, audit log view, expiry refresh-now button (refresh
happens automatically on `credentials:resolve` via the per-kind
sub-service).

---

## 7. Phases

Approach A (bottom-up). Each phase is a PR (or PR pair); each ends
green with no half-wired code.

| #   | Phase                                          | Ships                                                                                                                                                                                                                                                                              |
|-----|------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1   | Storage + facade scope axis                    | New `(scope, ownerId, ref)` key format; facade `set` / `get` / `delete` grow `scope`; precedence chain on `get`; new `credentials:list` + `credentials:list-kinds`; v1-key read-fallback; `ax-next credentials migrate` CLI                                                       |
| 2   | HTTP admin routes                              | New `@ax/credentials-admin-routes` plugin: `/admin/credentials*` and `/settings/credentials*` (CRUD only, no OAuth yet); ACL gates; loaded in k8s preset; chart wiring                                                                                                            |
| 3   | OAuth state-holder + paste-flow routes         | New `@ax/credentials-oauth-pending` plugin (in-memory, TTL+cap, userId-bound); `oauth/start` + `oauth/finish` routes added to credentials-admin-routes; works with existing `@ax/credentials-anthropic-oauth`                                                                     |
| 4   | Admin UI — Credentials tab                     | `AdminPanel` adds `'credentials'` view; `components/credentials/*` shared components; `lib/credentials.ts` client; user-menu entry                                                                                                                                                |
| 5   | Settings UI — My credentials panel             | New `SettingsPanel.tsx` modal mounted from user menu; reuses `components/credentials/*` with `scope='user-only'` prop                                                                                                                                                              |
| 6   | Phase F canary upgrades                        | Acceptance test in `presets/k8s/src/__tests__/acceptance.test.ts` covers: global api-key resolution, agent override, user override, anthropic-oauth paste flow with stub                                                                                                          |
| 7   | Cleanup + docs                                 | Document or remove `envFallback` (depending on whether single-tenant kind-dev still needs it); update `MANUAL-ACCEPTANCE.md`; chart values: mark `ANTHROPIC_API_KEY` env optional                                                                                                  |

---

## 8. Testing

| Layer                                              | Test type                                                                          | Where                                                                  |
|----------------------------------------------------|------------------------------------------------------------------------------------|------------------------------------------------------------------------|
| Facade scope precedence                            | Unit (real in-memory store)                                                        | `packages/credentials/src/__tests__/scope-precedence.test.ts`           |
| Storage key encoding + v1 fallback                 | Unit                                                                               | `packages/credentials-store-db/src/__tests__/scope-keys.test.ts`        |
| `credentials:list` shape (no plaintext)            | Unit; explicit assertion that listed entries do not contain `payload`/`blob`       | facade `__tests__`                                                      |
| HTTP route handlers (ACL, body cap, error mapping) | Unit (fake bus, fake req/res — `agents/src/__tests__/admin-routes.test.ts` style)  | `packages/credentials-admin-routes/src/__tests__/handlers.test.ts`      |
| OAuth pending plugin (TTL, cap, userId binding)    | Unit (vitest fake timers for TTL)                                                  | `packages/credentials-oauth-pending/src/__tests__/state.test.ts`        |
| OAuth web-paste end-to-end                         | Unit with stub Anthropic exchange                                                  | `packages/credentials-admin-routes/src/__tests__/oauth-flow.test.ts`    |
| UI components                                      | Component tests (existing testing-library setup)                                   | `packages/channel-web/src/components/credentials/__tests__/*.test.tsx`  |
| Multi-scope resolution at session boot             | Acceptance — Phase F canary                                                        | `presets/k8s/src/__tests__/acceptance.test.ts`                          |
| Manual browser acceptance                          | `k8s-acceptance-loop` skill against `ax-next-dev` cluster                          | New section in `deploy/MANUAL-ACCEPTANCE.md`                            |

### Bug-fix policy reminder

Per `CLAUDE.md`: any bug found during implementation that wasn't
caught by an existing test gets a regression test **before** the fix
is considered done. No exceptions.

### What is NOT tested in MVP (deliberately)

- Multi-replica `oauth-pending` (single-replica only — covered when
  DB-backed sibling ships).
- Anthropic's actual OAuth endpoint (always stubbed at the
  `credentials:exchange:anthropic-oauth` boundary).
- Migration of pre-existing v1 credentials in production
  (kind-dev only has handful of test credentials; covered by unit +
  small integration test).

---

## 9. Security review (three threat models)

This is a design-time pre-stage of the `security-checklist` walk; the
implementing PRs run the formal checklist against actual code.

### 9.1 Sandbox escape

Credentials live host-side; sandboxed runners never see plaintext
(`credentials:get` returns the resolved value into the host process;
the runner asks via the credential-proxy bridge by `ref`, not by
value). New surfaces:

- **`credentials:oauth:stash-pending` / `:claim-pending`** — in-process
  bus only. Not exposed via IPC. A runner cannot stash or claim
  pending OAuth state.
- **`/admin/credentials*` and `/settings/credentials*`** — HTTP routes
  mounted on the host listener. `auth:require-user` gates every
  handler. Runners hit a *different* listener (the runner-credentials
  proxy on a separate socket); these admin routes are unreachable from
  runner network space.
- **`credentials:list` / `credentials:list-kinds`** — service hooks,
  in-process bus only. The HTTP routes that wrap them enforce ACL.

**Verdict:** no new sandbox surface.

### 9.2 Prompt injection / untrusted content

- **User-pasted secret** (api-key form): the `payload` byte array
  travels POST body → zod-validated → `credentials:set` → encrypted
  envelope → storage. Never logged, never echoed in any response
  (error mapping uses static strings, not echo'd payload). 64 KiB body
  cap before zod parsing prevents log/timing amplification.
- **OAuth code from Anthropic's page**: the `code` param POSTed by
  the user travels → zod-validated as opaque string →
  `credentials:exchange:anthropic-oauth`. If the code is bad / expired
  / wrong-state, the exchange returns a `PluginError` that maps to 400
  with a generic message. The raw provider error is **not** echoed to
  the client.
- **`metadata` field** (optional, `Record<string, unknown>` per the
  existing `CredentialsSetInput`): treated as untrusted. Goes into the
  encrypted envelope verbatim, never rendered as HTML. The UI uses
  React's default text-escaping (`textContent` / JSX `{value}`) when
  displaying metadata in the list; never injects raw HTML via React's
  raw-HTML escape-hatch prop.

OAuth `state` parameter validation is preserved —
`credentials:exchange:anthropic-oauth` requires the `state` to match
the one bound to the verifier. The web-paste flow passes both through
`pending` storage, so the existing CSRF protection still applies.

### 9.3 Supply chain

No new third-party dependencies planned. New packages depend only on:

- `@ax/core` (existing)
- `@ax/credentials` and siblings (existing)
- `zod` (already in use across admin-routes packages)
- `node:crypto` (built-in, already used by `@ax/credentials/crypto.ts`)

The `pendingId` generation uses `crypto.randomBytes(32)` then
base64url-encode — standard library, no third party.

### 9.4 Capabilities-minimized check

| New plugin / surface              | Capabilities                                                                                  | Justification                                              |
|-----------------------------------|-----------------------------------------------------------------------------------------------|------------------------------------------------------------|
| `@ax/credentials-admin-routes`    | filesystem: none; net: none direct (uses bus); spawn: none; env: none; routes: `/admin/credentials*`, `/settings/credentials*` | Routes are the sole purpose; everything else delegates via bus |
| `@ax/credentials-oauth-pending`   | none                                                                                          | Pure in-process state holder; no I/O                       |
| Updated `@ax/credentials`         | unchanged (still requires `AX_CREDENTIALS_KEY` at boot)                                       | Scope axis is purely a key-shape change                    |
| Updated `@ax/credentials-store-db`| adds `storage:list-prefix` call                                                               | Required for `credentials:list`                            |

### 9.5 Boundary-review answers (CLAUDE.md required for new hooks)

**`credentials:list`**

- *Alternate impl:* vault-backed sibling enumerates by tag.
- *Field names that might leak:* none. `scope` / `ownerId` / `ref` /
  `kind` / `createdAt` / `expiresAt` / `metadata` are all
  storage-agnostic domain vocab.
- *Subscriber risk:* none (service-only, no subscriber payload).
- *Wire surface:* schema lives with `@ax/credentials-admin-routes`,
  not central.

**`credentials:list-kinds`**

- *Alternate impl:* a future `credentials-kind-registry` plugin could
  maintain an explicit list instead of bus-introspecting.
- *Field names:* `kinds: Array<{ kind: string; flow: 'paste'|'oauth' }>`.
- *Subscriber risk:* none.
- *Wire surface:* none direct (only consumed in-process).

**`credentials:oauth:stash-pending` / `:claim-pending`**

- *Alternate impl:* DB-backed sibling for multi-replica.
- *Field names:* `pendingId` / `codeVerifier` / `state` / `scope` /
  `ownerId` / `ref` / `kind` / `userId` / `expiresAt` — all auth-flow
  vocab; no backend leakage.
- *Subscriber risk:* none (service-only).
- *Wire surface:* none — strictly in-process. Not addressable from
  outside the host process.

---

## 10. Open questions / decisions deferred

These are explicitly punted. Each has a clear next-step that does not
block MVP.

1. **Multi-replica OAuth pending state.** MVP is single-replica only.
   Document loudly; revisit when k8s preset moves to >1 replica.
2. **Admin "act on behalf of" any user.** The recommended ACL is
   "admins can read all but the UI focuses on global+agent". A future
   slice can add "edit Bob's credentials" by extending the admin UI to
   pass `scope='user', ownerId='bob'` to the same endpoint. No new
   route shape needed.
3. **Generic OAuth scaffold extraction.** Deferred until a second
   concrete OAuth provider plugin exists (e.g.,
   `@ax/credentials-github-oauth`).
4. **Audit log integration with `@ax/audit-log`.** Punted from MVP.
   Hooks are positioned to support it later without API changes.
5. **`envFallback` shim deprecation.** Phase 7 decides whether to
   remove or document. Today it's the single-tenant kind-dev escape
   hatch.
