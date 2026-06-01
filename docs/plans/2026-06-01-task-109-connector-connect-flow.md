# TASK-109 — User-facing connector connect flow (keyMode JIT vs shared-key consent)

**Branch:** `auto-ship/TASK-109-connector-connect-flow` · **Base:** `main`
**Design:** `docs/plans/2026-05-31-connectors-first-class-design.md` (Phase 3, the UI half)
**Predecessors merged:** TASK-96 (`credentialPlan`/consent derivation in `@ax/connectors`),
TASK-99 (Connectors tab + tiles, no connect action), TASK-112 (authored-connector
PermissionCard — a *different* surface).

## Problem

`ConnectorsTab.tsx` lists connectors with a hard-coded "connected" dot and **no
Connect action**. The user can't actually connect a service. Wire the connect
handshake driven by `keyMode`:

- **`personal`** → prompt **this** user for their own key (per-user JIT,
  `account:<service>` vault, `scope:'user'`). Everyone acts as themselves.
- **`workspace`** → an **admin** stores **one** shared company key
  (`scope:'global'`), gated behind the explicit shared-key consent moment.

"Connected / not" must reflect **real credential presence** (TASK-96: reach derives
from scope; ref = `account:<slot.account ?? connectorId>`).

## Key facts (from exploration)

- **No `connectors:resolve` HTTP route** — only the 5 `/admin/connectors[/:id]` CRUD
  routes. `getConnector(id)` returns the full `Connector` (with `capabilities`), so the
  credential plan + consent gate are derived **client-side** from that object.
- **Cross-plugin runtime import of `@ax/connectors` is forbidden** (lint: not on the
  allowlist; `@ax/credentials` IS). So the TASK-96 derivation
  (`deriveCredentialPlan` / `requiresSharedKeyConsent` / `sharedKeyConsentMessage` /
  `accountRef` / `serviceTagForSlot`) is **re-declared locally** in
  `lib/connectors.ts`, mirroring the existing `refForDestination` re-declaration in
  `lib/credentials.ts`. A code comment names `@ax/connectors/credential-plan.ts` as the
  source of truth; a unit test pins the behavior + the exact consent copy string.
- **Write paths already exist** (`lib/credentials.ts`): `setDestinationCredential` →
  `/settings/destinations/account/credential` (scope `user`, server forces ownerId) for
  personal; `/admin/destinations/account/credential` (`requireAdmin`, scope `global`) for
  workspace. **No new wire surface.**
- **Presence detection** mirrors `CredentialSlotRow`: `myCredentials.list()` (user) /
  `adminCredentials.list()` (global), match `c.ref === ref && c.scope === planScope`.
  The user list only returns the actor's own creds → ref+scope match is sufficient
  (the JIT account flow already writes with `ownerId:null`).
- **Reuse `CredentialSlotForm`** (password input + save) for key entry.
- `Dialog` shadcn primitive is installed.

## Tasks (independent, testable)

### Task 1 — `lib/connectors.ts`: client-side credential-plan + consent derivation
Re-declare (local, no runtime cross-plugin import — I2):
- `accountRef(service)`, `serviceTagForSlot(slot, connectorId)`
- `deriveCredentialPlan(connector): { slot, scope:'user'|'global', ref }[]`
- `requiresSharedKeyConsent(connector): boolean`
- `SHARED_KEY_CONSENT_COPY` + `sharedKeyConsentMessage(service)`

These need `Connector` (full, with `capabilities`), already exported here.
Add a unit test `lib/__tests__/connectors-credential-plan.test.ts` pinning:
keyMode→scope, ref shape, empty-plan for no-creds, consent-gate truth table
(personal+private→false, workspace→true, shared→true), and the EXACT consent copy
string (security-relevant contract).

### Task 2 — `ConnectorConnectDialog.tsx`: the keyMode-aware connect flow
New component composing shadcn `Dialog` + `CredentialSlotForm` + `Alert`/`Button`:
- Loads the full connector (`getConnector`) on open → derives the plan.
- **Empty plan** (no credential slots, e.g. MCP-no-key): "Nothing to connect — this
  service needs no key", connected immediately.
- **`requiresSharedKeyConsent` true** → a **blocking** consent step rendering
  `sharedKeyConsentMessage(name)`; the key-entry form is NOT reachable until the user
  clicks "I understand". Must not be bypassable (security — Phase 5).
- **`workspace` + non-admin** → can't store the global key (admin route is admin-gated);
  surface "an admin provides this shared key" instead of a raw 403. (`isAdmin` prop.)
- Per slot: `CredentialSlotForm` with `destination={{kind:'account', service}}`,
  `scope={{ scope: planScope, ownerId: null }}`.
- `onConnected` callback re-checks presence so the tile flips to connected.

### Task 3 — wire the Connect action into `ConnectorsTab` tiles + real connected-state
- Replace the hard-coded "connected" dot with **derived** state: on list load, for each
  connector fetch presence for its plan refs (batch the two credential lists once) and
  show connected iff every plan slot has a stored credential (empty plan → connected).
- Add a "Connect" / "Reconnect" Button to each tile opening `ConnectorConnectDialog`.
- Keep the diff minimal in the shared tile area (siblings TASK-107/108 touch it).
- Extend `ConnectorsTab.test.tsx`: personal connector prompts a per-user key (user
  route); workspace connector shows the consent gate before the key form; connected
  vs not reflects credential presence.

## Out of scope / follow-ups
- Per-agent connector attachment (design Phase 4 other half — deferred card).
- Disconnect/clear from the tile (clear exists in `lib/credentials.ts` but the connect
  flow only needs set; a "Disconnect" affordance is a follow-up if wanted).
- A `connectors:resolve` BFF route (not needed; `getConnector` carries capabilities).

## Security note (Phase 5 — security-checklist)
Touches credential entry/storage + per-user vs shared scope + the consent gate.
The gate must be non-bypassable; the workspace write must stay admin-gated server-side
(UI hiding is convenience, the gate is the `requireAdmin` on `/admin/destinations`).
No secret value ever rendered/logged; key entry is a password field, written base64.
