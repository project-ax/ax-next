# TASK-106 — Dev mock server: /admin/connectors route for local Vite parity

epic: connectors-first-class · followup from TASK-98

## Problem

The connector registry UI (`channel-web` `ConnectorRegistry` / `lib/connectors.ts`)
reaches host hooks through real `/admin/connectors[/:id]` routes registered by
`@ax/connectors` `mountAdminRoutes`. The local Vite **mock** harness
(`packages/channel-web/mock/`) has no `/admin/connectors` middleware, so the registry
404s under offline `pnpm dev` (AX_BACKEND_URL unset). The proxy mode (TASK-114) is a
different path and out of scope.

## Contract to mirror (from `@ax/connectors` `admin-routes.ts` + `lib/connectors.ts`)

Paths (NO `/api/` prefix — unlike `mcp-servers`):

- `GET    /admin/connectors`      → `{ connectors: ConnectorSummary[] }` (owner-scoped list)
- `POST   /admin/connectors`      body `ConnectorUpsertInput` → `{ connector, created }` (201/200)
- `GET    /admin/connectors/:id`  → `{ connector: Connector }` (404 if not owned)
- `PATCH  /admin/connectors/:id`  body `Partial<ConnectorUpsertInput>` → `{ connector, created:false }` (404 if not owned)
- `DELETE /admin/connectors/:id`  → 204 (404 if nothing owned to delete)

Semantics:

- **Auth:** `auth:require-user` — ANY authenticated user (NOT admin-only). Mock = `requireSession`; 401 when no session. (Distinct from mcp-servers which is `requireAdmin`.)
- **Owner-scoped:** keyed by the session user's id. A read/mutate of a connector the
  actor doesn't own surfaces as **404** (cross-tenant isolation), never 403.
- **userId forced from session,** never the body (strip client-supplied `userId`).
- **PATCH** merges over existing, re-asserts id+owner; cannot create.
- **No credential VALUES** in any response — only declared slot names (capabilities).

## Storage in the mock `Store`

`Store.collection<T extends {id:string}>` keys rows by `id`. Connectors are
owner-scoped and two users may each own the same slug, so the row `id` is the
composite `${userId}::${connectorId}`; the connector's own slug + `userId` are
separate fields. List filters `rows.filter(r => r.userId === actor.id)` and maps to
the wire shape. Get/patch/delete resolve by `${actor.id}::${slug}`.

## Tasks

1. **`mock/admin/connectors.ts`** — `adminConnectorsMiddleware(store)`:
   - duck-typed JSON body read + `send` helpers (mirror `mcp-servers.ts`),
   - composite-key store rows `StoredConnector { id, userId, connectorId, …full Connector fields }`,
   - mappers to `ConnectorSummary` (list) + `Connector` (get),
   - list/get/create/patch/delete handlers with the semantics above,
   - lightweight validation (slug regex, required name/keyMode/visibility) → 400;
     missing/foreign → 404; 401 on no session.
2. **Wire into `mock/server.ts`** handler chain.
3. **`mock/__tests__/admin-connectors.test.ts`** — TDD, mirroring `admin-mcp.test.ts`:
   401 unauth, empty list, create→201, list reflects, get round-trip, cross-tenant
   404 (get/patch/delete a connector owned by another user), patch merges + 404 on
   foreign, delete 204 + idempotent 404, body userId stripped.

## YAGNI

- No `:id/test` endpoint (connectors have no connection-test route, unlike mcp).
- No `defaultAttached` admin-default mechanics beyond storing/echoing the field
  (the mock is offline UI parity, not an orchestrator union).
- No full zod capability validation — store/echo `capabilities` verbatim; the mock is
  dev-only and the real route owns strict validation.

## Gate

`pnpm -F @ax/channel-web build && pnpm -F @ax/channel-web test` + lint changed files.
Full `pnpm build` to surface any tsconfig type-check of `mock/**`.
