# TASK-113 — Promote approved authored connector into the registry

**Branch:** `auto-ship/TASK-113-promote-authored-connector`
**Epic:** connectors-first-class · design `docs/plans/2026-05-31-connectors-first-class-design.md`
**Parent:** TASK-101 e2e walk (attempt 2). Human-approved approach: **PROMOTE-TO-REGISTRY** (one source of truth, invariant #4).

## Problem (from the walk)

Approved AUTHORED connectors (`connectors_v1_authored`) currently never reach the
sandbox NOR the UI. The grant flow (`applyAuthoredConnectorGrant`,
orchestrator.ts:2647) writes approved-caps wall rows + flips the draft
`pending→active`, but:

- `foldConnectorCaps` folds reach only from `resolveEffectiveConnectors` (the
  curated registry `connectors:list` + `connectors:list-defaults`) and
  skill-referenced connectors (`connectors:resolve`). All three read ONLY the
  live registry `connectors_v1_connectors`.
- The 3 UI read paths (Connectors tab, admin Connector catalog, AgentForm
  attachment) read the registry too.

So `ax-connector-creator` → approve → use is broken: the approved connector's
reach is never folded (npx hits npm 403 + reactive wall) and it's
invisible/unattachable in the UI.

The approved-caps wall is about *gating*; it does not itself project reach. The
connector's reach comes from the registry-fed `foldConnectorCaps`. The fix is to
make the approved authored connector land in the registry.

## Approach: PROMOTE-ON-APPROVAL (path A)

On approval (inside `applyAuthoredConnectorGrant`, after the approved-caps rows
are written), call `connectors:upsert` to write the approved draft into the
curated registry `connectors_v1_connectors`, owner-scoped to the grant's
`userId`. The promoted row carries the (TOCTOU-`shown`-narrowed) approved
capability surface + keyMode/name/usageNote, `visibility: 'private'`.

Why this is one source of truth:
- The registry row is authoritative for active connectors. `connectors:resolve`
  already reads ONLY the registry, so the EXISTING `resolveEffectiveConnectors`
  (`connectors:list` + `connectors:resolve`) folds the promoted private
  connector into the sandbox with **zero** changes (verified: connector-union
  reads the owner's `connectors:list` private items).
- The 3 UI read paths read the registry → pick it up unchanged.
- The `connectors_v1_authored` row stays draft/proposal staging only. It is
  flipped `active` for the audit trail (already done) but NOTHING reads the
  authored table for *active-connector reach or UI* — that already holds today,
  so we are NOT adding a second read path. (Invariant #4 preserved.)

Security invariant preserved: reach still comes only from the live registry row.
A pending/unapproved draft is never upserted (promotion happens only inside the
human-gated grant), so it grants ZERO reach.

### Credential ref consistency (invariant #4 / TASK-96)

`foldConnectorCaps` derives the vault ref as `account:<slot.account ?? connectorId>`.
The promoted registry row carries the same `credentials[].account` from the
proposal, so `connectors:resolve` → `deriveCredentialPlan` → `account:<service>`
resolves the SAME vault row the user's connect-flow JIT stored. We carry the
proposal's slots verbatim (the `shown`-narrowed approved set), so the ref the
promoted connector folds matches the wall + the JIT key.

## Tasks

### Task 1 — Promote-on-approval in the orchestrator (TDD; the load-bearing fix)
- File: `packages/chat-orchestrator/src/orchestrator.ts`
- In `applyAuthoredConnectorGrant`, after step 3 (write approved-caps rows) and
  BEFORE step 3b (activate), add a step that calls `connectors:upsert` (bus,
  hasService-guarded, fail-loud — a silent promotion failure reproduces the bug).
  The upsert input:
  - `userId: input.userId`
  - `connectorId: input.connectorId`
  - `name: draft.name`
  - `description: ''` (drafts carry no description; keep empty)
  - `usageNote: draft.usageNote`
  - `keyMode: draft.keyMode`
  - `visibility: 'private'` (owner-scoped; an admin can re-curate to
    shared/default-on later — mirrors cap-migration's safe default)
  - `capabilities`: the **approved** capability surface (the `shown`-narrowed set
    — allowedHosts/credentials/packages, plus mcpServers from the proposal). We
    reuse the already-computed `approvedHosts/approvedCreds/approvedNpm/approvedPypi`
    and the proposal's `mcpServers` so the promoted reach == the approved reach.
- Mirror `connectors:upsert` input shape structurally (I2 — no @ax/connectors
  import), like the existing `ConnectorsListAuthoredOutput` mirror.
- Carry `keyMode`/`usageNote`/`name` from the resolved draft (already on the
  `ConnectorsListAuthoredOutput` mirror — `keyMode`, `usageNote`, `name` present).
- Order: upsert BEFORE activate so a promotion failure leaves the draft pending
  (re-approvable) rather than active-but-unpromoted. (Activate is the audit
  flip; promotion is the load-bearing reach. Fail-loud on upsert error.)
- **Tests (FIRST, per Bug Fix Policy):**
  - promote-on-approval: a grant upserts the connector into the registry with the
    approved caps + keyMode/visibility (would have caught the bug).
  - the `shown` TOCTOU narrowing flows into the promoted caps (a host not in
    `shown` is absent from the upserted capabilities).
  - mcpServers from the proposal ride into the promoted capabilities.
  - not-authored short-circuit (unknown id → no upsert).
  - hasService-guard: no `connectors:upsert` registered → grant still applies
    (back-compat, mirrors the other hasService guards).

### Task 2 — Card precedence: connector card beats reactive wall (TDD)
- File: `packages/channel-web/src/lib/permission-card-store.ts`
- `permissionCardActions.show()` currently blindly replaces any prior card. On a
  warm turn, an upfront `connector` card is clobbered by a same-turn reactive
  `host` (egress-wall) frame, so the user sees the npm wall instead of "Connect
  <service>".
- Fix: in `show()`, if the incoming request is a reactive `host` wall AND a
  `connector` card is already showing, KEEP the connector card (the upfront
  connect card is the actionable one; the wall is downstream of the same missing
  connector). All other transitions replace as before.
- **Tests (FIRST):**
  - a `host` frame does NOT clobber a showing `connector` card.
  - a `connector` frame DOES replace a showing `host` card (connector wins both
    directions).
  - a `host` frame replaces a `host`/`skill` card (unchanged behavior).
  - a `connector` frame replaces a `skill`/`connector` card (unchanged).
- No new shadcn primitives (store-only logic). No UI component change needed; the
  card component already renders whatever the store holds.

## Out of scope / follow-ups
- AgentForm per-agent connector ATTACHMENT store (design Phase 4 other half) —
  already a known follow-up in connector-union.ts; not this card.
- Admin re-curation of a promoted connector to shared/default-on — the upsert
  defaults `private`; admin flips later via the existing management surface.

## Verification
- `pnpm build`, `pnpm test` (filter the two packages), `pnpm lint` on changed
  files — all green.
- Whole-branch review via ax-code-reviewer before PR (inline self-review in
  orchestrated mode — no Task tool).
- security-checklist (untrusted model-authored connector promoted to live reach).
