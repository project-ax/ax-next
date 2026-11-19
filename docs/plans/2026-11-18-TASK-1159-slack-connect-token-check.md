# TASK-1159: Slack Connect tries the pasted refresh token once, right after the app is created — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An install never starts with a configuration refresh token Slack won't take: Connect tries the pasted one once, keeps the one Slack mints, and takes the new app back (or remembers it) when that fails.

**Architecture:** In `createInstall` (`packages/channel-slack/src/admin-routes.ts`), right after `apps.manifest.create` succeeds and before any vault or store write, Connect calls `tooling.tokens.rotate` with the pasted refresh token. On success it stores the refresh token Slack minted (never the pasted one) and drops the minted access token unused. On any failure it deletes the new app with the pasted access token (new `undoCreate`), puts the app on the leftover list if Slack won't delete it (new `InstallStore.rememberLeftoverApp`), and answers 502 `slack-refresh-token` (Slack refused the token) or `slack-error` (anything else). channel-web gains one sentence for the new code.

**Tech Stack:** TypeScript, Kysely + Postgres (testcontainers), vitest, `@ax/channel-slack` (host plugin), `@ax/channel-web` (copy only), `@ax/preset-k8s` (composition test).

**Spec:** the card (TASK-1159, the follow-up `.claude/memory/decisions/2026-11-18-TASK-1132.md` row 6 suggests) and `docs/plans/2026-11-09-channel-slack-design.md` §3. Planner decisions, alternatives and evidence: `.claude/memory/decisions/2026-11-18-TASK-1159.md` (read it first; Task 2 appends its security-checklist row there).

## The card, checked against the code

- **True.** Connect stores the pasted refresh token untried (`admin-routes.ts:458-459`). A dead one shows up only at the first Rename (502 `slack-config-token`) or Disconnect (`appDeleted:false`, then a leftover app, TASK-1132).
- **"Also: TASK-1128 should delete leftover apps under the same admin lock" is not this card.** TASK-1128 (replace the token) isn't built: no route in `admin-routes.ts`, and design §3:286 says so. It goes in the handoff learnings (Ship-time steps).
- **"Can a newer configuration token from the same person delete an app their earlier token made?"** A walk item, not code (Ship-time steps).
- **Where this plan departs from the brief** (shard rows 3 and 4): a transient rotate failure DOES take the app back, because most transient codes can't tell whether Slack spent the token, and `bad-response` means it did. A failed undo-delete is remembered through a new store method, because `remove({ appLeft })` moves an app out of an install row and none exists yet.

## Design (decided; the shard has the alternatives)

- Connect's order becomes: the two 409 checks → leftover pass (TASK-1132, unchanged) → `apps.manifest.create` → **rotate the pasted refresh token** → vault puts (client secret, signing secret, **the minted refresh token**) → `insertPending` → icon → install URL. A failed create never reaches the rotate, so it never spends the pasted pair.
- Rotate failure → `failed('try-refresh-token', err, installId)` → `undoCreate` → 502. `invalid_refresh_token` or any `TOKEN_ERRORS` code → `{ error: 'slack-refresh-token' }`. Anything else, a non-Slack throw included → `{ error: 'slack-error' }`.
- `undoCreate`: delete the app with the pasted access token. Deleted, or `app_not_found`: done, nothing logged. Otherwise log `undo-delete-app`, then `rememberLeftoverApp({ installId, appId, botName })`; if that throws, log `remember-leftover-app` (error). Never throws. Nothing else to undo: nothing was stored yet.
- The rotate's minted access token is never used. Every Connect call keeps using the pasted access token.
- **Not changing:** `undoConnect` (failures after the writes), `slack-api.ts`, Rename, Disconnect, the callback, `forget-leftover-app`, the status shape, `SlackTab.tsx` markup, any hook, IPC action or plugin manifest. No boundary review: `POST /admin/slack/connect` is an HTTP admin route channel-web mirrors by shape (no `@ax/ipc-protocol` contract).

## Global Constraints

