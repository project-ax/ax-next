# Agent-owned sign-ins — Slice 2b (delete cleanup + boot removal of non-admin connectors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deleted connector leaves nothing behind that a later connector with the same id could inherit:
- agent attachments and exclusions;
- reconnect markers;
- agents' and people's stored sign-ins and keys.

Existing connectors made by non-admins are removed once, at boot, and get the same cleanup.

**Architecture:**
- `connectors:deleted` gains one boolean, `idStillLive`: whether any live connector (any owner, any visibility) still has that id. Subscribers clean up by id only when it's false, so the event never needs to carry an owner.
- `@ax/agents` and `@ax/mcp-oauth` subscribe. Subscribers add no call-graph edge.
- Boot ordering: connectors init runs before agents subscribe. So agents also run an idempotent boot sweep that drops attachment ids with no live connector. They use a new read hook, `connectors:live-ids`, as an optional call; agents→connectors is already an edge.
- The non-admin boot removal lives in connectors init, after the stdio sweep. It uses `auth:get-user` and skips entirely (fail safe) when it can't tell who is an admin.

**Tech Stack:** TypeScript, vitest, Kysely/Postgres (testcontainers).

**Spec:** `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md` §5 Cleanup, §7 Migration step 1. This is slice 2b of the 2a/2b/2c split. **Prerequisites:** slice 1 (PR #969) and slice 2a.

## Global Constraints

- No cross-plugin imports (invariant 2). New edges come only from `subscribes` (not a graph edge) or the existing agents→connectors `optionalCalls`. Connectors must never declare an `agents:*` call (cycle; see the comment at `connectors/src/plugin.ts:~131`).
- Payload names are storage-agnostic: `idStillLive`, `connectorIds`, `live`.
- Subscribers never throw (K10): log and swallow.
- Destructive steps fail toward **keeping** data when they can't be sure: no auth provider, a lookup that throws, or an ambiguous id.
- `credentials:purge-account` accepts scopes `user` and `agent` only (slice 1).
- `export DOCKER_HOST=unix:///var/run/docker.sock`. Run Docker suites one at a time. Use `pnpm --filter <pkg> test` (filter first) plus tsc per package.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01YZ4rcdtzRxcf4xooEWqvx8`.

## Rulings carried in

- From the 2a final review: a shared-connector delete purges stored credentials at **user** scope too, because a deleted connector's per-person keys have no home. This only happens when `idStillLive` is false, so a surviving same-id connector's people keep their keys.
- From slice 1: the boot removal of non-admin connectors must run with purge authority (the equivalent of `purgeGlobal`), so their agents' sign-ins are purged.
- The skills `cap-migration` boot writer is left alone (it touches practically zero rows).

## Review Focus

- **Two owners with the same id, one deleted:** no attachments, markers or sign-ins of the survivor's users or agents are touched.
- **Boot with no `auth:get-user` provider (CLI/canary preset):** no connector is deleted, and one info log says why.
- **An owner whose account no longer exists (`auth:get-user` returns null):** treated as non-admin. Their connectors are removed.
- **A second boot:** removes nothing more, detaches nothing more, and doesn't throw.
- **A deleted connector re-created later with the same id:** an agent that had the old one attached does **not** silently have the new one. The KNOWN EXPOSURE test flips.

---

### Task 1: `idStillLive` on `connectors:deleted`; person-level purge on delete; `connectors:live-ids`

**Files:**
- Modify: `packages/connectors/src/types.ts` (`ConnectorDeletedEvent` ~:391; new `LiveIdsInput`/`LiveIdsOutput`)
- Modify: `packages/connectors/src/store.ts` (a `hasLiveById(connectorId)` helper counting any owner and visibility, plus `liveIds(ids)`)
- Modify: `packages/connectors/src/purge.ts`: compute or receive `idStillLive`, put it on the event, and when it's false and the connector was shared with purge authority, also call `credentials:purge-account {connectorId, scopes: ['user']}`
- Modify: `packages/connectors/src/plugin.ts`: register `connectors:live-ids`; wire `idStillLive` from `deleteConnector` (after the soft-delete) and from the stdio sweep
- Test: `packages/connectors/src/__tests__/hooks.test.ts`, `store.test.ts`, `stdio-sweep.test.ts`, `agent-credential-attachment.test.ts` (person-scope purge round trip)

**Interfaces:**
- Produces:
  - `ConnectorDeletedEvent = { connectorId; toolNamespaces; idStillLive: boolean }`
  - service `connectors:live-ids { connectorIds: string[] } → { live: string[] }`, the subset still live under any owner. Validate the ids against the connector-id grammar, and cap the list at 500.
- `idStillLive` must be computed **after** the soft-delete commits. If the check throws, log and treat it as `true` (keep data).

- [ ] Failing tests:
  - deleting the only `crm` fires `idStillLive: false`;
  - deleting one of two owners' `crm` fires `true`;
  - a shared `crm` deleted with authority and no survivor purges `['agent']` **and** `['user']`, and a survivor blocks both;
  - `connectors:live-ids` returns only live ids and rejects a bad id;
  - the stdio sweep's events carry the flag.
- [ ] Implement.
- [ ] Run `pnpm --filter @ax/connectors test` and tsc until green.
- [ ] Commit: `connectors: deleted event says whether the id is still in use; delete purges people's keys too`.

### Task 2: Agents detach a deleted connector everywhere (+ boot sweep)

**Files:**
- Modify: `packages/agents/src/store.ts`: `removeConnectorEverywhere(connectorId): Promise<{ agents: number }>`, which drops the id from every agent's `connector_attachments` and `connector_exclusions`. It's one statement or one transaction, and leaves rows without the id untouched.
- Create: `packages/agents/src/connector-cleanup.ts`, containing the `connectors:deleted` subscriber and the boot sweep `dropDanglingConnectorIds`.
- Modify: `packages/agents/src/plugin.ts`:
  - manifest `subscribes` gains `connectors:deleted`;
  - `optionalCalls` gains `connectors:live-ids`, with a degradation string;
  - call the boot sweep at the end of init, next to `convertLegacyConnectorDefaults` (~:654).
- Modify: `packages/connectors/src/__tests__/agent-credential-attachment.test.ts`: flip the `KNOWN EXPOSURE` test. After delete-and-recreate, the agent no longer has the connector, so the old row isn't readable. Rename the test to say what's now true.
- Test: `packages/agents/src/__tests__/` (new `connector-cleanup.test.ts`, plus `store.test.ts`), and the agent-keyed-tables guard if it enumerates subscribers.

**Behavior:**
- Subscriber: when `idStillLive === false`, run `removeConnectorEverywhere(connectorId)` and log the count. Do nothing when it's `true` or missing (older payloads).
- Boot sweep:
  - collect every distinct id across all agents' attachments and exclusions;
  - ask `connectors:live-ids` in batches of 500 or fewer;
  - remove the ids that aren't live;
  - when the service is absent or throws, do nothing (log);
  - never throw.

- [ ] Failing tests:
  - the subscriber removes `crm` from three agents' attachments and exclusions;
  - `idStillLive: true` changes nothing;
  - the boot sweep removes a dangling id and keeps live ones;
  - with no `connectors:live-ids` service, nothing changes;
  - the flipped exposure test.
- [ ] Implement.
- [ ] Run `pnpm --filter @ax/agents test`, `pnpm --filter @ax/connectors test` and tsc until green.
- [ ] Commit: `agents: a deleted connector is detached from every agent`.

### Task 3: mcp-oauth drops reconnect markers for a deleted connector

**Files:**
- Modify: `packages/mcp-oauth/src/store.ts`: `deleteMarkersForConnector(connectorId): Promise<{ user: number; agent: number }>`, deleting from both `mcp_oauth_v1_needs_reconnect` and `…_agent` in one transaction.
- Modify: `packages/mcp-oauth/src/plugin.ts`: subscribe `connectors:deleted` and call it when `idStillLive === false` (log, never throw). Manifest `subscribes` becomes `['agents:deleted', 'connectors:deleted']`; update the manifest tests that pin it (`plugin.test.ts:~99, ~112`).
- Test: `packages/mcp-oauth/src/__tests__/store.test.ts`, `plugin.test.ts`.

- [ ] Failing tests:
  - markers for `gmail` on two agents and one person are removed and `linear`'s stay;
  - `idStillLive: true` leaves them in place;
  - a malformed payload is logged and swallowed.
- [ ] Implement.
- [ ] Run `pnpm --filter @ax/mcp-oauth test` and tsc until green.
- [ ] Commit: `mcp-oauth: a deleted connector's reconnect markers go with it`.

### Task 4: Boot removal of connectors made by non-admins

**Files:**
- Create: `packages/connectors/src/non-admin-sweep.ts`
- Modify: `packages/connectors/src/scope.ts`: a system-scoped query listing **live** connectors as `{ ownerUserId, connectorId, visibility, keyMode, capabilities }`. It must go in `scope.ts` (lint I7, like `stdioConnectorRowsForSystemSweep`).
- Modify: `packages/connectors/src/plugin.ts`: call the sweep in init right after the stdio sweep. `auth:get-user` is already an optional call.
- Test: `packages/connectors/src/__tests__/non-admin-sweep.test.ts`

**Behavior:**
- If `bus.hasService('auth:get-user')` is false, log `connectors_non_admin_sweep_skipped {reason:'no-auth-provider'}` and return.
- For each distinct owner, call `auth:get-user {userId}`:
  - `isAdmin === true` → keep that owner's connectors;
  - `null` (account gone) → non-admin;
  - a throw → skip that owner (keep) and log.
- For each live connector of a non-admin owner:
  - **purge first**, via `purgeConnectorState` with full authority: `purgeGlobal: true`, and `purgeAgentSignIns` = no other live shared same-id connector survives the removal;
  - **then soft-delete** through the store, so the tombstone keeps its id;
  - **announce** through the same event, with `idStillLive` computed after the delete.
- Also clear that owner's **authored drafts** for removed ids, if the store has a cheap system-scoped way. Otherwise leave drafts to slice 2c and say so.
- Idempotent: a second boot finds no live non-admin rows. Never throw out of init.

- [ ] Failing tests:
  - an admin's connector survives;
  - a non-admin's private and shared connectors are removed, with purge calls made and events fired with the right `idStillLive`;
  - a null user is treated as non-admin;
  - an `auth:get-user` throw keeps that owner's rows;
  - no auth provider means nothing is removed;
  - a second run is a no-op.
- [ ] Implement.
- [ ] Run `pnpm --filter @ax/connectors test` and tsc until green.
- [ ] Commit: `connectors: remove connectors made by non-admins once, at boot`.

### Task 5: Gate + memory

- [ ] Run the full gate: `pnpm build && pnpm lint && pnpm -r --workspace-concurrency=2 --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.
- [ ] Write the decisions shard: `shard=$(scripts/memory-write-target.sh --shard decisions SIGNINS-3)`. Record:
  - `idStillLive` as the owner-free cleanup signal;
  - the agents boot sweep, needed because connectors init fires before agents subscribe;
  - the person-scope purge on delete;
  - the fail-safe rules of the non-admin sweep.
