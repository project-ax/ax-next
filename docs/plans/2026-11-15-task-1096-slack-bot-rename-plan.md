# TASK-1096: Slack — rename the shared bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AX admin renames the shared Slack bot from Admin › Slack. AX checks the name against Slack's rules, sends the app's whole manifest with `apps.manifest.update` using a freshly rotated configuration token, records the new name, and the tab shows the current name and what happened.

**Architecture:** `@ax/channel-slack` gains one Slack client method (`updateApp` → `apps.manifest.update`), one store method (`setBotName`) and one admin route (`POST /admin/slack/rename`). Each is assembled from pieces Connect and Disconnect already use: `checkBotName`, `buildAppManifest`, the rotate-then-act config-token step, the admin gate and the in-process lock. `@ax/channel-web` gains `renameSlackBot` and a Rename dialog on the connected card. The presets prove the route in the real assembly. No hook, no migration, no new dependency.

**Tech Stack:** TypeScript (exactOptionalPropertyTypes), vitest, Kysely on Postgres (store and composition tests via Testcontainers), React + shadcn + Testing Library (channel-web).

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` §3 "Renaming", §1.8, §7 Q3 and Q5, §9 item 6. Card: TASK-1096. Planner decisions, with the why and the alternatives: `.claude/memory/decisions/2026-11-15-TASK-1096.md`. Stack context: `.claude/memory/decisions/2026-11-13-TASK-1093.md` rows 16 and 77, `.claude/memory/decisions/2026-11-14-TASK-1095.md` row 19, and the mistakes shards `.claude/memory/mistakes/2026-11-13-TASK-1093.md` and `2026-11-15-TASK-1095.md`.

---

## Why this is not quite the card as written (yolo-ship rule 5)

1. **The validation already exists.** `checkBotName` (`packages/channel-slack/src/bot-name.ts:59-70`, TASK-1093) enforces every rule the card lists: ASCII letters, digits, space, `-`, `_`, `.`; at most 35 characters; `slackbot`/`here`/`channel`/`everyone` refused on the handle form (so `slack-bot` is refused too). It is tested in `bot-name.test.ts:56-110`. The card was written on 2026-11-09, before that code existed. This card reuses it at the new route and does not copy it into the UI.
2. **The design gives this card a second job the card doesn't carry.** Design §3 `:214-215` says "Replacing it [the configuration token] comes with the rename card (TASK-1096)". That line came from the TASK-1093 builder's own deferral (decisions row 16, 2026-11-13), after the card body was written. Replacement depends on an unmeasured Slack fact: whether another admin's configuration token can manage an app the first admin created. So it moves to a Backlog card (Task 7), and the design line is corrected (Task 8). The decisions shard supersedes TASK-1093 row 16. **Vinay is asked to confirm** (non-blocking).
3. **Lines this card makes false, each fixed in the task that changes the code:**
   - `admin-routes.ts:26-30` (the route list) and `:42-45` ("Only Disconnect reads it")
   - `slack-api.ts:3` and `:7` ("seventeen" methods)
   - `manifest.ts:73-76` ("The manifest `apps.manifest.create` takes")
   - `admin-routes.test.ts:539` ("the five admin routes")
   - `plugin.test.ts:599` ("the thirteen routes")
   - `channel-web/src/lib/slack-admin.ts:6-9` (the route list) and `SlackTab.tsx:9-14` (what each state shows)

## What exists today (read at `08aa5f048`)

- **Name rules:** `checkBotName(raw)` returns `{ ok: true; name }` or `{ ok: false; reason: 'empty' | 'too-long' | 'bad-characters' | 'reserved' }`. It trims and collapses whitespace runs. `BOT_NAME_MAX = 35` (`limits.ts:13`).
- **Manifest:** `buildAppManifest(botName, urls)` (`manifest.ts:77-109`) puts the name in `display_information.name` and `features.bot_user.display_name`, and carries nine scopes, `/ax`, two events and `settings.interactivity`. `slackUrls(publicOrigin, installId)` is at `:63-71`.
- **Admin routes** (`admin-routes.ts`):
  - `route()` (`:581-613`): runs `checkAdmin` (401/403), then the handler; an unhandled throw becomes a 500 logged code-only.
  - Every mutating route runs inside `d.lock.run`.
  - `deleteSlackApp` (`:423-441`) is the rotate-then-act pattern to copy, with stages `config-token` → `rotate` → `delete-app`. `failed(stage, err, installId)` logs `slack_admin_failed`.
  - `TOKEN_ERRORS` is at `:115-121`.
  - `canConnect = isHttps(d.publicOrigin)` (`:209`); Connect refuses 409 `public-origin-not-https` at `:495`.
  - `bodyObject` is at `:168-175`.
  - Connect's name handling (`:488-491`): a non-string name is 400 `{ error: 'invalid-bot-name', reason: 'bad-characters' }`.
  - `status()` already returns `botName` (`:459-476`).
- **Store** (`store.ts`): `InstallRow.botName`. `setOAuthState` and `activate` throw `InstallStoreError('install-not-pending')` when 0 rows change (`:115-122`, `:167-179`, `:226-240`).
- **Secrets:** `d.secrets.get(install, 'config-refresh-token')` returns `string | null` (null when nothing is stored). Any other vault fault throws.
- **Slack client** (`slack-api.ts`): 17 methods, all through `call(method, auth, body)`. Use `deleteApp` (`:469-471`) as the shape for `updateApp`. The `apps.*` methods take form bodies (`:20-24`).
- **Agent settings** show `install.botName` without an `@` (`agent-routes.ts:171,193`; `AgentSlack.tsx:137-138`), so they pick up a rename with no change.
- **channel-web:**
  - `slack-admin.ts`: `post()` (`:136-153`), `SLACK_ERROR_COPY` (`:211-220`), `slackErrorCopy` (`:235-256`) and `slackStateChanged` (`:259-268`, which already covers 409 `not-connected` and `public-origin-not-https`).
  - `SlackTab.tsx`: `ConnectedCard` (`:474-509`), `DisconnectDialog` (`:354-415`), the Connect form's name field (`:303-315`), the notices (`:73-74`, `:552-571`).
- **Test harnesses:**
  - `admin-routes.test.ts`: `memoryStore` (`:163-276`), `fakeSlack` (`:278-339`), `world()` (`:350-496`, helpers at `:486-492`), `connectedWorld` (`:520-525`), the secrets-never-leave test (`:1399-1479`; log fields may only be `installId`, `reason`, `stage`, `code`).
  - `plugin.test.ts`: the ordered route list (`:599-625`).
  - `slack-api.test.ts`: `everyMethod` (`:137-…`) feeds the shared transport tests.
  - Composition test: the fake Slack switch (`:284-372`, unknown methods answer `unknown_method`) and the first scenario (`:751-934`; `created` at `:790`; `let mark` is declared later, at `:814`).
  - Memory canary: the channel-slack test (`:737-813`); `apiJson(method, path, user, body?)` sends the CSRF header (`:424-450`).

## Delivery

One PR to `main`, Tasks 1–8. Review gate: `ax-code-reviewer` over the whole branch after Task 8. **security-checklist is required** (Tasks 1 and 3: a new admin route handling untrusted input, a stored configuration token in use, a new egress method). **No boundary review:** no hook is added or changed, the route rides the existing `http:register-route`, and channel-slack's manifest `calls` stay the same.

## Global Constraints

- **Nothing new at the platform level.** No new dependency, hook, migration, IPC action or plugin-manifest change. If `presets/k8s/src/__tests__/preset.test.ts` (which pins channel-slack's `calls`) changes, something was added by mistake.
- **Egress.** Egress stays `https://slack.com/api/<method>`. This card adds exactly one method, `apps.manifest.update`: a form body `{ app_id, manifest: JSON.stringify(manifest) }` sent with `Authorization: Bearer <config access token>`.
- **The whole manifest.** A rename always sends `buildAppManifest(name, slackUrls(d.publicOrigin, install.installId))`, never part of it. Slack replaces the manifest on update, so a partial one would drop interactivity, `/ax` and the scopes.
- **One name rule.** `checkBotName` is the only name rule. It runs before the vault is read or Slack is called. channel-web never re-implements it; it maps reasons to copy.
- **Order inside the lock.** First an active install, then the https origin, then the vault read, rotate, update, and the row write last. AX's row only ever shows a name Slack confirmed.
- **Logs.** Only `slack_admin_failed { installId, stage, code }`, with stages `config-token`, `rotate`, `update-app`. A log line never carries a token, the name, or Slack's text.
- **The minted access token.** It goes only into `updateApp`. Nothing returns, logs or stores it.
- **No Slack-facing words change**, so channel-slack's `copy.ts` is untouched. UI copy lives in `slack-admin.ts` and `SlackTab.tsx`, exactly as written in Tasks 5 and 6. JSX text escapes apostrophes as `&apos;`, like the rest of the file.
- **Fake tokens.** Use the existing fake-token helpers (`fakeConfigAccessToken`, `fakeConfigRefreshToken`, `fakeBotToken`). Never write a real-shaped literal; before committing, grep with `git grep -nE 'xox[bpe]-[0-9]{10,13}-'`.
- **Other repo hygiene** (from the mistakes shards):
  - No literal invisible or bidi characters. Never type a `\u` escape into a tool.
  - `beforeEach` bodies are blocks.
  - Under zsh, keep test-file lists in arrays.
  - Wait on the condition you assert (`vi.waitFor`), never on an earlier event.
