# Agent-owned sign-ins — Slice 2a (admin-only connector definitions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only workspace admins define connectors. Any admin can edit or delete any shared connector. A new connector's id can't collide with another owner's. Personal Settings loses Connectors and gains **Sites**, and Admin gains **Connectors**.

**Architecture:** Server: the non-admin *write* routes under `/settings/connectors` are deleted. The read routes stay, because the agent rail's Add list uses them. The authored-proposal routes stay until slice 2c. The admin bundle gains "act on the owner's row" for shared connectors, and an id-uniqueness flag on `connectors:upsert` that only the admin create route sets. UI: nav lists and AdminShell move Connectors to Admin, and a new `SitesTab` hosts the two existing site panels unchanged.

**Tech Stack:** TypeScript, vitest, Kysely/Postgres (testcontainers), React + shadcn (channel-web).

**Spec:** `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md` — "What people see" (Admin › Connectors, Settings) and §4. Slice 2 is split into 2a / 2b / 2c (ruling below).

## Global Constraints

- No cross-plugin imports; plugins talk via the hook bus. Hook payload names stay storage-agnostic.
- UI is shadcn primitives + semantic tokens only (invariant 6). Invoke the `shadcn` skill before UI work; every shadcn CLI call needs `-c packages/channel-web`.
- Keep `GET /settings/connectors`, `GET /settings/connectors/:id` and `GET /settings/connectors/:id/tool-permissions`. `AddConnector.tsx:130,151`, `TeamKeyDialog`, `ConnectorConnectDialog` and `SkillEditor` read them as non-admins.
- Keep the authored routes (`/settings/connectors/authored*`). Slice 2c moves proposals to admins.
- The stored `keyMode` value `'personal'` is **not** renamed (ruling). Only the UI copy changes.
- `export DOCKER_HOST=unix:///var/run/docker.sock`. Run Docker-backed suites **one at a time**. Use `pnpm --filter <pkg> test`, with the filter before the script, plus `pnpm --filter <pkg> exec tsc --noEmit -p .`. channel-web's tsc also covers its tests.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01YZ4rcdtzRxcf4xooEWqvx8`.

## Rulings carried in

- **Slice 2 is split:**
  - 2a = definitions + nav (this plan);
  - 2b = cleanup (detach-on-delete, purging markers on connector delete, boot deletion of non-admin connectors with purge authority);
  - 2c = proposals go to admins.
- **No `keyMode` rename.** It touches about 50 files and a database CHECK constraint, and it would make held `connector_propose` digests look stale. The gain is cosmetic.
- **Id uniqueness is enforced only where new connectors are created by an admin** (a `requireUniqueId` flag on `connectors:upsert`, set by `POST /admin/connectors`). Existing duplicates stay, and slice 1's survivor logic handles them. Tests that build duplicates through the hook keep working.

## Review Focus

- **A second admin edits or deletes the first admin's shared connector:** it must work, and the row's owner must not change. A non-admin must still get 403 on every `/admin/connectors` write.
- **A non-admin calling a removed write route** (`POST/PATCH/DELETE /settings/connectors…`, `PUT …/tool-permissions`) must get a 404, never a silent success.
- **Creating an id that another owner holds as a live *private* connector:** 409 `connector-id-taken`. A **tombstoned** row with that id must not block.
- **A non-admin opening Settings** sees Sites (both panels) and no Connectors. An admin sees Admin › Connectors. An `initialTab` of `connectors` for a non-admin falls back to a tab they can open.
- **The agent rail's Add list still loads for a non-admin.** The read routes must not be deleted.

---

### Task 1: Id uniqueness for admin-created connectors

**Files:**
- Modify: `packages/connectors/src/store.ts` (`upsert` ~line 410; `ConnectorStore` interface)
- Modify: `packages/connectors/src/plugin.ts` (the `connectors:upsert` input type and handler)
- Modify: `packages/connectors/src/admin-routes.ts` (`create` ~line 486; `handleHookError` → 409)
- Test: `packages/connectors/src/__tests__/store.test.ts`, `packages/connectors/src/__tests__/admin-routes.test.ts`

**Interfaces:**
- Produces: `connectors:upsert` input gains optional `requireUniqueId?: boolean`. When it's true and no live row exists for `(userId, connectorId)`, the call throws `PluginError({ code: 'connector-id-taken' })` if **any other owner** has a **live** row (any visibility) with that `connector_id`. Tombstoned rows never block. Re-upserting your own live row is never blocked.

