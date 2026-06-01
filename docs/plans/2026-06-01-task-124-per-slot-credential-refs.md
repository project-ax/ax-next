# TASK-124 — Per-slot credential refs (settings-unified keystone)

**Date:** 2026-06-01
**Branch:** `auto-ship/TASK-124-per-slot-credential-refs`
**Epic:** settings-unified (`docs/plans/2026-06-01-settings-unified-skills-connectors-credentials-design.md`, "Keystone: per-slot credential refs")

## Problem

Today every connector credential slot resolves to `account:<service>`, where
`service = slot.account ?? connectorId`. A connector that declares two slots that
both omit `account` (or both name the same service) collapses to ONE vault row
`account:<connectorId>` — the two slots overwrite each other. An MCP server that
needs `CLIENT_ID` + `CLIENT_SECRET` distinctly cannot be expressed.

## Approach (back-compat by construction)

Adaptive ref derivation keyed on the connector's slot COUNT:

- **exactly 1 slot** → ref stays `account:<service>` (byte-identical to today; no
  migration; "one key per service" preserved for the common case).
- **≥2 slots** → ref is `account:<service>:<slot>` per slot.

The predicate is `connector.capabilities.credentials.length >= 2`. Every mirror
re-derives it from the connector/proposal it already holds (no shared state).

`Destination`'s `account` variant gains an optional `slot`. `refForDestination`
stays a pure function: `{kind:'account', service, slot}` →
`account:<service>:<slot>` when `slot` is present, else `account:<service>`. The
PRESENCE of `slot` on the destination — set by the caller per the count rule —
is what selects collapse-vs-expand at the ref layer. Slot names are
SCREAMING_SNAKE (`^[A-Z][A-Z0-9_]{0,63}$`, @ax/connectors `SLOT_RE`), so they
carry no colon and append unambiguously; `assertNoColon` guards anyway.

No new service-hook signature: `credentials:{set,get,list,delete}` are unchanged
(the ref STRING is shaped differently). Only `Destination` (+ its 3 mirrors + the
`DestinationSchema` zod) gains optional `slot`.

## Invariants honored

- **I2 (no cross-plugin imports):** `refForDestination`/`deriveCredentialPlan`
  stay re-declared locally in each consumer; `Destination` is `import type` only.
- **I4 (one source of truth):** the canonical `refForDestination` is
  `@ax/credentials/refs.ts`; the 3 copies + `refs-fixtures.ts` are the drift
  guard. The connector plan derivation's canonical copy is
  `@ax/connectors/credential-plan.ts`; `channel-web/lib/connectors.ts` mirrors it.
- **I5 (capabilities/untrusted):** browser-supplied refs/secrets are re-validated
  server-side (`DestinationSchema` + `assertNoColon`); `security-checklist` note
  in the PR.

## Tasks (independent, testable; TDD each)

### Task 1 — `@ax/credentials` canonical: `Destination.slot` + ref derivation + fixtures
- `refs.ts`: add optional `slot?: string` to the `account` variant; in
  `refForDestination`'s `account` case, `assertNoColon('slot', dest.slot)` when
  present and return `account:<service>:<slot>`, else `account:<service>`.
- `refs-fixtures.ts`: KEEP the single-slot `{service:'linear'}` →`account:linear`
  fixture (back-compat byte-identity) and ADD a multi-slot
  `{service:'github', slot:'GITHUB_TOKEN'}` → `account:github:GITHUB_TOKEN`.
- `__tests__/refs.test.ts`: iterate the fixtures; add an explicit byte-identity
  assertion that the single-slot ref equals the literal `'account:linear'` (the
  acceptance "byte-identical to today" test). Add an assertion that a slot with a
  colon throws `invalid-destination-identifier`.
- **Files:** `packages/credentials/src/refs.ts`,
  `packages/credentials/src/refs-fixtures.ts`,
  `packages/credentials/src/__tests__/refs.test.ts`.

