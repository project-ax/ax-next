# TASK-1128: Replace the Slack configuration token — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can swap the Slack configuration token AX holds for a new one, from Admin › Slack, without dropping a single channel connection. Afterwards, every vault read names the admin who replaced it, and "Added by … on …" shows them and the replace date.

**Architecture:** The new admin route `POST /admin/slack/replace-token { refreshToken }` runs under the admin lock. It tries the pasted refresh token once (`tooling.tokens.rotate`). It then proves, with the access token that rotate minted, that the token's owner can manage *this* app: it sends `apps.manifest.update` with the app's current manifest, exactly as Rename does. Only after that does it store the minted refresh token over `slack:<installId>:config-refresh-token` (as the replacing admin), move the install row's `connected_by_user_id` to that admin, and stamp a new `config_token_added_at` column. Last, it deletes any leftover apps with the same minted access token. The old token is never read or rotated, so any failure before the store leaves the install exactly as it was. channel-web gets a Replace button and dialog on the connected card.

**Tech Stack:** TypeScript, Kysely/Postgres (channel-slack store + additive migration), the hook bus (`credentials:*`), React + shadcn (channel-web), vitest + Testcontainers.

**Spec:** the card body (`TASK-1128`), design `docs/plans/2026-11-09-channel-slack-design.md` §3 (now at `:272-311`, not the card's `:211-221`), and decisions `.claude/memory/decisions/2026-11-19-TASK-1128.md` (this plan's reasoning, alternatives and residuals: read it before Task 2).

## What the brief got wrong (checked against the code; details in the shard)