- [ ] **Step 1: failing tests.**
  - Store/hook: owner A has a live private `gmail`. Owner B upserts `gmail` with `requireUniqueId: true` → rejects with code `connector-id-taken`.
  - The same without the flag → succeeds (existing behaviour).
  - Owner A's `gmail` is soft-deleted → B with the flag succeeds.
  - A re-upserting its own live `gmail` with the flag → succeeds.
  - Route: admin2 `POST /admin/connectors` with an id admin1 holds as a private connector → 409 `{ error: 'connector-id-taken' }`.
- [ ] **Step 2:** run them; expected FAIL.
- [ ] **Step 3: implement.**
  - In `upsert`, when `created` and `args.requireUniqueId === true`, select any live row with `connector_id = args.connectorId AND owner_user_id <> args.userId`. If one is found, throw. Do the check inside the same transaction or statement sequence the upsert already uses; don't widen it.
  - Thread the flag through the hook.
  - In the `create` route, set `requireUniqueId: true` only for `mode === 'admin'`. The user-mode POST is deleted in Task 3.
  - Map `connector-id-taken` → 409 in the route's error mapping.
- [ ] **Step 4:** `pnpm --filter @ax/connectors test` + tsc → green.
- [ ] **Step 5:** commit `connectors: admin-created connectors need an id no other owner holds`.

### Task 2: Any admin may edit or delete a shared connector

