# Fold credentials into connectors; remove the Credentials tab

**Date:** 2026-06-01
**Status:** Design — approved in brainstorm, pending spec review
**Author:** Vinay + Claude

## Problem

The Settings area has three user-facing tabs: **Skills**, **Connectors**, **Credentials**. The
separate **Credentials** tab is confusing: it's a second surface for entering keys that the
**Connectors** tab already handles. Clicking **Connect** on a connector
(`ConnectorConnectDialog`) already renders a key field per credential slot and writes the secret
straight to the vault, with scope (personal vs shared) and the shared-key consent gate derived
from the connector. The Credentials tab (`KeysTab`) duplicates that, plus shows a flat list of
all stored keys including leftovers that no longer have a clear home.

The fix: make the **connector the single home for its keys**. Remove the Credentials tab.

## Decisions (from brainstorm)

1. **Remove the Credentials tab entirely.** The Connectors tab becomes the one place to enter,
   see-status, replace, and remove a connector's keys.
2. **Each connector owns its own key(s) — no sharing.** Drop the optional "share key by service"
   (`account`) tag. A key is keyed by the connector id, so two connectors that want the same
   token each store their own copy. This is the user's explicit preference, and it also
   eliminates the purge-safety problem (see below).
3. **Purge on delete.** Deleting a connector also purges its stored key(s), so a secret can never
   linger with no UI home. Because keys are no longer shared, the purge is unconditional and
   needs no reference counting.
4. **No data migration.** A connector that set a custom `account` tag will read "needs a key"
   once and the user re-enters it (one-time). Sharing was a seldom-used optional field and this
   is pre-GA, so a migration script isn't worth it.

## Why "no sharing" is safe (verification)

Connectors are the **sole** consumer of `account:<service>` credential refs:

- Skills stopped declaring credential slots in TASK-100; their reach is the connectors they
  reference. `GET /api/chat/account-usage` (the old "used by skills" hint) already returns an
  empty map by design (`packages/channel-web/src/server/routes-connections.ts:535`).
- `getAccountUsage` (`packages/channel-web/src/lib/connections.ts:171`) is connector-only and
  backed by that now-empty endpoint.

So removing the share-by-service tag breaks nothing outside the connector surface.

## Data model

A connector declares credential slots in `capabilities.credentials`
(`packages/connectors/src/types.ts`, `CapabilitySlotSchema`):

```ts
const CapabilitySlotSchema = z.object({
  slot: z.string(),                 // machine name (env var / header)
  kind: z.literal('api-key'),
  description: z.string().optional(),// human label
  account: z.string().optional(),   // share-by-service tag  ← REMOVE
});
```

The credential plan (`packages/connectors/src/credential-plan.ts`) derives, per slot, the vault
ref the proxy resolves:

```ts
export function serviceTagForSlot(slot: CapabilitySlot, connectorId: string): string {
  return slot.account !== undefined && slot.account.length > 0 ? slot.account : connectorId;
}
// deriveCredentialPlan: single-slot → account:<service>; multi-slot → account:<service>:<slot>
```

**Change:** `serviceTagForSlot` always returns `connectorId`. The ref builder
(`packages/credentials/src/refs.ts:49`) is unchanged — `service` is a free string, so
`account:<connectorId>` and `account:<connectorId>:<SLOT>` are valid by construction. Multi-slot
connectors keep the per-slot ref form, so each slot lands in a distinct row — **no collision**.
The bare-account/per-slot collapse rule (`credentials.length >= 2 → per-slot`) stays as-is.

