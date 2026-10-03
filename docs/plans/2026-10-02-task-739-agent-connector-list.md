# TASK-739 — Connectors rail 6/10: agent connector list, row menu, remove + empty state

Design: `docs/plans/2026-10-02-connectors-rail-design.md` § Architecture 4. Product owner's final
decisions override it: rows are the connector NAME only, no panel title, "+ Add" hidden until
TASK-740, "View details" hidden until TASK-742, error icon / Reconnect / Retry belong to TASK-741.

## Contracts (fixed up front so the tasks can run in parallel)

### A. `@ax/connectors` — `connectors:list-effective` (host-internal service hook)

```ts
input:  { userId: string; attachmentIds?: string[]; exclusions?: string[] }
output: { connectors: Array<{
  summary: ConnectorSummary;          // the same shape connectors:list returns (no capabilities)
  source: 'default' | 'attached' | 'legacy-owned';
  capabilities: Capabilities;         // what the orchestrator folds
  toolNamespaces: ConnectorToolNamespace[];  // [{server, toolNamespace}], row-owner derived
}> }
```

Union, in order, deduped by id (first wins), every id in `exclusions` skipped in ALL sources:
1. `default` — `store.listDefaults(userId)` (id asc).
2. `attached` — each `attachmentIds` entry via `store.getAvailableById(userId, id)`;
   malformed / unknown ids skipped (a dangling attachment grants nothing).
3. `legacy-owned` — `store.listAvailable(userId)` rows with `canEdit !== false &&
   requiresAttachment !== true`.

The card listed an `agentId` input; nothing in the union reads it, so it is left out (YAGNI).

### B. `@ax/agents` — exclusions + atomic attach / detach

- Column `connector_exclusions JSONB NOT NULL DEFAULT '[]'`; `Agent.connectorExclusions: string[]`.
- `agents:attach-connector {actor, agentId, connectorId}` → `{agent, changed}`. Validates the id,
  `assertWriteAllowed`, then the workspace-connector guard (non-admin + `keyMode: 'workspace'` →
  `forbidden`), then ONE row-locked transaction: append if absent (≤ 50), drop from exclusions.
- `agents:detach-connector {actor, agentId, connectorId, exclude}` → `{agent, changed}`.
  `assertWriteAllowed`, then one row-locked transaction: drop from attachments; if `exclude`,
  add to exclusions (≤ 100).
- `agents:set-connector-attachments` enforces the same guard for ids it ADDS (moved out of
  the admin route so every path enforces it).

### C. `@ax/chat-orchestrator`

`resolveEffectiveConnectors(bus, ctx, attachmentIds, exclusions)` calls `connectors:list-effective`
only (one implementation). Fail open to `[]` + warn on a throw / missing hook.
Parity test: the old three-source algorithm kept as a test oracle vs the new hook.

### D. `@ax/channel-web` routes (`routes-workspace.ts`, all `agents:resolve`-gated → 404)

- `GET /api/workspace/agents/:agentId/connectors` → `{connectors: [{id, name, source, editable}]}`.
- `POST …/connectors {connectorId}` → `agents:attach-connector` (consumed by TASK-740's Add).
- `DELETE …/connectors/:connectorId` → find it in the effective set (404 if absent);
  `agents:detach-connector {exclude: source !== 'attached'}`; then clear the agent's tool-policy
  overrides under that connector's namespaces and revoke its approved-capability grants.
  `{removed: true, cleanup: 'complete' | 'partial'}`.

### E. UI (`components/workspace/AgentConnectors.tsx`, above "Other abilities")

"Connectors <n>"; one card of rows (name + `⋯` DropdownMenu: Edit connector (editable only) →
existing `ConnectorEditDialog`; separator; "Remove from <agent>" destructive → confirm Dialog).
Empty: shadcn `Empty`, dashed, Plug, "No connectors yet", copy; the "Add connector" button is
hidden until TASK-740.

## Tasks

1. A + C (connectors hook, orchestrator switch, parity test).
2. B (agents migration, store, hooks, admin route guard move, tests incl. concurrency + 403).
3. D + E (routes + UI + tests + screenshots).
