# TASK-96 — Credentials reach-by-attachment + connector keyMode connect flow

**Status:** Plan (yolo-ship Phase 2)
**Epic:** connectors-first-class
**Design:** `docs/plans/2026-05-31-connectors-first-class-design.md` (Phase 3)
**Branch:** `auto-ship/TASK-96-connector-keymode-connect`

## Problem

A connector declares `keyMode: 'personal' | 'workspace'` (TASK-91 landed the field
on the store). Nothing yet derives *whose key* the connect flow spends from that
field. Per the design:

- `personal` — each user supplies their own key the first time they use the
  connector (the existing JIT `account:<service>` per-user vault). Everyone acts as
  themselves.
- `workspace` — an admin provides ONE key; every allowed agent spends it as a
  shared service identity.

Reach is purely **by attachment** — it derives from the credential SCOPE
(`global | user | agent`) the key binds to. Credentials get **no** public/private
visibility flag. Sharing a key for *use* (workspace mode, or a shared connector)
needs the explicit one-moment consent: "Sharing this key lets their assistant act
as you on Salesforce. They can't copy the key — but they can use it."

## Scope (and what is deferred)

This card is design **Phase 3** (credentials-side connect semantics). The design's
**Phase 4** (orchestrator union, `AgentForm` connector-attachment, replacing the
MCP-ID list) and **Phase 5** (connect-flow UI) are SEPARATE later cards.
Connectors remain half-wired (nothing consumes `connectors:resolve` yet) — that
window is open by design.

Therefore this card delivers the keyMode→credential mapping + consent gate as a
**genuinely-wired, tested extension of the already-live `connectors:resolve`
hook** — the documented future routing entry point — NOT a new UI surface and NOT
a helper nothing calls (which would be half-wired infra).

## The derivation (reach-by-attachment)

For a resolved connector, derive one **credential plan entry per declared
credential slot** in its `capabilities.credentials`:

| keyMode | credential scope | ref | derived reach |
|---|---|---|---|
| `personal` | `user` | `account:<service>` | private — that user's key, act-as-self |
| `workspace` | `global` | `account:<service>` | the company key — every allowed agent spends it |

- `<service>` = the slot's existing `CapabilitySlot.account` when set, else the
  connector `id`. Both modes use the SAME `account:<service>` ref shape — only the
  SCOPE differs. (Design open-Q #1 lean: share by service; reuses the JIT vault key
  the rest of the system already binds via `applyCapabilityGrant`.)
- A connector with zero credential slots → empty plan (still resolves; nothing to
  prompt).

## Consent gate

`requiresSharedKeyConsent` is true iff the resolved key becomes spendable by an
identity the keyholder doesn't solely control:

- `keyMode === 'workspace'` (one key, every allowed agent spends it), OR
- `visibility === 'shared'` (bound to a shared/team agent).

`personal` + `private` → false (you only ever act as yourself).

The copy is exported so the future connect surface renders it and a test pins it:
`SHARED_KEY_CONSENT_COPY` (template) + `sharedKeyConsentMessage(service)`.

## Tasks

### Task 1 — derive module + `connectors:resolve` extension (`@ax/connectors`)
- New `src/credential-plan.ts`:
  - Local `CredentialScope = 'global' | 'user' | 'agent'` re-declared (I2 — no
    `@ax/credentials` import).
  - `serviceTagForSlot(slot, connectorId): string` — `slot.account ?? connectorId`.
  - `accountRef(service): string` — `account:${service}` (re-derived locally, same
    posture as `applyCapabilityGrant`).
  - `deriveCredentialPlan(connector): CredentialPlanEntry[]` — maps keyMode→scope
    over `capabilities.credentials`.
  - `requiresSharedKeyConsent(connector): boolean`.
  - `SHARED_KEY_CONSENT_COPY` constant + `sharedKeyConsentMessage(service)`.
- Extend `ResolveOutput` (types.ts) with `credentialPlan: CredentialPlanEntry[]`
  and `requiresSharedKeyConsent: boolean`; extend `ResolveOutputSchema`.
  `CredentialPlanEntry = { slot: string; scope: 'user' | 'global'; ref: string }`.
- `resolveConnector` (plugin.ts) populates both new fields from the derive module.
- Export the new public types + the consent copy from `index.ts`.
- **Boundary review:** new fields are storage-agnostic (`slot`/`scope`/`ref`/
  `credentialPlan`/`requiresSharedKeyConsent`). `scope` values are the neutral
  credential-scope contract, NOT backend vocab. No `transport`/`command`/`url`/`mcp`.
- Tests (test-first): `credential-plan.test.ts` (unit — both branches, account-tag
  fallback, empty slots, consent gate truth table, copy formatter); extend
  `hooks.test.ts` resolve cases (personal→user, workspace→global, consent flag).

### Task 2 — leak-guard: connectors hook surface still has no leaked field; resolve adds only neutral fields
- Extend `leak-guard.test.ts`: `credentialPlan` / `requiresSharedKeyConsent` are
  present on the resolve shape and carry no leaky first-class mechanism field;
  `scope`/`ref`/`slot` are allowed.

### Task 3 — no-visibility-flag guard (`@ax/credentials`)
- New `src/__tests__/no-visibility-flag.test.ts`: assert the `credentials:set`
  input contract and `credentials:list` output (`CredentialMeta` /
  `CredentialsListOutputSchema`) carry NO `visibility`/`public`/`private`/`shared`/
  `reach` field — reach derives from `scope` alone (card acceptance #2). Pins the
  invariant so a future change that adds a visibility column reds here.

## Out of scope (handoff follow-ups)
- Phase 4: orchestrator union for connectors; `AgentForm` connector-attachment
  replacing the MCP-ID list; standalone "MCP servers" form → connector registry.
- Phase 5: connect-flow UI (connector tile, `keyMode`-aware prompt, the consent
  moment rendered) — consumes `requiresSharedKeyConsent` + `SHARED_KEY_CONSENT_COPY`.
- Wiring `connectors:resolve`'s credential plan into the credential-proxy /
  sandbox-spawn path (Phase 5 design note: "resolving slots through the connector").
