# TASK-1132: A Slack app Disconnect couldn't delete is remembered, and the next Connect deletes it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A refused install followed by a second Connect leaves exactly one Slack app, and Admin > Slack says which app may still need deleting by hand.

**Architecture:** When Disconnect (Cancel is the same route) can't delete the Slack app, the install row still goes, but its app id and name move, in the same SQL statement, into a new channel-slack table, `channel_slack_v1_leftover_apps`. The next Connect deletes those apps first, with the access token the admin just pasted, and forgets each one Slack deleted or no longer has. While nothing is connected, `GET /admin/slack` lists them and the Slack tab links each one to its own settings page on api.slack.com.

**Tech Stack:** TypeScript, Kysely + Postgres (testcontainers), vitest, `@ax/channel-slack` (host plugin), `@ax/channel-web` (React, shadcn `Alert`).

**Spec:** the card (TASK-1132, from the TASK-1097 walk, `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md:64`) and `docs/plans/2026-11-09-channel-slack-design.md` §3. Planner decisions, the alternatives and the evidence: `.claude/memory/decisions/2026-11-18-TASK-1132.md` (read it first; Task 2 appends its security-checklist row there).

## The problem, from the code (the card's premise is half right)

- **A refused callback leaves nothing behind by itself.** The admin gate's refusal (`unauthenticated`: the admin's cookie wasn't on the public address) spends nothing and leaves the install `pending` (`admin-routes.ts:733-737`, pinned by `admin-routes.test.ts:634`). Continue in Slack mints a fresh state for the SAME app (`admin-routes.ts:597-608`): the card's "reuse that app" already exists. Connect answers 409 `already-connected` while any install row exists, pending included (`admin-routes.ts:591`).
- **So a second app needs the pending row removed first, and that is Cancel = `POST /admin/slack/disconnect`** (`admin-routes.ts:697-708`). It deletes the app with an access token minted from the stored refresh token. When that fails (the token is dead, revoked or missing, or Slack doesn't answer) it still removes the row and the four secrets, answers `{ appDeleted: false }`, and the app id is gone with the row. Nothing can delete that app afterwards, and the next Connect makes a second one.
- **The card's two cases are one bug.** "Disconnect after the stored refresh token died answers `appDeleted:false`" is the same path on an active install. On the 11-15 walk the 01:27 Cancel most likely failed because the stored token was already dead (the next Connect "used a new pair"; inferred, not recorded).

## Design (decided; the decisions shard has the alternatives)

- **Remember, don't forget.** New table `channel_slack_v1_leftover_apps (install_id PK, app_id, bot_name, left_at)`. `InstallStore.remove(installId, { appLeft: true })` deletes the install row and its bindings AND inserts the app into the leftover table in ONE statement (a data-modifying CTE over the delete's `RETURNING`). Disconnect passes `{ appLeft: !appDeleted }`. A row delete that fails (Disconnect's 500) remembers nothing; the retry decides again.
- **Connect cleans up first.** After the two 409 checks and before `apps.manifest.create`, under the admin lock: for each leftover (oldest first, at most `LEFTOVER_APPS_MAX` = 10), `apps.manifest.delete` with the pasted access token. Deleted, or `app_not_found`: forget it. Anything else: keep it and log `slack_admin_failed { installId: <the leftover's>, stage: 'delete-leftover-app', code }`. A failed forget logs `stage: 'forget-leftover-app'`. Neither stops the Connect. A store fault reading the list throws (the route's 500) before any Slack call.
- **The status lists them while not connected.** `not-connected` gains `leftoverApps: Array<{ botName, appId }>`, always present. `pending` and `connected` don't change.
- **The tab names them.** One `Alert` above the Connect form (or the https explainer), each app's name linking to `https://api.slack.com/apps/<appId>`. The live app and a leftover usually share a name, so a link by id is the only safe "delete it yourself". The old transient sentence "We couldn't remove the Slack app itself. Delete it on the same page." goes: the persistent note replaces it.
- **Not changing:** the Connect and Disconnect answers, Rename, the OAuth callback, a bootstrap reset (it still forgets installs; it already logs each app id with a delete hint), Connect's own undo, any hook, IPC action or plugin manifest. No boundary review: `GET /admin/slack` is a plain HTTP admin route that channel-web mirrors by shape (no `@ax/ipc-protocol` contract).

## Global Constraints

- Log lines stay code-only: `slack_admin_failed` fields are exactly `installId`, `stage`, `code` (the leak test, `admin-routes.test.ts:2056-2061`, allows only `installId`, `reason`, `stage`, `code`). New stage literals: `'delete-leftover-app'`, `'forget-leftover-app'`.
- No token value in any response body, log line or error. The pasted access token goes only to slack.com, as `Authorization: Bearer`, through the existing client.
- Fake tokens come from `packages/channel-slack/src/__tests__/fake-slack-tokens.ts` helpers, never a token-shaped literal. Before each commit: `git diff --cached | grep -nE 'xox[bpe]-[0-9]{10,13}-'` prints nothing.
- No literal invisible characters in `packages/channel-slack/src` (`source-hygiene.test.ts` fails on them).
- `--filter` goes before the script: `pnpm --filter @ax/channel-slack test`. Package `tsc` excludes test files everywhere except channel-web, so also run `pnpm --filter @ax/channel-slack build` and `pnpm --filter @ax/channel-web build`.
- `store.test.ts`, `plugin.test.ts` and the presets' tests are Docker-backed: set `DOCKER_HOST` as CLAUDE.md "Docker-backed tests" says.
- After Task 2 and again after Task 4, run the package AND its dependents: `pnpm -r --no-bail --filter "...@ax/channel-slack" --filter "...@ax/channel-web" run test` (this reaches `@ax/cli`, `@ax/preset-k8s`, `@ax/preset-memory`; `.claude/memory/mistakes/2026-11-13-TASK-1094.md` is why).
- Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- UI: invariant 6. Installed shadcn primitives (`Alert`, `AlertDescription`) and semantic tokens only; invoke the `shadcn` skill (`-c packages/channel-web`) before editing `SlackTab.tsx`. No "AX" in any UI sentence (white-label; TASK-1093 decisions line 39). Write apostrophes in JSX text as `&apos;`, like the rest of the file.
- User-facing prose (UI copy, changeset): the CLAUDE.md voice. Copy below is pinned; change a word only if it is false.
- Memory: new rows go only to `.claude/memory/decisions/2026-11-18-TASK-1132.md`. Never edit a root archive or delete a memory line.
- GitHub text (PR body, comments): `@ax` only inside backticks.

## Review Focus

1. **The new token can't delete a leftover** (another person's token, another workspace, Slack down or rate-limited) → Connect still answers 200 and creates the new app; the leftover stays listed; one warn line naming the leftover's own install id. Pinned: Task 2 test f.
2. **The admin already deleted the leftover by hand** → the next Connect's delete answers `app_not_found` and it is forgotten silently, never reported as a failure. Pinned: Task 2 test e.
3. **Disconnect's row delete fails after Slack refused the app delete** → 500, nothing remembered (same statement), secrets kept; the retry remembers the app exactly once. Pinned: Task 2 test d; Task 1 store tests 3 and 4.
4. **Two apps with the same name on api.slack.com** (the live one and a leftover, both "ax") → each listed name links to its own app id's page; nothing tells the admin to find it by name. Pinned: Task 4 test "several apps".
5. **A Connect refused before Slack, or a store fault reading the list** → no leftover is touched; a read fault answers 500 before any Slack call. Pinned: Task 2 tests g and h.

---

## Files

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/limits.ts` | `LEFTOVER_APPS_MAX` | 1 |
| `packages/channel-slack/src/migrations.ts` | new table + its type; header paragraph | 1 |
| `packages/channel-slack/src/store.ts` | `LeftoverApp`; `remove(installId, { appLeft })`; `leftoverApps()`; `forgetLeftoverApp()` | 1 |
| `packages/channel-slack/src/__tests__/store.test.ts` | TRUNCATE list; new describe | 1 |
| `packages/channel-slack/src/__tests__/admin-routes.test.ts` | in-memory store mirror (1); fake Slack `live`; new and extended tests (2) | 1, 2 |
| `packages/channel-slack/src/__tests__/plugin.test.ts` | TRUNCATE list (1); exact status body (2); end-to-end test (3) | 1, 2, 3 |
| `packages/channel-slack/src/admin-routes.ts` | `SlackStatus`; status; Connect's leftover pass; Disconnect's `appLeft`; header and comments | 2 |
| `presets/memory/src/__tests__/canary.test.ts` | exact status body (`:740-743`) | 2 |
| `packages/channel-web/src/lib/slack-admin.ts` | `LeftoverSlackApp`; status parse; `slackAppSettingsUrl` | 4 |
| `packages/channel-web/src/components/admin/SlackTab.tsx` | `LeftoverAppsNote`; not-connected view; `DisconnectedNotice` loses `appDeleted`; header | 4 |
| `packages/channel-web/src/__tests__/admin-slack.test.tsx` | parse and URL tests | 4 |
| `packages/channel-web/src/components/admin/__tests__/SlackTab.test.tsx` | fixtures; new and changed tests | 4 |
| `docs/plans/2026-11-09-channel-slack-design.md` | §3 Connect step 3 and the Disconnect bullet | 5 |
| `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md` | "Found later" note on line 64 | 5 |
| `.changeset/slack-leftover-apps.md` | new: patch for `@ax/channel-slack` and `@ax/channel-web` | 5 |

---

### Task 1: The store remembers an app Disconnect couldn't delete `[tier: sensitive]`

Migration (hard to reverse) and an atomic multi-table statement. No security-checklist (no secret, egress, IPC or untrusted input).

**Files:**
- Modify: `packages/channel-slack/src/limits.ts` (Installing section, after `LABEL_MAX` at `:28`)
- Modify: `packages/channel-slack/src/migrations.ts` (header `:3-60`, types `:61-103`, `runMigrations` `:105-173`)
- Modify: `packages/channel-slack/src/store.ts` (`InstallStore` `:35-82`, `remove` `:263-273`, two new methods)
- Test: `packages/channel-slack/src/__tests__/store.test.ts` (TRUNCATE `:29-31`; new describe after the bindings describe ending `:369`)
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts` (`memoryStore` `:174-292` only)
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts:365` (TRUNCATE list only)

**Interfaces:**
- Produces:
  - `limits.ts`: `export const LEFTOVER_APPS_MAX = 10;` doc: "The most Slack apps Disconnect couldn't delete that the store lists, oldest first: what one Connect tries to delete and the Slack tab names."
  - `migrations.ts`: `export interface ChannelSlackLeftoverAppsTable { install_id: string; app_id: string; bot_name: string; left_at: ColumnType<Date, Date | undefined, never>; }` and `ChannelSlackDatabase.channel_slack_v1_leftover_apps`.
  - `store.ts`:
    ```ts
    /** A Slack app AX made that Disconnect couldn't delete, so it may still be on Slack. No secret. */
    export interface LeftoverApp {
      /** The removed install's id: how logs name it, and the key to forget it by. */
      installId: string;
      appId: string;
      botName: string;
      leftAt: Date;
    }
    // InstallStore:
    remove(installId: string, o?: { appLeft?: boolean }): Promise<void>;
    leftoverApps(): Promise<LeftoverApp[]>;           // oldest first (left_at, then install_id), at most LEFTOVER_APPS_MAX
    forgetLeftoverApp(installId: string): Promise<void>; // a missing one is not an error
    ```
  - Test twin: `memoryStore(...)` also returns `leftovers: Map<string, LeftoverApp>`.

- [ ] **Step 1: Write the failing store tests** (`store.test.ts`)

  First add `channel_slack_v1_leftover_apps` to the `beforeEach` TRUNCATE (`:30`), and a helper beside `withInstallDeleteTrigger` (`:93`): `withLeftoverInsertTrigger(body, fn)`, the same shape but `BEFORE INSERT ON channel_slack_v1_leftover_apps` with its own function and trigger name (`channel_slack_store_test_on_leftover`).

  New `describe("an app Disconnect couldn't delete is remembered with the install's removal (TASK-1132)")`:
  1. `'remove with appLeft moves the app id and name into the leftover list, and the bindings still go'`: `a = await pending(); await bind(a, 'C07SUPPORT1'); await store.remove(a, { appLeft: true });` then `store.get(a)` is null, `bindings()` is `[]`, and `store.leftoverApps()` equals `[{ installId: a, appId: PENDING.appId, botName: PENDING.botName, leftAt: expect.any(Date) }]`.
  2. `'remove without appLeft, or with appLeft false, remembers nothing'`: two installs, `remove(a)` and `remove(b, { appLeft: false })`; both gone, `leftoverApps()` is `[]`.
  3. `'a failing or skipped install delete remembers nothing'`: with `withInstallDeleteTrigger("RAISE EXCEPTION 'refused in test'; RETURN OLD;")`, `remove(a, { appLeft: true })` rejects, `get(a)` is not null, `leftoverApps()` is `[]`. With `` `IF OLD.install_id = '${a}' THEN RETURN NULL; END IF; RETURN OLD;` ``, `remove(a, { appLeft: true })` resolves, the row stays, `leftoverApps()` is `[]`. Also `remove(newInstallId(), { appLeft: true })` (no such install) resolves and remembers nothing.
  4. `'if remembering the app fails, the install and its bindings stay: one statement'`: `bind(a, 'C07SUPPORT1')`; with `withLeftoverInsertTrigger("RAISE EXCEPTION 'refused in test'; RETURN NEW;")`, `remove(a, { appLeft: true })` rejects; `get(a)` is not null; `bindings()` still lists `${a}/C07SUPPORT1`; `leftoverApps()` is `[]`.
  5. `'leftoverApps lists the oldest first, at most LEFTOVER_APPS_MAX; forgetLeftoverApp drops only the one named'`: 12 installs removed with `{ appLeft: true }`; then set each row's `left_at` with raw SQL (`UPDATE channel_slack_v1_leftover_apps SET left_at = $ts WHERE install_id = $id`, 1 minute apart, in creation order) so the order is deterministic. `leftoverApps()` has length `LEFTOVER_APPS_MAX` and is the 10 oldest in order. `forgetLeftoverApp(oldest)`: the next list starts at the second and now includes the 11th. `forgetLeftoverApp(newInstallId())` resolves.
  6. `'the same install id remembered twice keeps the first (only tests reuse ids)'`: `pending(a)`, `remove(a, { appLeft: true })`, `insertPending({ installId: a, ...PENDING, appId: 'A07OTHERAPP1' })`, `remove(a, { appLeft: true })` resolves; `get(a)` is null; `leftoverApps()` holds one row with `appId: PENDING.appId`.
  7. `'removeAll leaves the leftover list alone'`: one remembered app, one live install; `removeAll()` returns only the live install; `leftoverApps()` still has the remembered app.

- [ ] **Step 2: Run them and watch them fail**

  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/store.test.ts`
  Expected: the seven new tests FAIL (`relation "channel_slack_v1_leftover_apps" does not exist`, or `store.leftoverApps is not a function`). Every existing store test still passes. If the TRUNCATE itself fails in `beforeEach`, that is the missing table too.

- [ ] **Step 3: Implement**

  - `migrations.ts`: in `runMigrations`, after the threads statements:
    ```sql
    CREATE TABLE IF NOT EXISTS channel_slack_v1_leftover_apps (
      install_id  TEXT PRIMARY KEY,
      app_id      TEXT NOT NULL,
      bot_name    TEXT NOT NULL,
      left_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    ```
    Header: add a paragraph after `channel_slack_v1_threads`:
    ```
     *   channel_slack_v1_leftover_apps — Slack apps AX made that Disconnect
     *     couldn't delete (TASK-1132): the stored configuration token was dead
     *     or revoked, or Slack didn't answer. The install's row moves its app id
     *     and name here in the statement that deletes it (store.ts), so the id
     *     is never in both tables. The next Connect deletes them with the pasted
     *     access token, and the Slack tab names them until then. Keyed by the
     *     removed install's id. No secret and no person.
    ```
  - `store.ts` `remove`: without `appLeft`, today's statement, unchanged. With `appLeft: true`, one statement (keep the two as separate literal statements; no boolean SQL parameter):
    ```sql
    WITH removed AS (
      DELETE FROM channel_slack_v1_installs
       WHERE install_id = ${installId}
      RETURNING install_id, app_id, bot_name
    ), kept AS (
      INSERT INTO channel_slack_v1_leftover_apps (install_id, app_id, bot_name)
      SELECT install_id, app_id, bot_name FROM removed
      ON CONFLICT (install_id) DO NOTHING
    )
    DELETE FROM channel_slack_v1_channels
     WHERE install_id IN (SELECT install_id FROM removed)
    ```
    Extend the method's doc: "With `appLeft`, the install's Slack app is still on Slack (Disconnect couldn't delete it): its id and name move to the leftover list in the same statement, so a later Connect can delete it."
  - `leftoverApps()`: select the four columns, `ORDER BY left_at ASC, install_id ASC LIMIT ${LEFTOVER_APPS_MAX}`, mapped to `LeftoverApp`. `forgetLeftoverApp(installId)`: `DELETE ... WHERE install_id = ${installId}`.
  - `admin-routes.test.ts` `memoryStore` (keep "the real one's rules"): a `leftovers = new Map<string, LeftoverApp>()`. `remove(installId, o)` records `[installId, o]` in `calls` (via `enter`), and only after `enter` didn't throw: if the row exists, `o?.appLeft === true` and `!leftovers.has(installId)`, set `{ installId, appId, botName, leftAt: new Date(clock()) }`; then delete the row. `leftoverApps()`: `enter('leftoverApps', [])`, sort by `leftAt` then `installId`, slice to `LEFTOVER_APPS_MAX`, return copies. `forgetLeftoverApp(installId)`: `enter('forgetLeftoverApp', [installId])`, delete. Return `leftovers` from `memoryStore`.
  - `plugin.test.ts:365`: add `channel_slack_v1_leftover_apps` to the `afterEach` TRUNCATE (its tests re-use `INSTALL_ID`, and Task 2 makes their disconnects remember apps).

- [ ] **Step 4: Run and pass**

  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/store.test.ts src/__tests__/admin-routes.test.ts src/__tests__/plugin.test.ts` then `pnpm --filter @ax/channel-slack build`
  Expected: PASS; build clean.

- [ ] **Step 5: Commit**

  `git add` the six files; message `[TASK-1132] channel-slack: the store can remember a Slack app Disconnect couldn't delete`.

---

### Task 2: Disconnect remembers the app; Connect deletes leftovers first; the status lists them `[tier: sensitive]`

**security-checklist: required.** The admin's pasted configuration access token gains a destructive use (deleting app ids read from channel-slack's own table), and app ids from Slack's answers now reach the admin UI.

**Files:**
- Modify: `packages/channel-slack/src/admin-routes.ts` (header `:21-69`, `SlackStatus` `:71-80`, a new helper after `undoConnect` `:345-357`, `status()` `:556-573`, `connect()` `:590-594`, `disconnect()` `:697-709`)
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts`
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts:687-695` (exact status body)
- Test: `presets/memory/src/__tests__/canary.test.ts:740-743` (exact status body)

**Interfaces:**
- Consumes: Task 1's `remove(installId, { appLeft })`, `leftoverApps()`, `forgetLeftoverApp()`, `LeftoverApp`, `LEFTOVER_APPS_MAX`.
- Produces (wire; Task 4 consumes it): `GET /admin/slack` answers `{ state: 'not-connected'; defaultBotName: string; canConnect: boolean; leftoverApps: Array<{ botName: string; appId: string }> }`. `leftoverApps` is always present, oldest first, at most 10, and carries nothing else per item. `pending` and `connected` bodies are unchanged. Connect's and Disconnect's answers are unchanged.
- Internal: `async function deleteLeftoverApps(accessToken: string): Promise<void>` in `createAdminRoutes`.

- [ ] **Step 1: Test fixtures** (`admin-routes.test.ts`)

  - `fakeSlack`: a `live = new Set<string>()` of the apps that exist on the fake Slack. In the `api` wrappers, after `on.createApp` resolves add its `appId`; after `on.deleteApp` resolves delete the `appId`. Expose `live` on the returned object. The default behaviours don't change.
  - Constants: `const SECOND_APP_ID = 'A07SECONDAPP';`, `const LEFT_1 = { installId: 'inst_left_1', appId: 'A07LEFTAPP01' } as const;`, `const LEFT_2 = { installId: 'inst_left_2', appId: 'A07LEFTAPP02' } as const;`.
  - Helper: `function leaveApp(w: World, l: { installId: string; appId: string }, botName = 'Canopy Bot', leftAtMs = NOW_MS - 60_000): void` sets `w.memory.leftovers` as the store would have.

- [ ] **Step 2: Write the tests.** The Review Focus cites them by letter.

  - **a. NEW (the card's acceptance)** `'a refused install, Cancel with a configuration token Slack no longer takes, then Connect again: the first app is deleted with the new access token, so exactly one Slack app is left (TASK-1132)'`: `w = world()`; `const state = stateOf(await w.connect())`; `const firstInstallId = mintedInstallId(w)`. `w.callback({ code: CODE, state }, null)` `toStrictEqual(FAILED)` (signed out on the public address: the walk's `unauthenticated`), and `(await w.status()).body` still matches `{ state: 'pending' }`. Make the rotate fail: `w.slack.on.rotateConfigToken = async () => { throw new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'); }`. `w.disconnect()` → `{ status: 200, body: { appDeleted: false } }`, and `w.lines` contains `{ level: 'warn', msg: 'slack_admin_failed', fields: { installId: firstInstallId, stage: 'rotate', code: 'invalid_refresh_token' } }`. `(await w.status()).body` toEqual `{ state: 'not-connected', defaultBotName: 'canopy-works', canConnect: true, leftoverApps: [{ botName: 'Canopy Bot', appId: APP.appId }] }`. Then `w.slack.on.createApp = async () => ({ ...APP, appId: SECOND_APP_ID })`, `mark = w.trail.length`, `w.connect()` → 200. Assert `w.trail.slice(mark, mark + 5)` equals `['store:current', 'store:leftoverApps', 'slack:deleteApp', 'store:forgetLeftoverApp', 'slack:createApp']`; the `deleteApp` args are `[ACCESS, APP.appId]`; `[...w.slack.live]` equals `[SECOND_APP_ID]`; `w.memory.leftovers.size` is 0. (On main the second Connect never deletes: `live` holds two apps.)
  - **b. EXTEND** `'rotate fails, deleteApp fails or the token is gone → { appDeleted: false }…'` (`:1368`): for each breaker, `[...w.memory.leftovers.values()]` equals `[{ installId, appId: APP.appId, botName: 'Canopy Bot', leftAt: expect.any(Date) }]`, and `(await w.status()).body` matches `{ state: 'not-connected', leftoverApps: [{ botName: 'Canopy Bot', appId: APP.appId }] }`. Rename it to end `…, row and secrets still removed, and the app remembered`.
  - **c. EXTEND** `:1336` (happy), `:1410` (`app_not_found`), `:1424` (pending cancel), `:1458` (save fails): `expect(w.memory.leftovers.size).toBe(0)`.
  - **d.** EXTEND `:1479` (row won't delete): after the 500, `w.memory.leftovers.size` is 0. NEW `'Slack refusing the delete and the row refusing to go → 500 and nothing remembered; the retry remembers the app once'`: `connectedWorld()`; rotate refused as in a; `w.memory.failures.set('remove', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))`; disconnect → `{ status: 500, body: { error: 'internal' } }`, `leftovers.size` 0; delete the failure; disconnect → `{ status: 200, body: { appDeleted: false } }`; `leftovers` holds exactly one entry, `appId: APP.appId`.
  - **e. NEW** `'Connect deletes every leftover app with the pasted access token before it creates the new one, and forgets each one Slack deleted or no longer has'`: `w = world()`; `leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 120_000)`; `leaveApp(w, LEFT_2, 'Second Bot')`; `w.slack.on.deleteApp = async (_t, appId) => { if (appId === LEFT_2.appId) throw new SlackApiError('apps.manifest.delete', 'app_not_found'); }`. Connect → 200. `deleteApp` args in order: `[ACCESS, LEFT_1.appId]`, `[ACCESS, LEFT_2.appId]`. The trail from the connect's start begins `['store:current', 'store:leftoverApps', 'slack:deleteApp', 'store:forgetLeftoverApp', 'slack:deleteApp', 'store:forgetLeftoverApp', 'slack:createApp']`. `leftovers.size` 0. `w.lines.filter((l) => l.msg === 'slack_admin_failed')` is `[]`. The pasted access token's calls: `w.slack.calls.filter((c) => c.args.includes(ACCESS)).map((c) => c.method)` equals `['deleteApp', 'deleteApp', 'createApp', 'setAppIcon']`.
  - **f. NEW** `"a leftover app Slack won't delete stays listed, logged code-only under its own install id; Connect still goes ahead"`: `leaveApp(w, LEFT_1)`; `deleteApp` throws `new SlackApiError('apps.manifest.delete', 'no_permission')` for `LEFT_1.appId` only. Connect → 200, `createApp` called once. `w.lines` equals exactly `[{ level: 'warn', msg: 'slack_admin_failed', fields: { installId: LEFT_1.installId, stage: 'delete-leftover-app', code: 'no_permission' } }]`. `leftovers` still has `LEFT_1`. Then disconnect (cancel; deletes the new app) → `appDeleted: true`, and `(await w.status()).body.leftoverApps` equals `[{ botName: 'Canopy Bot', appId: LEFT_1.appId }]`.
  - **g. NEW** `'a Connect refused before Slack never touches a leftover'`: with `leaveApp(w, LEFT_1)`: `w.connect({})` → 400, `w.trail` `[]`. An http-origin world with `LEFT_1` left → 409 `public-origin-not-https`, `slack.calls` `[]`. A world that connected first, THEN `leaveApp(w, LEFT_1)`, then `w.connect(CONNECT_BODY, GRACE)` → 409 `already-connected`. In all three no `deleteApp` call, and `leftovers` still has `LEFT_1`.
  - **h. NEW** `'reading the leftover list failing → 500 before Slack is asked anything, logged code-only'`: `w.memory.failures.set('leftoverApps', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))`. Connect → `{ status: 500, body: { error: 'internal' } }`, `w.slack.calls` `[]`, `w.lines` equals `[{ level: 'error', msg: 'slack_admin_failed', fields: { stage: 'connect', code: 'ECONNRESET' } }]`. Status → 500 with one `{ stage: 'status', code: 'ECONNRESET' }` error line.
  - **i. NEW** `'forgetting a deleted leftover failing is logged; Connect goes on, and the next Connect forgets it'`: `leaveApp(w, LEFT_1)`; `failures.set('forgetLeftoverApp', ECONNRESET error)`. Connect → 200; `w.lines` equals `[{ level: 'error', msg: 'slack_admin_failed', fields: { installId: LEFT_1.installId, stage: 'forget-leftover-app', code: 'ECONNRESET' } }]`; `LEFT_1` still in `leftovers`. Delete the failure; disconnect (cancel) → 200; connect → 200; `deleteApp` was asked for `LEFT_1.appId` twice in all; `leftovers.size` 0.
  - **j. EXTEND** `'two concurrent connects → one 200, one 409'` (`:1034`): `leaveApp(w, LEFT_1)` first. Afterwards `deleteApp` args are exactly `[[ACCESS, LEFT_1.appId]]` and `leftovers.size` is 0.
  - **k. Status.** EXTEND `:661-691`: every `not-connected` body gains `leftoverApps: []`. NEW `"not-connected lists the apps Disconnect couldn't delete, oldest first, by name and app id only"`: `leaveApp(w, LEFT_2, 'Second Bot', NOW_MS - 60_000)`; `leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 120_000)`; `(await w.status()).body` toEqual `{ state: 'not-connected', defaultBotName: 'canopy-works', canConnect: true, leftoverApps: [{ botName: 'First Bot', appId: LEFT_1.appId }, { botName: 'Second Bot', appId: LEFT_2.appId }] }` (`toEqual` fails on an extra `installId` or `leftAt`). The `pending`/`connected` test at `:693` stays exact and unchanged: neither carries the field.
  - **l. Leak** (`describe('secrets never leave')`, after the Disconnect worlds): three new worlds. `leftoverDelete`: `leaveApp`, `deleteApp` throws `leak('deleteApp')`, `connect()`. `leftoverForget`: `leaveApp`, `memory.failures.set('forgetLeftoverApp', leak('forget'))`, `connect()`. `leftoverList`: `memory.failures.set('leftoverApps', leak('list'))`, `connect()` and `status()`. The existing allowlist and `not.toContain` checks cover them unchanged.
  - **Exact status bodies elsewhere:** `plugin.test.ts:692` and `presets/memory/src/__tests__/canary.test.ts:742` gain `leftoverApps: []`.

- [ ] **Step 3: Run and watch them fail**

  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts`
  Expected FAIL (on Task 1's code): a, b, the new half of d, e, f, h, i, j, k, l (l's three new worlds log nothing, so "every failure world really failed somewhere and said so" fails). Expected to PASS already: c, the `:1479` half of d, and g (they guard against a wrong implementation). Nothing else may fail.

- [ ] **Step 4: Implement in `admin-routes.ts`**

  - `SlackStatus`'s `not-connected` member gains `leftoverApps: Array<{ botName: string; appId: string }>`.
  - `status()`: when `current()` is null, also `leftoverApps: (await d.store.leftoverApps()).map(({ botName, appId }) => ({ botName, appId }))`.
  - `deleteLeftoverApps(accessToken)`, placed after `undoConnect`: for each `await d.store.leftoverApps()`, in order: `d.api.deleteApp(accessToken, app.appId)`. On success, or a `SlackApiError` with code `app_not_found`, `d.store.forgetLeftoverApp(app.installId)`, and if that throws, `failed('forget-leftover-app', err, app.installId)`. Any other delete failure: `failed('delete-leftover-app', err, app.installId)` and keep it. It never throws except from the list read. Doc: "Before a new app: delete the ones an earlier Disconnect couldn't, with the access token the admin just pasted (its owner is usually the person whose earlier token made them; that a new token can delete them is UNMEASURED, decisions shard). Deleted, or already gone on Slack's side (`app_not_found`): forgotten. Anything else: kept, logged code-only, and still listed. Never stops the Connect; a store fault reading the list throws, before Slack is asked anything."
  - `connect()`: inside the lock, after the two 409 checks, `await deleteLeftoverApps(accessToken);` then `return createInstall(...)`.
  - `disconnect()`: `await d.store.remove(install.installId, { appLeft: !appDeleted });`. Replace the comment above it (`:702-704`) with exactly:
    ```ts
      // Local state goes whatever Slack said: a dead token or an app someone
      // already deleted must never strand a "connected" row. An app Slack
      // didn't delete is remembered in the same statement, so the next
      // Connect can delete it and the tab names it until then. If the row
      // won't go, nothing is remembered and the secrets stay too, so a retry
      // can still delete the app.
    ```
  - Header: the `GET /admin/slack` line (`:26`) becomes `GET  /admin/slack                 → SlackStatus (not connected: with the apps Disconnect couldn't delete)`. The ACCESS bullet (`:41-43`) becomes exactly:
    ```
     *   - The pasted ACCESS token first deletes the Slack apps an earlier
     *     Disconnect couldn't (below), then creates the app and sets its icon
     *     (and, if Connect fails halfway, deletes the app again). Then it is
     *     dropped. It is never stored.
    ```
    and a paragraph goes after the Secrets list, before "The OAuth `state`…":
    ```
     * Disconnect (and Cancel, the same route) deletes the Slack app with an
     * access token minted from the stored refresh token. When Slack won't (the
     * token is dead or revoked, or Slack doesn't answer), the install still
     * goes, and in the same statement its app's id and name move to the
     * leftover list (store.ts) instead of being forgotten. The status names
     * them while nothing is connected, and the next Connect deletes them with
     * the newly pasted access token. Only Slack's `app_not_found` counts as
     * already gone.
    ```

- [ ] **Step 5: Run and pass, the package and its dependents**

  Run: `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build`, then `pnpm -r --no-bail --filter "...@ax/channel-slack" run test`.
  Expected: PASS everywhere, including `@ax/preset-k8s` (its composition test's Connect now also reads the empty leftover table) and `@ax/preset-memory` (the canary's status body).

- [ ] **Step 6: security-checklist walk.** Invoke the `security-checklist` skill on this task's diff and append its row to the decisions shard. It must cover: **sandbox** (no new egress method, URL, header, hook or vault call; `apps.manifest.delete` is already in the client's closed method union; the pasted access token now also deletes app ids from channel-slack's own table, written only by Disconnect from install rows, never from a request field; only inside an admin's Connect, behind the admin gate, CSRF, the body cap and the lock, after the 409 checks; at most 10 deletes, each under the client's per-call deadline); **injection** (app ids come from Slack's create answer narrowed by `idOf`, names passed `checkBotName`; both go only to admins, in the status; logs carry only `installId`, `stage`, `code`; Task 4 re-checks the app id before it becomes an href); **supply chain** (N/A: no `package.json` or lockfile change); and the residuals (a)-(f) in the shard's last planner row.

- [ ] **Step 7: Commit**

  Message: `[TASK-1132] channel-slack: Disconnect remembers an app it couldn't delete, and Connect deletes it first`.

---

### Task 3: The real plugin on Postgres leaves exactly one app `[tier: integration]`

**Files:**
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts` (one new test, beside the disconnect tests near `:1206`)

**Interfaces:**
- Consumes: Tasks 1 and 2 through the real plugin (`boot`, `call`, `request`, `installCount`, `probe`, `s.vault` already exist in the file).

- [ ] **Step 1: Write the test** `"a Disconnect that can't delete the Slack app keeps its id on Postgres, and the next Connect deletes it with the pasted access token: one app left (TASK-1132)"`

  - A local `fetchImpl` (form bodies are strings; parse with `new URLSearchParams`, as `fakeSlackFetch` at `:240-247` does) that records `{ method, auth, body }` and answers: `apps.manifest.create` → the 1st call `app_id: 'A07FIRSTAPP1'`, the 2nd `'A07SECONDAP2'`, each with `credentials: { client_id, client_secret, signing_secret }` (copy the shape from `presets/k8s/src/__tests__/channel-slack-composition.test.ts:295-301`), and adds it to a `live` set; `apps.manifest.delete` → `{ ok: true }` and removes `body.app_id` from `live`; `tooling.tokens.rotate` → `{ ok: false, error: 'invalid_refresh_token' }`; anything else → `{ ok: true }`.
  - `boot({ fetchImpl })`. POST `/admin/slack/connect` as `ADMIN.id` with `{ accessToken: fakeConfigAccessToken(), refreshToken: fakeConfigRefreshToken(), botName: 'canopy-works' }` → 200; `installCount()` 1.
  - POST `/admin/slack/disconnect` → `{ status: 200, body: { appDeleted: false } }`; `installCount()` 0; `SELECT install_id, app_id, bot_name FROM channel_slack_v1_leftover_apps` (through `probe`) → one row, `app_id 'A07FIRSTAPP1'`, `bot_name 'canopy-works'`.
  - GET `/admin/slack` → body matches `{ state: 'not-connected', leftoverApps: [{ botName: 'canopy-works', appId: 'A07FIRSTAPP1' }] }`.
  - POST `/admin/slack/connect` again → 200. In the recorded calls, an `apps.manifest.delete` with `auth === \`Bearer ${fakeConfigAccessToken()}\`` and `body.app_id === 'A07FIRSTAPP1'` comes before the second `apps.manifest.create`. The leftover table is empty, `installCount()` is 1, and `[...live]` equals `['A07SECONDAP2']`.

- [ ] **Step 2: Run it**

  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/plugin.test.ts`
  Expected: PASS.

- [ ] **Step 3: Prove it can fail.** With `git status --short` empty, change Task 2's `{ appLeft: !appDeleted }` in `admin-routes.ts` to `{ appLeft: false }`, re-run: the test FAILS at the leftover-row assertion. Restore with `git checkout HEAD -- packages/channel-slack/src/admin-routes.ts` and check `git status --short` is empty again.

- [ ] **Step 4: Commit**

  Message: `[TASK-1132] channel-slack: prove the leftover app round trip on Postgres`.

---

### Task 4: Admin > Slack names the apps it couldn't delete, each linked to its own Slack page `[tier: integration]`

**Files:**
- Modify: `packages/channel-web/src/lib/slack-admin.ts` (header `:1-20`, `SlackStatus` `:23-32`, `parseStatus` `:86-115`, a new export)
- Modify: `packages/channel-web/src/components/admin/SlackTab.tsx` (header `:9-16` and `:24-26`, `Notice` `:77-80`, `Actions` `:82-89`, `DisconnectedNotice` `:145-158`, a new `LeftoverAppsNote`, `DisconnectDialog.confirm` `:383-398`, `StatusView` `:669-684`, `SlackTab.onDisconnected` `:710-716` and its use `:731`)
- Test: `packages/channel-web/src/__tests__/admin-slack.test.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/SlackTab.test.tsx`

**Interfaces:**
- Consumes: Task 2's wire shape.
- Produces (`slack-admin.ts`):
  ```ts
  /** A Slack app an earlier Disconnect couldn't delete (TASK-1132). */
  export interface LeftoverSlackApp { botName: string; appId: string }
  // SlackStatus's not-connected member gains: leftoverApps: LeftoverSlackApp[]
  /** The Slack page for one app: its settings, and the Delete App button. */
  export function slackAppSettingsUrl(appId: string): string; // `https://api.slack.com/apps/${encodeURIComponent(appId)}`
  ```
  Parse rule (not-connected only; never fails the read): `leftoverApps` absent or not an array → `[]`. An item is kept only when it is an object whose `botName` is a string of 1 to 80 characters and whose `appId` matches `/^[A-Za-z0-9]{1,64}$/`; only those two fields are copied.

- [ ] **Step 1: Write the failing tests**

  `admin-slack.test.tsx`:
  - EXTEND `'GETs /admin/slack … extra fields dropped'` (`:71`): the not-connected input carries `leftoverApps: [{ botName: 'canopy', appId: 'A0CHZPVDJHX', installId: 'should-not-pass-through' }]`; the expected output has `leftoverApps: [{ botName: 'canopy', appId: 'A0CHZPVDJHX' }]`.
  - NEW `'leftoverApps: a missing or broken list reads as none, and only well-formed apps are kept'`: missing → `[]`; `'x'` → `[]`; `null` → `[]`. In one list, dropped: `null`, `'A0X'`, `{ botName: '', appId: 'A01' }`, `{ botName: 5, appId: 'A01' }`, `{ botName: 'x'.repeat(81), appId: 'A01' }`, `{ botName: 'ax', appId: 'A0/../x' }`, `{ botName: 'ax', appId: 'javascript:alert(1)' }`, `{ botName: 'ax', appId: 'A'.repeat(65) }`; kept: `{ botName: 'ax', appId: 'A0CHZPVDJHX' }`. A broken list never makes the read throw.
  - NEW `'slackAppSettingsUrl points at that one app on api.slack.com'`: `slackAppSettingsUrl('A0CHZPVDJHX')` is `'https://api.slack.com/apps/A0CHZPVDJHX'`.

  `SlackTab.test.tsx`:
  - Fixtures `NOT_CONNECTED` and `NO_HTTPS` (`:39-40`) gain `leftoverApps: []` (channel-web's `tsc` checks test files).
  - Constants: `const LEFT = { botName: 'canopy', appId: 'A0CHZPVDJHX' };`, `const LEFT_2 = { botName: 'canopy', appId: 'A0CHHCT1Z8X' };`.
  - NEW `"not connected, with a Slack app we couldn't delete: names it, links to its own settings page, and still offers Connect"`: `renderTab({ ...NOT_CONNECTED, leftoverApps: [LEFT] })`. The alert holding `"We couldn't delete this Slack app, so it may still be on Slack:"` also holds `"We'll try again the next time you connect. To delete it yourself, open it and click Delete App at the bottom of the page."`; inside it, the link named `canopy` has `href` `https://api.slack.com/apps/A0CHZPVDJHX`, `target` `_blank`, `rel` `noopener noreferrer`. The Connect button is still there.
  - NEW `'several apps: each listed and linked to its own page, even with the same name'`: `leftoverApps: [LEFT, LEFT_2]`. The plural sentences show (`"We couldn't delete these Slack apps, so they may still be on Slack:"`, `"We'll try again the next time you connect. To delete one yourself, open it and click Delete App at the bottom of the page."`). Two links named `canopy`, with hrefs ending `A0CHZPVDJHX` and `A0CHHCT1Z8X`.
  - NEW `'no public https address: the note shows above the https explainer'`: `renderTab({ ...NO_HTTPS, leftoverApps: [LEFT] })` → `findAllByRole('alert')` has 2, the first holding the leftover note, the second the https explainer; no Connect button.
  - NEW `'nothing left over: no note'`: `renderTab(NOT_CONNECTED)` → no text `/couldn't delete/`.
  - CHANGE `'if the Slack app could not be deleted, says to delete it on the same page'` (`:351-360`) into `"if the Slack app could not be deleted, the re-read names it with its own link, and the Revoke note says nothing more"`: `disconnect` resolves `{ appDeleted: false }`; reads `CONNECTED`, then `{ ...NOT_CONNECTED, leftoverApps: [LEFT] }`. The Revoke alert (closest `[role="alert"]` to `/One more step only you can do/`) does NOT contain `"We couldn't remove the Slack app itself."`; the leftover note and its link are on the page.

- [ ] **Step 2: Run and watch them fail**

  Run: `pnpm --filter @ax/channel-web exec vitest run src/__tests__/admin-slack.test.tsx src/components/admin/__tests__/SlackTab.test.tsx`
  Expected FAIL: the extended and new parse tests, the URL test (no export), the four new tab tests and the changed one. Every other test passes.

- [ ] **Step 3: Implement** (invoke the `shadcn` skill first)

  - `slack-admin.ts`: the type, the parse rule, `slackAppSettingsUrl`. Header: after the route list, one line: "`GET /admin/slack`, while nothing is connected, also lists the Slack apps an earlier Disconnect couldn't delete (`leftoverApps`). It is advisory: a broken list reads as none, and an app id becomes a link only when it is plain letters and digits."
  - `SlackTab.tsx`:
    - `function LeftoverAppsNote({ apps }: { apps: LeftoverSlackApp[] })`: `null` when empty. Otherwise `<Alert>` > `<AlertDescription className="flex flex-col gap-2">` with: a `<p>` (one: `We couldn't delete this Slack app, so it may still be on Slack:`; several: `We couldn't delete these Slack apps, so they may still be on Slack:`); a `<ul className="flex list-disc flex-col gap-1 pl-5">` with one `<li key={app.appId}>` per app holding `<a href={slackAppSettingsUrl(app.appId)} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4">{app.botName}</a>` (the same classes as `SlackAppsLink`); a `<p>` (one: `We'll try again the next time you connect. To delete it yourself, open it and click Delete App at the bottom of the page.`; several: `We'll try again the next time you connect. To delete one yourself, open it and click Delete App at the bottom of the page.`).
    - `StatusView` `case 'not-connected'`: a fragment, `<LeftoverAppsNote apps={status.leftoverApps} />` first, then the existing `ConnectForm` / `NeedsHttps` choice.
    - `DisconnectedNotice()` takes no props and loses the `{!appDeleted && …}` paragraph. `Notice`'s `disconnected` member becomes `{ kind: 'disconnected' }`; `Actions.onDisconnected: () => void`; `DisconnectDialog.confirm`: `await disconnectSlack(); onDisconnected();` (`disconnectSlack` still validates `appDeleted`); `SlackTab`'s `onDisconnected` takes no argument.
    - Header: the `not-connected` line (`:11-12`) gains ", and above either, any Slack app an earlier Disconnect couldn't delete, each linked to its own page on Slack". The paragraph at `:24-26` gains: "An app a disconnect couldn't delete is named in the not-connected view instead. It comes from the status, so it outlasts a reload, until a Connect deletes it (TASK-1132)."

- [ ] **Step 4: Run and pass**

  Run: `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build`, then `pnpm -r --no-bail --filter "...@ax/channel-web" run test`.
  Expected: PASS (`AdminShellHeadings.test.tsx`'s stub sends no `leftoverApps`; the lenient parse reads that as none).

- [ ] **Step 5: Commit**

  Message: `[TASK-1132] channel-web: Admin > Slack names a Slack app it couldn't delete, linked to its own page`.

---

### Task 5: Fix the lines that made the bug look impossible; the changeset `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md:202-205`, `:247-251`
- Modify: `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md:64`
- Create: `.changeset/slack-leftover-apps.md`

- [ ] **Step 1: Design §3, Connect step 3** (`:202-205`) becomes exactly:
  ```
  3. AX first deletes any app an earlier Disconnect couldn't (below), with the
     access token just pasted. Then it creates the shared app with
     `apps.manifest.create` and sets the avatar (the branding logo) with
     `apps.icon.set`. The manifest sets the name, scopes, and the event and
     interactivity URLs. Slack sends no challenge and needs no manual Verify
     click (§7 Q1).
  ```
- [ ] **Step 2: Design §3, the Disconnect bullet** (`:247-251`): keep its three sentences and append:
  ```
    Deleting the app needs the stored token, so a dead or revoked one (or
    Slack not answering) leaves the app on Slack. Disconnect still removes the
    install, but keeps the app's id and name (TASK-1132): the Slack tab names
    it, linked to its own settings page, and the next Connect deletes it with
    the newly pasted access token. Cancelling an unfinished install is the
    same Disconnect. Whether a new token can delete an app an earlier token of
    the same person made is unmeasured.
  ```
- [ ] **Step 3: The walk report's line 64** (the line the card was filed from). Append to that bullet, as TASK-1130 did to `:62`:
  ```
   *Found later (TASK-1132): the refused callback itself leaves nothing behind. The install stays pending, Continue in Slack reuses its app, and Connect refuses while an install is pending. A second app needs a Cancel first. Cancel deletes the app with the stored configuration token, and when that token is dead or revoked the delete fails (`appDeleted:false`) and AX forgot the app. It now remembers it, and the next Connect deletes it.*
  ```
- [ ] **Step 4: The changeset** `.changeset/slack-leftover-apps.md`:
  ```
  ---
  '@ax/channel-slack': patch
  '@ax/channel-web': patch
  ---

  Trying Slack again no longer leaves an extra Slack app behind. When Disconnect, or cancelling a connection that didn't finish, can't delete the Slack app we made (usually because the configuration token we hold has stopped working, for example after it was revoked on Slack's page), we now remember that app instead of forgetting it. Admin > Slack names it, with a link straight to its settings page, and the next Connect deletes it with the token you paste.
  ```
- [ ] **Step 5: Check and commit.** `pnpm test:scripts` (doc guards) passes. Message: `[TASK-1132] docs: Disconnect can leave an app behind, and the next Connect deletes it`.

---

## Ship-time steps (the builder; not implementer tasks)

1. **PR** (squash title `[TASK-1132] Slack: an app Disconnect couldn't delete is remembered, and the next Connect deletes it`). Body: what the card claimed and what the code shows (the premise section above, with its file:line evidence); the design bullets; `## Security review` from Task 2's shard row; boundary review: N/A, no hook, IPC action or manifest change, and `GET /admin/slack` is an HTTP admin route mirrored by shape; "Not measurable in CI" with the shard's four unmeasured items.
2. **Handoff `learnings:`**
   - **The next real-Slack walk** must measure the shard's unmeasured items, first: can a NEW configuration token of the same person delete an app an earlier token made? The acceptance on real Slack: Connect, refuse the callback (sign out on the public address), revoke the token on Slack's page, Cancel, then Connect with a new pair: api.slack.com/apps shows exactly one app.
   - **TASK-1128** (replace the configuration token): a replace is another moment the admin pastes a working token, so it could delete leftovers too. Its route must take the same admin lock.
   - **TASK-1139** (success log lines): Connect's leftover pass logs only failures.
   - **Suggested follow-up card** (decisions shard, YAGNI row): validate the pasted refresh token right after `apps.manifest.create`.