- Log lines stay code-only: `slack_admin_failed` fields exactly `installId`, `stage`, `code` (the leak test allows only `installId`, `reason`, `stage`, `code`). New stage literals: `'try-refresh-token'`, `'remember-leftover-app'`; `'undo-delete-app'` gets a second call site. Add failure lines only. Never edit an existing log call: TASK-1139 (branch `auto-ship/TASK-1139-slack-disconnect-logs`) is adding success lines in parallel, so expect a rebase conflict in `admin-routes.ts` if it lands first.
- No token in any response body, log line or error. The pasted refresh token goes only to `tooling.tokens.rotate`, through the existing client. The minted access token goes nowhere.
- Fake tokens come from `packages/channel-slack/src/__tests__/fake-slack-tokens.ts` helpers, never a token-shaped literal. Before each commit: `git diff --cached | grep -nE 'xox[bpe]-[0-9]{10,13}-'` prints nothing.
- No literal invisible characters under `packages/channel-slack/src` (`source-hygiene.test.ts` fails on them).
- `--filter` goes before the script. Package `tsc` excludes test files everywhere except channel-web, so also run `pnpm --filter @ax/channel-slack build` and `pnpm --filter @ax/channel-web build`.
- Docker-backed: `store.test.ts`, `plugin.test.ts`, `presets/k8s`. Set `DOCKER_HOST` as CLAUDE.md "Docker-backed tests" says, plus `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000`, and run Docker-backed packages one at a time (`--workspace-concurrency=1`).
- After Task 2 and after Task 4, run the packages and their dependents: `pnpm -r --workspace-concurrency=1 --no-bail --filter "...@ax/channel-slack" --filter "...@ax/channel-web" run test` (reaches `@ax/cli`, `@ax/preset-k8s`, `@ax/preset-memory`).
- Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- UI: invariant 6 holds without markup changes (the new sentence renders in the Connect form's existing error slot). No "AX" in UI copy. User-facing prose follows the CLAUDE.md voice; the copy below is pinned, change a word only if it is false.
- Memory: new rows go only to `.claude/memory/decisions/2026-11-18-TASK-1159.md`. Never edit a root archive, or another task's shard.
- GitHub text (PR body, comments): `@ax` only inside backticks.

## Review Focus

1. **Slack refuses the pasted refresh token** → 502 `slack-refresh-token`, the new app deleted with the pasted access token, nothing in the vault or the store, and the tab says to generate a new pair. Pinned: Task 2 a, b; Task 4.
2. **Slack doesn't answer the rotate, then won't delete the app either** → the app is on the leftover list under the install id Connect minted, the status names it, and the next Connect deletes it. Pinned: Task 2 c; Task 3.
3. **A failed create (expired access token, refused name)** → no rotate, so the same pair still works for the retry. Pinned: the existing createApp-failure test (`admin-routes.test.ts:1025`, `slackMethods == ['createApp']`), Task 2 k.
4. **Connect, Rename, Rename, Disconnect** → each rotate spends the token the step before stored, starting with Connect's. Pinned: Task 2 j (`:2042`, `:2088`) and n.
5. **A store fault after the rotate, then the admin retries with the same pair** → 500, then a retry while Slack still honours the spent token connects; a later one gets `slack-refresh-token`. Pinned: Task 2 h.

---

## Files

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/store.ts` | `rememberLeftoverApp` (interface and impl); `LeftoverApp`, `leftoverApps()` docs | 1 |
| `packages/channel-slack/src/migrations.ts` | leftover paragraph of the header (comment only, no schema change) | 1 |
| `packages/channel-slack/src/__tests__/store.test.ts` | new describe | 1 |
| `packages/channel-slack/src/__tests__/admin-routes.test.ts` | `memoryStore` twin (1); fixtures, new and changed tests, leak worlds (2) | 1, 2 |
| `packages/channel-slack/src/admin-routes.ts` | rotate after create; `undoCreate`; `refreshTokenError`; `REFRESH_TOKEN_REFUSED`; header and comments | 2 |
| `packages/channel-slack/src/secrets.ts` | header `:31-35` | 2 |
| `packages/channel-slack/src/__tests__/plugin.test.ts` | the TASK-1132 test's fetch (2); new test (3) | 2, 3 |
| `presets/k8s/src/__tests__/channel-slack-composition.test.ts` | Connect's rotate; the rename's rotate body | 2 |
| `packages/channel-web/src/lib/slack-admin.ts` | `slack-refresh-token` copy and case | 4 |
| `packages/channel-web/src/__tests__/admin-slack.test.tsx` | one row | 4 |
| `packages/channel-web/src/components/admin/__tests__/SlackTab.test.tsx` | one row | 4 |
| `docs/plans/2026-11-09-channel-slack-design.md` | §3 steps 3 and 5, the Disconnect bullet; §7 configuration-tokens row | 5 |
| `.changeset/slack-connect-refresh-token.md` | new | 5 |

---

### Task 1: The store can remember an app no install row ever held `[tier: integration]`

No security-checklist here: an inert store method. Task 2's walk covers its one caller.

**Files:**
- Modify: `packages/channel-slack/src/store.ts` (`LeftoverApp` `:36-43`, `InstallStore` `:96-101`, implementation after `forgetLeftoverApp` `:348-350`)
- Modify: `packages/channel-slack/src/migrations.ts` (header `:42-49` only)
- Test: `packages/channel-slack/src/__tests__/store.test.ts` (new describe after the TASK-1132 one, which ends at `:525`)
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts` (`memoryStore` `:181-318` only)

**Interfaces:**
- Produces (`store.ts`, `InstallStore`):
  ```ts
  /**
   * Remember a Slack app Connect made and couldn't take back (TASK-1159): no
   * install row ever held it. An id already on the list keeps its first app.
   */
  rememberLeftoverApp(app: Pick<LeftoverApp, 'installId' | 'appId' | 'botName'>): Promise<void>;
  ```
  One parameterized `INSERT INTO channel_slack_v1_leftover_apps (install_id, app_id, bot_name) ... ON CONFLICT (install_id) DO NOTHING`. A failure rejects. `left_at` takes its default.
- Test twin: `memoryStore`'s store gains the same method.

- [ ] **Step 1: Write the failing store tests.** New `describe("an app Connect couldn't take back is remembered with no install row (TASK-1159)")`:
  1. `'rememberLeftoverApp lists the app under the id Connect minted, touches no install, and is forgotten like any other'`: `const live = await pending(); const id = newInstallId(); await store.rememberLeftoverApp({ installId: id, appId: 'A07NEWAPP001', botName: 'canopy' });` then `store.leftoverApps()` toEqual `[{ installId: id, appId: 'A07NEWAPP001', botName: 'canopy', leftAt: expect.any(Date) }]`, `store.get(id)` is null, `(await store.current())?.installId` is `live`. Then `forgetLeftoverApp(id)` and `leftoverApps()` is `[]`.
  2. `'the same id remembered twice keeps the first app'`: remember `{ installId: id, appId: 'A07NEWAPP001', botName: 'canopy' }`, then `{ installId: id, appId: 'A07NEWAPP002', botName: 'other' }` resolves; `leftoverApps()` holds one entry, `appId: 'A07NEWAPP001'`, `botName: 'canopy'`.
  3. `'a failing insert rejects, so the caller can say so, and leaves nothing'`: inside `withLeftoverInsertTrigger("RAISE EXCEPTION 'refused in test'; RETURN NEW;", ...)`, `rememberLeftoverApp(...)` rejects with `/refused in test/`; afterwards `leftoverApps()` is `[]`.

- [ ] **Step 2: Run them and watch them fail**

  Run: `DOCKER_HOST=<yours> AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack exec vitest run src/__tests__/store.test.ts`
  Expected: the three new tests FAIL (`store.rememberLeftoverApp is not a function`). Every other store test passes.

- [ ] **Step 3: Implement**
  - `store.ts`: the method. Docs: `LeftoverApp` (`:36`) becomes "A Slack app AX made and couldn't delete (Disconnect's, or Connect's own after Slack refused the pasted refresh token), so it may still be on Slack. No secret."; its `installId` doc becomes "The install's id (a removed install's, or the one Connect minted and never stored): how logs name it, and the key to forget it by."; `leftoverApps()` (`:96`) starts "The Slack apps AX made and couldn't delete, oldest first" (rest unchanged).
  - `migrations.ts`: the leftover paragraph (`:42-49`) becomes exactly:
    ```
     *   channel_slack_v1_leftover_apps — Slack apps AX made and couldn't
     *     delete. Disconnect's (TASK-1132): the stored configuration token was
     *     dead or revoked, or Slack didn't answer; the install's row moves its
     *     app id and name here in the statement that deletes it (store.ts).
     *     Connect's own (TASK-1159): Slack refused the pasted refresh token, or
     *     didn't answer, and then wouldn't delete the app Connect had just made;
     *     no install row ever held that one, so Connect writes it here directly.
     *     Either way the id is never in both tables. The next Connect tries to
     *     delete them with the pasted access token; the Slack tab names them
     *     until that works or the admin says they deleted one by hand
     *     (`forget-leftover-app`). Keyed by the install's id (for Connect's own,
     *     the one it minted and never stored). No secret and no person.
    ```
  - `admin-routes.test.ts` `memoryStore`: `rememberLeftoverApp(a)` calls `enter('rememberLeftoverApp', [a])`, then, only when `!leftovers.has(a.installId)`, sets `{ installId: a.installId, appId: a.appId, botName: a.botName, leftAt: new Date(clock()) }`. `failures` and `trail` pick the method up through `enter`.

- [ ] **Step 4: Run and pass**

  Run: the Step 2 command, then `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts` and `pnpm --filter @ax/channel-slack build`.
  Expected: PASS; build clean.

- [ ] **Step 5: Commit** the four files: `[TASK-1159] channel-slack: the store can remember an app no install row ever held`.

---

### Task 2: Connect tries the pasted refresh token once; a refusal takes the new app back `[tier: sensitive]`

**security-checklist: required.** The pasted refresh token now reaches Slack at Connect, a Slack-minted secret is stored there, and the leftover table gains a second writer.

**Files:**
- Modify: `packages/channel-slack/src/admin-routes.ts` (header `:27`, `:47-55`, `:60-69`; `LeftoverAppsField` doc `:85-90`; `CONFIG_TOKEN_REFUSED` `:168-182`; `refreshTokenError` beside `createAppError` `:264-275`; `undoCreate` after `undoConnect` `:390-407`; `createInstall` `:439-475`)
- Modify: `packages/channel-slack/src/secrets.ts` (header `:31-35`)
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts`
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts` (the TASK-1132 test, `:1238-1320`)
- Test: `presets/k8s/src/__tests__/channel-slack-composition.test.ts` (`:796-860`)

**Interfaces:**
- Consumes: Task 1's `rememberLeftoverApp`.
- Produces (wire; Task 4 consumes it): `POST /admin/slack/connect` may answer `502 { error: 'slack-refresh-token' }`, exactly that body. Every other answer is unchanged.
- Internal (`admin-routes.ts`):
  ```ts
  /** Slack refusing a refresh token itself at rotate. CONFIG_TOKEN_REFUSED is rebuilt from it plus 'no_permission' and 'app_not_owned_by_manager_app': the same members as today. */
  const REFRESH_TOKEN_REFUSED: ReadonlySet<string>; // [...TOKEN_ERRORS, 'invalid_refresh_token']
  function refreshTokenError(err: unknown): 'slack-refresh-token' | 'slack-error';
  // inside createAdminRoutes:
  async function undoCreate(accessToken: string, appId: string, installId: string, botName: string): Promise<void>;
  ```

- [ ] **Step 1: Test fixtures** (`admin-routes.test.ts`)
  - `const SECOND_ACCESS = fakeConfigAccessToken('SECONDACCESSSECRET');`, `const SECOND_REFRESH = fakeConfigRefreshToken('SECONDREFRESHSECRET');`, `const SECOND_PAIR = { accessToken: SECOND_ACCESS, refreshToken: SECOND_REFRESH, botName: 'Canopy Bot' };` with the doc "A new pair, as an admin pastes after a Cancel: the strict fake retires REFRESH as soon as a Connect rotates it." Add `SECOND_ACCESS` and `SECOND_REFRESH` to `SECRETS`.
  - `function failRotate(w: World, err: unknown): void` sets `w.slack.on.rotateConfigToken` to throw `err`. A test that needs the default back saves `w.slack.on.rotateConfigToken` first.

- [ ] **Step 2: Write and change the tests.** Review Focus cites the letters. New ones go in a new `describe('Connect tries the pasted refresh token once (TASK-1159)')` after the Connect describe (ends `:1159`).
  - **a. NEW (the card's acceptance)** `'a pasted refresh token Slack refuses: the new app is deleted again with the pasted access token, nothing is stored, and the admin is asked for a new pair'`: `failRotate(w, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'))`; `res = await w.connect()`; `res.status` 502 and `res.body` toStrictEqual `{ error: 'slack-refresh-token' }`. `w.trail` equals exactly `['store:current', 'store:leftoverApps', 'slack:createApp', 'slack:rotateConfigToken', 'slack:deleteApp']`. The rotate's args are `[REFRESH]`; `deleteApp` args are `[[ACCESS, APP.appId]]`. `[...w.slack.live]` is `[]`, `w.vaultCalls` `[]`, `w.memory.rows.size` 0, `w.memory.leftovers.size` 0. `w.lines` equals exactly `[{ level: 'warn', msg: 'slack_admin_failed', fields: { installId: mintedInstallId(w), stage: 'try-refresh-token', code: 'invalid_refresh_token' } }]`. Status body toEqual `{ state: 'not-connected', defaultBotName: 'canopy-works', canConnect: true, leftoverApps: [] }`.
  - **b. NEW** `'a refused token → slack-refresh-token; any other rotate failure → slack-error; the new app goes either way and nothing is stored'`, shaped like the createApp-failure test (`:1025`): `slack-refresh-token` for `invalid_refresh_token`, `invalid_auth`, `not_authed`, `token_expired`, `token_revoked`, `account_inactive`; `slack-error` for `timeout`, `network`, `bad-response`, `too-large`, `http-503`, `redirect`, `slack-error`, `ratelimited` (built with `retryAfterMs` 60_000), and `new TypeError('not a Slack answer')`. Each in a fresh world: 502 with exactly `{ error }`; `deleteApp` args `[[ACCESS, APP.appId]]`; `w.vaultCalls` `[]`; no row; no leftover; `w.lines` exactly one `try-refresh-token` line, `warn` with the error's code (`error` with code `unknown` for the TypeError).
  - **c. NEW** `"Slack won't delete the new app either: it is remembered under the install id Connect minted, the status names it, and the next Connect deletes it"`: save the default rotate; `failRotate(w, new SlackApiError('tooling.tokens.rotate', 'timeout'))`; `deleteApp` throws `new SlackApiError('apps.manifest.delete', 'timeout')`. Connect → 502 `{ error: 'slack-error' }`; the trail ends `'slack:deleteApp', 'store:rememberLeftoverApp'`; `[...w.memory.leftovers.values()]` toEqual `[{ installId: mintedInstallId(w), appId: APP.appId, botName: 'Canopy Bot', leftAt: expect.any(Date) }]`; no row; `w.vaultCalls` `[]`; `w.lines` exactly the `try-refresh-token` and `undo-delete-app` warn lines (code `timeout`, that install id), in that order; the status's `leftoverApps` is `[{ botName: 'Canopy Bot', appId: APP.appId }]`. Then Slack recovers: restore the default rotate, `deleteApp` resolves, `createApp` answers `{ ...APP, appId: SECOND_APP_ID }`; `mark = w.trail.length`; `w.connect()` (the same pair: the timed-out rotate never reached the fake's ledger, and on Slack a spent token still works for a while) → 200. `w.trail.slice(mark, mark + 6)` equals `['store:current', 'store:leftoverApps', 'slack:deleteApp', 'store:forgetLeftoverApp', 'slack:createApp', 'slack:rotateConfigToken']`; every `deleteApp` call so far is `[ACCESS, APP.appId]` (two); `leftovers.size` 0; `[...w.slack.live]` `[SECOND_APP_ID]`; `w.vault.get(secretRef(onlyRow(w).installId, 'config-refresh-token'))` is `mintedRefresh(1)` (`mintedInstallId` reads the FIRST create, so it names the leftover, not this install).
  - **d. NEW** `'remembering it failing too is logged code-only, and the answer is the same'`: rotate refused (`invalid_refresh_token`); `deleteApp` throws `new SlackApiError('apps.manifest.delete', 'ratelimited', 60_000)`; `w.memory.failures.set('rememberLeftoverApp', connectionReset())`. Connect → 502 `{ error: 'slack-refresh-token' }`; no row, no leftover, `w.vaultCalls` `[]`; `w.lines` equals exactly the `try-refresh-token` warn, the `undo-delete-app` warn (`ratelimited`), and `{ level: 'error', msg: 'slack_admin_failed', fields: { installId, stage: 'remember-leftover-app', code: 'ECONNRESET' } }`.
  - **e. NEW** `'an app Slack says is already gone when Connect takes it back is not remembered, and not reported'`: rotate refused; `deleteApp` throws `app_not_found`. Connect → 502 `slack-refresh-token`; the trail's last entry is `'slack:deleteApp'`; no leftover; `w.lines` only the `try-refresh-token` line.
  - **h. NEW** `'a store fault after the rotate spends the pasted refresh token: a retry while Slack still honours it connects; once Slack has retired it, the admin is asked for a new pair'`: world 1: `failures.set('insertPending', connectionReset())`; Connect → 500 `{ error: 'internal' }` (and `w.vault.size` 0); delete the failure; `w.slack.rotatedStillWork = true`; Connect → 200, and `w.vault.get(secretRef(onlyRow(w).installId, 'config-refresh-token'))` is `mintedRefresh(2)`. World 2: the same first Connect → 500; delete the failure; Connect (the fake retires `REFRESH` at once) → 502 `{ error: 'slack-refresh-token' }`, `w.memory.rows.size` 0, `w.vault.size` 0.
  - **f. CHANGE** `:899`, renamed `'stores client-secret, signing-secret and the refresh token Slack minted from the pasted one, then a pending row'`: the vault's `config-refresh-token` is `mintedRefresh(1)`. Add: `w.trail.slice(0, 5)` equals `['store:current', 'store:leftoverApps', 'slack:createApp', 'slack:rotateConfigToken', 'vault:set client-secret']`; `w.slack.calls.filter((c) => c.args.includes(REFRESH)).map((c) => c.method)` equals `['rotateConfigToken']`; `w.slack.calls.filter((c) => c.args.includes(MINTED_ACCESS))` equals `[]` (the minted access token is never used).
  - **g. CHANGE** `:1109`: `slackMethods(noIcon)` equals `['createApp', 'rotateConfigToken']`.
  - **i. CHANGE (they connect twice)** `:1641`: save the default rotate before overriding it; restore it before the second Connect, which pastes `SECOND_PAIR`; its `deleteApp` assertion becomes `[[SECOND_ACCESS, APP.appId]]`. `:1854`: the second Connect pastes `SECOND_PAIR`; the `deleteApp` assertion becomes `[[ACCESS, LEFT_1.appId], [SECOND_ACCESS, LEFT_1.appId]]`.
  - **j. CHANGE (one mint later: Connect minted `mintedRefresh(1)`)** `:1445` the rotate/delete list becomes `[['rotateConfigToken', REFRESH], ['rotateConfigToken', mintedRefresh(1)], ['deleteApp', MINTED_ACCESS, APP.appId]]`. `:1602` both `mintedRefresh(1)` become `mintedRefresh(2)`. `:2042` the rotate's args become `[mintedRefresh(1)]`, the vault `mintedRefresh(2)`, and the comment "replaced the pasted one" becomes "replaced the one Connect stored". `:2088` → `[REFRESH, mintedRefresh(1), mintedRefresh(2), mintedRefresh(3)]`. `:2105` the vault `mintedRefresh(2)`, the list `[REFRESH, mintedRefresh(1), mintedRefresh(2)]`. `:2124` "the old token stays" is `mintedRefresh(1)`, the retry stores `mintedRefresh(3)`. `:2378` → `[REFRESH, mintedRefresh(1), mintedRefresh(2)]`. `:2465` the vault `mintedRefresh(2)`; the last assertion becomes `w.slack.calls.filter((c) => JSON.stringify(c.args).includes(mintedRefresh(2)))` equals `[]`, and the title ends "the refresh token it minted nowhere but the vault".
  - **k. COMMENT ONLY** `:1025`, above `expect(slackMethods(w)).toEqual(['createApp'])`: `// No rotate: a failed create never spends the pasted pair (TASK-1159).`
  - **l. Leak** (`'secrets never leave'`, after the TASK-1132 worlds at `:2550-2571`): `connectRotate` (`failRotate(w, leak('rotate'))`, `connect()`); `connectUndo` (rotate throws `leak('rotate')`, `deleteApp` throws `leak('deleteApp')`, `memory.failures.set('rememberLeftoverApp', leak('remember'))`, `connect()`). The allowlist and `not.toContain` checks cover them unchanged.
  - **m. CHANGE** `plugin.test.ts` TASK-1132 test (`:1238`): its fetch refuses every rotate, so its first Connect would now 502. Add `const minted = fakeConfigRefreshToken('E2EMINTEDREFRESH');`. The rotate answers `{ ok: false, error: 'invalid_refresh_token' }` when `body.refresh_token === minted` (comment: the token AX holds has since been revoked on Slack's page), else `{ ok: true, token: fakeConfigAccessToken('E2EROTATEDACCESS'), refresh_token: minted, exp: 4_102_444_800 }`. Destructure `s` from `boot`; after the first Connect, read the install id through `probe` and expect `s.vault.get(secretRef(id, 'config-refresh-token'))` to be `minted`. The rest stands.
  - **n. CHANGE** the composition test (`presets/k8s`, step 2 at `:796`): take `const connectMark = slackCalls.length` before the Connect; after it, `slackCalls.slice(connectMark).slice(0, 2).map((c) => c.method)` equals `['apps.manifest.create', 'tooling.tokens.rotate']`, and that rotate's body equals `{ refresh_token: CONFIG_REFRESH_TOKEN }`. After the `signing-secret` read: `const atConnect = await readSecret(installId, 'config-refresh-token')`, expected `rotatedRefreshToken(rotateSeq)` and not `CONFIG_REFRESH_TOKEN`. `:843` becomes `{ refresh_token: atConnect }`; after `:859`, `expect(kept).not.toBe(atConnect)`. Step 2b's comment says the rename rotates the token Connect kept.

- [ ] **Step 3: Run and watch them fail**

  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts`
  Expected FAIL (on Task 1's code): a, b, c, d, e, h (Connect answers 200 and never rotates); f and g; the eight tests in j (one mint short); l (its two new worlds log nothing, so "every failure world really failed somewhere and said so" fails). Expected to PASS already: i and k. Nothing else may fail. (m and n are Docker-backed. If run now, m fails at `appDeleted: false` and n at `atConnect`; running them here is optional.)

- [ ] **Step 4: Implement in `admin-routes.ts` and `secrets.ts`**
  - `REFRESH_TOKEN_REFUSED`, `CONFIG_TOKEN_REFUSED` rebuilt from it, and `refreshTokenError` (a `SlackApiError` whose code is in `REFRESH_TOKEN_REFUSED` → `'slack-refresh-token'`, anything else → `'slack-error'`).
  - `undoCreate` after `undoConnect`, as the Design says. Doc: "Connect stopped right after Slack made the app, before anything was stored: take the app back with the pasted access token. If Slack won't, the app goes onto the leftover list (no install row holds it), so the tab names it and the next Connect deletes it. Never throws."
  - `createInstall`: after the create's try/catch and before `const owner`, a try/catch around `d.api.rotateConfigToken(refreshToken)`. Its catch: `failed('try-refresh-token', err, installId)`, `await undoCreate(accessToken, app.appId, installId, botName)`, `return json(502, { error: refreshTokenError(err) })`. Keep only the minted refresh token in scope (destructure it), so the minted access token can't be used by accident. The `config-refresh-token` put stores it; its comment (`:458`) becomes "The one Slack just minted from the pasted one, until a rotate (Rename, Disconnect) saves its replacement."
  - Header: `:27` becomes `GET  /admin/slack                 → SlackStatus (every state: with the Slack apps AX made and couldn't delete)`. The REFRESH bullet (`:47-55`) becomes exactly:
    ```
     *   - The pasted REFRESH token is tried once, right after Slack makes the
     *     app: Connect rotates it and stores the refresh token Slack mints in
     *     its place, and never uses that rotate's access token (TASK-1159). If
     *     the rotate fails, nothing is stored and the app goes again (below), so
     *     an install never starts with a token Slack won't take. No route ever
     *     returns the stored one. Only Disconnect and Rename read it, each to
     *     mint one access token that is used once: Disconnect to delete the
     *     app, Rename to update its manifest. Each rotate also mints a new
     *     refresh token, and Slack retires the old one within minutes to hours
     *     (MEASURED, TASK-1097 walk; slack-api.ts), so the new one replaces it
     *     in the vault BEFORE the access token is used. If that write fails,
     *     Rename stops (a retry soon after may still work with the old token)
     *     and Disconnect deletes the app anyway.
    ```
    In the Disconnect paragraph (`:60-69`), after "instead of being forgotten.", insert: "Connect's own undo does the same when Slack refuses the pasted refresh token (or doesn't answer) and then won't delete the app Connect just made: no install row holds that one yet, so it goes straight onto the list." `LeftoverAppsField`'s first sentence (`:86`) becomes "The Slack apps AX made and couldn't delete (Disconnect's, or Connect's own undo's), oldest first: a name and an app id each, nothing else."
  - `secrets.ts` `:31-35` becomes exactly:
    ```
     * The configuration refresh token stored here is never the one the admin
     * pasted: Connect rotates that one once and stores the refresh token Slack
     * mints with it (TASK-1159). After each later rotate, admin-routes.ts writes
     * the one Slack mints alongside over it, because Slack retires a rotated
     * refresh token within minutes to hours (slack-api.ts). If that write fails,
     * the old one stays, and works only until Slack retires it.
    ```

- [ ] **Step 5: Run and pass, the package and its dependents**

  Run: `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build` (Docker env set), then `DOCKER_HOST=<yours> AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm -r --workspace-concurrency=1 --no-bail --filter "...@ax/channel-slack" run test`.
  Expected: PASS everywhere, m and n included.

- [ ] **Step 6: Commit.** Message: `[TASK-1159] channel-slack: Connect tries the pasted refresh token once, and takes the app back if Slack refuses it`.

- [ ] **Step 7: Mutation check.** With `git status --short` empty, apply each mutant to `admin-routes.ts` alone, run `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts` (make sure the `Tests` summary line prints), compare with the prediction, then `git checkout HEAD -- packages/channel-slack/src/admin-routes.ts` and check `git status --short` is empty again.
  - M1, the rotate moved before `createApp`: `:1025` (k), a, b, c and f fail.
  - M2, the put stores the pasted `refreshToken`: f fails, and every rename and disconnect test that keeps the default rotate (the strict fake refuses `REFRESH` twice).
  - M3, a non-refusal failure skips the undo and stores the pasted token: b's `slack-error` rows and c fail.
  - M4, `undoCreate` never calls `rememberLeftoverApp`: c and d fail.
  A mutant nothing catches is a missing test: add it before going on.

- [ ] **Step 8: security-checklist walk.** Invoke the `security-checklist` skill on this task's diff and append its row to the decisions shard (commit it: `[TASK-1159] memory: Task 2 security walk`). It must cover: **sandbox** (no new egress method, URL, header or hook: `tooling.tokens.rotate` is already in the closed `SlackMethod` union, no auth header, form body, `redirect: 'manual'`, the 10 s deadline; the pasted refresh token's one new use; the vault write is the same ref, scope and identity Connect already wrote; the leftover table's new writer is only `undoCreate`, under the admin gate, CSRF, body cap and admin lock, after both 409 checks, with the app id from Slack's create answer narrowed by `idOf` and a name that passed `checkBotName`); **injection** (rotate's answer narrowed by `tokenOf` and the `exp` check from TASK-1129; the stored value goes only to the vault and back to slack.com on the next rotate; response bodies are fixed codes; logs keep the allowlist; l's two worlds); **supply chain** (N/A: no `package.json` or lockfile change); and the residuals (a)-(h) in the shard's residual row.

---

### Task 3: On Postgres, a refused Connect keeps nothing, and an app Slack won't take back is remembered `[tier: integration]`

**Files:**
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts` (one new test after the TASK-1132 test, near `:1320`)

**Interfaces:**
- Consumes: Tasks 1-2 through the real plugin (`boot`, `call`, `request`, `installCount`, `probe`, `s.vault`, `secretRef`).

- [ ] **Step 1: Write the test** `"a Connect whose pasted refresh token Slack refuses keeps nothing on Postgres or in the vault; an app Slack then won't delete is remembered there, and the next Connect deletes it (TASK-1159)"`
  - `const dead = fakeConfigRefreshToken('DEADREFRESHSECRET')`, `const minted = fakeConfigRefreshToken('E2EMINTEDREFRESH2')`, `let deleteRefuses = false`. A local `fetchImpl` that records `{ method, auth, body }` (parse as the TASK-1132 test does) and answers: `apps.manifest.create` → by count `A07FIRSTAPP1`, `A07SECONDAP2`, `A07THIRDAPP3` (credentials as in that test), added to a `live` set; `apps.manifest.delete` → `{ ok: false, error: 'internal_error' }` while `deleteRefuses`, else `{ ok: true }` and `body.app_id` leaves `live`; `tooling.tokens.rotate` → `{ ok: false, error: 'invalid_refresh_token' }` for `dead`, else `{ ok: true, token: fakeConfigAccessToken('E2EROTATEDACCESS2'), refresh_token: minted, exp: 4_102_444_800 }`; anything else `{ ok: true }`.
  - `const { s, call } = await boot({ fetchImpl })`; `connect(refreshToken)` posts `{ accessToken: fakeConfigAccessToken(), refreshToken, botName: 'canopy-works' }` as `ADMIN.id`.
  - `connect(dead)` → `{ status: 502, body: { error: 'slack-refresh-token' } }`; `installCount()` 0; `SELECT install_id, app_id, bot_name FROM channel_slack_v1_leftover_apps` has no rows; `s.vault.size` 0; `[...live]` `[]`.
  - `deleteRefuses = true`; `connect(dead)` → the same 502. The leftover table holds exactly one row: `app_id 'A07SECONDAP2'`, `bot_name 'canopy-works'`, `install_id` matching `/^[A-Za-z0-9_-]{22}$/`. `installCount()` 0; `s.vault.size` 0. `GET /admin/slack` body matches `{ state: 'not-connected', leftoverApps: [{ botName: 'canopy-works', appId: 'A07SECONDAP2' }] }`.
  - `deleteRefuses = false`; `connect(fakeConfigRefreshToken())` → 200. An `apps.manifest.delete` with `auth === \`Bearer ${fakeConfigAccessToken()}\`` and `body.app_id === 'A07SECONDAP2'` comes before the last `apps.manifest.create`. The leftover table is empty, `installCount()` 1, the new install's `config-refresh-token` in `s.vault` is `minted`, and `[...live]` equals `['A07THIRDAPP3']`.

- [ ] **Step 2: Run it**

  Run: `DOCKER_HOST=<yours> AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack exec vitest run src/__tests__/plugin.test.ts`
  Expected: PASS.

- [ ] **Step 3: Prove it can fail.** With `git status --short` empty: drop `undoCreate`'s `rememberLeftoverApp` call, re-run: the test FAILS at the one-row assertion. Restore (`git checkout HEAD -- packages/channel-slack/src/admin-routes.ts`). Then make the put store the pasted `refreshToken`: it FAILS at the `minted` vault assertion. Restore, and check `git status --short` is empty.

- [ ] **Step 4: Commit.** Message: `[TASK-1159] channel-slack: prove on Postgres that a refused Connect keeps nothing, or remembers the app`.

---

### Task 4: Admin > Slack says what a refused refresh token means `[tier: mechanical]`

No markup change: `slackErrorCopy` already feeds the Connect form's error slot, so no shadcn work.

**Files:**
- Modify: `packages/channel-web/src/lib/slack-admin.ts` (`SLACK_ERROR_COPY` `:281-297`, `slackErrorCopy` `:312-339`)
- Test: `packages/channel-web/src/__tests__/admin-slack.test.tsx` (`'what an error says'` table, `:330-363`)
- Test: `packages/channel-web/src/components/admin/__tests__/SlackTab.test.tsx` (the "shown above the button" table, `:425-433`)

**Interfaces:**
- Consumes: Task 2's wire code `slack-refresh-token`.
- Produces: `SLACK_ERROR_COPY['slack-refresh-token']`, and `slackErrorCopy` maps the code to `{ field: null, message: SLACK_ERROR_COPY['slack-refresh-token'] }`.

- [ ] **Step 1: Write the failing rows**
  - `admin-slack.test.tsx`, after the `slack-token` row: `[refusal(502, 'slack-refresh-token'), null, "Slack didn't accept the refresh token. Generate a new pair and paste both again."]`.
  - `SlackTab.test.tsx`, after the `slack-token` row: `['slack-refresh-token', "Slack didn't accept the refresh token. Generate a new pair and paste both again."]`.

- [ ] **Step 2: Run and watch them fail**

  Run: `pnpm --filter @ax/channel-web exec vitest run src/__tests__/admin-slack.test.tsx src/components/admin/__tests__/SlackTab.test.tsx`
  Expected: the two new rows FAIL (they get the generic sentence). Everything else passes.

- [ ] **Step 3: Implement.** In `SLACK_ERROR_COPY`, after `slack-token`, with the comment `// Connect tried the pasted refresh token once and Slack refused it; the app we made is gone again.`: `'slack-refresh-token': "Slack didn't accept the refresh token. Generate a new pair and paste both again."`. In `slackErrorCopy`, a `case 'slack-refresh-token'` returning it with `field: null`.

- [ ] **Step 4: Run and pass**

  Run: `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build`, then the dependents command from Global Constraints.
  Expected: PASS.

- [ ] **Step 5: Commit.** Message: `[TASK-1159] channel-web: say what a refused refresh token at Connect means`.

---

### Task 5: The design and the changeset `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md` (`:250-255`, `:259-263`, `:289-302`, `:871`)
- Create: `.changeset/slack-connect-refresh-token.md`

- [ ] **Step 1: §3 step 3** (`:250-255`) becomes exactly:
  ```
  3. AX first deletes any app an earlier Disconnect couldn't (below), with the
     access token just pasted. Then it creates the shared app with
     `apps.manifest.create`, tries the pasted refresh token once (step 5), and
     sets the avatar (the branding logo) with `apps.icon.set`. If Slack refuses
     the refresh token, or doesn't answer, AX deletes the new app again and
     asks for a new pair, so an install never starts with a token Slack won't
     take (TASK-1159). The manifest sets the name, scopes, and the event and
     interactivity URLs. Slack sends no challenge and needs no manual Verify
     click (§7 Q1).
  ```
- [ ] **Step 2: §3 step 5** (`:259-263`) becomes exactly:
  ```
  5. AX keeps a **refresh token** and gets a fresh access token from it with
     `tooling.tokens.rotate` whenever it needs one. The first rotate is at
     Connect (step 3), so the one AX keeps is never the one pasted. Each rotate
     also hands back a new refresh token, and Slack retires the old one within
     minutes to hours (§7, configuration tokens), so AX stores the new one
     before it uses the access token (TASK-1129). Access tokens are never
     stored past their 12 hours.
  ```
- [ ] **Step 3: The Disconnect bullet.** Replace "Whether that Revoke also ends the refresh tokens rotates have minted since (the one AX holds after a rename) is unmeasured (TASK-1134)." (`:291-293`) with "Whether that Revoke also ends the refresh tokens rotates have minted since (the one AX holds from Connect on) is unmeasured: the TASK-1134 walk revoked right after a reconnect, before any rename, so the token it revoked was most likely the pasted one." After "tries to delete it with the newly pasted access token." (`:298`), insert "Connect keeps one the same way when it can't take back the app it just made (step 3)."
- [ ] **Step 4: §7, the configuration-tokens row** (`:871`): replace "(the one AX holds after a rename) is unmeasured (TASK-1134)." with "(the one AX holds from Connect on) is unmeasured: the TASK-1134 walk revoked right after a reconnect, before any rename."
- [ ] **Step 5: The changeset** `.changeset/slack-connect-refresh-token.md`:
  ```
  ---
  '@ax/channel-slack': patch
  '@ax/channel-web': patch
  ---

  Connecting Slack now checks the refresh token you paste. Right after we create the Slack app, we use that token once and keep the fresh one Slack hands back. If Slack won't take it, we delete the app we just made and ask you for a new token pair, instead of finishing a connection whose first rename or disconnect would fail. If Slack won't let us delete that app either, Admin > Slack names it until the next Connect deletes it. One side effect: the refresh token you pasted stops working a while after you connect, because Slack retires a token once it's been used. If you need one somewhere else, generate another pair.
  ```
- [ ] **Step 6: Check and commit.** `pnpm test:scripts` passes. Message: `[TASK-1159] docs: Connect tries the pasted refresh token once`.

---

## Ship-time steps (the builder; not implementer tasks)

1. **PR** (squash title `[TASK-1159] Slack: Connect tries the pasted refresh token once, and takes the app back if Slack refuses it`). Body: the card checked against the code (section above, with file:line); the Design bullets; `## Security review` from Task 2's shard row; boundary review: N/A (no hook, IPC action or manifest change; `POST /admin/slack/connect` gains one 502 code on an HTTP admin route mirrored by shape); "Not measurable in CI": the shard's four unmeasured items.
2. **Handoff `learnings:`**
   - **Next real-Slack walk, first:** Connect, then Revoke on Slack's configuration-tokens page, then Rename: the Rename must answer the token message. Every install now holds a rotate's successor from Connect on, so the "Revoke on Slack's page" advice depends on it. Then the card's question (can a newer token of the same person delete an app their earlier token made), and the acceptance: a pair whose refresh token was revoked gets "Slack didn't accept the refresh token" and leaves no app on api.slack.com/apps; a fresh pair connects and the first Rename works.
   - **TASK-1128** (replace the configuration token, not built): its route must take the admin lock, delete leftover apps with the newly pasted access token (TASK-1132), and try the pasted refresh token once and keep the successor, as Connect now does.
   - **TASK-1139** (success log lines): Connect's new lines are failures only (`try-refresh-token`, `undo-delete-app`, `remember-leftover-app`); no existing log call changed.
