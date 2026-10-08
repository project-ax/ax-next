# Agent-Owned Sign-Ins — Slice 7: Every Connector Is Shared

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the idea of a private connector. Every connector is shared and usable by agents, there is no Sharing control, and no code branches on connector visibility.

**Architecture:**
- **Data.** A one-time, marker-guarded boot step in `@ax/connectors` resolves duplicate ids and flips every private row to shared. A migration gives the `visibility` column `DEFAULT 'shared'`, so code can stop writing it.
- **Code.** `Visibility` and every `visibility` field leave the connectors types, zod schemas, store, hook payloads and channel-web. Shared-only branches become unconditional. "Sole shared definition" becomes "sole live definition".
- **What stays.** The column stays physically, so rolling the image back stays safe: old code reads every row as shared. Dropping it is a later cleanup card.

**Tech Stack:** TypeScript, Kysely/Postgres, zod, React + shadcn (channel-web), vitest.

**Spec:** `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md`, plus the owner decision of 2026-10-08 recorded in `docs/plans/2026-10-08-agent-owned-sign-ins-slice7-walk.md` ("Every connector is shared and usable by agents. Remove the Private option."). It supersedes the slice 5 ruling "private connectors aren't auto-shared".

## Global Constraints

- Connector visibility only. **Agent** visibility (`personal` / `team`) and connector `key_mode` (`personal` / `workspace`) are different concepts and stay exactly as they are.
- No cross-plugin imports. The hook bus is the API.
- Hook payload changes get a boundary-review line in the PR: `visibility` leaves `connectors:list/get/upsert/list-effective`, and `requiresSharedKeyConsent` leaves `connectors:resolve`.
- The boot step never throws and never fails boot. It marks itself done only after a complete pass, using the `isBootStepDone` / `markBootStepDone` pattern from `non-admin-sweep.ts`, with step name `'all-connectors-shared'`.
- The boot step logs counts only, never ids or owners: `connectors_all_shared {flipped, deduped}`, and only when something changed.
- Every deleted behaviour loses its tests, and every new behaviour gets one. Don't leave tests that assert on private connectors.
- Copy follows the CLAUDE.md voice. No user-facing string says "Private", "Shared" or "Make it Shared" any more.
- Memory goes into a shard only: `scripts/memory-write-target.sh --shard decisions SIGNINS-9`.

## Rulings carried into the tasks

- **Dedup on flip.** For each `connector_id` with more than one live row: keep the shared row if exactly one exists. Otherwise keep the earliest `created_at`, tie-broken by `owner_user_id`, and soft-delete (`deleted_at = now()`) the others.
  - Why it's safe: a private row could never hold an agent sign-in (attach refused, store refused) or a global client secret (shared-only), so there is nothing to purge.
  - Cost if wrong: an agent that was attached to a private duplicate now uses the kept definition.
- **The column stays, with `DEFAULT 'shared'`.** Why: image rollback stays safe. Cost: one vestigial column until a cleanup card drops it.
- **`requiresSharedKeyConsent` is removed** from `connectors:resolve`. In skill-broker, `reachShape` keeps `sharedKeyConsent: true` as a literal, so approval digests for previously-shared connectors don't churn. Cost: one stale-approval prompt for connectors that were private before.
- **`agent-store-refused`** stays as the refusal code from `credentials:authorize-agent:account` with `purpose:'store'`. It can still deny, for example when the id has no live definition. channel-web's own `visibility !== 'shared'` 403 is deleted, and the user copy becomes generic: "This connector can't be added to agents right now. Ask a workspace admin."

## Review Focus