### Task 2 — Mirror #2: `credentials-admin-routes/destination-routes.ts`
- Mirror the `account` case in the inlined `refForDestination`.
- Add optional `slot` to the `account` arm of `DestinationSchema` (`.strict()`),
  validated as SCREAMING_SNAKE (`/^[A-Z][A-Z0-9_]{0,63}$/`) to match `SLOT_RE`,
  so a browser-supplied `slot` is bounded.
- `__tests__/refs-drift.test.ts`: iterates `KNOWN_DESTINATION_FIXTURES` — picks up
  the new fixture automatically; confirm green. Add a handler-level test that a
  POST with `{kind:'account', service, slot}` derives the per-slot ref (assert via
  the `credentials:set` spy's `ref`).
- **Files:** `packages/credentials-admin-routes/src/destination-routes.ts`,
  `packages/credentials-admin-routes/src/__tests__/{refs-drift,destination-handlers}.test.ts`.

### Task 3 — Mirror #3: `channel-web/lib/credentials.ts`
- Mirror the `account` case in the local `refForDestination`.
- `__tests__/credentials-refs-drift.test.ts`: iterates fixtures — picks up the new
  fixture automatically; confirm green.
- **Files:** `packages/channel-web/src/lib/credentials.ts`,
  `packages/channel-web/src/__tests__/credentials-refs-drift.test.ts`.

### Task 4 — Canonical connector plan: `@ax/connectors/credential-plan.ts`
- `accountRef(service, slot?)`: `account:<service>:<slot>` when `slot` set, else
  `account:<service>`. `serviceTagForSlot` unchanged.
- `deriveCredentialPlan`: compute `isMulti = connector.capabilities.credentials.length >= 2`;
  each entry `ref: accountRef(serviceTagForSlot(slot, id), isMulti ? slot.slot : undefined)`.
- Add to `CredentialPlanEntry` the structured destination bits the connect-flow UI
  needs WITHOUT string-parsing the ref: `service: string` (the service tag) and
  `slotTag?: string` (present iff the per-slot ref form is used). The UI builds
  `{kind:'account', service, slot: slotTag}` directly.
- `__tests__/credential-plan.test.ts`: single-slot connector → 1 entry, ref
  `account:<service>`, no `slotTag`; two-slot connector (both omitting `account`)
  → 2 distinct entries `account:<id>:<SLOT_A>` / `account:<id>:<SLOT_B>` (the
  collision fix); two-slot with distinct `account`s → per-slot refs on each tag.
- **Files:** `packages/connectors/src/credential-plan.ts`,
  `packages/connectors/src/__tests__/credential-plan.test.ts`. Also update the
  `ResolveOutput` `credentialPlan` consumer if the new fields break the
  `CredentialPlanEntrySchema` (`types.ts`) — add `service`/`slotTag` to the schema.

### Task 5 — Mirror connector plan: `channel-web/lib/connectors.ts`
- Same `accountRef(service, slot?)` + `isMulti` derivation + `service`/`slotTag`
  on `ConnectorCredentialPlanEntry`.
- `ConnectorConnectDialog.tsx`: stop `entry.ref.slice('account:'.length)`; build
  `{kind:'account', service: entry.service, ...(entry.slotTag ? {slot: entry.slotTag} : {})}`.
- `lib/__tests__/connectors-credential-plan.test.ts`: mirror Task 4's cases +
  pin the exact `SHARED_KEY_CONSENT_COPY` (unchanged) still matches.
- **Files:** `packages/channel-web/src/lib/connectors.ts`,
  `packages/channel-web/src/components/settings/ConnectorConnectDialog.tsx`,
  `packages/channel-web/src/lib/__tests__/connectors-credential-plan.test.ts`.

### Task 6 — Orchestrator fold + cards (the READ side)
- `connector-union.ts` `foldConnectorCaps`: compute `isMulti` per connector;
  `ref = account:<service>` collapsed OR `account:<service>:<slot>` per slot.
  Pin in `connector-union.test.ts` (single-slot byte-identical; two-slot distinct
  refs — the collision the fold previously had too).
- `connector-card.ts` `buildAuthoredConnectorCard`: per-slot `account`+`slotTag`
  on each card slot row; `haveExisting` checks the per-slot ref
  (`vaultedRefs.has(account:<service>[:<slot>])`). Pin in `connector-card.test.ts`.
- `orchestrator.ts` `applyAuthoredConnectorGrant` rows (line ~2750): the slot
  `detail` carries enough to write the per-slot ref (the card's write path uses
  it). Verify the approved rows still gate by slot name (the wall is slot-keyed,
  unchanged) — no ref logic in the wall; only the card's credential WRITE changes.
- `skill-broker/tools/request-capability.ts`: the card's slots carry per-slot
  `account`+`slotTag`; `haveExisting` checks the per-slot ref. Mirror the
  `isMulti` derivation across the connectors the skill references (count is
  per-connector). Pin in `skill-broker/__tests__/plugin.test.ts`.
- **Files:** `packages/chat-orchestrator/src/{connector-union,connector-card,orchestrator}.ts`,
  `packages/skill-broker/src/tools/request-capability.ts`, + their tests.

### Task 7 — PermissionCard write paths (the WRITE side, channel-web)
- `PermissionCard.tsx` `approveConnector` + `approveSkill`: the card slot rows now
  carry per-slot `account`+`slotTag` (from Task 6's producers via the SSE frame).
  Build `{kind:'account', service, ...(slotTag ? {slot} : {})}` so the WRITE lands
  in the SAME row the orchestrator fold READS.
- Update the SSE frame shape mirrors (`server/types.ts`,
  `lib/permission-card-store.ts`, `UserSkillsPanelBody.tsx` if it writes slots) to
  carry the per-slot tag fields.
- `__tests__`: a card with a two-slot connector writes two distinct per-slot refs;
  a one-slot connector writes the collapsed ref (back-compat).
- **Files:** `packages/channel-web/src/components/PermissionCard.tsx`,
  `packages/channel-web/src/server/types.ts`,
  `packages/channel-web/src/lib/permission-card-store.ts`,
  `packages/channel-web/src/components/skills/UserSkillsPanelBody.tsx` (if needed),
  + tests.

### Task 8 — Whole-branch gate + verify-before-merge note
- `pnpm build && pnpm test && pnpm lint` (scoped to changed packages for lint).
- Document the "no existing multi-slot connector relies on `account:<connectorId>`"
  check in the PR (verified: no seeded/migration-inserted connectors; all created
  at runtime; single-slot back-compat = zero migration).
- `security-checklist` note: credential write/derivation paths (untrusted
  browser-supplied secrets + refs); supply-chain N/A (no new deps).

## YAGNI pass
- `service`/`slotTag` on the plan entry are load-bearing (the UI must not
  string-parse a `:`-bearing ref into an invalid `account` service). Keep.
- No DB migration — single-slot back-compat means stored rows are untouched. Cut.
- No `connectors:resolve` HTTP route — derivation stays client-side (TASK-109
  precedent). Cut.

## Boundary review (Task 6/7 touch hook payloads, not signatures)
- **Alternate impl:** `Destination` is consumed by `@ax/credentials` (postgres
  vault) and could be backed by a secrets-manager vault — the ref string is the
  opaque key either way. The optional `slot` adds no backend vocabulary.
- **Leaky field names:** none. `slot` is the connector's declared SCREAMING_SNAKE
  capability slot — mechanism-agnostic (an env name OR a header name OR request
  auth, per the connector's transport). No `sha`/`bucket`/`pod_name`.
- **Subscriber risk:** the per-slot ref is still an opaque vault key; subscribers
  never parse it. The card's `account`+`slotTag` are per-request UI hints, never
  persisted on a store type.
- **Wire surface:** `DestinationSchema` (the IPC/HTTP body validator) lives in
  `@ax/credentials-admin-routes` (its own plugin dir) — Task 2 extends it there.
