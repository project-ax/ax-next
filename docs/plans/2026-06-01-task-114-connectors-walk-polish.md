# TASK-114 — Connectors walk polish: re-propose dedup + Vite /settings dev-proxy

Parent: TASK-101 walk-pass. Epic: connectors-first-class.
Design: docs/plans/2026-05-31-connectors-first-class-design.md

Two non-blocking glitches observed during the passing TASK-101 e2e walk. Polish — keep SMALL.

## Item 1 — Re-propose dedup (root-cause fix in `connectors:install-authored`)

**Bug:** during a warm drive turn, the agent re-proposed an ALREADY-ACTIVE connector
unprompted. `connectors:install-authored` reset the authored draft to `pending`, and the
orchestrator's `fireUpfrontConnectorCards` then re-fired the upfront approval card every
turn — even though the promoted registry entry (`connectors_v1_connectors`, TASK-113)
stayed active. (`applyAuthoredConnectorGrant` clears `upfrontConnectorCardsByConv` on
approval, so each warm turn re-evaluates the pending draft and re-cards.)

**Root cause:** `installAuthoredConnector` always (re)writes a `pending` draft, with no
check against the live registry the approval already promoted into.

**Fix (single chokepoint):** in `@ax/connectors` `installAuthoredConnector`, before
upserting the authored draft, check the owner's LIVE registry
(`connectors_v1_connectors`) for an equivalent active connector. If one exists, the
install is a NO-OP: do NOT (re)write/reset the authored draft, and return
`{ connectorId, status: 'active' }`. Otherwise behave exactly as today (write pending
draft, return `status: 'pending'`).

Because no pending draft is re-created, `fireUpfrontConnectorCards` (which filters
`status === 'pending'`) sees nothing to card → no redundant approval card. One fix
covers BOTH acceptance sub-points (no spurious pending draft + no re-card).

**Equivalence rule (simplest-correct, per the card's scoping note):** an active
(not-deleted) registry connector with the SAME connector id, owned by the same user
(`store.getByIdNotDeleted(ownerUserId, connectorId) !== null`). Pure id match — NOT a
capability-fill comparison (that would be a product decision the card says to avoid).

**Wire change:** widen `InstallAuthoredOutput.status` from `'pending'` to
`'pending' | 'active'` (+ its zod `InstallAuthoredOutputSchema`). This is the only
hook-surface change — `status` is already a lifecycle verdict, storage/transport-agnostic,
no leak. `@ax/tool-connector-propose` already passes `out.status` through; widen its
`ConnectorProposeOutput.status` to match so the model learns "already active" (not an
error). No new `calls` edge — the registry read uses the same plugin's `localStore`.

**Security:** dedup only short-circuits when an ALREADY-APPROVED (human-gated) registry
connector exists. A re-propose can never escalate or bypass approval: if there is no
matching active registry connector, the pending-draft + card behavior is unchanged. The
short-circuit grants ZERO new reach (it writes nothing). Run security-checklist (Phase 5).

### Tasks
1. **(TDD, Bug Fix Policy)** Add a failing hook test in
   `packages/connectors/src/__tests__/authored-hooks.test.ts`: seed an active registry
   connector via `connectors:upsert`, then `connectors:install-authored` the same id →
   assert `status: 'active'` AND `connectors:list-authored` shows NO pending draft for it
   (the re-propose is a no-op). Plus a control: re-proposing a DIFFERENT id (no registry
   match) still writes a pending draft. Plus a control: a pre-existing pending draft is
   NOT clobbered/reset when the registry already has it (idempotent no-op).
2. Implement the dedup in `installAuthoredConnector` (pass `localStore` to the handler);
   widen `InstallAuthoredOutput.status` + schema + the tool's `ConnectorProposeOutput.status`.

## Item 2 — Vite dev-proxy `/settings` gap (harness)

The connector approval credential-write POSTs to `/settings/*`; channel-web's Vite dev
proxy (`packages/channel-web/vite.config.ts`) forwards only `/auth`, `/admin`, `/api` to
`AX_BACKEND_URL`. Real deployments are same-origin (unaffected); a local Vite walk needs
`/settings` forwarded too. Add `'/settings'` to the proxy block. Config-only — no test
(mock mode has no `/settings` connector handlers; proxy mode is the walk). Update the
file's header comment for accuracy.

### Tasks
3. Add `'/settings': { target: backendUrl, changeOrigin: false, ws: false }` to the
   `vite.config.ts` proxy block; touch the header comment.

## Gate
`pnpm -F @ax/connectors build && test`, `pnpm -F @ax/tool-connector-propose build`,
`pnpm -F @ax/channel-web build`, lint changed files; whole-branch review (security-checklist).