- **A vault with two live rows for one id** (two admins each held it privately, or one private and one shared): after boot, exactly one is live and the agent still resolves it.
- **The boot step crashing halfway:** it doesn't mark itself done, so the next boot finishes the job; the flip is idempotent.
- **A non-owner admin editing a connector another admin created:** allowed now (every row is curated), but changing `key_mode` stays owner-only.
- **An old client sending `visibility:'private'`** in a POST or PATCH body: the field is ignored and the stored row is shared. It's not a 400, so a stale SPA tab doesn't break.
- **A connector created after the deploy:** visible to every signed-in user's Add list and attachable. No 403.

---

### Task 1: connectors — boot step, defaults, and visibility out of the plugin

**Files:**
- Modify:
  - `packages/connectors/src/migrations.ts`: add `ALTER TABLE connectors_v1_connectors ALTER COLUMN visibility SET DEFAULT 'shared'`, idempotent, after the CREATE TABLE.
  - Leave the CHECK and the partial index `connectors_v1_connectors_shared` alone. Postgres keeps them consistent, and the index stops being used.
- Create: `packages/connectors/src/all-shared-step.ts`, exporting `ALL_SHARED_STEP = 'all-connectors-shared'` and `makeAllConnectorsShared(db, logger): Promise<{ran:boolean; flipped:number; deduped:number}>`.
- Modify: `packages/connectors/src/scope.ts`
  - `availableConnectors` → every live row: drop the `owner = me OR visibility = 'shared'` OR. Keep the function name, signature and `scope` argument.
  - Delete the `sharedOnly` filter (~:191) and the visibility selects (~:131, :166).
  - The system read for the step lives here, for lint I7: `liveRowsForAllSharedStep(db)` returns `{owner_user_id, connector_id, visibility, created_at}`.
- Modify: `packages/connectors/src/store.ts`
  - Delete `validateVisibility` and the visibility mapping and writes (~:129-134, :190, :207, :279, :517, :592, :610).
  - Rename `getSoleSharedById` → `getSoleLiveById`: exactly one live row for the id, and it's the one `selectAvailableRow` picks.
  - Delete `hasLiveSharedById` and `liveSharedIds`; callers use `hasLiveById` and `liveIds`.
- Modify: `packages/connectors/src/types.ts`
  - Delete `Visibility`, `VisibilitySchema` and the `visibility` field on `Connector`, `ConnectorSummary`, `UpsertInput` and `ConnectorSummarySchema` (~:249, :272, :299, :339, :758-781, :872).
  - Delete `requiresSharedKeyConsent` (~:495-497, :844).
  - `packages/connectors/src/index.ts`: drop the re-exports (`Visibility`, `requiresSharedKeyConsent`).
- Modify: `packages/connectors/src/plugin.ts`
  - Validate (`:665`) and write (`:757`).
  - Shared-only branches become unconditional: `:773` `authored.clearAllById`; `:1000` survivor check → `hasLiveById`; `:1210` install dedup; `:1248` the proposals queue hides live ids.
  - Resolve output: drop `requiresSharedKeyConsent` (`:1097-1112`).
  - Wire `makeAllConnectorsShared` in `init`, after the stdio sweep and before the non-admin sweep, in a try/catch that only warns (same shape as `:311-318`).
- Modify: `packages/connectors/src/admin-routes.ts`
  - POST no longer reads `visibility`: drop `raw.visibility ??= 'shared'` (`:670`).
  - PATCH ignores any `visibility` in the body (`:760-761`).
  - `adminCurates` (`:346`) → any admin may curate any row.
  - `presentCanEdit` (`:427`) → `canEdit` true for admins.
  - The `owner-only-change` 403 (`:408`) keeps covering `key_mode` only.
  - Fix the comments at `:91, :321, :342, :379-390, :647-654, :714`.
- Modify: `credential-plan.ts` (delete `requiresSharedKeyConsent`, `:168-173`), `purge.ts` (shared-only purges become unconditional, `:11, :91, :120, :125`), `non-admin-sweep.ts` (`:57, :149, :167-170`) and `stdio-sweep.ts` (`:52`).
- Modify: `packages/connectors/src/credential-authz.ts`
  - `:181` and `:298-299` use `getSoleLiveById`.
  - Deny codes `not-the-shared-connector` → `not-the-connector`, and `client-secret-not-the-shared-connector` → `client-secret-not-the-connector`.
  - Grep the repo for both strings and update every consumer and test.
