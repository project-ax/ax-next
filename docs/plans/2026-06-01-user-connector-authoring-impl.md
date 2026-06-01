# TASK-129 — User connector authoring (/settings/connectors CRUD)

**Epic:** settings-unified · **Design:** `docs/plans/2026-06-01-settings-unified-skills-connectors-credentials-design.md` (card #6)
**Depends on:** TASK-128 (#285, merged) — `ConnectorEditDialog` is a shared variant-aware form (`isAdmin`).

## Problem

The `ConnectorEditDialog` (user variant) is ready. We need to:
1. Add owner-scoped `/settings/connectors` CRUD routes that force owner=caller, force
   `visibility:private`, and **reject** admin-only fields (`visibility:shared`,
   `defaultAttached:true`) server-side — not merely hide them in the UI. Catalog/shared
   connectors stay read-only for non-admins.
2. Wire non-admin New/Edit/Delete entry points into `ConnectorsTab`, targeting the new
   routes; reuse the user variant of `ConnectorEditDialog`.

The existing `/admin/connectors` routes already require only `auth:require-user` and force
owner=caller, but they pass `visibility`/`defaultAttached` through from the body unchecked.
The new `/settings/connectors` routes are the locked-down user-authoring surface.

## Key facts (verified)
- `connectors:upsert/get/list/delete` hooks are owner-scoped by `userId` (forced from
  session in the route). No role concept in the hook — the route is the policy layer.
- The connector store is owner-scoped: a user's list shows only their own connectors.
- `connectorSource(c)` → `'catalog'` iff `defaultAttached || visibility==='shared'`, else
  `'private'`. The read-only gate for non-admins: editable iff `source==='private'`.
- No new service-hook signatures — only new HTTP routes (schemas in the connectors plugin
  dir). Human-authored private connectors skip the model-authored approval wall (the wall
  is `connectors:install-authored` — a different hook the route never touches).

## Tasks

### Task 1 — Server: `/settings/connectors` user routes (`@ax/connectors`)
- Refactor `createAdminConnectorRouteHandlers` → `createConnectorRouteHandlers({ bus, mode })`
  where `mode: 'admin' | 'user'`. Keep `createAdminConnectorRouteHandlers` as a thin
  `mode:'admin'` wrapper (back-compat for the existing registration + tests).
- User mode behavior:
  - `create`/`update`: if body sends `visibility:'shared'` OR `defaultAttached:true` →
    **400** `{ error: 'admin-only-field' }` (rejected, not silently dropped). Then force
    `visibility:'private'`, `defaultAttached:false` onto the upsert input.
  - `update`/`destroy`: if the EXISTING connector is catalog/shared
    (`visibility==='shared' || defaultAttached===true`) → **403** `{ error: 'read-only' }`
    (defense-in-depth: catalog/shared read-only for non-admins even when owned).
  - No `/test` route in user mode (Test is admin curation).
- Add `registerUserConnectorRoutes(bus, ctx)` registering GET/POST/PATCH/DELETE on
  `/settings/connectors[/:id]`. Mount it from the plugin alongside the admin routes when
  `mountAdminRoutes` is on (same http-server gate; the user CRUD shares the bridge surface).
- TDD: extend `admin-routes.test.ts` (or a new `settings-routes.test.ts`) — user-mode
  create forces private + rejects shared/default-on; user-mode patch/delete 403 on a
  catalog/shared existing connector; owner forced from session; cross-tenant 404.

### Task 2 — Client lib: route-base variant (`channel-web/lib/connectors.ts`)
- Add a `base: '/admin/connectors' | '/settings/connectors'` parameter to
  `listConnectors/getConnector/createConnector/patchConnector/deleteConnector`
  (default `/admin/connectors` for back-compat). The user surface passes
  `/settings/connectors`.
- Keep `testConnector` admin-only (`/admin/connectors/:id/test`) — no change.

### Task 3 — `ConnectorEditDialog`: target the right base
- Pass `base` derived from `isAdmin` (admin → `/admin/connectors`, user →
  `/settings/connectors`) into create/patch/getConnector calls.

### Task 4 — `ConnectorsTab`: non-admin authoring entry points
- Show "New connector" for all users (not just admins).
- `canCurate` for Edit/Delete: admins → all; non-admins → only `connectorSource(c)==='private'`.
- Admin-only per-row actions (Test, Set/Unset default) stay `isAdmin`.
- The dialog/list/get/delete calls in the tab pick the base by `isAdmin`.
- TDD: extend `ConnectorsTab.test.tsx` — non-admin sees New + Edit/Delete on a private
  owned connector, but NOT on a catalog/shared one; no Test / Set-default for non-admin.

### Task 5 — Mock: `/settings/connectors` middleware (`channel-web/mock`)
- Add `settingsConnectorsMiddleware` mirroring the user-mode contract (force private,
  reject admin fields, 403 read-only on catalog/shared) so `pnpm dev` offline parity holds.
- Register it in `mock/server.ts`.

## Security (invariant #5) — security-checklist note required
Untrusted browser-supplied connector specs cross into stored config. The route forces
owner=caller (session, never body), forces `visibility:private`, rejects admin-only fields
server-side, and treats catalog/shared as read-only — all server-side, not UI-only. No
approval wall is touched (that gates model-authored reach). Capability validation stays in
`connectors:upsert` (canonical zod parse).

## YAGNI
- No `/settings/connectors/:id/test` — Test is admin curation only. (cut)
- No new service hook — reuse existing `connectors:*`. (per design)
- No catalog read surface — the store is already owner-scoped; out of scope per design.
