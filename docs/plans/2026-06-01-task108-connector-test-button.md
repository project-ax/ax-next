# TASK-108 — Optional connector Test button (connector equivalent of MCP /test)

epic: connectors-first-class · followup from TASK-98

## Problem

The deleted `McpServerForm` had a per-row **Test** button → `POST /admin/mcp-servers/:id/test`
that opened a real MCP connection and reported ok/error inline. The connector registry
(`ConnectorRegistry`, backed by `@ax/connectors` `/admin/connectors[/:id]`) has **no
Test affordance** — and worse, the list tile currently hardcodes a green `connected`
`StatusDot` for every connector regardless of whether its key is actually filled. We
want a connector-level Test action that reports **reachable / unreachable / needs-key**.

## Chosen approach (see decisions.md 2026-06-01)

A **server-side probe** `POST /admin/connectors/:id/test` on the existing
`@ax/connectors` admin-route bridge. The probe does **credential-slot presence +
config sanity**, NOT a live outbound MCP connection:

- **needs-key** — the connector declares a credential slot whose derived `(scope, ref)`
  has no matching row in the vault (`credentials:list`, metadata-only — never values).
- **unreachable** — config is malformed: an MCP-backed connector (`capabilities.mcpServers`
  non-empty) whose leading server has neither `url` (http) nor `command` (stdio).
- **reachable** — required slots filled + config sane (covers CLI/packages connectors,
  which only need slot presence + non-empty backing).

Rationale: the card is explicit "Optional polish" and allows a lighter CLI check. A real
outbound MCP connect would need a new host-side network-egress hook + untrusted-remote
handling — out of scope for an optional affordance, and `@ax/connectors` can't import
`@ax/mcp-client`'s connection layer (invariant #2). Credential-presence + config-sanity
needs zero new egress and works uniformly across MCP and CLI connectors. A real-connection
probe is filed as a deferred follow-up.

## Invariants

- **I1 (transport/storage-agnostic hooks):** no NEW bus hook. The probe is an internal
  function in the connectors plugin that reuses the EXISTING `credentials:list` hook
  (metadata-only) + `connectors:get`. The HTTP response body `{ status, detail? }` carries
  no backend vocabulary — `reachable`/`unreachable`/`needs-key` are neutral verdicts.
- **I2 (no cross-plugin imports):** the probe calls `credentials:list` over the bus — no
  `@ax/credentials` or `@ax/mcp-client` runtime import. The credential-scope contract is
  already re-declared locally in `credential-plan.ts`.
- **I4 (one source of truth):** no new state. Slot presence is derived live from the vault;
  connector config from the store.
- **I5 (capabilities minimized):** the probe reads credential METADATA only (no
  `credentials:get`, no secret values). Adds `credentials:list` to the plugin's `calls`
  list, only when `mountAdminRoutes` is on.
- **I6 (shadcn + tokens):** Test button is a shadcn `Button`; status uses the existing
  `StatusDot` (ok/bad/pending variants) + a semantic-token label. No raw colors.

## Tasks

### Task 1 — connectors: probe function + `/admin/connectors/:id/test` route (backend, TDD)
`packages/connectors/src/admin-routes.ts` (+ store/credential-plan reuse):
- Add `probeConnector(connector, { bus, ctx, actorId }) → { status: 'reachable'|'unreachable'|'needs-key', detail?: string }`.
  - Derive the credential plan via `deriveCredentialPlan` (already in plugin.ts).
  - For each plan entry call `credentials:list` filtered by `{ scope, ownerId }` and check
    a row with the entry's `ref` exists. `ownerId` = actorId for `user` scope, `null` for
    `global` scope (workspace key). Any missing required slot ⟹ `needs-key` (detail names
    the first unfilled slot).
  - Config sanity: MCP-backed (mcpServers non-empty) leading server with neither url nor
    command ⟹ `unreachable`.
  - Else `reachable`.
- Add `test` handler (POST `/admin/connectors/:id/test`): `auth:require-user` → `connectors:get`
  (404 on foreign/missing) → `probeConnector` → 200 `{ status, detail? }`. No body parse.
- Register the route in `registerAdminConnectorRoutes`.
- `plugin.ts`: when `mountAdminRoutes`, push `credentials:list` onto `calls`.
- Tests in `packages/connectors/src/__tests__/admin-routes.test.ts`: needs-key (unfilled
  slot), reachable (filled slot / no slots), unreachable (mcp w/o url+command), 401
  unauth, 404 foreign, owner-scoped credential lookup uses the right ownerId per scope.

### Task 2 — channel-web: `testConnector` client (TDD)
`packages/channel-web/src/lib/connectors.ts`:
- `testConnector(id): Promise<{ status: 'reachable'|'unreachable'|'needs-key'; detail?: string }>`
  — POST `/admin/connectors/:id/test` with `x-requested-with: ax-admin`, `credentials:'include'`.
  Non-throwing: folds HTTP/network failure into `{ status: 'unreachable', detail }` (mirrors
  old `testMcpServer`).

### Task 3 — channel-web: Test action in the registry tile (TDD)
`packages/channel-web/src/components/admin/ConnectorRegistry.tsx`:
- Add a per-row **Test** `Button` (variant outline, size sm) in the tile action row.
- Per-row status map `Record<id, TestStatus>` (`idle|testing|reachable|unreachable|needs-key`)
  so rows test independently (mirrors old McpServerForm).
- Replace the hardcoded green `connected` dot with a status-driven `StatusDot` + label:
  idle → "not tested" (empty dot); testing → pending dot "testing…"; reachable → ok dot
  "reachable"; unreachable → bad dot "unreachable"; needs-key → bad/empty dot "needs key".
  Compose `StatusDot` variants + muted-foreground / destructive token text.
- Tests in `admin-connectors.test.tsx`: clicking Test calls the endpoint with CSRF; renders
  reachable / unreachable / needs-key states; rows are independent.

## YAGNI pass
- No new bus hook — reuse `credentials:list`. ✅ load-bearing minimal.
- No real-connection probe — deferred follow-up. ✅ cut.
- No `detail` UI beyond the status label text — keep minimal. ✅

## Security note (Phase 5)
Touches credential PRESENCE (untrusted reach) → run `security-checklist`. The probe reads
credential metadata only (no values), is owner-scoped, and opens no network connection.
