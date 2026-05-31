# TASK-94 — install_authored_connector hook + one-card approval gate

**Status:** Plan
**Branch:** auto-ship/TASK-94-install-authored-connector
**Epic:** connectors-first-class (design 2026-05-31-connectors-first-class-design.md, Phase 2)

## Problem

An agent must be able to author a connector draft and submit it for approval,
mirroring the authored-skill flow. `install_authored_connector({connectorId,
name, hosts, slots, packages, mcpServers, usageNote, keyMode})` produces ONE
approval card declaring the connector's network reach + credential slots +
binaries. Nothing reaches the outside world until a human approves
(invariant #5), reusing the TASK-93 capability-approval wall. On approval the
connector activates.

## Scope (this card) vs siblings

- **TASK-94 (this):** the host-side data plane — the `install_authored_connector`
  hook (persist a PENDING draft, zero reach), the orchestrator's ONE-card fire
  for pending connector drafts, and the approval-gate grant hook (write
  connector-subject approved-caps rows via the TASK-93 wall + flip
  pending→active).
- **TASK-95 (sibling, To Do):** the `ax-connector-creator` builtin SKILL.md that
  *drives* the hook + the runner-side `install_authored_connector` sandbox tool
  executor + its IPC action. We expose the host hook + an IPC action seam they
  plug into, but the builtin/runner executor is their card.
- **TASK-97 (sibling, In Progress):** the orchestrator union that *resolves an
  ACTIVE connector into the sandbox* (projects reach). We only flip a draft to
  active + record the grants; TASK-97 reads them.
- **TASK-99 (sibling, To Do):** the agent-centric Skills/Connectors/Credentials
  React UI + the channel-web permission-decision route's connector branch. We
  emit the card PAYLOAD on the bus (`chat:permission-request`) and expose the
  host grant hook; rendering + the HTTP decision route is theirs.

Rationale: the acceptance criteria are all host-data-plane + testable at the
hook level (draft→card→approve→active; not-approved→no-reach; idempotency;
clear). Pulling the React card / HTTP route in would duplicate TASK-99; the
sandbox tool executor would duplicate TASK-95. The host hook + card-fire is the
fully-wired, non-half-wired cohesive unit.

## Predecessor learnings folded in

- TASK-91: `connectors_v1_connectors` is the LIVE registry; authored drafts are a
  distinct lifecycle → a dedicated `connectors_v1_authored` side-table (mirrors
  `skills_v1_authored` vs `skills_v1_skills`). Backing-mechanism vocab stays
  inside the opaque `capabilities` JSONB; no first-class transport/url/mcp field.
- TASK-93: the approved-caps wall is connector-ready — `skills:approved-caps-set`
  accepts an optional `connectorId` subject. EXTEND it (do not fork). NOTE:
  `approved-caps-set` rejects `kind:'mcp'` ("not yet supported"), so mcp grants
  are deferred from the card (same as the authored-skill card excludes mcp).
- TASK-92: connector-id grammar `/^[a-z0-9][a-z0-9_-]*$/`, ≤128 chars (mirror the
  store's `validateConnectorId`).
- TASK-91 GOTCHA: a new cross-package reference in presets/k8s needs the project
  ref in BOTH root tsconfig.json AND presets/k8s/tsconfig.json; verify with a
  filtered build.

## Tasks

### T1 — `@ax/connectors`: authored-connector draft store + migration

`connectors_v1_authored` keyed `(owner_user_id, agent_id, connector_id)`:
columns `name`, `usage_note`, `key_mode` (CHECK personal|workspace),
`capability_proposal` JSONB (the declared `Capabilities`), `status` (CHECK
pending|active), timestamps. Additive `IF NOT EXISTS` migration in
`migrations.ts`; add `ConnectorsAuthoredRow` + extend `ConnectorDatabase`.

New `authored-store.ts` (mirror `skills/authored-store.ts`):
- `upsertAuthored(input)` — last-write-wins per (owner, agent, connectorId);
  always lands `status:'pending'`; returns `{created}`.
- `listAuthored(ownerUserId, agentId)` — all drafts, sorted by connector_id.
- `activateAuthored({ownerUserId, agentId, connectorId})` — status-guarded
  pending→active flip; idempotent; returns `{activated}`.
- `clearAuthored({ownerUserId, agentId, connectorId})` — delete the draft
  (reject/clear path); returns `{cleared}`.
Validate `capability_proposal` against `CapabilitiesSchema` on read (don't trust
the DB). Scope helper for the multi-row read (lint `no-bare-tenant-tables`).

### T2 — `@ax/connectors`: install/list/activate/clear hooks + types

`types.ts` adds storage-/mechanism-agnostic hook I/O:
- `InstallAuthoredInput {ownerUserId, agentId, connectorId, name, hosts[],
  slots[], packages?, mcpServers?, usageNote?, keyMode}` →
  `InstallAuthoredOutput {connectorId, status:'pending'}`. The handler assembles
  a `Capabilities` proposal from the flat args (hosts→allowedHosts,
  slots→credentials, packages, mcpServers) and persists a pending draft. Bound +
  validated at the boundary (slot grammar, host non-empty, id grammar, keyMode).
- `ListAuthoredInput {ownerUserId, agentId}` → `ListAuthoredOutput {drafts:
  AuthoredConnectorDraft[]}` where a draft carries `{connectorId, name,
  usageNote, keyMode, status, proposal: Capabilities}` (the card + grant source).
- `ActivateAuthoredInput {ownerUserId, agentId, connectorId}` →
  `{activated:boolean}`.
- `ClearAuthoredInput {ownerUserId, agentId, connectorId}` → `{cleared:boolean}`.

`plugin.ts` registers `connectors:install-authored`, `connectors:list-authored`,
`connectors:activate-authored`, `connectors:clear-authored` with return schemas.
`index.ts` exports the new types/schemas.

**Zero-reach invariant:** `connectors:resolve` (TASK-91) reads only
`connectors_v1_connectors` (the LIVE table) — a pending authored draft lives in
`connectors_v1_authored` and is NEVER returned by resolve. Pin with a test.

### T3 — Orchestrator: fire ONE connector approval card at session-open

Mirror the authored-skill card block (orchestrator.ts ~1595, ~2007):
- At session-open, if `bus.hasService('connectors:list-authored')`, resolve the
  agent's pending connector drafts (best-effort try/catch → []).
- New pure `connector-card.ts` (sibling of `authored-card.ts`):
  `buildAuthoredConnectorCard({connectorId, name, proposal}, vaultedRefs)` →
  `{kind:'connector', connectorId, name, hosts, slots, packages, authored:true}`
  or null when the shown delta is empty (mcp excluded — deferred). Reuse the
  `hasShownDelta`/dedup-key shape. Dedup per (conversation, connectorId, delta)
  via `upfrontConnectorCardsByConv`.
- Fire `chat:permission-request` with the connector card payload.

### T4 — Orchestrator: `agent:apply-authored-connector-grant` (the approval gate)

Register a new host service hook mirroring `agent:apply-authored-capability-grant`:
- Input `{userId, agentId, connectorId, conversationId?, shown?}` → `{applied,
  reason?}`.
- Re-resolve the draft via `connectors:list-authored` (host-authoritative;
  unknown id → `{applied:false, reason:'not-authored'}`).
- Build approval rows from the proposal (host/slot/npm/pypi; mcp deferred), apply
  the `shown` TOCTOU intersection guard (copy the skill path's logic).
- Write each row via `skills:approved-caps-set` with `{connectorId}` subject
  (TASK-93 wall) — fail-loud (propagate). hasService-guarded.
- Flip the draft active via `connectors:activate-authored`. hasService-guarded.
- If a conversation is present and a credential slot was approved, retire the
  warm session (re-spawn next turn) — reuse `activeAliveSession`. No conversation
  → rows + activate are the whole effect.
- Drop the per-conversation card dedup for the connector.

### T5 — Wiring: presets/k8s + orchestrator manifest + tsconfig refs

- `connectors:install-authored` / `list-authored` / `activate-authored` /
  `clear-authored` are registered by `@ax/connectors` (already in the k8s preset).
- Orchestrator: register `agent:apply-authored-connector-grant`; its
  `connectors:list-authored` / `connectors:activate-authored` /
  `skills:approved-caps-set` peers stay OUT of `calls` (hasService-gated, same
  convention as the authored-skill grant peers). No manifest `calls` churn.
- IPC seam for TASK-95: add a `connector.install-authored` IPC action schema +
  handler in @ax/ipc-protocol/@ax/ipc-core ONLY IF it does not strand as
  half-wired. DECISION: defer the IPC action to TASK-95 (it owns the sandbox
  tool executor that posts it); a handler with no runner caller would be
  half-wired here. The host `connectors:install-authored` hook is the seam.
- Verify presets/k8s build with a filtered build (TASK-91 gotcha) — but note we
  add no NEW package, only new hooks on the already-wired @ax/connectors, so no
  tsconfig ref change is expected. Confirm.

### T6 — Tests (Bug Fix Policy / acceptance)

- `@ax/connectors`: authored-store (upsert pending, list, activate idempotent,
  clear), install-authored hook (proposal assembly + validation rejects), the
  resolve-doesn't-see-pending zero-reach test, leak-guard (no backend vocab in
  hook fields).
- Orchestrator: connector card fires once per pending draft (dedup); grant writes
  connector-subject approved-caps rows + flips active + not-authored fallback +
  shown TOCTOU intersection; idempotent re-grant.
- Return-schema drift test for the new connectors hooks.

## Boundary review (T2/T4 new hooks) — answered in PR body

- Alternate impl: `@ax/connectors-sqlite` registers the same `connectors:*`
  hooks; the orchestrator grant could be a direct call iff connectors+skills+orch
  were one plugin (they're separate → must cross the bus, I2).
- Leaking fields: none. `hosts/slots/packages/mcpServers/keyMode/usageNote/
  status/connectorId/agentId` are mechanism- and storage-agnostic; backing vocab
  (transport/command/url) stays inside the `Capabilities`/`mcpServers` spec.
- Subscriber risk: a subscriber keys off connectorId + declared
  credentials/allowedHosts, never "is this MCP?".
- Wire surface: the `connectors:*` hook schemas live in @ax/connectors; no IPC
  action added here (deferred to TASK-95).

## Out of scope / follow-ups

- TASK-95: sandbox `install_authored_connector` tool executor + IPC action +
  `ax-connector-creator` builtin (the hook's caller).
- TASK-99: React connector PermissionCard + channel-web permission-decision
  connector branch (the card's HTTP approval entry point + rendering).
- mcp-kind approved-caps (the wall rejects `kind:'mcp'`); card excludes mcp.