- Tests in `packages/connectors/src/__tests__/`:
  - Delete or rewrite every private-connector assertion listed in the inventory: store, admin-routes, hooks, credential-plan, credential-authz-client-secret, no-person-level-keys, non-admin-sweep, authored-hooks, tool-permission-routes and leak-guard; fixture defaults in list-effective, credential-authz and credential-scope-authz.
  - Fixtures that inserted `visibility: 'private'` now insert nothing; the default applies.
  - Tests that relied on "another owner's private row is invisible" are deleted. That behaviour no longer exists.
- Create: `packages/connectors/src/__tests__/all-shared-step.test.ts`.

**Interfaces:**
- Produces:
  - `ConnectorStore.getSoleLiveById(userId, connectorId)` (same return shape as the old `getSoleSharedById`).
  - Hook payloads with no `visibility` and no `requiresSharedKeyConsent`.
  - Deny codes `not-the-connector` and `client-secret-not-the-connector`.

- [ ] **Step 1: Write the failing boot-step tests** in `all-shared-step.test.ts` (real Postgres via the package's existing testcontainer helper):
  1. Two private rows with distinct ids → both shared; returns `{ran:true, flipped:2, deduped:0}`; the marker is set.
  2. Id `x`: shared(owner A) + private(owner B) → A's row stays live and B's has `deleted_at` set; `deduped:1`.
  3. Id `y`: private(A, created t1) + private(B, created t2 > t1) → A's row is live and shared, and B's is soft-deleted.
  4. Id `z`: shared(A) + shared(B), legacy duplicate → keep the earliest `created_at`; the other is soft-deleted.
  5. A second run → `{ran:false}` and nothing changes.
  6. Already soft-deleted rows are ignored (they're never flipped or counted).
  7. Logs `connectors_all_shared` once with counts only. The log payload has no `connector_id` or owner. Assert on the recorded logger call's keys.
  8. A throw in the middle (inject a db that rejects on the UPDATE) → no marker, no throw out of `makeAllConnectorsShared` (it warns `connectors_all_shared_failed` with `{name}`), and the next run completes.
  9. After the step, an `INSERT` that omits `visibility` succeeds and reads back as shared. This proves the DEFAULT.
- [ ] **Step 2: Run them and see them fail.** `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/connectors exec vitest run src/__tests__/all-shared-step.test.ts`
- [ ] **Step 3: Implement** the migration line, `all-shared-step.ts` (one transaction: select the live rows, compute the keep/delete sets in TS, `UPDATE … SET deleted_at = now()` on the losers, `UPDATE … SET visibility='shared' WHERE deleted_at IS NULL AND visibility='private'`, then `markBootStepDone`), and the `init` wiring.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Remove visibility from the plugin**, per the Files list. Add these tests:
  - `admin-routes.test.ts`: a POST with `visibility:'private'` → 201 and the row reads back with no visibility field, live for another user's `connectors:list`.
  - `admin-routes.test.ts`: a PATCH with `visibility:'private'` from the owner → 200 and still listed for others.
  - `admin-routes.test.ts`: a non-owner admin can PATCH the name of another admin's connector; changing its `key_mode` → 403 `owner-only-change`.
  - `hooks.test.ts`: `connectors:list` for user B includes user A's connector.
  - `hooks.test.ts`: the `connectors:resolve` output has no `requiresSharedKeyConsent` key.
  - `credential-authz.test.ts`: `purpose:'store'` allowed for any live connector; an id with no live row → `not-the-connector`.
  - `credential-authz-client-secret.test.ts`: two live rows for one id (inserted directly, bypassing the step) → `client-secret-not-the-connector`.
- [ ] **Step 6: Run the whole package.** `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/connectors test`, plus `pnpm --filter @ax/connectors exec tsc --noEmit -p .` and `pnpm lint`. Expect all green. The grep `grep -rn "visibility" packages/connectors/src | grep -v __tests__` should show only `migrations.ts`, the step's file and `scope.ts` (the step's select), each with a comment.
- [ ] **Step 7: Commit.** `connectors: every connector is shared — boot step flips and dedupes, visibility leaves the plugin`

### Task 2: consumers outside connectors and channel-web

**Files:**
- Modify: `packages/skill-broker/src/tools/capability-freshness.ts`
  - `:247` drop `requiresSharedKeyConsent?` from the input type.
  - `:383` becomes `sharedKeyConsent: true,` with the comment: "Every connector is shared since SIGNINS-9, so approving always spends a key that is not only this person's; kept as a literal so approval digests don't change."
  - Update its tests so they no longer feed the field, and assert that the digest for a resolve with no `requiresSharedKeyConsent` equals the digest the old code produced for `requiresSharedKeyConsent: true` (pin the old digest string in the test).
- Modify: `packages/mcp-oauth/src/__tests__/routes.test.ts` (`:1336`, `:1391`) and `admin-client-secret.e2e.test.ts` (`:412`, `:425`, the `author(..., 'private')` helper). Delete the private cases, and replace them with "no live definition → 403 `agent-store-refused`" where a refusal case is still needed.
- Modify: `packages/mcp-oauth/src/routes.ts:607`, the comment only (the client secret is stored globally for the connector).
- Modify: `presets/k8s/src/__tests__/connector-delete-composition.test.ts` (`:121`, `:251`, `:320-322`). ADMIN2's private `dupid` scenario becomes "a second definition of the same id is soft-deleted by the boot step". If that's no longer meaningful for the delete composition, drop the case with a one-line note in the commit body.
- Modify: `presets/k8s/src/__tests__/prod-bootstrap.test.ts:393`, the comment.
- Modify: `packages/chat-orchestrator/src/connector-union.ts:31`, the stale comment.
- Grep for and fix every other consumer of `not-the-shared-connector`, `client-secret-not-the-shared-connector`, `getSoleSharedById`, `hasLiveSharedById`, `liveSharedIds` and `requiresSharedKeyConsent` outside connectors and channel-web.

- [ ] **Step 1:** Make the edits above; the digest-pin test goes first and should fail if the field is dropped from the shape.
- [ ] **Step 2:** Run `pnpm --filter @ax/skill-broker test`, `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/mcp-oauth test`, `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/preset-k8s test`, `pnpm --filter @ax/chat-orchestrator test`, `pnpm build` and `pnpm lint`. Expect all green.
- [ ] **Step 3: Commit.** `skill-broker, mcp-oauth, preset-k8s: follow connectors with no visibility`

### Task 3: channel-web — no Sharing control, no private notices, no visibility

**Files:**
- Modify:
  - `src/lib/connectors.ts` (`:122`, `:136`, `:153`): delete `ConnectorVisibility` and the fields.
  - `src/lib/connector-form.ts` (`:97`, `:133`, `:214`, `:531`).
  - `src/lib/add-connector.ts:40`: the filter keeps only `!effectiveIds.has(c.id)`. Update the comment at `:34-38`.
- Modify: `src/components/settings/RemoteMcpConnectorForm.tsx`
  - Delete the visibility state (`:172-173`), `sharedConnector` and the client-secret gate (`:178`, `:449-450`), and the body field (`:536`, `:541`).
  - Delete the whole Sharing FieldSet (`:685-717`).
- Modify: `src/components/settings/LegacyConnectorEditDialog.tsx`: delete the Sharing Select (`:832-858`), the forced-shared `fromRequest` handling (`:591`), the client-secret refusal (`:613-614`) and the body field (`:668`). Keep `fromRequest`'s other behaviour.
- Modify:
  - `src/components/settings/ConnectorEditDialog.tsx:41`: drop `visibility` from the draft.
  - `src/components/settings/ConnectorsTab.tsx`: delete `PRIVATE_CONNECTOR_NOTICE` and its render (`:62-64`, `:247-255`).
  - `src/components/SourceBadge.tsx`: drop the `'private'` source. `connectorSource` has no non-test caller, so delete it and its test cases; keep the badge component.
  - `src/lib/connector-credential-slots.ts:36`: delete `CLIENT_SECRET_NEEDS_SHARED` and its uses.
- Modify: `src/lib/oauth-failure.ts:65-67, :81-82` and `src/components/workspace/AddConnector.tsx:128-131`. The `agent-store-refused` copy becomes: "This connector can't be added to agents right now. Ask a workspace admin."
- Modify: `src/server/routes-workspace.ts`
  - Delete the `connector?.visibility !== 'shared'` 403 (`:7399`) and its doc comments (`:7310-7311`, `:7395-7398`).
  - The per-ref `credentials:authorize-agent:account` `purpose:'store'` check (`:7482-7497`) stays as the authority.
  - Fix the comment at `:3866`.
- Modify: `mock/admin/connectors.ts`: remove visibility from the mock types, validation and filters (`:57, :90, :168, :250-252, :271, :399, :421, :519`). For `:271`, the read-only rule becomes `key_mode === 'workspace'`.
- Tests: update every file the inventory lists.
  - Delete private cases: routes-workspace-connectors `:1455-1476` (it.each private, and "no visibility is refused"); add-connector `:43`; ConnectorsTab `:86`; RemoteMcpConnectorForm `:1543-1554` and "sharing (SIGNINS-7)" `:1647-1712`; ConnectorEditDialog `:372`, `:832-851`; SourceBadge; mock admin-connectors `:798`.
  - Drop visibility from fixtures: connector-form, connectors-route-base, connectors-credential-plan, both endpoint-reset tests.
  - Update the copy assertions in AddConnector `:223`, `:519`.
- Add tests:
  - `routes-workspace-connectors.test.ts`: attaching a connector whose `connectors:get` returns no `visibility` field succeeds when the store question allows it, and gets 403 `agent-store-refused` when it denies.
  - `RemoteMcpConnectorForm.test.tsx`: editing an existing connector renders no "Sharing" legend and no radio for Private; the saved body has no `visibility` key.
  - `RemoteMcpConnectorForm.test.tsx`: a client secret can be entered on an edit (the old shared gate is gone).
  - `ConnectorsTab.test.tsx`: no row renders "can't be used by agents".
  - `add-connector.test.ts`: every non-attached connector is offered.
  - `AddConnector.test.tsx`: the `agent-store-refused` copy matches the new string.
- [ ] **Step 1:** Write the new tests and see them fail.
- [ ] **Step 2:** Make the edits.
- [ ] **Step 3:** Run `pnpm --filter @ax/channel-web test` (Docker-backed server files with `DOCKER_HOST=unix:///var/run/docker.sock`), `pnpm --filter @ax/channel-web exec tsc --noEmit -p .` and `pnpm lint`. Expect all green. `grep -rn "visibility" packages/channel-web/src packages/channel-web/mock | grep -iv agent` should return no connector hits.
- [ ] **Step 4:** Write the memory shard `decisions/2026-10-08-SIGNINS-9.md` (via `scripts/memory-write-target.sh --shard decisions SIGNINS-9`). It records:
  - the owner decision and the superseded slice 5 ruling;
  - the dedup rule;
  - the column kept for rollback;
  - the `sharedKeyConsent` literal;
  - the deny-code renames.

  Then run `scripts/memory-append-check.sh`.
- [ ] **Step 5: Commit.** `channel-web: every connector is shared — no Sharing control, no private notices`