- **Type-checking.** channel-slack's tests are not type-checked (TASK-1124); `pnpm --filter @ax/channel-slack run build` type-checks `src`. channel-web's `tsc --build` includes its tests.
- **UI.** Use installed shadcn primitives only (`Dialog`, `Field`/`FieldGroup`, `Input`, `Button`, `Alert`, `Spinner`; all already imported by `SlackTab.tsx`) and semantic tokens. Invoke the `shadcn` skill before Task 6.

## Review Focus

Each case below has its test in the owning task.

1. **The configuration token stopped working** (revoked on Slack's page, or its owner left). Expect 502 `slack-config-token`, the row unchanged, and the dialog saying how to fix it. (Task 3 test 4, Task 6 test 4.)
2. **Slack refuses a name our rule let through** (Slack's rules moved). Expect `invalid_manifest` → 502 `slack-name` → the dialog's field error, with nothing stored. (Task 3 test 5, Task 6 test 3.)
3. **Two admins: a rename racing a Disconnect.** The lock serializes them. Whichever comes second sees the result: the rename then gets 409 `not-connected`, and the tab refreshes. (Task 3 test 8, Task 6 test 6.)
4. **Slack took the name, but the row write failed.** Expect 500. A retry sends the identical manifest and lands. (Task 3 test 7.)
5. **A double click on Rename.** Expect exactly one request, and the dialog can't be closed mid-flight. (Task 6 test 7.)

---

### Task 1: Slack client: `apps.manifest.update` [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/channel-slack/src/slack-api.ts`:
  - header `:3` and `:7`: "seventeen" → "eighteen"
  - `SlackApi` `:142-206`
  - `SlackMethod` `:208-225`
  - the implementation beside `deleteApp` `:469-471`
- Modify (fakes): every test file whose whole-`SlackApi` fake lists `deleteApp` (`git grep -l "deleteApp: notHere" packages/channel-slack/src/__tests__`, plus `answers.test.ts`, which uses `notHere('deleteApp')`). Add `updateApp` in the file's own style. `admin-routes.test.ts` gets its recording version in Task 3.
- Test: `packages/channel-slack/src/__tests__/slack-api.test.ts`

**Interfaces:**
- Produces: `SlackApi.updateApp(configToken: string, appId: string, manifest: Record<string, unknown>): Promise<void>`. It POSTs `apps.manifest.update` with the form `{ app_id: appId, manifest: JSON.stringify(manifest) }` and `bearer(configToken)`.
  - It resolves on `ok: true` and reads nothing else from the answer. `permissions_updated` is deliberately unread; say why in one doc line: "the manifest carries this build's scopes; a card that changes `BOT_SCOPES` owns existing installs".
  - Failures are the shared `SlackApiError('apps.manifest.update', code)`.

- [ ] **Step 1: Write the failing tests.**
  - Add `['apps.manifest.update', () => api.updateApp(CFG, 'A0APP', { display_information: { name: 'ax' } })]` to `everyMethod`. The file's shared transport tests (redirect refused, statuses, 429 with Retry-After, size cap, bad JSON, timeout, code-only errors) then cover it.
  - `it('updateApp sends the app id and the whole manifest as form fields with the config token')`:
    - Set up: `const manifest = buildAppManifest('Ada Helper', slackUrls('https://ax.example', 'AAAAAAAAAAAAAAAAAAAAAA'))`, then `await api.updateApp(CFG, 'A0APP', manifest)`.
    - Expect `slack.sent.map((r) => [r.method, formOf(r), r.headers.get('authorization')])` toStrictEqual `[['apps.manifest.update', { app_id: 'A0APP', manifest: JSON.stringify(manifest) }, \`Bearer ${CFG}\`]]`.
    - Expect `JSON.parse(formOf(slack.sent[0]!).manifest)` toEqual `manifest`.
  - `it('updateApp resolves whatever permissions_updated says, and rejects refusals code-only')`:
    - An answer of `{ ok: true, app_id: 'A0APP', permissions_updated: true }` resolves to `undefined`.
    - Each of `invalid_manifest`, `invalid_auth` and `token_revoked`, through the file's `slackError(code)` helper, rejects with message `` `slack apps.manifest.update: ${code}` `` and `code === code`.
- [ ] **Step 2: Run, expect FAIL** (`api.updateApp is not a function`).
  `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/slack-api.test.ts`
- [ ] **Step 3: Implement** the method, the union entry and the header counts.
- [ ] **Step 4: Add `updateApp` to the other fakes, then run.**
  `pnpm --filter @ax/channel-slack run build && pnpm --filter @ax/channel-slack exec vitest run src/__tests__/slack-api.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit** (stage paths explicitly).

### Task 2: Store: `setBotName` [tier: mechanical]

**Files:**
- Modify: `packages/channel-slack/src/store.ts` (the `InstallStore` interface `:35-76`, `InstallStoreError` `:115-122`, the implementation)
- Test: `packages/channel-slack/src/__tests__/store.test.ts` (the "install rows" describe, `:138-270`; Postgres via Testcontainers, so use the Local gate's Docker env)

**Interfaces:**
- Produces: `InstallStore.setBotName(installId: string, botName: string): Promise<void>`.
  - One `UPDATE channel_slack_v1_installs SET bot_name = … WHERE install_id = … AND status = 'active'`.
  - It throws `new InstallStoreError('install-not-active')` unless exactly one row changed (the same `numUpdatedRows !== 1n` check as `activate`).
  - `botName` must already have passed `checkBotName`. As with `insertPending`, nothing is cleaned here.
- Produces: `InstallStoreError.code: 'install-not-pending' | 'install-not-active'` (widen the constructor parameter to match).

- [ ] **Step 1: Write the failing tests.**
  - `it('setBotName renames an active install and changes nothing else, on no other install')`:
    - Set up: insert install A, activate it, insert pending install B, and snapshot `get(A)` and `get(B)`.
    - `await setBotName(A, 'Ada Helper')`.
    - Expect `get(A)` toEqual `{ ...snapshotA, botName: 'Ada Helper' }`, and `get(B)` toEqual `snapshotB`.
  - `it('setBotName refuses an install that is missing or still pending, and changes nothing')`:
    - A pending install rejects with `InstallStoreError` whose `code` is `'install-not-active'`, and `get()` keeps the old name.
    - An unknown id rejects the same way.
- [ ] **Step 2: Run, expect FAIL.**
  `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/store.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** The same command and `pnpm --filter @ax/channel-slack run build`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: The rename route [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/channel-slack/src/admin-routes.ts`:
  - header `:26-30`: add `POST /admin/slack/rename { botName } → { botName }`
  - header `:42-45` becomes: "Only Disconnect and Rename read it, each to mint one access token that is used once: Disconnect to delete the app, Rename to update its manifest"
  - `ADMIN_RENAME_PATH`, the route, its helpers, and the route table at `:615-622`
- Modify: `packages/channel-slack/src/manifest.ts:73-76`. The doc becomes: "The manifest `apps.manifest.create` and `apps.manifest.update` take. Slack replaces the whole manifest on update, so a rename sends all of it, and a scope or event added here reaches an existing install that way (Slack then wants a re-Allow, which nothing builds yet: the card that adds one owns existing installs). `botName` must already have passed `checkBotName`."
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts`, `packages/channel-slack/src/__tests__/plugin.test.ts:599-625`

**Interfaces:**
- Consumes: `SlackApi.updateApp` (Task 1); `InstallStore.setBotName` and `InstallStoreError('install-not-active')` (Task 2).
- Produces (the HTTP contract Task 5 mirrors): `export const ADMIN_RENAME_PATH = '/admin/slack/rename'`. It takes `POST` with JSON `{ botName: string }` and answers:
  - 200 `{ botName }`: the tidied name, as stored.
  - 400 `{ error: 'invalid-body' }` when the body is not a JSON object.
  - 400 `{ error: 'invalid-bot-name', reason }` with `reason` one of `'empty' | 'too-long' | 'bad-characters' | 'reserved'`. A missing or non-string `botName` is reason `'bad-characters'`, like Connect.
  - 413 `{ error: 'body-too-large' }` (backstop).
  - 409 `{ error: 'not-connected' }` when there is no install, it isn't active, or the row is gone at write time.
  - 409 `{ error: 'public-origin-not-https' }`.
  - 502 `{ error: 'slack-config-token' | 'slack-name' | 'slack-error' }`.
  - 500 `{ error: 'internal' }`.
  - 401/403 from the gate.
- Internal:
  - `updateSlackApp(install: InstallRow, botName: string): Promise<'slack-config-token' | 'slack-name' | 'slack-error' | null>` copies `deleteSlackApp`'s staging.
    - A null refresh token logs `{ installId, stage: 'config-token', code: 'missing' }` at warn and returns `'slack-config-token'`. A vault fault propagates, so the route answers 500.
    - On a Slack failure, it calls `failed(stage, err, installId)` and maps the error:
      - A `SlackApiError` whose code is in `CONFIG_TOKEN_REFUSED = TOKEN_ERRORS ∪ {'invalid_refresh_token'}` → `'slack-config-token'`.
      - `stage === 'update-app'` and code `invalid_manifest` → `'slack-name'`.
      - Anything else → `'slack-error'`.
  - Mount `route('POST', ADMIN_RENAME_PATH, 'rename', rename)` between install-url and disconnect.

- [ ] **Step 1: Extend the harness.**
  - `fakeSlack`: add `updateApp(token, appId, manifest): Promise<void>` to `SlackBehaviour`, an `on.updateApp` that defaults to `async () => {}`, and a recording `api.updateApp`.
  - `memoryStore`: add `setBotName` with the real rule. Call `enter('setBotName', [installId, botName])`, throw `new InstallStoreError('install-not-active')` unless the row exists and is `active`, then set `botName`.
  - `world()`: add `rename: (body: unknown = { botName: 'Ada Helper' }, as: TestUser | null = ADA) => call('POST', '/admin/slack/rename', { as, body })`.
- [ ] **Step 2: Write the failing tests.**
  - **Route table** (`:538-554`): retitle it "is exactly the six admin routes; …" and add `'POST /admin/slack/rename'` to the sorted list.
  - **`plugin.test.ts:599`**: retitle it "init registers the fourteen routes, …" and add `{ method: 'POST', path: '/admin/slack/rename', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES }` right after the install-url entry.
  - New `describe('POST /admin/slack/rename')`:
    1. **`it('rotates the stored refresh token and sends Slack the whole manifest with only the name changed; the row and the status show the new name')`**
       - Set up: from `connectedWorld()`, take `mark = w.slack.calls.length`, then `w.rename({ botName: '  Ada   Helper ' })`.
       - Expect the answer `{ status: 200, body: { botName: 'Ada Helper' } }`.
       - Expect the Slack calls after `mark` to equal `[{ method: 'rotateConfigToken', args: [REFRESH] }, { method: 'updateApp', args: [MINTED_ACCESS, APP.appId, buildAppManifest('Ada Helper', slackUrls(ORIGIN, installId))] }]`.
       - The update's manifest toEqual a `structuredClone` of the `createApp` manifest with `display_information.name` and `features.bot_user.display_name` set to `'Ada Helper'`. Its `settings.interactivity.request_url` is `` `${ORIGIN}/slack/interactions/${installId}` ``.
       - Expect `onlyRow(w).botName === 'Ada Helper'`, the status body's `botName === 'Ada Helper'`, and `slack:updateApp` before `store:setBotName` in `w.trail`.
    2. **`it('refuses a bad name with { error: "invalid-bot-name", reason } before reading the vault or calling Slack')`**
       - Cases: `['', 'empty']`, `['a'.repeat(36), 'too-long']`, `['Café', 'bad-characters']`, `['slack-bot', 'reserved']`, `[42, 'bad-characters']`, and `{}` (no name) → `'bad-characters'`.
       - Each one fails exactly one rule.
       - Expect 400, no new Slack call, and no new `credentials:get` in `w.vaultCalls`.
       - Also: a non-object body → 400 `invalid-body`, and a body over the cap → 413 (copy Connect's `:851-859`).
    3. **`it('→ 409 not-connected with nothing connected or an unfinished install; → 409 public-origin-not-https on an http origin; neither touches the vault or Slack')`**
       - Nothing connected → 409 `not-connected`.
       - After `connect()` alone (pending) → 409 `not-connected`.
       - `world({ publicOrigin: HTTP_ORIGIN })` with an active row put straight into `w.memory.rows` → 409 `public-origin-not-https`, with `w.slack.calls` and `w.vaultCalls` empty.
    4. **`it('a configuration token Slack no longer accepts → 502 slack-config-token; the row keeps its name')`** (Review Focus 1)
       - Cases:
         - the refresh token missing from the fake vault (`w.vault.delete(secretRef(installId, 'config-refresh-token'))`, importing `secretRef` from `../secrets.js` rather than spelling the `slack:` prefix): expect the log `{ stage: 'config-token', code: 'missing' }`
         - `rotateConfigToken` rejecting `new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token')`
         - `updateApp` rejecting `SlackApiError('apps.manifest.update', c)` for each `c` of `invalid_auth`, `not_authed`, `token_expired`, `token_revoked`, `account_inactive`
       - Each case: 502 `{ error: 'slack-config-token' }`, `onlyRow(w).botName === 'Canopy Bot'`, no `store:setBotName` in the trail, and a `slack_admin_failed` line with that stage and code.
    5. **`it('Slack refusing the manifest → 502 slack-name; anything else Slack says → 502 slack-error; nothing stored')`** (Review Focus 2)
       - `updateApp` rejecting `invalid_manifest` → `slack-name`.
       - `updateApp` rejecting `ratelimited`, `timeout`, `http-503`, `app_not_found` or `bad-response` → `slack-error`.
       - `rotateConfigToken` rejecting `invalid_manifest` or `network` → `slack-error`. This pins that `slack-name` only comes from the update step.
    6. **`it('a vault fault reading the token → 500, logged code-only, and Slack is never called')`**
       - Set `w.vaultFailures.set('credentials:get config-refresh-token', new Error('vault down'))`.
       - Expect 500 `{ error: 'internal' }` and no Slack call after `mark`.
    7. **`it('the row write failing after Slack said yes → 500; a retry sends the same manifest and lands')`** (Review Focus 4)
       - Set `w.memory.failures.set('setBotName', new Error('db down'))`.
       - Expect 500, one `updateApp`, and the row unchanged.
       - Then clear the failure and rename again. Expect 200, two `updateApp` calls with toEqual manifests, and the row renamed.
    8. **`it('a rename and a disconnect never interleave')`** (Review Focus 3)
       - Gate `on.updateApp` on a `deferred()`. Start `w.rename()`, then `w.disconnect()`, `await settle()`, and resolve the gate.
       - Expect the rename 200 and the disconnect 200 `{ appDeleted: true }`. In `w.trail`, `slack:updateApp` < `store:setBotName` < the second `slack:rotateConfigToken` < `slack:deleteApp`.
       - The reverse in a fresh `connectedWorld()`: gate `on.deleteApp`, start the disconnect first, then the rename.
       - Expect the disconnect 200, the rename 409 `not-connected`, and no `updateApp` call.
    9. **`it('saving the name it already has sends the manifest again and answers 200')`**
       - Rename to `'Canopy Bot'` (Connect's name).
       - Expect 200 and one `updateApp`.
    10. **`it('never calls credentials:set, and the minted access token goes nowhere but updateApp')`**
        - Mirror Disconnect's `:1378-1386`.
  - **Secrets never leave** (`:1399-1479`):
    - In the happy world, add `await happy.rename()` before `happy.disconnect()`.
    - Add three tracked worlds from `connectedWorld()`, each renamed once: one with `on.rotateConfigToken` throwing `leak('rotate')`, one with `on.updateApp` throwing `leak('updateApp')`, and one with `memory.failures.set('setBotName', leak('setBotName'))`.
    - The existing assertions then cover rename.
  - The existing "every JSON route: non-admin → 403, unauthenticated → 401" test picks the new route up by itself. Confirm it passes.
- [ ] **Step 3: Run, expect FAIL.**
  `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts src/__tests__/plugin.test.ts`
- [ ] **Step 4: Implement** the route, the helpers, the two doc edits and the mount.
- [ ] **Step 5: Run.** The same command, then `pnpm --filter @ax/channel-slack run build`. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 4: The rename in the real assembly (presets) [tier: integration]

**Files:**
- Modify: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`:
  - the fake Slack switch `:284-372`
  - the first scenario: a new step between step 2's final status check (`:801-808`) and step 3
- Modify: `presets/memory/src/__tests__/canary.test.ts`: the channel-slack test `:737-813`; append TASK-1096 to its title

**Interfaces:**
- Consumes: Task 3's HTTP contract.

- [ ] **Step 1: Write the tests.**
  - **Composition, step "2b. The admin renames the bot"**:
    - Use a local `const renameMark = slackCalls.length` (`let mark` is only declared at `:814`).
    - Set `actor = { id: ADMIN, isAdmin: true }`, then call `callRoute('POST', '/admin/slack/rename', { body: jsonBody({ botName: 'Canopy Helper' }) })`.
    - Expect the answer `{ status: 200, body: { botName: 'Canopy Helper' } }`.
    - Expect `slackCalls.slice(renameMark).map((c) => c.method)` toEqual `['tooling.tokens.rotate', 'apps.manifest.update']`.
    - The rotate body toEqual `{ refresh_token: CONFIG_REFRESH_TOKEN }`.
    - The update's `auth` is `` `Bearer ${ROTATED_ACCESS_TOKEN}` `` and its `body.app_id` is `APP_ID`.
    - `JSON.parse(String(update.body['manifest']))` toEqual `JSON.parse(String(created.body['manifest']))` with the two name fields set to `'Canopy Helper'`.
    - `query('SELECT bot_name FROM channel_slack_v1_installs')` toEqual `[{ bot_name: 'Canopy Helper' }]`, and `GET /admin/slack`'s body has `botName: 'Canopy Helper'`.
    - Then set `actor = null`. The scenario's own Disconnect at step 6 cleans up the install.
  - **Canary**, after the disconnect CSRF check:
    - A POST to `/admin/slack/rename` without the CSRF header is 403. Copy the `noCsrf` fetch.
    - `apiJson('POST', '/admin/slack/rename', CANARY_ADMIN, { botName: 'Canary Bot' })` toEqual `{ status: 409, json: { error: 'not-connected' } }`.
    - This is the route's own answer: nothing is connected in the canary, and an unmounted POST would get the router's 405 (`:767-771`).
- [ ] **Step 2: Run, expect the composition test to FAIL.** The fake answers `unknown_method`, so the route answers 502 `slack-error`. The canary assertions pass already: they pin the mount.
  - `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/channel-slack-composition.test.ts`
  - `pnpm --filter @ax/preset-memory exec vitest run src/__tests__/canary.test.ts`
- [ ] **Step 3: Implement.** Add `case 'apps.manifest.update': answer = { ok: true, app_id: APP_ID, permissions_updated: false }; break;` to the fake.
- [ ] **Step 4: Run both, expect PASS.** If a Docker-backed file fails, classify it by error text first (`grep -E 'Error: '`), per the TASK-1094 mistakes shard.
- [ ] **Step 5: Commit.**

### Task 5: channel-web client: `renameSlackBot` and its error sentence [tier: mechanical]

**Files:**
- Modify: `packages/channel-web/src/lib/slack-admin.ts`:
  - header `:6-9`: add `POST /admin/slack/rename { botName } → { botName }`
  - `RENAME_PATH`, `renameSlackBot`
  - a `SLACK_ERROR_COPY` entry and a `slackErrorCopy` case
- Test: `packages/channel-web/src/__tests__/admin-slack.test.tsx`

**Interfaces:**
- Consumes: Task 3's HTTP contract (mirrored by shape, not imported: invariant 2).
- Produces: `renameSlackBot(botName: string): Promise<{ botName: string }>`.
  - It POSTs `/admin/slack/rename` with exactly `{ botName }` (as typed; the server tidies) through `post()`.
  - It returns the answer's `botName` when that is a non-empty string, else throws `SlackAdminError(status, 'bad-response')`.
- Produces: `SLACK_ERROR_COPY['slack-config-token']`, with this exact copy: "Slack stopped accepting the configuration token we have, so we couldn't rename the bot. To fix it, disconnect Slack, then connect it again with a new token. Channels will need connecting again after that."
  - `slackErrorCopy` maps code `slack-config-token` to `{ field: null, message: <that> }`.
  - The existing mappings already cover the rest: `invalid-bot-name` and `slack-name` go to the `botName` field, and anything else is the generic sentence.

- [ ] **Step 1: Write the failing tests.**
  - `it('renameSlackBot POSTs exactly the name with the CSRF header and returns the name the server kept')`:
    - The server answers `json(200, { botName: 'Ada Helper', extra: 1 })`.
    - `await renameSlackBot('  Ada   Helper ')` toEqual `{ botName: 'Ada Helper' }`.
    - The recorded call is `{ url: '/admin/slack/rename', method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' }, body: { botName: '  Ada   Helper ' } }`.
  - `it('a rename answer without a usable name is refused')`: answers `{}`, `{ botName: '' }` and `{ botName: 7 }` each reject with a `SlackAdminError` whose code is `bad-response`.
  - In the `what an error says` table, add `[refusal(502, 'slack-config-token'), null, <the exact copy>]`.
- [ ] **Step 2: Run, expect FAIL.**
  `pnpm --filter @ax/channel-web exec vitest run src/__tests__/admin-slack.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `pnpm --filter @ax/channel-web run build`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 6: Admin › Slack: Rename the bot [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/admin/SlackTab.tsx`:
  - header `:9-14`: the connected line becomes "the workspace, the bot (with Rename), who added the token and when"
  - `Notice` `:74`, `Actions` `:76-81`, `ConnectedCard` `:474-509`, a new `RenameDialog`, `SlackTab` `:528-579`
- Test: `packages/channel-web/src/components/admin/__tests__/SlackTab.test.tsx`. The `vi.mock` list at `:20-27` gains `renameSlackBot: vi.fn()`.

**Interfaces:**
- Consumes: `renameSlackBot`, `slackErrorCopy`, `slackStateChanged` (Task 5).
- Produces (inside the file):
  - `Notice` gains `{ kind: 'renamed'; botName: string }`.
  - `Actions` gains `onRenamed: (botName: string) => void`, which `StatusView` passes through; only `ConnectedCard` uses it.
  - `SlackTab`'s `onRenamed` sets the notice and calls `read()`, exactly as `onDisconnected` does.

**The UI, exactly:**
- **Bot name row:** the `<dd>` holds the name (`text-muted-foreground`) and `<Button variant="outline" size="sm">Rename</Button>` in a `flex items-center gap-3`. The row keeps `min-h-12 … justify-between`. Clicking the button opens the dialog.
- **Dialog structure:** a `Dialog` whose form state lives in a child rendered inside `DialogContent`, so every opening starts fresh, prefilled with `status.botName`, with no error.
- **Dialog copy:**
  - `DialogTitle`: "Rename the bot"
  - `DialogDescription`: "Only the name changes. Conversations and connected channels keep working."
  - The field: `FieldLabel` "Bot name" (`htmlFor="slack-rename-bot-name"`); an `Input`; `FieldDescription` "The name people see in Slack." (`id="slack-rename-bot-name-hint"`); `FieldError` (`id="slack-rename-bot-name-error"`) for a `botName` error.
  - Wire `aria-invalid`/`aria-describedby` as the Connect form does (`:303-315`).
- **Form-level errors** (`field === null`) go in `<Alert variant="destructive"><AlertDescription>`.
- **Footer:** `Cancel` (`variant="outline"`, `type="button"`) and `Rename` (`type="submit"`).
- **While busy:** both buttons are disabled, the submit reads `<Busy>Renaming…</Busy>`, and the dialog ignores close requests (Escape or the overlay), like `DisconnectDialog`'s `close` (`:369-373`).
- **Submit:** call `renameSlackBot(value)` with the input's value as typed.
  - Success → `onRenamed(botName)`.
  - `slackStateChanged(err)` → `onChanged()`.
  - Otherwise → `slackErrorCopy(err)`. Focus the input when the error is the `botName` field's.
- **Success notice** (a plain `<Alert>` above the tab, like the others): "Renamed. People in Slack now see the bot as {botName}." Use the name from the server's answer.

- [ ] **Step 1: Invoke the `shadcn` skill.** Confirm the primitives above are installed in `packages/channel-web`. Nothing should need adding.
- [ ] **Step 2: Write the failing tests** (a new `describe('Rename')`; scope dialog queries with `within(dialog)`, where `dialog = await screen.findByRole('dialog', { name: 'Rename the bot' })`).
  1. `it('the connected card shows the name with a Rename button; the dialog opens with that name filled in')`:
     - The card shows `canopy` and a Rename button.
     - The dialog shows the description and the hint, and the input's value is `canopy`.
  2. `it('Rename sends the name as typed, then says what Slack shows now and reads the tab again')`:
     - Set up: `rename.mockResolvedValueOnce({ botName: 'Ada Helper' })` and `renderTab(CONNECTED, { ...CONNECTED, botName: 'Ada Helper' })`. Type `'  Ada   Helper '` and submit.
     - Expect `rename` called with `'  Ada   Helper '`.
     - An alert has the text "Renamed. People in Slack now see the bot as Ada Helper."
     - `status` is called twice, the dialog is gone, and the row shows `Ada Helper`.
  3. `it('a name Slack can't use stays in the dialog, under the field')`:
     - `SlackAdminError(400, 'invalid-bot-name', 'reserved')` → the field error "Slack keeps that name for itself. Pick another.", with the input `aria-invalid` and focused.
     - `SlackAdminError(502, 'slack-name')` → "Slack didn't accept that bot name. Try another."
     - In both cases the dialog stays open and `status` is called once.
  4. `it('a configuration token Slack no longer accepts says what to do, in the dialog')`: `SlackAdminError(502, 'slack-config-token')` → an alert in the dialog with Task 5's exact copy. Nothing is re-read.
  5. `it('other trouble reads as the generic sentence and changes nothing')`: `SlackAdminError(500, 'internal')` and `new TypeError('Failed to fetch')` each show "Something went wrong talking to Slack. Try again in a minute."
  6. `it('someone else disconnected meanwhile: it refreshes and says so')`:
     - Set up: `SlackAdminError(409, 'not-connected')` and `renderTab(CONNECTED, NOT_CONNECTED)`.
     - Expect "This changed while you were here, so we've refreshed it." and the Connect form showing.
  7. `it('is one request at a time: Rename and Cancel wait while Slack answers')` (Review Focus 5):
     - With a pending promise, clicking Rename twice makes one call.
     - Both buttons are disabled and "Renaming…" shows. Escape leaves the dialog open.
     - After resolving, the notice shows.
  8. `it('Cancel closes without a request, and opening again starts from the current name')`:
     - Type, then Cancel: no call.
     - Reopen: the value is `canopy` and no error shows.
- [ ] **Step 3: Run, expect FAIL.**
  `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/SlackTab.test.tsx`
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the test and `pnpm --filter @ax/channel-web run build` (tsc includes channel-web's tests). Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 7: Board: the token follow-up card and the walk's new checks [tier: mechanical]

No code. This is a standalone run, so the builder writes the board (yolo-ship rule 3). Mind the memory index's board lessons: claim one id at a time, verify the card exists with a live read rather than a snapshot, and edit bodies only, because a `--title` edit drops the `[TASK-n]` prefix.

- [ ] **Step 1: Create one Backlog card.**
  - Allocate its id with `scripts/board-task-id.sh` (read its usage first).
  - Title: `[TASK-<n>] Slack: replace the configuration token in Admin › Slack`. Depends on: `TASK-1096`.
  - The body says, in plain words:
    - **The need.** Configuration tokens belong to one person. When that person revokes it or leaves, Rename and Disconnect stop working, and today's only fix (Disconnect, then Connect) drops every channel connection.
    - **Measure first.** Does another admin's configuration token pass `apps.manifest.update` (or `apps.manifest.export`) on an app the first admin created, or must they be added as a collaborator on api.slack.com/apps?
    - **What it touches.** A new admin route that stores a pasted refresh token. `connected_by_user_id`, which is the identity every vault read uses (`packages/channel-slack/src/secrets.ts:84-90`). The "Added by … on …" date, now `created_at`, needs its own column (a migration).
    - **References.** Design §3 `:211-221`, `.claude/memory/decisions/2026-11-15-TASK-1096.md` row 1, and TASK-1093 decisions row 77's Disconnect wording. "We couldn't remove the Slack app itself" should become "we couldn't confirm the Slack app was deleted", because Disconnect reports `appDeleted: false` also when the app was already gone.
  - Re-read the card live and check the id and Status.
- [ ] **Step 2: Append to the TASK-1097 walk card's body.** Read it, append, and write it back whole.
  - "TASK-1096 adds three unmeasured checks:
    - (1) Rename through Admin › Slack on real Slack: the new name shows in Slack without a reload, the @handle stays, and a DM and a channel mention still work.
    - (2) On an install with no interactivity URL (remove it on api.slack.com/apps, or an install connected before TASK-1095), save the bot name. Allow and Deny buttons then work without a reconnect.
    - (3) Revoke the configuration token on Slack's page, then rename. The dialog shows the token message."
- [ ] **Step 3: Log the new card id** as a row in the decisions shard, for Task 8.

### Task 8: Design doc, stale lines and changeset [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`
- Create: `.changeset/slack-bot-rename.md` (`'@ax/channel-slack': patch`, `'@ax/channel-web': patch`, matching the TASK-1095 changesets: no hook-surface change)

- [ ] **Step 1: Design edits.** Each is a line this card makes stale; confirm each is in the diff at review.
  - **§3 "Renaming" `:200-203`** becomes:
    > **Renaming:** Admin › Slack → **Rename** (TASK-1096), once Slack is connected. AX checks the name (§7 Q3) and applies it with `apps.manifest.update`, using an access token minted from the stored refresh token. Slack replaces the whole manifest on update, so AX sends all of it as this build makes it, with only the name changed. There's no reinstall, and the bot token keeps working (§7 Q3). The name people see changes; the @handle underneath stays as it was at install. Slack shows mentions by current name, so people don't notice.
  - **§3 `:214-215`.** Replace "Replacing it comes with the rename card (TASK-1096)." with: "Replacing it isn't built yet (TASK-<n>, Task 7's card). Until then, a token that stops working means Disconnect, then Connect with a new one."
  - **§3, the interactivity paragraph `:236-242`.** Append: "Saving the bot's name (TASK-1096) also sends the whole current manifest, so it should bring that URL to an older install without a reconnect. That isn't measured yet; the TASK-1097 walk checks it."
- [ ] **Step 2: Write the changeset** in the project voice:
  > Admins can now rename the Slack bot from Admin > Slack: click **Rename** next to its name. We check the name against Slack's rules first, then tell Slack, and people see the new name straight away. Nothing needs reinstalling, and connected channels keep working. (The bot's @handle stays the one it got when Slack was first connected; Slack shows the new name in mentions anyway.) If Slack no longer accepts the configuration token we have, the tab says so and what to do about it.
- [ ] **Step 3: Grep the stale spellings.**
  `git grep -nE 'Replacing it comes with the rename card|seventeen|Only Disconnect reads it|five admin routes|thirteen routes' -- docs/plans/2026-11-09-channel-slack-design.md packages/channel-slack packages/channel-web/src`
  Expected: no output.
- [ ] **Step 4: Run `pnpm lint`, expect PASS. Commit.**

---

## Local gate (before the review gate and before calling anything green)

```bash
cd /Users/vpulim/dev/ai/ax-next/.claude/worktrees/TASK-1096
export DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock
export AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000
pnpm build
pnpm -r --no-bail --filter "...@ax/channel-slack" --filter @ax/channel-web run test
pnpm test:scripts
pnpm test:eslint-rules
pnpm lint
```

- `--filter` goes before `run test`. `--no-bail` matters, or the first failing package hides the rest.
- `...@ax/channel-slack` also runs its dependents: cli, preset-k8s and preset-memory.
- `AX_TESTCONTAINER_START_SLOT_WAIT_MS` caps at 600000.
- On a loaded host, add `--workspace-concurrency=1`.

## Security notes (input for the security-checklist walk)

- **Sandbox escape.** No sandbox, IPC or runner change, so the runner can't reach the new route (it's a host admin route).
  - The route sits behind the existing admin gate (401/403), with http-server's CSRF check and a body cap.
  - The new Slack method goes through the single egress client: same host, no redirects, timeout, size cap, code-only errors.
- **Prompt injection / untrusted input.** No model or tool text is involved. The name is admin input:
  - `checkBotName` limits it to `[A-Za-z0-9 ._-]`, at most 35 characters, not reserved. This runs before any vault read or Slack call.
  - It enters the manifest through `JSON.stringify` and the request through `URLSearchParams`.
  - It is stored with a parameterized query and rendered by React.
  - It can't carry a mention, markup or a control character into Slack.
- **Secrets.**
  - The refresh token is read from the vault (global scope) and rotated once.
  - The minted access token is used for the one update and dropped. The client never returns Slack's new refresh token (`slack-api.ts:40-43`).
  - No response or log line carries a token: the leak test covers rename.
- **Capability.** `apps.manifest.update` can change an app's scopes and URLs. The route only ever sends `buildAppManifest(…)` from code, with config-derived https URLs (the https guard) and the install's own app id.
- **Supply chain.** No new dependency.
- **Residuals to state in the PR.**
  - Each rename mints a configuration-token pair that Slack keeps live and AX never sees (Disconnect already does this). Only Revoke on Slack's page ends them.
  - The lock is in-process, which assumes one host replica, as every admin route does.
  - After a 500 (row write failed) or a `slack-error` with no answer, Slack may already show the new name. A retry converges.
  - A future `BOT_SCOPES` change reaches existing installs through a rename (the `manifest.ts` doc line says so).
  - A pending install can't be renamed. Cancel and Connect again instead.
