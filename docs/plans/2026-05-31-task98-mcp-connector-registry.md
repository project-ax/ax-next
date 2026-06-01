# TASK-98 — MCP-servers form → connector registry; AgentForm attaches connectors

Epic: connectors-first-class. Design: `docs/plans/2026-05-31-connectors-first-class-design.md` (Phasing step 4, channel-web half).

## Problem

Two homes for MCP servers (invariant #4 violation): the standalone admin
`McpServerForm` (backed by `@ax/mcp-client`'s `/admin/mcp-servers`) AND the
connector store (`@ax/connectors`). Replace the standalone MCP form with a
connector registry view (an MCP-backed connector = a connector whose fill is
`capabilities.mcpServers`), and replace AgentForm's raw `mcpConfigIds` chip with
a connector picker. Mechanism (transport/command/url/args) only behind Advanced.

## Architecture decisions (see decisions.md 2026-05-31 TASK-98)

- The registry is reached over a NEW `/admin/connectors[/:id]` REST surface that
  bridges the existing `connectors:*` bus hooks, registered by `@ax/connectors`
  behind a `mountAdminRoutes` opt (mirroring `@ax/mcp-client` / `@ax/teams`).
- AgentForm's connector picker writes chosen connector ids into the agent's
  existing `mcpConfigIds` field (kept load-bearing — deeply used by the
  session/sandbox/wildcard paths). No new attachment store (deferred follow-up).
- Connector form: name + needs (credential slots) + connected state by default;
  transport/command/url/args/mcpServers behind an Advanced disclosure, written
  into `capabilities.mcpServers` via `connectors:upsert`.

## Tasks (independent, testable)

### Task 1 — `@ax/connectors` admin-routes bridge (server)
New `packages/connectors/src/admin-routes.ts`: duck-typed RouteRequest/Response
(copy the @ax/mcp-client shape, I2-clean), handlers for
`GET/POST /admin/connectors`, `GET/PATCH/DELETE /admin/connectors/:id`. Each
`auth:require-user`-gated; delegates to `connectors:{list,get,upsert,delete}` via
the bus with `userId = actor.id`. 64 KiB body cap, JSON parse, error collapse.
`registerAdminConnectorRoutes(bus, ctx)` returns unregister callbacks. Add
`mountAdminRoutes` opt to `createConnectorsPlugin` (push `http:register-route` +
`auth:require-user` to `calls`; register routes in init; unregister on shutdown).
Tests: `admin-routes.test.ts` — auth 401, CRUD round-trips, cross-tenant 404,
body-too-large 413, invalid-json 400.

### Task 2 — wire `mountAdminRoutes: true` in the k8s preset
`presets/k8s/src/index.ts`: `createConnectorsPlugin({ mountAdminRoutes: true })`.
Update `preset.test.ts` connectors assertion (`calls` now includes
`http:register-route` + `auth:require-user`). Verify isolated
`pnpm --filter @ax/preset-k8s build`.

### Task 3 — channel-web connector admin client (`lib/connectors.ts`)
Typed wrappers around `/admin/connectors`: `listConnectors`, `getConnector`,
`upsertConnector`, `deleteConnector`. CSRF `x-requested-with: ax-admin` on writes.
Types `AdminConnector` (summary) + `AdminConnectorFull` (with capabilities) +
`ConnectorUpsertInput` mirroring the wire.

### Task 4 — `ConnectorRegistry.tsx` (replaces `McpServerForm.tsx`)
List view: each connector as a RoleCard (pill="connector", title=name,
caption=what-it-needs + connected StatusDot), edit/delete. Form view: name,
description, usageNote, keyMode (select personal|workspace), visibility
(private|shared). **Advanced** disclosure reveals mechanism: an MCP server
sub-form (transport/command/args/url + credential slot names) that maps to one
`capabilities.mcpServers[]` entry, plus allowedHosts. Compose shadcn primitives +
semantic tokens (Button/Input/Label/Card/Select/Badge/Checkbox). Submit →
`upsertConnector`. Delete `McpServerForm.tsx`.

### Task 5 — AgentForm connector picker
Replace the comma-text `mcpConfigIds` Input with a checkbox list over
`listConnectors()`. Selected connector ids → `form.mcpConfigIds` (array). Keep
the wildcard-guard semantics (at least one tool OR one connector). Drop the
`listMcpServers` import on the AgentForm path. Update `admin-agents.test.tsx`.

### Task 6 — nav + tests + cleanup
AdminShell/AdminSidebar: rename `mcp-servers` tab → `connectors` ("Connectors",
Plug/Server icon) mounting `ConnectorRegistry`. Replace `admin-mcp.test.tsx`
with `admin-connectors.test.tsx` (list, new, create POST, edit PATCH, delete,
Advanced reveals mechanism). Remove dead `listMcpServers`/`McpServer` type usage
where now unused (keep `lib/admin.ts` mcp helpers iff still referenced elsewhere).

## YAGNI pass
- No connector "Test" button this card (the MCP `/test` lived in mcp-client; a
  connector-test endpoint is a follow-up — not load-bearing for the collapse).
- No per-agent connector-attachment store (deferred; reuse `mcpConfigIds`).
- No catalog source-badge (design Phase 5, separate card).

## Boundary review (new `/admin/connectors` routes — HTTP, not a bus hook)
- Alternate impl: the routes bridge `connectors:*` hooks; an alternate store
  (`@ax/connectors-sqlite`) registering the same hooks needs zero route change.
- Leak: no `transport`/`command`/`url`/`mcp` as first-class route fields — they
  ride inside the opaque `capabilities` body only (same as the bus hooks).
- Subscriber risk: n/a (HTTP surface, no bus subscribers).
- Wire surface: schema lives in `packages/connectors/src/admin-routes.ts`.

## Security
Touches an IPC/HTTP surface (new admin routes) + untrusted body. Run
`security-checklist` in Phase 5. Mitigations: auth gate, body cap, JSON parse
guard, userId forced from the authenticated actor (no client-supplied owner),
capabilities re-validated by `connectors:upsert` (store parses on write+read),
cross-tenant reads 404.