**Files:**
- Modify: `packages/connectors/src/admin-routes.ts` (`loadEditable` ~417, `isReadOnly` ~329, `update` ~546, `destroy` ~623, `setToolPermissions` ~763, `create`'s existing-row branch ~512-520)
- Possibly modify: `packages/connectors/src/types.ts` / `store.ts` / `plugin.ts` if the connector view handed to routes lacks the owner id
- Test: `packages/connectors/src/__tests__/admin-routes.test.ts`, `admin-route-gate.test.ts`

**Context:**
- `canEdit` is `row owner === actor` (`store.ts:354,366`), and `isReadOnly` 403s when `canEdit === false`. So today a second admin can't edit or delete the first admin's shared connector.
- The hooks are keyed by owner: `userId` is the row owner.

**Requirement:** in `mode === 'admin'` only, when the target is a **shared** connector owned by someone else, the route acts on the **owner's** row:
- PATCH, DELETE and the tool-permissions PUT call the hooks with `userId = <row owner>`.
- `purgeGlobal` stays `actor.isAdmin`.
- Ownership never changes.
- Logs and audit, if any, record the actor.

Private connectors owned by others stay invisible and untouched. The user-mode bundle is unchanged here; Task 3 deletes its writes. If the view has no owner id, add `ownerUserId` to what `connectors:get` returns, which is internal and host-side. Name it plainly, with no storage vocabulary.

- [ ] **Step 1: failing tests (route level, real Postgres harness).**
  - admin1 creates shared `crm`.
  - admin2 PATCHes its name → 200; a GET shows the new name; the owner is still admin1.
  - admin2 PUTs tool permissions → 200.
  - admin2 DELETEs → 204, and admin1's GET → 404.
  - A non-admin PATCH via `/admin/connectors/crm` → 403.
  - admin2 trying to PATCH admin1's **private** connector → 404, unchanged.
- [ ] **Step 2:** run them; expected FAIL (403 read-only).
- [ ] **Step 3:** implement as above.
- [ ] **Step 4:** connectors tests + tsc green.
- [ ] **Step 5:** commit `connectors: any admin can edit or delete a shared connector`.

### Task 3: Delete the non-admin connector write routes

**Files:**
- Modify: `packages/connectors/src/admin-routes.ts` (`registerUserConnectorRoutes` ~1061-1124, and stale comments ~320-325, ~1052 claiming non-admins author private connectors)
- Modify: `packages/channel-web/src/mock/admin/connectors.ts` (the user-mode mock bundle ~547-560 mirrors the server)
- Test: `packages/connectors/src/__tests__/admin-routes.test.ts` (user-route sections ~803-1298), `admin-route-gate.test.ts` (~398-415 pins "the `/settings/connectors` twin stays open"), `credential-scope-authz.test.ts`, `tool-permission-routes.test.ts`, and channel-web `mock/__tests__/admin-connectors.test.ts`

**Requirement:**
- `registerUserConnectorRoutes` registers only:
  - `GET /settings/connectors`
  - `GET /settings/connectors/:id`
  - `GET /settings/connectors/:id/tool-permissions`
  - the three authored routes (unchanged)
- POST, PATCH, DELETE and the tool-permissions PUT are no longer registered, so they 404.
- Delete the tests that exercised non-admin writes. Replace them with tests asserting each removed route 404s for a signed-in non-admin.
- Flip the "twin stays open" gate test to pin that only the reads and authored routes exist.
- Update the dev mock the same way.
- Then grep channel-web for every **write** call to a `/settings/connectors` base:

  ```bash
  git grep -n "settings/connectors" packages/channel-web/src
  ```

  Anything still reachable by a non-admin after Task 4 must not write. Note each one in your report. Task 4 removes the admin-only surfaces' non-admin branches.

- [ ] **Step 1:** write the 404 tests → FAIL.
- [ ] **Step 2:** remove the registrations and update the tests and the mock.
- [ ] **Step 3:** `pnpm --filter @ax/connectors test`, `pnpm --filter @ax/channel-web test`, tsc → green.
- [ ] **Step 4:** commit `connectors: only admins write connector definitions (remove /settings write routes)`.

### Task 4: Admin › Connectors, Settings › Sites

**Files:**
- Modify: `packages/channel-web/src/components/admin/AdminSidebar.tsx` (`AdminTabId` :22-40, `USER_NAV` :46, `ADMIN_NAV` :55)
- Modify: `packages/channel-web/src/components/admin/AdminShell.tsx` (`TAB_META` :56-68, render chain :132-143)
- Create: `packages/channel-web/src/components/settings/SitesTab.tsx`
- Modify: `packages/channel-web/src/components/settings/ConnectorsTab.tsx`: remove the two site panels (:381, :389), make it admin-only (always the `/admin/connectors` base; drop the non-admin branches at :62, :167-168, :225-227), and change `needsCaption` (:52) personal copy to `"Each agent adds its own key"` (workspace stays `"Needs a shared key"`; consider `"Shared key"`, matching the editor). Update the stale header comment (:1-22, :58-61).
- Modify, where only non-admin writes made them branch: `ConnectorEditDialog.tsx`, `RemoteMcpConnectorForm.tsx`, `LegacyConnectorEditDialog.tsx`. They are now opened only from the admin tab, so their writes always use `/admin/connectors`. Leave `AddConnector.tsx`, `TeamKeyDialog.tsx`, `ConnectorConnectDialog.tsx` and `SkillEditor.tsx` read bases alone.
- Tests: `admin/__tests__/AdminSidebar.test.tsx` (:36, :148-160), `AdminShell.test.tsx` (:144, :163, :256-311), `AdminShellHeadings.test.tsx` (:131), `src/__tests__/settings-return-focus.test.tsx` (:81, :293), `settings/__tests__/ConnectorsTab.test.tsx` (:433-466, which move to a new `SitesTab.test.tsx`), `AllowedSitesPanel.test.tsx` / `RememberedSitesPanel.test.tsx` (unchanged).

**Requirement:**
- `USER_NAV`: remove `connectors-user`; add `{ id: 'sites', label: 'Sites', icon: Globe }` (lucide), where Connectors used to sit.
- `ADMIN_NAV`: add `{ id: 'connectors', label: 'Connectors', icon: Plug }` as the first admin item.
- `ADMIN_ONLY_TABS` derives from `ADMIN_NAV`, so `connectors` becomes admin-gated automatically. Verify that a non-admin `initialTab: 'connectors'` (and the old `'connectors-user'`, if anything still passes it) falls back safely, and test it.
- `SitesTab` renders `<AllowedSitesPanel />` then `<RememberedSitesPanel />`, under the same heading outline the Connectors tab gave them, with `TAB_META` title "Sites" and eyebrow "Settings".
- No new styled `<div>`s or raw colors; reuse the panels as they are.

- [ ] **Step 1:** invoke the `shadcn` skill and read the installed-component list.
- [ ] **Step 2:** update and add failing tests:
  - sidebar user tabs include "Sites", not "Connectors";
  - admin tabs include "Connectors";
  - `SitesTab` embeds both panels in order;
  - `ConnectorsTab` no longer embeds them;
  - the caption is "Each agent adds its own key";
  - a non-admin with `initialTab` `connectors` doesn't render it;
  - the return-focus test runs as admin for Connectors.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `pnpm --filter @ax/channel-web test` and `pnpm --filter @ax/channel-web exec tsc --noEmit -p .` → green; `pnpm lint` → exit 0.
- [ ] **Step 5:** commit `channel-web: Connectors moves to Admin; personal Settings gets Sites`.

### Task 5: Gate + memory

- [ ] `pnpm build && pnpm lint && pnpm -r --workspace-concurrency=2 --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts` → green.
- [ ] Decisions shard:

  ```bash
  shard=$(scripts/memory-write-target.sh --shard decisions SIGNINS-2A)
  ```

  Record the 2a/2b/2c split, the dropped `keyMode` rename, admin-create-only id uniqueness, and that the rail's read routes must stay. Commit it.
