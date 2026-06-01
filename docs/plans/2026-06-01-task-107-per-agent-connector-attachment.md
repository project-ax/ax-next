# TASK-107 — Per-agent connector-attachment store (replace mcpConfigIds stopgap)

**Status:** Plan (TDD, one PR)
**Branch:** auto-ship/TASK-107-per-agent-connector-attachment
**Design:** docs/plans/2026-05-31-connectors-first-class-design.md (Phasing step 4, the "other half")
**Predecessors:** TASK-97 (connector union), TASK-98 (mcpConfigIds stopgap), TASK-96 (keyMode→cred ref)

## Problem

TASK-98 overloaded `agent.mcpConfigIds` to carry connector-attachment ids (a stopgap). This
field is ALSO the host tool-dispatcher MCP binding + the wildcard sentinel
(`allowedTools=[] && mcpConfigIds=[]` ⇒ "see the whole catalog"). Overloading it
mis-feeds connector ids into `@ax/mcp-client` `filterByAgentScope` as host MCP config
ids. We need a first-class per-agent connector-attachment store; `mcpConfigIds` reverts to
MCP-only meaning.

## Approach (decided in brainstorm — see decisions.md 2026-06-01)

A new `connector_attachments JSONB NOT NULL DEFAULT '[]'` column on `agents_v1_agents`
holding a plain `string[]` of connector ids — mirroring `skill_attachments` exactly. A
new `agents:set-connector-attachments` hook + `PATCH /admin/agents/:id/connector-attachments`
route. `connectorAttachments` surfaced on the `Agent` DTO + `agents:resolve` output. The
orchestrator union reads it as a THIRD source in `resolveEffectiveConnectors`. AgentForm
writes via the new route, not `mcpConfigIds`.

The wildcard sentinel is UNCHANGED (`allowedTools=[] && mcpConfigIds=[]`): connector
attachments don't participate, exactly like skill_attachments. The admin route's
`rejectsWildcardScope` (≥1 tool or ≥1 MCP config) is unchanged. No data migration that
reclassifies mcpConfigIds → connectorAttachments (ax-next has no prod data + the field's
historical dual meaning makes that lossy); the additive NOT-NULL-DEFAULT-'[]' column IS the
idempotent migration (every existing row reads `[]` safely).

## Tasks (each independently testable, TDD)

### Task 1 — @ax/agents store + types + migration (the store)
- `migrations.ts`: add `ALTER TABLE … ADD COLUMN IF NOT EXISTS connector_attachments JSONB NOT NULL DEFAULT '[]'`; add `connector_attachments: unknown` to `AgentsRow`.
- `types.ts`: add `connectorAttachments: string[]` to `Agent`; add it to `AgentSchema` (z.array(z.string())); add `SetConnectorAttachmentsInput/Output` hook payload types.
- `store.ts`: `rowToAgent` validates + surfaces `connectorAttachments` (string[] guard, corrupt-row throw mirroring skill_attachments); `create` inserts `'[]'`; `update`/`setWebhookToken`/`setSkillAttachments` return-column lists gain `connector_attachments`; add `setConnectorAttachments(agentId, ids)` to the store interface + impl (wholesale replace, validated ids), mirroring `setSkillAttachments`. Add a `validateConnectorAttachmentIds` (bounded count + MCP_ID_RE-style connector-id slug, dedup) used by the route.
- **Tests** (`store.test.ts`): new rows default to `[]`; `setConnectorAttachments` replaces; corrupt JSONB throws; id validation (count cap, dedup, slug).

### Task 2 — @ax/agents plugin hook + admin route (the write surface)
- `plugin.ts`: register `agents:set-connector-attachments` (actor+agentId+connectorIds → {agent}), mirroring `agents:set-skill-attachments` (not-found + `assertWriteAllowed` ACL).
- `admin-routes.ts`: `serializeAgent` gains `connectorAttachments`; add `PATCH /admin/agents/:id/connector-attachments` handler (admin-only, parse `{ connectorAttachments: string[] }`, validate ids, dedup, call the hook) + register the route. Connector ids are validated for shape; existence is NOT required (a dangling id simply never resolves at session open — same posture as skill_attachments' orphan tolerance + the union's NON-FATAL resolve).
- **Tests** (`admin-routes.test.ts`, `plugin.test.ts`): PATCH persists + returns serialized agent w/ `connectorAttachments`; non-admin → 403; bad ids → 400; hook ACL (owner/admin).

### Task 3 — `agents:resolve` return-schema + return-schemas test
- `return-schemas.test.ts`: assert `connectorAttachments` is in the resolve output schema (drift guard already covers the schema; add the field assertion).

### Task 4 — orchestrator union reads the attachment store (the consumer)
- `orchestrator.ts`: add `connectorAttachments?: string[]` to the `AgentRecord` mirror (I2). Pass `agent.connectorAttachments ?? []` into `resolveEffectiveConnectors`.
- `connector-union.ts`: `resolveEffectiveConnectors(bus, ctx, attachmentIds)` resolves attached ids via `connectors:resolve` as a THIRD source (after defaults + owner's-own), deduped by id, NON-FATAL. Update the header comment (the "FOLLOW-UP" note → "wired here").
- **Tests** (`connector-union.test.ts`): attachments resolve + fold; deduped against defaults/own; a resolve miss is skipped; empty attachments = no change. (`orchestrator.test.ts`): an agent with `connectorAttachments` folds the connector's caps into the spawn.

### Task 5 — AgentForm writes the new store (channel-web UI)
- `lib/admin.ts`: `AdminAgent` gains `connectorAttachments: string[]`; add `patchAgentConnectorAttachments(agentId, connectorIds)` (PATCH the new route), mirroring `patchAgentSkillAttachments`.
- `AgentForm.tsx`: `formFromAgent` reads `a.connectorAttachments ?? []` (not `a.mcpConfigIds`); submit no longer writes connectors into `mcpConfigIds` (sends `mcpConfigIds: []`); after create/update resolves (agent id known), PATCH connector-attachments with the selected ids. The "≥1 tool or ≥1 connector" guard reverts to "≥1 tool" (since `mcpConfigIds` is no longer the connector home and the server rejects empty-empty). Update the file header comment.
- **Tests** (`admin-agents.test.tsx`): edit pre-checks the attached connector from `connectorAttachments`; submit POSTs `mcpConfigIds: []` AND issues the connector-attachments PATCH with the selected ids.

## Phase 5 gate
- `security-checklist` (agent↔connector binding + sandbox reach): a mis-migrated binding could grant/drop reach.
- `shadcn` (AgentForm is channel-web UI).
- `ax-code-reviewer` whole-branch review.

## Boundary review (new hook `agents:set-connector-attachments`)
- **Alternate impl:** a future @ax/agents-git stores agent rows as files; it registers the same hook with the same payload. Storage-agnostic (`connectorAttachments` is opaque connector-id slugs, no backend vocab).
- **Leaky field names:** none. `connectorAttachments: string[]` — connector-id slugs only, no `mcp`/`url`/`transport`/`row`/`bucket`.
- **Subscriber risk:** subscribers key off the connector id; a connector's backing mechanism (MCP/CLI/API) can change without the id changing. No mechanism field on the wire.
- **Wire surface:** the `PATCH /admin/agents/:id/connector-attachments` schema lives in @ax/agents' `admin-routes.ts`, not a central file.