1. **"Re-write other secrets under the new owner?" No, and existing installs can't break.** The vault keys a global row by `(scope, ownerId, ref)` only (`credentials-store-db` `v2StorageKey`). A global-only read of a non-`account:` ref checks `userId` against a regex and nothing else (`credentials/src/plugin.ts` `findRow` with `onlyGlobal`). So moving `connected_by_user_id` relabels every later read and the new token's write. The bot token, signing secret and client secret stay where they are and stay readable.
2. **"We couldn't remove the Slack app itself" no longer exists.** TASK-1132 (#1195) removed it. Only two negative assertions remain (`SlackTab.test.tsx:532`, `:543`). The same overclaim lives on in `LeftoverAppsNote` ("We couldn't delete this Slack app, so it may still be on Slack:", `SlackTab.tsx:228-229`), and Task 4 fixes that one.
3. **"Rotate, store, then delete leftovers" is missing a check.** If the pasted token's owner can't manage this app, storing it overwrites a token that may still work, and the breakage surfaces only at the next Rename or Disconnect. Since the cross-admin question can't be measured here, the route checks it on every replace: `apps.manifest.update` runs before the store.
4. **No pasted access token.** TASK-1159's plan (`:336`) assumed the replace form takes an access token. It doesn't. An access token pasted alongside could belong to a different person than the refresh token, or be past its 12 hours. The rotate's own minted access token does the check and the leftover deletes.

## Global Constraints

- Merge `origin/main` before Task 1 and again before the PR. #1199 (TASK-1139) and #1200 (TASK-1133) are open and touch `admin-routes.ts`, `admin-routes.test.ts`, `SlackTab.tsx`, `slack-admin.ts`, the design doc and the composition test. Keep `admin-routes.ts` edits additive. Do **not** edit `deleteLeftoverApps`, `setIcon`, `route()`'s options, `log()`'s signature, or their log calls. Expect conflicts only in header comments, the route list and the `return [...]` array.
- Wire shapes: channel-web mirrors the route by shape and never imports `@ax/channel-slack` (invariant 2). No hook, IPC action or manifest `calls` change, so there is no boundary review and no preset pin change.
- Logs stay code-only. Message names start with `slack_`. Field keys stay within `installId`, `reason`, `stage`, `code` (`admin-routes.test.ts` leak test). No response, log line or error ever carries a token.
- The pasted refresh token goes nowhere but `tooling.tokens.rotate`, as a form field. The minted refresh token goes only to the vault. The minted access token is used only for the check and the leftover deletes, then dropped.
- Every write runs under `d.lock.run`. Admin POSTs keep http-server's CSRF check and `maxBodyBytes: ADMIN_BODY_MAX_BYTES`.
- Migrations are additive-only and idempotent, because every boot runs them.
- UI: shadcn primitives and semantic tokens only (invariant 6; invoke the `shadcn` skill before editing). Never write "AX" in a sentence (white-label, TASK-1093 decisions line 39). Copy is pinned below. A `ux-design` pass may change wording only if it records the change in the shard and updates every pin.
- The test fake Slack stays strict: it retires a rotated token at once (`admin-routes.test.ts` `fakeSlack`). Never loosen it.
- Docker-backed suites run one package at a time, with `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000` and an explicit `DOCKER_HOST`.
- Final gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, plus `pnpm lint`.

## Review Focus

1. **A token whose owner can't manage this app** (another admin who isn't an app collaborator): answer 502 `slack-not-app-manager`, keep the old token, and let a Rename afterwards still use it. Pinned by Task 2 test f.
2. **A token from another Slack workspace** (Slack's answer is unmeasured: `app_not_found` or `no_permission`): never call the app gone (that copy sends the admin to Disconnect and costs every channel). Same refusal as 1. Pinned by Task 2 test f, its `app_not_found` row.
3. **An access token pasted into the refresh field, or a refresh token already used:** answer 400 under the field, or 502 "generate a new token", and change nothing. Pinned by Task 2 tests c and e, and Task 4 tests 3 and 4.
4. **A double click, two admins at once, or a replace during a Disconnect:** one at a time. The loser gets a clear answer and nothing is half done. Pinned by Task 2 tests k and l, and Task 4 test 7.
5. **The database failing between the vault write and the row write:** the install keeps a working token (only "Added by" is stale). A reset racing it leaves no live token behind. Pinned by Task 2 tests h and i.

## File map

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/migrations.ts` | `config_token_added_at` column, header doc | 1 |
| `packages/channel-slack/src/store.ts` | `InstallRow.configTokenAddedAt`, `setConfigTokenOwner` | 1 |
| `packages/channel-slack/src/admin-routes.ts` | status `connectedAt` (1); replace route (2) | 1, 2 |
| `packages/channel-slack/src/secrets.ts`, `plugin.ts` | comments only | 2 |
| `packages/channel-slack/src/__tests__/{store,admin-routes,plugin}.test.ts` | tests | 1, 2 |
| `presets/memory/src/__tests__/canary.test.ts` | reachability | 3 |
| `presets/k8s/src/__tests__/channel-slack-composition.test.ts` | acceptance, real vault | 3 |
| `packages/channel-web/src/lib/slack-admin.ts` | `replaceSlackConfigToken`, copy | 4 |
| `packages/channel-web/src/components/admin/SlackTab.tsx` | Replace dialog, notices, copy | 4 |
| `packages/channel-web/src/{__tests__/admin-slack,components/admin/__tests__/SlackTab}.test.tsx` | tests | 4 |
| `docs/plans/2026-11-09-channel-slack-design.md`, `.changeset/slack-replace-config-token.md` | docs | 5 |

---

### Task 1: Store: who added the configuration token, and when [tier: sensitive]

Migration: hard to reverse once shipped.

**Files:**
- Modify: `packages/channel-slack/src/migrations.ts` (header `:8-11` and `:56-59`, `ChannelSlackInstallsTable`, end of `runMigrations`)
- Modify: `packages/channel-slack/src/store.ts` (`InstallRow` `:10-24`, `ROW_COLUMNS`, `toRow`, `InstallStore`, `createInstallStore`)
- Modify: `packages/channel-slack/src/admin-routes.ts:706-710` (status only)
- Test: `packages/channel-slack/src/__tests__/store.test.ts` (Docker)
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts` (`memoryStore` fake `:187-337`; one status test)

**Interfaces:**
- Produces: `InstallRow.configTokenAddedAt: Date`. Doc: when the configuration token this install holds was added. At Connect that is the same instant as `createdAt`; after a Replace it is the latest replace (TASK-1128). Reword `connectedByUserId`'s doc to "the admin who added that token (at Connect, or the latest Replace); vault reads name them; their name is auth's".
- Produces: `InstallStore.setConfigTokenOwner(installId: string, o: { userId: string; addedAt: Date }): Promise<void>`. One UPDATE of `connected_by_user_id` and `config_token_added_at` `WHERE install_id = $1 AND status = 'active'`, nothing else. It throws `InstallStoreError('install-not-active')` when no row matches. Channel bindings live in another table and are never touched.
- Produces: column `config_token_added_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Kysely type: `config_token_added_at: ColumnType<Date, Date | undefined, Date>`. `insertPending` doesn't name it: the DEFAULT gives the same `now()` instant as `created_at` in one INSERT.
- Produces: `GET /admin/slack` `connectedAt` = `install.configTokenAddedAt.toISOString()` (pending and connected). Wire field names stay the same.
- Produces (test fake, used by Task 2): `memoryStore` rows carry `configTokenAddedAt`. `insertPending` sets it to the same `new Date(clock())` as `createdAt`. `view()` returns it. `setConfigTokenOwner` follows the real store's rules and shows in the trail as `store:setConfigTokenOwner`. The one hand-built row (`:2447`, Rename's https test) gains `configTokenAddedAt: new Date(NOW_MS)` too.

- [ ] **Step 1: Write the failing store tests** (`store.test.ts`)
  - In `describe('runMigrations')`, add `'adds config_token_added_at to an installs table from before it: backfilled from created_at, NOT NULL with a default, and a later run keeps a replaced value'`:
    - Set up: `pending()`, then `UPDATE … SET created_at = '2026-11-01T00:00:00Z'`, then `ALTER TABLE channel_slack_v1_installs DROP COLUMN config_token_added_at`, then `runMigrations(db)`.
    - Expect `configTokenAddedAt` to equal `new Date('2026-11-01T00:00:00Z')`.
    - Then `activate`, `setConfigTokenOwner(id, { userId: 'usr_admin2', addedAt: new Date('2026-11-19T09:00:00.000Z') })`, and `runMigrations(db)` again. The value must still be `2026-11-19T09:00:00.000Z`.
    - `information_schema.columns` for the column has `is_nullable = 'NO'`, and `column_default` matches `/now\(\)/`.
  - In `'insertPending then get/current round-trips'`, add `configTokenAddedAt` to the expected key set, plus `expect(row.configTokenAddedAt).toEqual(row.createdAt)`.
  - Add `'setConfigTokenOwner changes who added the token and when on an active install, and nothing else: not its other columns, not another install, not its channel bindings'`:
    - Set up two active installs a and b, `bind(a, 'C07SUPPORT1')`, `bind(b, 'C07SALES002', 'agt_sales')`, then snapshot both.
    - Call `setConfigTokenOwner(a, { userId: 'usr_admin2', addedAt: new Date('2026-11-19T09:00:00.000Z') })`.
    - `get(a)` must equal `{ ...snapA, connectedByUserId: 'usr_admin2', configTokenAddedAt: <that date> }`, with `createdAt` unchanged. `get(b)` must equal `snapB`. `bindings()` must be unchanged.
  - Add `'setConfigTokenOwner refuses an install that is missing or still pending, and changes nothing'`. It throws `InstallStoreError` with code `'install-not-active'`, and the pending row is unchanged.
- [ ] **Step 2: Run** `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack test -- store.test.ts`. Expected: FAIL (no such column or method).
- [ ] **Step 3: Implement.** Append these four statements to `runMigrations`, in this order:
  ```sql
  ALTER TABLE channel_slack_v1_installs ADD COLUMN IF NOT EXISTS config_token_added_at TIMESTAMPTZ NULL
  ALTER TABLE channel_slack_v1_installs ALTER COLUMN config_token_added_at SET DEFAULT now()
  UPDATE channel_slack_v1_installs SET config_token_added_at = created_at WHERE config_token_added_at IS NULL
  ALTER TABLE channel_slack_v1_installs ALTER COLUMN config_token_added_at SET NOT NULL
  ```
  Comment: a single `ADD COLUMN … NOT NULL DEFAULT now()` would stamp every existing install with the migration's time, so "Added on" would show the deploy date. The `UPDATE` only fills NULLs, so a later boot never overwrites a replace.

  Extend the `migrations.ts` header's installs paragraph:
  - `connected_by_user_id` is the admin who added the configuration token the install holds (at Connect, or the latest Replace, TASK-1128), and vault reads name them.
  - `config_token_added_at` is when they added it.
  - `created_at` is still when the row was made, and it orders `current()`.

  Then add the store method, the row field, the column in `ROW_COLUMNS`, and `toRow`.
- [ ] **Step 4: Run** the same command. Expected: PASS, including `'runMigrations twice is a no-op'`.
- [ ] **Step 5: Update the `memoryStore` fake as in Interfaces.** Write the failing test in `describe('GET /admin/slack')`: `'connectedAt is when the configuration token was added, which a replace moves; the row's createdAt does not'`.
  - `connectedWorld()`, then set `onlyRow(w).configTokenAddedAt = new Date(NOW_MS + 86_400_000)`.
  - `status()` `connectedAt` must be that ISO. `onlyRow(w).createdAt` must still be `new Date(NOW_MS)`.
- [ ] **Step 6: Run** `pnpm --filter @ax/channel-slack test -- admin-routes.test.ts`. Expected: that one test FAILS (status reads `createdAt`), and every other test passes.
- [ ] **Step 7: Implement.** In `status()`, set `connectedAt: install.configTokenAddedAt.toISOString()`. Comment: "when the configuration token was added (Connect, or the latest Replace), not when Allow was clicked".
- [ ] **Step 8: Run** the admin-routes tests and `pnpm --filter @ax/channel-slack build`. Expected: PASS, and tsc is clean.
- [ ] **Step 9: Commit** `[TASK-1128] channel-slack: record when the configuration token was added (config_token_added_at)`.

### Task 2: `POST /admin/slack/replace-token` [tier: sensitive]

**security-checklist: REQUIRED.** A pasted secret goes to the vault and to slack.com egress, on an admin route, under the lock.

**Files:**
- Modify: `packages/channel-slack/src/admin-routes.ts`:
  - header route list `:27-33`, plus a Replace bullet in "Secrets" `:42-63`
  - `CONFIG_TOKEN_REFUSED` doc `:183-189`: its last sentence becomes "The remedy is the same for all: Replace the token with one whose owner can manage the app."
  - the new path const, `NOT_APP_MANAGER` and `replaceCheckError`, the route, and its entry in the `return [...]` array, after rename
- Modify: `packages/channel-slack/src/secrets.ts`, comments only:
  - `:22-24`: "names the admin who added the install's configuration token (Connect, or the latest Replace). The vault keys a global row by its ref alone, so who is named never changes which row is read."
  - `:31-38`: "Replace (TASK-1128) does the same with a refresh token pasted later, and stores it only after Slack accepted the app's manifest from the token it minted."
- Modify: `packages/channel-slack/src/plugin.ts:70-71`: the route list comment gains `replace-token`.
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts`
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts:~662`: the route-shape pin gains `{ method: 'POST', path: '/admin/slack/replace-token', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES }`, after rename.

**Interfaces:**
- Consumes: Task 1's `setConfigTokenOwner` and `configTokenAddedAt`, plus the existing `configToken`, `REFRESH_TOKEN_PREFIX`, `refreshTokenError`, `REFRESH_TOKEN_REFUSED`, `saveRotatedToken`, `deleteLeftoverApps`, `buildAppManifest`, `slackUrls` and `canConnect`.
- Produces (the wire contract Task 4 mirrors):
  - `export const ADMIN_REPLACE_TOKEN_PATH = '/admin/slack/replace-token'`. Body `{ refreshToken: string }`; other fields are ignored. Success: `200 {}`.
  - Errors:
    - 400: `invalid-body` | `invalid-refresh-token`
    - 413: `body-too-large`
    - 409: `not-connected` | `public-origin-not-https`
    - 502: `slack-refresh-token` | **`slack-not-app-manager` (new)** | `slack-error`
    - 500: `internal`
    - the gate's 401/403
  - Logs:
    - failures: `slack_admin_failed { installId, stage, code }`, with stages `try-refresh-token`, `check-app`, `save-config-token`, `save-owner` (added in review round 1) and `leftover-apps`
    - the route-level catch: `{ stage: 'replace-token', code }` (after review round 1, a failed row write logs `save-owner` with its installId instead)
    - success: `slack_config_token_replaced { installId }` at **info**
- `function replaceCheckError(err: unknown): 'slack-refresh-token' | 'slack-not-app-manager' | 'slack-error'`:
  - not a `SlackApiError` → `slack-error`
  - `REFRESH_TOKEN_REFUSED` → `slack-refresh-token`
  - `NOT_APP_MANAGER = new Set(['no_permission', 'app_not_owned_by_manager_app', 'app_not_found'])` → `slack-not-app-manager`
  - else `slack-error`

  Doc on `NOT_APP_MANAGER`: Slack can't tell "can't manage" from "another workspace" from "gone" here. "Gone" sends the admin to Disconnect, which costs every channel, so none of the three is called gone.

**Behaviour, in this order (the tests pin it):**
- Before the lock:
  - the 413 backstop
  - `bodyObject` → 400 `invalid-body`
  - `configToken(body['refreshToken'], REFRESH_TOKEN_PREFIX)` → 400 `invalid-refresh-token`
- Under the lock:
  1. `d.store.current()`. Null or not `active` → 409 `not-connected`.
  2. `!canConnect` → 409 `public-origin-not-https`.
  3. `minted = await d.api.rotateConfigToken(refreshToken)`. If it throws: `failed('try-refresh-token', err, installId)`, then 502 `refreshTokenError(err)`.
  4. `await d.api.updateApp(minted.accessToken, install.appId, buildAppManifest(install.botName, slackUrls(d.publicOrigin, install.installId)))`. If it throws: `failed('check-app', err, installId)`, then 502 `replaceCheckError(err)`. **This comes before the store. Do not mirror Rename's store-first order:** there, the stored token was the one spent; here, the old token is untouched and must stay untouched until this passes.
  5. `if (!(await saveRotatedToken({ ...install, connectedByUserId: actor.id }, minted.refreshToken))) return INTERNAL;`. The write names the new owner.
  6. `await d.store.setConfigTokenOwner(install.installId, { userId: actor.id, addedAt: new Date(d.now()) })`. On `InstallStoreError` (a reset removed the row): `await d.secrets.remove(install, 'config-refresh-token')`, then 409 `not-connected`. Any other throw propagates to the route's 500, as Rename's `setBotName` does.
  7. `log('info', 'slack_config_token_replaced', { installId })`.
  8. `try { await deleteLeftoverApps(minted.accessToken); } catch (err) { failed('leftover-apps', err, installId); }`. Best-effort: the replace has already happened.
  9. `json(200, {})`.

**Test-helper changes** (`admin-routes.test.ts`):
- `world()` gains `replace: (body: unknown = { refreshToken: SECOND_REFRESH }, as: TestUser | null = ADA) => call('POST', '/admin/slack/replace-token', { as, body })`.
- The fake vault gains `vaultAs: Array<{ hook: string; name: string; userId: string }>`. `credentials:get` records `input.userId`; set and delete record `ctx.userId`. Leave `vaultCalls` exactly as it is, because `:1638` and `:1814` compare its entries whole.
- The route-table test becomes "exactly the eight admin routes", plus `'POST /admin/slack/replace-token'`. The gate loop covers the new route without changes.
- `const ONE_REPLACE = ['store:current', 'slack:rotateConfigToken', 'slack:updateApp', 'vault:set config-refresh-token', 'store:setConfigTokenOwner', 'store:leftoverApps']`.

- [ ] **Step 1: Write the failing tests** in a new `describe('POST /admin/slack/replace-token (TASK-1128)')`. Every world below is `connectedWorld()` unless it says otherwise. There, Connect stored `mintedRefresh(1)` as Ada.

  a. `'Grace replaces the token Ada added: the pasted token is tried once, Slack gets the app's whole manifest with the token it minted, then the minted refresh token is stored and the row moves; the install, its id and its other secrets stay'`
     - Act: `w.advance(86_400_000)`, then `replace(…, GRACE)`.
     - Answer: `res.body` toStrictEqual `{}`. The trail slice equals `ONE_REPLACE`: no `store:remove*`, no vault delete.
     - Slack calls: `[{ rotateConfigToken, [SECOND_REFRESH] }, { updateApp, [MINTED_ACCESS, APP.appId, buildAppManifest('Canopy Bot', slackUrls(ORIGIN, installId))] }]`.
     - Vault: `config-refresh-token === mintedRefresh(2)`. bot-token, signing-secret and client-secret are unchanged.
     - Row:
       - `installId`, `status: 'active'` and `botName` unchanged
       - `connectedByUserId: GRACE.id`
       - `configTokenAddedAt: new Date(NOW_MS + 86_400_000)`
       - `createdAt: new Date(NOW_MS)`
     - Logs: `w.lines` equals `[{ level: 'info', msg: 'slack_config_token_replaced', fields: { installId } }]`.

  b. `'after a replace, the vault is read and written as the admin who replaced it, and Rename then Disconnect use the replaced token'`
     - The replace's `vaultAs` entry is `{ hook: 'credentials:set', name: 'config-refresh-token', userId: GRACE.id }`.
     - `status()` → `connectedBy: 'Grace Hopper'`, `connectedAt` = the replace time.
     - `rename()`, as Ada → 200. Its rotate sends `mintedRefresh(2)`. Its `vaultAs` get and set both name `GRACE.id`.
     - `disconnect()` → `appDeleted: true`. Its rotate sends `mintedRefresh(3)`, and its get names `GRACE.id`.

  c. `'checked before the lock: not a JSON object → 400 invalid-body; no usable refresh token → 400 invalid-refresh-token; neither touches anything'`
     - `invalid-refresh-token` cases: `{}`, `{ refreshToken: ACCESS }` (an access token in the refresh box), a bare `'xoxe-'`, 513 characters, an embedded space.
     - Plus the 413 backstop.
     - Each leaves `w.trail` slice `[]`.

  d. `'→ 409 not-connected with nothing connected or an unfinished install; → 409 public-origin-not-https on an http origin; none touches the vault or Slack'`
     - Mirror Rename's test (`:2430-2468`), including the hand-built active row on `HTTP_ORIGIN`.

  e. `'Slack refusing the pasted token → 502 slack-refresh-token; anything else at the try → 502 slack-error; nothing is stored, the row is unchanged, and the old token still renames'`
     - Set up: save `w.slack.on.rotateConfigToken` first, then `failRotate`.
     - `slack-refresh-token` codes: `invalid_refresh_token`, `invalid_auth`, `token_revoked`, `account_inactive`.
     - `slack-error` codes: `timeout`, `network`, `http-503`, `bad-response`, `ratelimited`, plus a plain `Error`, which logs at error.
     - For each:
       - the trail stops at `slack:rotateConfigToken`
       - the vault still holds `mintedRefresh(1)`, and the row still names Ada
       - exactly one line: `slack_admin_failed { installId, stage: 'try-refresh-token', code }`, at warn for Slack's codes and error for the plain `Error`
     - Restore rotate, then `rename()` → 200, rotating `mintedRefresh(1)`.

  f. `'Slack refusing the check: a token that can't manage or can't see this app → 502 slack-not-app-manager, never slack-app-gone; a dead token → slack-refresh-token; anything else → slack-error; nothing is stored and the old token still renames'`
     - `updateApp` throws these codes:
       - `no_permission`, `app_not_owned_by_manager_app`, `app_not_found` → `slack-not-app-manager`
       - `invalid_auth`, `token_revoked` → `slack-refresh-token`
       - `invalid_manifest`, `ratelimited`, `timeout`, `http-500`, plain `Error` → `slack-error`
     - For each:
       - the trail stops at `slack:updateApp`
       - the vault still holds `mintedRefresh(1)`, and the row is unchanged
       - one line at stage `check-app`
     - Restore `updateApp`, then `rename()` → 200.

  g. `'storing the minted token failing → 500 internal: the old token and the row stay, one error line; a retry while Slack still honours the pasted token lands'`
     - Set up: `vaultFailures.set('credentials:set config-refresh-token', connectionReset())`.
     - First replace → `{ error: 'internal' }`:
       - the vault still holds `mintedRefresh(1)`, and the row still names Ada
       - lines are `[{ level: 'error', msg: 'slack_admin_failed', fields: { installId, stage: 'save-config-token', code: 'ECONNRESET' } }]`
     - Retry: clear the failure, set `w.slack.rotatedStillWork = true`, and replace again → 200. The vault now holds `mintedRefresh(3)`.

  h. `'the row write failing after the store → 500 internal; the vault holds the new token (Slack took it for this app) and the row still names Ada'`
     - Set up: `memory.failures.set('setConfigTokenOwner', connectionReset())`.
     - The vault holds `mintedRefresh(2)`, and the row still names Ada.
     - Lines are `[{ level: 'error', msg: 'slack_admin_failed', fields: { installId, stage: 'save-owner', code: 'ECONNRESET' } }]` (review round 1; the plan first had the route-level `replace-token` line).

  i. `'the install removed meanwhile (a reset) → the token just stored is deleted again → 409 not-connected'`
     - Set up: `failures.set('setConfigTokenOwner', new InstallStoreError('install-not-active'))`.
     - The last trail entry is `vault:delete config-refresh-token`. The vault has no `config-refresh-token`. No log lines.

  j. `'leftover apps go with the minted access token after the replace, and are forgotten; a refusal keeps one and a list fault is logged, and neither changes the 200'`
     - World 1:
       - Set up: `leaveApp(w, LEFT_1)` and `leaveApp(w, LEFT_2)`.
       - Expect `deleteApp` calls `[MINTED_ACCESS, LEFT_1.appId]`, then `[MINTED_ACCESS, LEFT_2.appId]`, both after `store:setConfigTokenOwner`. The leftover list ends empty.
     - World 2: LEFT_1's delete throws `SlackApiError('apps.manifest.delete', 'no_permission')`.
       - 200. LEFT_1 is kept and LEFT_2 is gone.
       - Lines: the `slack_config_token_replaced` info line, then one warn line: `{ installId: LEFT_1.installId, stage: 'delete-leftover-app', code: 'no_permission' }`.
     - World 3: `failures.set('leftoverApps', connectionReset())`.
       - 200, and the token and row are replaced.
       - Lines: the info line, then one error line: `{ installId, stage: 'leftover-apps', code: 'ECONNRESET' }`.
     - If #1199 has merged, `deleteLeftoverApps` also logs `slack_leftover_app_deleted` at info. Include those lines in the exact `w.lines` expectations.

  k. `'two replaces at once take turns: the second finds the pasted token spent and answers 502 slack-refresh-token; the first one's token stays'`
     - Use the `deferred()` gate on the first's `updateApp`, as in `'two renames at once'` (`:2678`).
     - The first, as Grace → 200. The second, as Ada → 502 `slack-refresh-token`.
     - The vault holds `mintedRefresh(2)`, and the row names Grace.

  l. `'a replace started while a Disconnect is in flight waits for it, then answers 409 not-connected and stores nothing'`
     - Gate Disconnect's `deleteApp`.
     - Disconnect → `appDeleted: true`. Replace → 409.
     - No rotate of `SECOND_REFRESH` and no `credentials:set` from the replace.

  m. In `'secrets never leave'`:
     - Add `await happy.replace()` before `happy.rename()`.
     - Add these worlds:
       - the replace's rotate throwing `leak('rotate')`
       - `updateApp` throwing `leak('updateApp')`
       - the vault set throwing `leak('vault')`
       - `setConfigTokenOwner` throwing `leak('setConfigTokenOwner')`
       - a leftover delete throwing `leak('deleteApp')`
     - The existing asserts must hold: no secret, no `MINTEDREFRESH`, only the four keys.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack test -- admin-routes.test.ts`. Expected: a–m FAIL with "no route POST /admin/slack/replace-token" and the eight-route pin. Nothing else fails.
- [ ] **Step 3: Implement** the route, `replaceCheckError` and the comments above. Update the `plugin.test.ts` pin.
- [ ] **Step 4: Run** `pnpm --filter @ax/channel-slack test` (`plugin.test.ts` and `store.test.ts` need Docker) and `pnpm --filter @ax/channel-slack build`. Expected: PASS.
- [ ] **Step 5: Commit**, then run the mutation check on the committed tree.
  - Use `git checkout HEAD -- packages/channel-slack/src/admin-routes.ts` between mutants, and confirm `git status --short` is empty before and after each.
  - Predict first, then run. Each mutant must fail:
    - M1, store before the check (move step 5 above step 4): f fails, because the vault holds `mintedRefresh(2)` after a refused check.
    - M2, no check at all (delete step 4): a and f fail.
    - M3, store as the old owner (`saveRotatedToken(install, …)`): b fails.
    - M4, no reset-race undo: i fails.
    - M5, `app_not_found` → `slack-app-gone`: f fails.
- [ ] **Step 6: Security checklist.** Run the `security-checklist` skill over this task's diff. Paste its Sandbox, Injection and Supply-chain lines, and any residual beyond the planner's (shard row "Residuals"), into the decisions shard as a new row.

### Task 3: Reachable from the canary; the acceptance end to end with the real vault [tier: integration]

**Files:**
- Test: `presets/memory/src/__tests__/canary.test.ts` (the channel-slack `it`, `~:738-790`; add TASK-1128 to its title)
- Test: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`: a new constant `SECOND_CONFIG_REFRESH_TOKEN = join('xo', 'xe-', '1-', 'COMPOSITIONSECONDREFRESH')`, and one new `it` appended **last** in the describe, so no later test sees the changed owner.

**Interfaces:**
- Consumes: Task 2's route and wire contract, Task 1's `config_token_added_at`, and the file's own helpers (`supportChannel`, `bindings`, `readSecret`, `query`, `mention`, `deliver`, `invokedTurn`, `channelTurnCalls`, `dropAgent`, `callRoute`, `jsonBody`, `rotatedRefreshToken`, `rotateSeq`).

- [ ] **Step 1: Canary (invariant 3).** After the forget-leftover-app block:
  - A POST to `/admin/slack/replace-token` without the CSRF header → 403.
  - `apiJson('POST', '/admin/slack/replace-token', CANARY_ADMIN, {})` → `{ status: 400, json: { error: 'invalid-refresh-token' } }`. That is the route's own answer: an unmounted POST gets the router's 405. `{}` keeps token-shaped literals out of source.
- [ ] **Step 2: Composition test:** `'an admin replaces the configuration token: the install, its channel and every secret stay, the plugin reads them as the new admin, and Rename then rotates the new token (TASK-1128)'`.
  1. `supportChannel()`, `invokes.length = 0`, then `before = await bindings()`. Read the install row's `connected_by_user_id` and `config_token_added_at`.
  2. Set `actor = { id: 'usr_grace', isAdmin: true }`, then replace with `SECOND_CONFIG_REFRESH_TOKEN` → `{ status: 200, body: {} }`.
  3. The Slack calls since the mark are exactly `['tooling.tokens.rotate', 'apps.manifest.update']`:
     - the rotate body is `{ refresh_token: SECOND_CONFIG_REFRESH_TOKEN }`
     - the update's auth is `Bearer ${ROTATED_ACCESS_TOKEN}`, and its `body.app_id` is `APP_ID`
  4. Vault:
     - `readSecret(installId, 'config-refresh-token') === rotatedRefreshToken(rotateSeq)`; keep this value for step 7
     - bot-token is `BOT_TOKEN` and signing-secret is `SIGNING_SECRET`
  5. The row:
     - same `install_id`, `status` still `'active'`
     - `connected_by_user_id = 'usr_grace'`
     - `config_token_added_at` differs from step 1's value

     `await bindings()` must equal `before`. `GET /admin/slack` → `{ state: 'connected', connectedBy: 'usr_grace', connectedAt: <the row's config_token_added_at ISO> }`. Don't compare across clocks: `created_at` is the database's and the replace uses the host's.
  6. Set `actor = null`. MEL mentions the bot in `SUPPORT_CHANNEL` → 200, and `invokedTurn(1).ctx.agentId === agentId`. The turn's Slack calls carry `Bearer ${BOT_TOKEN}`. This proves ingress and the router still read the signing secret and bot token while naming the new admin.
  7. As Grace, rename to `'Canopy Helper'` → 200. Its rotate body is `{ refresh_token: <step 4's token> }`.
  8. `actor = null; await dropAgent(agentId);`
- [ ] **Step 3: Run**, one package at a time:
  - `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/preset-memory test -- canary`
  - `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/preset-k8s test -- channel-slack-composition`

  Expected: PASS. To show the new `it` bites, temporarily remove step 6's `setConfigTokenOwner` call from `admin-routes.ts` (committed tree, `git checkout HEAD --` after). Step 5's owner assertion must fail. If local Docker can't run these, say so in the handoff; don't skip silently.
- [ ] **Step 4: Commit** `[TASK-1128] presets: Slack token replace reachable from the canary; composition proves channels and secrets survive`.

### Task 4: Admin › Slack: Replace, and copy that stays true [tier: integration]

**security-checklist: REQUIRED.** The pasted secret is handled in the browser. Invoke the `shadcn` skill first. No new primitive is needed: Dialog, Field, Input, Button and Alert are installed.

**Files:**
- Modify: `packages/channel-web/src/lib/slack-admin.ts`
  - header `:6-11` and `:23-26`, which becomes: "The pasted configuration tokens go out in one body each (Connect's two, Replace's refresh token) and nowhere else". #1200 edits this same sentence.
  - a `REPLACE_TOKEN_PATH` constant, the new function, `SLACK_ERROR_COPY`, `slackErrorCopy`
- Modify: `packages/channel-web/src/components/admin/SlackTab.tsx`
  - header `:14-15` ("…who added the token and when (with Replace)") and `:21` ("THE PASTED TOKENS (Connect's two, Replace's one) NEVER LIVE IN REACT STATE")
  - `Notice`, `Actions`, `DisconnectedNotice`, `LeftoverAppsNote` `:228-229`, the new `ReplaceTokenForm` and `ReplaceTokenDialog`, the `ConnectedCard` row `:753-758`, and the `SlackTab` notice
- Test: `packages/channel-web/src/__tests__/admin-slack.test.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/SlackTab.test.tsx` (add `replaceSlackConfigToken: vi.fn()` to the `vi.mock` list)

**Interfaces:**
- Consumes: Task 2's wire contract, by shape.
- Produces: `export async function replaceSlackConfigToken(refreshToken: string): Promise<void>`. It POSTs `{ refreshToken }` to `/admin/slack/replace-token` through the existing `post()`, with the write headers and `httpFetch`. A non-ok answer throws `SlackAdminError`.
- Produces: `slackErrorCopy` maps `slack-not-app-manager` → `{ field: null, message }`. The existing `invalid-refresh-token` → `refreshToken` field mapping is reused.

**Copy (exact):**

`SLACK_ERROR_COPY` changes:
- `'slack-refresh-token'`: "Slack didn't accept the refresh token. Generate a new token and try again." Shared by Connect and Replace. It used to say "…a new pair and paste both again", which is wrong for a one-field form.
- New `'slack-not-app-manager'`: "Slack says that token can't manage this Slack app. Paste a refresh token from someone who can manage it, in the same Slack workspace. If this Slack app is no longer listed on api.slack.com/apps, Disconnect and connect again instead."
- `'slack-config-token'`: "We can't use the configuration token we have for this Slack app, so we couldn't rename the bot. Replace the token with one from someone who can manage this Slack app, then try again."
- `'public-origin-not-https'`: "Our public address isn't https right now, so we can't update the Slack app. Whoever runs this server can fix that."

Replace dialog:
- Title: "Replace the configuration token"
- Description: "Do this when the token we have stops working, or when whoever added it is leaving. Conversations and connected channels keep working."
- Steps (an `ol`, styled like Connect's):
  1. "Open {SlackAppsLink}. Under **Your App Configuration Tokens**, click **Generate Token** for this workspace. The token has to come from someone who can manage this Slack app."
  2. "Paste its refresh token below. We keep it encrypted, and nobody can read it back."
- The `TokenField`: id `slack-replace-refresh-token`, label "Refresh token", hint "Starts with xoxe-".
- Buttons: "Cancel" (outline) and "Replace token"; while busy, `<Busy>Replacing…</Busy>`.

Notices and notes:
- Success notice, a non-destructive `Alert` above the tab: "Token replaced. We use the new one from now on. To retire the old one, whoever generated it can click **Revoke** for it on {SlackAppsLink}, under **Your App Configuration Tokens**."
- `DisconnectedNotice`: "Slack is disconnected. One more step that Slack doesn't let us do: on {SlackAppsLink}, under **Your App Configuration Tokens**, whoever generated the token clicks **Revoke**." After a replace, "only you" may be false.
- `LeftoverAppsNote`, one app: "We couldn't confirm this Slack app was deleted, so it may still be on Slack:"
- `LeftoverAppsNote`, several: "We couldn't confirm these Slack apps were deleted, so they may still be on Slack:"

**Shape:**
- Mirror `RenameDialog`/`RenameForm`:
  - The form sits under `DialogContent`, so every opening remounts it empty.
  - The dialog owns `busy` and refuses to close mid-request.
  - On success or a state change, it closes itself before calling the action.
- Reuse `TokenField`. Read the value once, trim it, and clear it before the request.
- Error routing:
  1. Check `public-origin-not-https` first, and show it in the dialog, as Rename does.
  2. `slackStateChanged(err)`: close, then `onChanged()`.
  3. Anything else goes through `slackErrorCopy(err)`. A `refreshToken` field error goes under the field; `null` goes in a destructive `Alert` in the dialog.
  4. After any error, focus the field.
- The `ConnectedCard` "Configuration token" row: `<dd className="flex items-center gap-3">` holding the "Added by …" `<span className="text-muted-foreground">` and `<Button variant="outline" size="sm">Replace</Button>`, the same shape as the Bot name row.
- `Actions` gains `onReplaced: () => void`. `SlackTab` sets `{ kind: 'replaced' }` and re-reads.

- [ ] **Step 1: Write the failing tests.**

  `admin-slack.test.tsx`:
  - `'replaceSlackConfigToken POSTs exactly the refresh token with the CSRF header'`: url `/admin/slack/replace-token`, the body is exactly `{ refreshToken }`, and `x-requested-with: ax-admin`.
  - `'a refused replace carries the status and the server's code'`.
  - The copy table: the new entry and the three changed ones, as exact strings, and `slackErrorCopy(new SlackAdminError(502, 'slack-not-app-manager'))` → `{ field: null, message: <copy> }`.

  `SlackTab.test.tsx`, a new `describe('Replace the configuration token')`:
  1. `'the connected card shows who added the token and when, with Replace; the dialog asks for one refresh token from someone who can manage the app'`
     - the exact title, description and steps
     - one password field labelled "Refresh token" with hint "Starts with xoxe-"
     - no access-token field
  2. `'Replace sends the pasted refresh token, trimmed; the field is empty as the request goes out and the token is never on the page; then the dialog closes, the notice says the old one can be revoked, and the tab reads again'`
     - `replace` was called with `REFRESH`
     - the input's value is `''`
     - `document.body.innerHTML` doesn't contain `REFRESH`
     - the notice text is exact, and its link is `https://api.slack.com/apps`
     - `fetchSlackStatus` was called twice
  3. `'a token Slack refuses, or one that can't manage this app, says so in the dialog, never the raw code; the field is empty and focused'`. Cover both 502 codes.
  4. `'a malformed token shows under the field'`: `invalid-refresh-token`.
  5. `'refused for want of https: says so in the dialog instead of refreshing in a loop'`. The status is not read again.
  6. `'someone else disconnected meanwhile: it refreshes and says so'`: 409 `not-connected`.
  7. `'is one request at a time: Replace token and Cancel wait while Slack answers'`.
  8. `'Cancel closes without a request; opening again starts with an empty field'`.

  Update these existing pins:
  - the leftover-note sentences (`:146-215`)
  - the Disconnect notice test `:517-536`. It finds the note by `/One more step/`; keep the `not.toHaveTextContent("We couldn't remove…")` line.
  - Rename's `'a configuration token Slack no longer accepts…'` (`:620`) and the https test (`:631`), which get the new copy
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test -- SlackTab admin-slack`. Expected: the new and updated tests FAIL, and nothing else does.
- [ ] **Step 3: Implement** the lib, then the tab.
- [ ] **Step 4: Run** the same tests, then `pnpm --filter @ax/channel-web build`, because channel-web's tsc type-checks its tests. Then `pnpm lint`. Expected: all clean.
- [ ] **Step 5: Commit** `[TASK-1128] channel-web: Replace the Slack configuration token; error and leftover copy that stays true`.
- [ ] **Step 6: Security checklist.** Run the `security-checklist` skill over this task's diff and record the three lines in the shard. Points to cover:
  - an uncontrolled password input: no React state, no `value` attribute
  - cleared before the request
  - one same-origin POST with the CSRF header
  - never rendered, logged or echoed
  - error paths render fixed copy only

### Task 5: The design doc and the changeset [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`
- Create: `.changeset/slack-replace-config-token.md`

- [ ] **Step 1: Design §3, Renaming** `:278-281`. Replace "…, or the Slack app was deleted on Slack's side, the tab says so and the fix is Disconnect, then Connect again." with: "If the stored token can't be used (Slack refuses it, or its owner can't manage the app), the tab says so and the fix is **Replace** (below), which keeps every channel connected. If the Slack app was deleted on Slack's side, the fix is Disconnect, then Connect again."
- [ ] **Step 2: Design §3.** Add a paragraph right after Renaming:

  > **Replacing the token:** Admin › Slack → **Replace**, next to who added the configuration token (TASK-1128), once Slack is connected. The admin pastes one value, a refresh token, from someone who can manage this Slack app. AX tries it once (`tooling.tokens.rotate`) and sends the app's whole manifest with the access token that rotate minted (`apps.manifest.update`, as Rename does). Slack taking it shows that the token's owner can manage this app. Only then does AX store the minted refresh token in place of the old one and record who added it and when. The install, its channels, the bot token and the other secrets stay as they are, and if any step fails, the old token stays. AX never reads or rotates the old token here, so it keeps working on Slack until whoever generated it revokes it, and the tab says so. A replace also tries again to delete any Slack apps listed as left over. Whether another admin's token can manage an app the first admin's token made, or only an app collaborator's can, is unmeasured (§8 Q5).
- [ ] **Step 3: Design §3 secrets bullet** `:292-295`. Replace the last three sentences with: "The token AX holds changes with every rotate whose new token it manages to save (step 5), and with **Replace** (above), which also changes who added it and when." Make the bullet's first sentence read "who added the token and when".
- [ ] **Step 4: Design §8.** Add Q5:

  > 5. **Whose configuration token can manage the shared app?** Can a second admin's configuration token update and delete an app the first admin's token made, or must they be added as a collaborator on the app first? Replace (TASK-1128) is built for either answer: it sends the app's manifest before it keeps a new token, and turns away one Slack says can't manage the app. Measure it on the next real-Slack walk. The answer decides the form's copy, and whether it should link to the app's collaborators page.
- [ ] **Step 5: Changeset.** Bump `'@ax/channel-slack': patch` and `'@ax/channel-web': patch`. Text:

  > Admins can now replace Slack's configuration token from Admin > Slack: click **Replace** next to who added it, and paste a refresh token from someone who can manage the Slack app. Before we switch over, we check with Slack that the new token can manage the app. A token that can't is turned away, and the old one keeps working. Connected channels, conversations and the bot carry on as they were, so a token that stopped working (or whose owner is leaving) no longer means disconnecting and connecting again. Also: the note about Slack apps we couldn't delete now says we couldn't *confirm* they were deleted, since sometimes they're already gone. And the note after Disconnect now says the Revoke step belongs to whoever generated the token.
- [ ] **Step 6: Commit** `[TASK-1128] docs: Slack design and changeset for replacing the configuration token`.

---

## For the builder's handoff

- **`followups`:** one real-Slack walk card covering:
  1. A second admin's config token, from someone who isn't an app collaborator: what do `tooling.tokens.rotate` and `apps.manifest.update` answer? We expect a refusal that maps to `slack-not-app-manager`.
  2. The same admin after being added as a collaborator: Replace works, then Rename and Disconnect work.
  3. A token from another workspace: what does `apps.manifest.update` answer?
  4. Replace with the same admin's fresh token: channels still answer, and "Added by" changes.
  5. After Replace, Revoke the old token on its owner's page.
  6. Leftover deletes with a replacement token.
- **`learnings`:**
  - The vault ignores the `userId` for global-only `slack:` reads, so an owner change never needs a secret rewrite.
  - `config_token_added_at` now backs "Added on". `created_at` is only the row's age.
  - Replace checks with `apps.manifest.update` before it stores anything.