This derivation is **duplicated** (invariant #2 — no cross-plugin import): the server copy in
`connectors/src/credential-plan.ts` and the client re-declaration in
`channel-web/src/lib/connectors.ts:295`. **Both must change identically**, or the connect-flow
WRITE and the host-resolver READ drift apart.

## Changes

### Backend — `@ax/connectors`

1. **Drop the `account` tag.** Remove `account` from `CapabilitySlotSchema`
   (`src/types.ts`), the authored-connector assembly (`src/plugin.ts:489`), and
   `serviceTagForSlot` (always `connectorId`). Client mirror in
   `channel-web/src/lib/connectors.ts` changes identically.

2. **Purge on delete.** `deleteConnector` (`src/plugin.ts:394`, behind `connectors:delete` /
   `DELETE /admin/connectors/:id` + `/settings/connectors/:id`) currently only soft-deletes the
   row. New behavior: load the connector, derive its credential plan, soft-delete, then for each
   plan entry call `credentials:delete` with `{ scope, ownerId, ref }`:
   - `scope`/`ref` come from the plan entry.
   - `ownerId`: user scope → the deleting `userId`; global scope → `null`.
   - Guard with `bus.hasService('credentials:delete')`; declare it as an **optionalCall** in the
     manifest (degradation: "the connector is deleted but its stored key is left in the vault" —
     a preset without `@ax/credentials` still deletes the connector). Add to `manifest.calls`
     only if we decide it's hard; default is optionalCall + hasService guard, matching the
     existing `credentials:list` soft-dep posture.
   - `credentials:delete` (`packages/credentials/src/plugin.ts:625`) takes
     `{ scope, ownerId, ref }` and writes a tombstone (empty encrypted blob). Row-by-row; no bulk
     delete exists, so we loop the plan.

   Security: this is cross-plugin credential deletion → run the `security-checklist` skill and
   include the structured PR note. The purge only ever targets the deleted connector's own refs
   at the scope the connector declares; a personal connector can only purge the deleting user's
   own (`scope:user`, `ownerId:userId`) rows; a workspace connector's global purge is reachable
   only on the admin delete route (already `requireAdmin`).

### Backend — `@ax/credentials`

No change. `credentials:delete` already exists with the right shape.

### Frontend — `@ax/channel-web`

1. **Remove the Credentials tab.** Delete `components/settings/CredentialsTab.tsx` and
   `components/settings/KeysTab.tsx`. Drop `'credentials'` from `AdminTabId`
   (`components/admin/AdminSidebar.tsx`), from `TAB_META` (`components/admin/AdminShell.tsx`),
   and its routing/render branch. Provider/AI-model keys tab (`providers` / `ProvidersPanel`) is
   untouched.

2. **Simplify the connector form.** `components/settings/ConnectorEditDialog.tsx` slot rows lose
   the "Share key by service (optional)" field → each row is **Label** + **Machine name** only.
   Update `lib/connector-form.ts` (`slotToRow` / row→slot) to drop `account`.

3. **Grow the Connect dialog from *enter* to *manage*.**
   `components/settings/ConnectorConnectDialog.tsx` currently hardcodes `current={{ set: false }}`
   for every slot. Change it to read per-slot presence on open (the connector's plan refs vs the
   user/global credential list — the same presence check `ConnectorsTab` already does) and pass
   real `current={{ set }}` into each `CredentialSlotForm`, so a stored slot shows
   **Replace / Remove** (via the form's existing `onSaved` / `onCleared`) and an empty slot shows
   **enter**. Removing a key flips the tile back to "needs a key" via the existing
   `onConnected`/`refreshConnectedState` path.

4. **Relabel the connected-shelf action.** In `ConnectorsTab.tsx` `renderTile`, the connected
   button "Reconnect" becomes **"Manage"** (it now manages keys, not just re-enters). Available
   stays **"Connect"**.

5. **Prune dead client code.** Remove `getAccountUsage` (`lib/connections.ts:171`) and its usages
   (it only fed the removed KeysTab "used by" hint), and the now-unused account-usage route
   (`server/routes-connections.ts` `accountUsage` + its registration) — it already returns empty.
   Remove any `myCredentials`/`adminCredentials` imports orphaned by the KeysTab deletion (keep
   the ones `ConnectorsTab` still uses for presence).

## Testing

### Backend (`@ax/connectors`)
- `deriveCredentialPlan` always keys by connector id (single + multi slot); multi-slot yields
  distinct per-slot refs (no collision); the old `account` tag, if present on legacy data, is
  ignored.
- `connectors:delete` purges every slot's ref at the correct `(scope, ownerId)`; a personal
  connector purges `scope:user`/`ownerId:userId`, a workspace connector purges
  `scope:global`/`ownerId:null`.
- `credentials:delete` absent (`hasService` false) → delete still soft-deletes the connector and
  does not throw (degraded path).
- Bug-Fix-Policy: a regression test that deleting a connector leaves no resolvable key for its
  refs.

### Frontend (`@ax/channel-web`)
- `ConnectorEditDialog` slot rows have no share-by-service field; round-trips Label + Machine
  name only.
- `ConnectorConnectDialog` shows **Replace/Remove** for a slot with a stored key and **enter**
  for an empty one (driven by mocked presence); removing a key calls the clear path and triggers
  `onConnected`.
- No `credentials` entry in the settings nav (`AdminSidebar`/`AdminShell`); the Credentials route
  no longer renders.

## Security & invariants

- **Invariant #5 (capabilities minimized):** purge only touches the deleted connector's own refs
  at its own scope; no widening. `security-checklist` PR note required (cross-plugin credential
  deletion).
- **Invariant #2 (no cross-plugin import):** `@ax/connectors` calls `credentials:delete` through
  the hook bus; the client re-declares the plan derivation rather than importing `@ax/connectors`.
- **Invariant #4 (one source of truth):** a connector's keys are addressed solely by its id;
  removing sharing removes the only cross-connector coupling.
- **Boundary review:** no new service-hook *signature* is introduced (`credentials:delete`
  already exists); `@ax/connectors` adds it as an optionalCall. Note this in the PR.

## Out of scope

- Provider / AI-model keys (separate admin tab, unchanged).
- MCP / routine reserved credential kinds (not user-facing).
- Cross-owner workspace connector catalog (still owner-scoped).
- A data-migration script for legacy `account`-tagged connectors (accepted one-time re-entry).
  Caveat (no migration): the connector now resolves to `account:<connectorId>`, so a key that was
  stored under the old `account:<tag>` row is left orphaned in the vault — no UI home, and not
  reached by purge-on-delete (which now targets `account:<connectorId>`). The ironic flip side of
  the purge feature, accepted pre-GA because the `account` tag was a seldom-used optional field;
  an operator who used it can clear the stray row out-of-band.

## Open questions

None outstanding. (Migration deliberately skipped; relabel "Reconnect"→"Manage" approved.)
