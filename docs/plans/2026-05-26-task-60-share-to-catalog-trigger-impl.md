# TASK-60 — JIT user-facing share-to-catalog trigger (UI + HTTP route firing catalog:submit)

**Goal:** Give a user a way to submit one of their own user-scoped skills to the org
catalog. The promotion path (admit queue → promote → working-copy retirement) is already
verified (TASK-41); the admin review UI shipped (TASK-45); the broker cold-start producer
shipped (TASK-53). The **missing piece** is the *user-facing producer*: there is no UI
control or HTTP route a user can use to fire `catalog:submit kind:'share'` for their own
skill. This card adds it. Design §6D / §12 (P6 mirror table row "Submit to catalog").

**Non-goals / out of scope (explicit):**
- The live open-mode authoring ANTHROPIC-key env note (separate, not this card).
- No new hook surface. `catalog:submit` already exists + is registered (`plugin.ts`),
  `CatalogSubmitOutput` is exported from `@ax/skills`. Pure additive route + UI.
- No user-side revoke (§12: "Submit to catalog | admin Admit queue | —" — the admin
  decides; a submission is a request, not a reversible toggle).

## Design decision (locked, see decisions.md)

- The trigger lives in the **My Skills** settings surface (`UserSkillsPanel.tsx`) as a
  per-row **Share** action, backed by a new user-scoped route
  `POST /settings/skills/:id/share` in `@ax/skills` `settings-routes.ts`.
- The route fires the EXISTING `catalog:submit` hook with `kind:'share'`,
  `skillId` from the path param, `requestedByUserId = actor.id` (host-supplied —
  NEVER from the body, invariant I5). Body is empty/optional.
- Dedup: a duplicate pending submission returns `created:false` (HTTP 200), not an error;
  the UI surfaces "submitted / already pending review".

## Tasks (independent, testable)

### Task 1 — HTTP route: `POST /settings/skills/:id/share` (`@ax/skills`)
**Files:** `packages/skills/src/settings-routes.ts`, `packages/skills/src/__tests__/settings-routes.test.ts` (add cases; create the test file only if it doesn't already exist — verify first).
- Add a `share` handler to `createSettingsSkillsHandlers`:
  - `requireAuthenticated` → 401 if no actor.
  - `id` from `req.params`; 400 `missing skill id` if absent (mirror existing handlers).
  - Call `catalog:submit` with `{ kind:'share', skillId:id, requestedByUserId: actor.id }`.
    Body is ignored for identity (I5). No body parse needed (no client fields), but if
    we parse for symmetry, use the empty-OK `parseRequestBody`.
  - On success: `res.status(200).json(out)` where `out` is `CatalogSubmitOutput`
    (`{requestId, created, status}`).
  - On `PluginError` → `writeServiceError` (already maps `skill-not-found`→404,
    `cold-start-not-promotable`/`invalid-*`→400). Rethrow otherwise.
- Register the route in `registerSettingsSkillsRoutes`:
  `{ method:'POST', path:'/settings/skills/:id/share', handler: handlers.share }`.
  (Order it AFTER the `:id` GET/PUT/DELETE — distinct path, no collision.)
- Import `CatalogSubmitInput`/`CatalogSubmitOutput` from `./types.js`.
- **Tests (TDD):** seed a user skill via `skills:upsert` scope=user; POST share →
  200, `created:true`, a pending request appears (`catalog:list-requests`). Re-POST →
  `created:false` (dedup). Share a non-owned id → 404. Unauthenticated → 401.
  Spoofed `requestedByUserId` in body is ignored (the share lands under `actor.id`).
  Mirror `catalog-routes.test.ts` harness (Postgres testcontainer + `createSkillsPlugin`).

### Task 2 — Client wire wrapper (`channel-web/src/lib/user-skills.ts`)
**Files:** `packages/channel-web/src/lib/user-skills.ts`, `packages/channel-web/src/lib/__tests__/user-skills.test.ts` (add if a test file pattern exists; else cover via the panel test).
- Add `shareUserSkill(skillId): Promise<{ requestId: string; created: boolean; status: string }>`:
  `POST /settings/skills/:id/share` with `credentials:'include'` + `csrfHeader`
  (`x-requested-with: ax-admin`), empty body. Reuse `handleResponse`.
- Import the `CatalogSubmitOutput` type from `@ax/skills` for the return type.

### Task 3 — UI: Share action in My Skills panel (`channel-web`)
**Files:** `packages/channel-web/src/components/skills/UserSkillsPanel.tsx`,
`packages/channel-web/src/components/skills/__tests__/UserSkillsPanel.test.tsx` (extend).
- Add a per-row **Share** button (lucide `Share2`, `variant="ghost" size="sm"`,
  `aria-label={`Share ${s.id} to catalog`}`) next to Edit/Delete.
- On click → open a confirmation Dialog (mirror the existing Delete-confirm Dialog):
  explain that submitting sends the skill to the admin for org-wide review and that the
  author's editable copy is retired on admission (§6D). Confirm → call `shareUserSkill`.
- Status feedback (compose `Alert`, no custom divs):
  - success `created:true` → success Alert "Submitted for review."
  - `created:false` (dedup) → info Alert "Already submitted — pending admin review."
  - error → destructive Alert with the message.
- shadcn discipline: only installed primitives (`Button`, `Dialog*`, `Alert*`),
  `data-icon`-free icon usage matches existing rows (existing rows pass icons as
  `<Pencil className="h-3.5 w-3.5" />` — match the local convention for consistency),
  semantic tokens only, `flex gap-*` not `space-*`.
- **Tests:** clicking Share opens the dialog; confirming calls the wire fn and shows the
  success/dedup/error Alert. Mock `@/lib/user-skills`.

## Gate / verification
- `pnpm build` (full tsc project refs — the cross-hop type gate), `pnpm lint`.
- `pnpm -F @ax/skills test` (route — needs Postgres testcontainer; re-probe Docker),
  `pnpm -F @ax/channel-web test` (UI + client).
- Cross-package note (patterns.md): channel-web tests import `@ax/skills` from its
  built `dist` — `pnpm -F @ax/skills build` (or full `pnpm build`) BEFORE the
  channel-web test if the new `CatalogSubmitOutput` re-export matters (it's already
  exported, so likely fine, but rebuild to be safe).

## Security note (pre-PR)
Touches an HTTP route handling an authenticated user's request → light security-checklist
pass in Phase 3: the route is a thin front for the existing `catalog:submit` hook; the
only identity (`requestedByUserId`) is host-supplied from the session, never the body
(I5); the skill bytes are snapshotted host-side; submit is an inert queue insert (no code
runs, nothing materializes until an admin admits — TASK-41's gate). No new egress, fs,
spawn, or env. No new dependency.

## Boundary review
N/A — no new or changed hook surface. The route fires the existing `catalog:submit`
service hook unchanged. (Internal-only route addition; CLAUDE.md "Patches that only change
a plugin's internal implementation … don't need boundary review.")
