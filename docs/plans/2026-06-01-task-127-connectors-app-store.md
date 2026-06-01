# TASK-127 — Connectors tab → app-store (Connected / Available) + inline admin curation + self-connect/consent

**Date:** 2026-06-01
**Epic:** settings-unified
**Design:** `docs/plans/2026-06-01-settings-unified-skills-connectors-credentials-design.md`
**Branch:** `auto-ship/TASK-127-connectors-app-store`

## Problem statement

Rebuild the Settings → Connectors tab as an app-store split (Connected vs Available, mirroring Skills' Installed/Not-installed), fold the (now-orphaned) admin Connector Registry CRUD inline gated on `isAdmin`, and let a non-admin self-connect a connector from the Available shelf with the existing capability-consent card. The standalone Connector Registry nav surface is already gone (TASK-125); this card folds its curation logic inline.

## Key scope resolution (logged in decisions.md)

The connector data model is **owner-scoped at every layer** — `connectors:list` / `listForUser` / `listDefaults` all key on `userId`; there is no cross-owner workspace-catalog table (unlike Skills, which has catalog-tier/catalog-routes/user-attachments). The design's decomposition explicitly **defers** the new shared-connector catalog wire surface (design line 45) and the open question (line 154) anticipated this.

Therefore:
- **Connected** = an owned connector where every credential-plan slot has a stored key (the existing `connected==='connected'` derivation).
- **Available** = an owned connector still missing a key (`disconnected`/`unknown`) → **Connect**.
- **Self-connect** = connecting an owned-but-unconnected connector via the existing `ConnectorConnectDialog` (which already renders the credential plan + the blocking shared-key consent gate). No new attach hook, no new consent component, no new wire surface.
- **Admin curation** = the folded `ConnectorRegistry` CRUD (New / Edit / set-default / Delete + Test), rendered inline only when `isAdmin`. Catalog/shared connectors are read-only for non-admins (badge + Connect/Reconnect only).

This is faithful to the card's acceptance over the existing data model and is **not** a human-owned decision — the design resolves it.

## Invariants honored

- **#4 one source of truth:** the Available shelf is just the owner-scoped connector list filtered by credential presence — no second catalog concept. ConnectorRegistry.tsx stays orphaned-but-present (do not delete — TASK-128 reshapes the form).
- **#2 no cross-plugin imports:** channel-web keeps using the local `lib/connectors.ts` re-declarations; no `@ax/connectors` runtime import.
- **#5 capabilities / untrusted input:** self-connect requests are browser-supplied; the consent gate is unchanged (admin-vetted item, consent card, no approval wall). Admin write paths go through the existing `auth:require-user` + owner-forced `/admin/connectors` routes (server gates `scope:'global'` writes). security-checklist note required.
- **#6 one UI language:** compose installed shadcn primitives (Button/Card/Alert/Input/Label/Select/Textarea/Checkbox/Dialog/Badge) + the project's RoleCard/StatusDot/SourceBadge. No new primitive needed.

## Tasks (independent, testable)

### Task 1 — Rebuild ConnectorsTab as Connected / Available sections
Split the single connector list into two sections by derived connected-state:
- **Connected (n)** — connectors with all keys present; per-row Reconnect (+ admin Edit/set-default/Delete/Test).
- **Available (n)** — connectors missing a key; per-row Connect (+ admin Edit/set-default/Delete/Test).
- Section headers with counts; mechanism-free captions preserved; SourceBadge preserved; `connector-tile-<id>` testids preserved. While connected-state is loading, a connector defaults to Available (it has no key yet by definition until proven).
- Empty states: no connectors at all → existing empty copy. All connected → Available section shows "Nothing left to connect." All available → Connected section shows an empty hint.
- Keep the Allowed-sites section verbatim (TASK-131 owns it next).
- **Tests:** sectioning by presence, counts, Connect on Available / Reconnect on Connected, badge placement, mechanism-free, empty states, load error — extend the existing ConnectorsTab.test.tsx.

### Task 2 — Fold inline admin curation (gated on isAdmin)
Port ConnectorRegistry's CRUD into ConnectorsTab as an admin-only affordance:
- Section-level **New connector** button (admin only) opens the connector form (reuse ConnectorRegistry's FormState / capabilitiesFromForm / formFromConnector logic — extract to a shared module `lib/connector-form.ts` so both ConnectorsTab and the orphaned ConnectorRegistry can import it without duplication, or inline a `ConnectorEditDialog` component in settings).
- Per-row (admin only): **Edit** (opens form prefilled), **set-default** toggle (patch `defaultAttached`), **Delete** (styled confirm Dialog — no window.confirm), **Test** (existing probe).
- Non-admin rows show NO edit/set-default/delete — only Connect/Reconnect (+ shared/Catalog badge).
- Admin form exposes visibility:shared + default-on; the form is the existing Advanced-disclosure form (TASK-128 reshapes it mechanism-first later — keep its shape now).
- After a successful create/edit/delete/set-default, refresh the list + connected-state so the tile re-sections.
- **Tests:** admin sees New/Edit/Delete/set-default; non-admin sees none of them; create/edit/delete/set-default round-trip via mocked lib calls; delete confirm dialog.

### Task 3 — security-checklist PR note
Run the security-checklist skill over: the self-connect consent path (browser-supplied connect requests against an admin-vetted item; consent card, no approval wall), the admin write paths (owner-forced, server role-gated for global), and untrusted text rendering. Produce the structured PR note.

## YAGNI pass
- No new attach hook / catalog read hook — explicitly out of scope (design line 45). Cut.
- No mechanism-first form rewrite — that's TASK-128. Keep the existing form shape. Cut.
- No status-wording change — that's TASK-130. Keep "connected/not connected". Cut.
- No Allowed-sites changes — that's TASK-131. Keep verbatim. Cut.
- Shared form-logic module only if it avoids real duplication; otherwise inline. Decide during impl.

## Verification
`pnpm build && pnpm test --filter @ax/channel-web` + `pnpm lint` (scoped to changed files). Whole-branch ax-code-reviewer before PR.
