# TASK-1129: Store the rotated Slack configuration refresh token — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `tooling.tokens.rotate` keeps the refresh token Slack mints with it, so Rename works more than once and Disconnect after a rename still deletes the Slack app.

**Architecture:** `rotateConfigToken` (the Slack client) starts handing back the minted refresh token. Its two callers in `admin-routes.ts` (Rename's `updateSlackApp`, Disconnect's `deleteSlackApp`) write it over the stored `slack:<installId>:config-refresh-token` secret **before** they use the minted access token, inside the admin lock they already hold. If that write fails, Rename stops with a 500 and Disconnect deletes the app anyway. No hook, route contract, migration or UI change.

**Tech Stack:** TypeScript, vitest, `@ax/channel-slack` (host plugin), `@ax/credentials` via `credentials:set`, preset-k8s composition test (Postgres testcontainer).

**Spec:** the card (TASK-1129, found by the TASK-1097 walk, `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md`) and `docs/plans/2026-11-09-channel-slack-design.md` §3 and §7. Planner decisions and their rationale: `.claude/memory/decisions/2026-11-15-TASK-1129.md` (read it; Tasks 1 and 2 append their security-checklist rows there).

## The problem, measured

On real Slack (TASK-1097 walk), a configuration refresh token keeps working for a while after its first rotate (four rotates over 18 s all worked), then Slack answers `invalid_refresh_token`: dead about 6 minutes after the first rotate on one install and within 3 hours on the other. The 6 minutes has a confound (the admin also saved an Interactivity change on api.slack.com in that gap, which may be what retired it); the walk report names no confound for the 3 hours. So the window is somewhere between 18 s and 3 hours, and isn't pinned down (whole-branch review F3). TASK-1090's spike re-checked inside that window and recorded "the old refresh token keeps working". TASK-1093 then stored the pasted refresh token forever and made `rotateConfigToken` drop the new one on purpose, and TASK-1096 reused the stored one for every rename. Result: Rename works once per install, and Disconnect after any rename can't delete the app.

## Design (decided; see the decisions shard for alternatives)

- **Order:** read the stored token → rotate → **store the minted refresh token** → use the minted access token once → (Rename) write the row. Storing first means a Slack failure after the rotate can't lose the new token.
- **Both callers write back.** Disconnect too: when its row delete fails it keeps the secrets "so a retry can still delete the app" (`admin-routes.ts:658-660`); that retry needs the live token, not the spent one.
- **Store fails:** Rename answers 500 `{ error: 'internal' }` without calling `apps.manifest.update` (the generic UI copy already says "Try again in a minute", and a retry inside Slack's window still works with the old token). Disconnect logs and deletes the app anyway. Both log `slack_admin_failed { installId, stage: 'save-config-token', code }` at error, once.
- **Client contract:** `refresh_token` is narrowed with the existing `tokenOf`; missing or unusable → `bad-response`. No `xoxe-` prefix check (it would fail closed by killing tokens on a Slack format change).
- **Reset race:** when `setBotName` finds the install gone (a bootstrap reset, which takes no admin lock), Rename removes the refresh token it just stored before answering 409.
- **Not changing:** Connect (stores the pasted, never-rotated token, still right), the channel-web UI (its Rename copy never claimed the handle stays), any hook or route contract.

## Global Constraints

- Log lines stay code-only: `slack_admin_failed` fields are exactly `installId`, `stage`, `code` (the leak test allows only `installId`, `reason`, `stage`, `code`). The new stage literal is `'save-config-token'`.
- No token value ever reaches a response body, a log line, an error message or a hook payload other than `credentials:set`.
- Fake tokens are built from pieces (`fakeConfigRefreshToken(tail)` in `packages/channel-slack/src/__tests__/fake-slack-tokens.ts`; the `join(...)` helper in the composition test). Never a token-shaped literal. Before each commit: `git diff --cached | grep -nE 'xox[bpe]-[0-9]{10,13}-'` prints nothing.
- No literal invisible characters in source (`source-hygiene.test.ts` fails on them). Write `\r\n` the way the existing tests already spell it.
- Commands: `--filter` goes before the script (`pnpm --filter @ax/channel-slack test`). Tests aren't type-checked by `tsc` here, so also run `pnpm --filter @ax/channel-slack build`.
- The composition test is Docker-backed: set `DOCKER_HOST` as CLAUDE.md "Docker-backed tests" says.
- Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- Memory: new rows go only to `.claude/memory/decisions/2026-11-15-TASK-1129.md`. Never edit a root archive or delete a memory line.
- GitHub text (PR body, comments): `@ax`, `@ax-walk` and `@handle` only inside backticks, so nobody named `ax` gets notified.
- User-facing prose (changesets): the CLAUDE.md voice: plain, short sentences, "we".

## Review Focus

1. **Slack's rotate answer has no usable `refresh_token`** → `bad-response`; nothing is stored and the access token is never used. Pinned in Task 1 (`rotateConfigToken without a usable token, refresh_token or exp`).
2. **The vault write fails after a good rotate** (a Postgres blip) → Rename: 500, no update, the old token still stored, one error line, and a retry inside Slack's window lands. Disconnect: the app is still deleted. Pinned in Task 2 (tests d and j).
3. **Slack fails after the rotate** (ratelimited, timeout, app gone) → the new token is already stored and the next rename works. Pinned in Task 2 (test c).
4. **Back-to-back admin actions** (a double-clicked Rename, Rename then Disconnect, Disconnect retried after a failed row delete) → each rotate uses the token the one before it stored. Pinned in Task 2: the fake Slack retires a rotated token at once, so the existing concurrency tests check it, plus tests b and k.
5. **A reset removes the install mid-rename** → 409, and the token just stored is removed again. A reset wipes the vault before it removes the rows, so a token stored in between used to survive a rename that still answered 200; the reset now deletes what is left of each removed install's secrets once its rows are gone (whole-branch review F1, `plugin.ts`). Still left live, where no route can reach it: a token stored after that sweep when Slack then refuses the update (502), and any failed delete (logged). Pinned in Task 2 (test f) and the three TASK-1129 reset tests in `plugin.test.ts`.

## Files

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/slack-api.ts` | `RotatedConfigToken.refreshToken`; `rotateConfigToken` reads `refresh_token`; header and doc comments | 1 |
| `packages/channel-slack/src/__tests__/slack-api.test.ts` | flip one test, widen one, add narrowing cases | 1 |
| `packages/channel-slack/src/admin-routes.ts` | `saveRotatedToken`; Rename and Disconnect store before use; reset-race undo; comments | 2 |
| `packages/channel-slack/src/secrets.ts` | header comment only (`:31-33`) | 2 |
| `packages/channel-slack/src/__tests__/admin-routes.test.ts` | strict fake rotate; trail updates; new tests; leak test | 2 |
| `presets/k8s/src/__tests__/channel-slack-composition.test.ts` | fake rotate answers `refresh_token`; vault read-back; Disconnect uses it | 3 |
| `docs/plans/2026-11-09-channel-slack-design.md` | six stale lines (§3, §7) | 4 |
| `.changeset/slack-bot-rename.md` | drop the false @handle sentence | 4 |
| `.changeset/slack-config-token-rotation.md` | new, patch for `@ax/channel-slack` | 4 |

Order: 1 → 2 → 3 → 4. Until Task 3 lands, the preset-k8s composition test fails at its rename step (its fake rotate sends no `refresh_token`). That is expected; don't run it before Task 3.

---

### Task 1: `rotateConfigToken` hands back the minted refresh token `[tier: sensitive]`

**security-checklist: required** (a secret from an external system now leaves the egress client; this removes TASK-1093's "no caller can store it" guarantee on purpose).

**Files:**
- Modify: `packages/channel-slack/src/slack-api.ts:41-44` (header paragraph), `:103-107` (`RotatedConfigToken`), `:144` (`SlackApi.rotateConfigToken` doc), `:451-460` (implementation)
- Test: `packages/channel-slack/src/__tests__/slack-api.test.ts:540-570`

**Interfaces:**
- Produces: `interface RotatedConfigToken { accessToken: string; refreshToken: string; /** Epoch milliseconds. */ expiresAt: number }`. `SlackApi.rotateConfigToken(refreshToken: string): Promise<RotatedConfigToken>` keeps its signature.

- [ ] **Step 1: Write the failing tests** (constants `NEW_ACCESS`, `MINTED_REFRESH`, `REFRESH` already exist at the top of the file)

  Replace the test at `:540` with:
  - name: `'rotateConfigToken returns the access token, the refresh token Slack minted to replace the one sent, and expiresAt'`
  - same fake answer as today (`token`, `refresh_token`, `team_id`, `user_id`, `iat`, `exp`)
  - `expect(out).toStrictEqual({ accessToken: NEW_ACCESS, refreshToken: MINTED_REFRESH, expiresAt: 1_800_000_000_000 })`

  Rewrite the test at `:557` as `'rotateConfigToken without a usable token, refresh_token or exp → bad-response, and the error carries none of it'`. Start from a valid `GOOD = { token: NEW_ACCESS, refresh_token: MINTED_REFRESH, exp: 1_800_000_000 }` and break ONE field per case, so each case is valid on every other rule (TASK-1093 mistakes shard):
  - `token`: absent; `'has a space'`
  - `exp`: absent; `'1800000000'`; `1.5`; `0`
  - `refresh_token`: absent; `''`; `'has a space'`; `'r\r\nx-injected: 1'` (spelled like `:609`'s signing-secret case); `42`; `null`; `'r'.repeat(513)`

  For each: `code` is `'bad-response'` and `err.message` is exactly `'slack tooling.tokens.rotate: bad-response'`. Then one positive case: `{ ...GOOD, refresh_token: 'r'.repeat(512) }` resolves with `refreshToken` of length 512.

- [ ] **Step 2: Run them and watch them fail**

  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/slack-api.test.ts`
  Expected: FAIL. The first test gets no `refreshToken`; the "`refresh_token` absent / unusable" cases resolve instead of rejecting.

- [ ] **Step 3: Implement**

  In `rotateConfigToken`: `const refreshToken = tokenOf(r['refresh_token']);`, add `refreshToken === null` to the existing `bad-response` guard, return `{ accessToken, refreshToken, expiresAt: exp * 1000 }`. Add `refreshToken: string` to `RotatedConfigToken` with the doc `/** The refresh token to keep from now on: Slack retires the one that was sent some time after this rotate (header). */`.

  Put this doc on `SlackApi.rotateConfigToken`:
  ```ts
  /**
   * A configuration access token for one use, and the refresh token that
   * replaces the one sent. The caller must store `refreshToken` before it
   * uses `accessToken` (header).
   */
  ```

  Replace the header paragraph at `:41-44` with exactly:
  ```
   * `rotateConfigToken` hands back the refresh token Slack mints with the
   * access token. Slack retires the refresh token it was sent some time after
   * the rotate, so the caller must store the new one before it uses the access
   * token, or the install loses its configuration token. How long the old one
   * lasts isn't pinned down. MEASURED on the TASK-1097 walk: it still worked
   * 18 s after its first rotate, and Slack refused it about 6 minutes after the
   * first rotate on one install and within 3 hours on the other. The 6 minutes
   * has a confound (the
   * admin also saved an app setting on api.slack.com in that gap, which may be
   * what retired it); the walk report names no confound for the 3 hours. The TASK-1090 spike reused the old
   * one before Slack refused it, and read that as "keeps working".
  ```

- [ ] **Step 4: Run tests and build**

  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/slack-api.test.ts` → PASS (the "every method" tests already send `refresh_token` in `EVERY_FIELD`).
  Run: `pnpm --filter @ax/channel-slack test` → PASS (`admin-routes.ts` ignores the new field until Task 2).
  Run: `pnpm --filter @ax/channel-slack build` → exit 0.

- [ ] **Step 5: security-checklist walk** for this change. Append its row (Sandbox / Injection / Supply chain, each answered) to the decisions shard. Expected answers: no new egress, method, header or capability. The new untrusted input is `refresh_token` from slack.com, narrowed by `tokenOf` (printable ASCII, no space, at most 512). It only goes back to Slack in a form body. No dependency change.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/channel-slack/src/slack-api.ts packages/channel-slack/src/__tests__/slack-api.test.ts .claude/memory/decisions/2026-11-15-TASK-1129.md
  git commit -m "[TASK-1129] Slack client: rotateConfigToken returns the refresh token Slack mints"
  ```

---

### Task 2: Rename and Disconnect store the minted refresh token before using the access token `[tier: sensitive]`

**security-checklist: required** (secret handling; a route that never wrote the vault now does; untrusted Slack output is persisted).

**Files:**
- Modify: `packages/channel-slack/src/admin-routes.ts:44-48`, `:129-136`, `:373`, `:453-503`, `:586-603`
- Modify: `packages/channel-slack/src/secrets.ts:31-33` (comment only)
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's `RotatedConfigToken.refreshToken`.
- Produces (internal to `admin-routes.ts`):
  - `async function saveRotatedToken(install: InstallRow, refreshToken: string): Promise<boolean>`: `d.secrets.put(install, 'config-refresh-token', refreshToken)`. On a throw: `failed('save-config-token', err, install.installId)` and `false`. Never throws.
  - `updateSlackApp(install, botName): Promise<RenameRefusal | 'token-not-kept' | null>`
  - Wire: Rename answers 500 `{ error: 'internal' }` when the save fails. Every other answer is unchanged.

- [ ] **Step 1: Make the test Slack behave like real Slack, only stricter** (`fakeSlack`, `:299-352`)

  - Add, near `MINTED_ACCESS` (`:40`): `const mintedRefresh = (n: number): string => fakeConfigRefreshToken(\`MINTEDREFRESH${n}SECRET\`);`
  - In `fakeSlack`: a `Set<string>` of refresh tokens already rotated, a mint counter, and a mutable flag on the returned object, `rotatedStillWork` (default `false`).
  - The default `on.rotateConfigToken(refreshToken)`: if the token was rotated before and `rotatedStillWork` is false, throw `new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token')`. Otherwise record it, bump the counter and return `{ accessToken: MINTED_ACCESS, refreshToken: mintedRefresh(n), expiresAt: NOW_MS + 43_200_000 }`. Doc comment: Slack retires a rotated refresh token within minutes to hours (MEASURED, TASK-1097 walk; slack-api.ts). This fake retires it at once, so any path that rotates one token twice fails.
  - `ONE_RENAME` (`:1416`) becomes `['store:current', 'vault:get config-refresh-token', 'slack:rotateConfigToken', 'vault:set config-refresh-token', 'slack:updateApp', 'store:setBotName']`. `STOPS_AFTER` becomes `{ 'config-token': 2, rotate: 3, 'save-config-token': 4, 'update-app': 5 }`.

- [ ] **Step 2: Write the tests.** The Review Focus cites these by letter. "Ref" below is `secretRef(installId, 'config-refresh-token')`.

  Rename (`describe('POST /admin/slack/rename')`):
  - **a.** Happy test (`:1429`): trail is the new `ONE_RENAME`. Also `expect(w.vault.get(ref)).toBe(mintedRefresh(1))`.
  - **b. NEW** `'two renames in a row, then Disconnect: each rotate spends the token the one before it stored, so all three work (TASK-1129)'`: `connectedWorld()`, then rename `'First Name'` → 200, rename `'Second Name'` → 200, disconnect → `{ status: 200, body: { appDeleted: true } }`. The rotate args in order are `[REFRESH, mintedRefresh(1), mintedRefresh(2)]`. `w.lines` is `[]`. `w.vault.size` is 0. (Fails on main: the second rename answers 502 `slack-config-token`.)
  - **c. NEW** `'the new refresh token is stored before Slack is asked to update: an update Slack refuses still leaves it stored, and the next rename works'`: `updateApp` throws `SlackApiError('apps.manifest.update', 'ratelimited', 60_000)` → 502 `slack-error`, and the vault ref holds `mintedRefresh(1)`. Restore `on.updateApp = async () => {}`, rename again → 200. Rotate args are `[REFRESH, mintedRefresh(1)]`.
  - **d. NEW** `'storing the new refresh token failing → 500; Slack is never asked to update and the old token stays; a retry while Slack still honours it lands'`: after `connectedWorld()`, `w.vaultFailures.set('credentials:set config-refresh-token', Object.assign(new Error(\`vault down ${REFRESH}\`), { code: 'ECONNRESET' }))`. Rename → `{ status: 500, body: { error: 'internal' } }`. The trail slice equals `ONE_RENAME.slice(0, STOPS_AFTER['save-config-token'])`. `updates(w)` is `[]`. The vault ref is still `REFRESH`. The row keeps `'Canopy Bot'`. `w.lines` equals exactly `[{ level: 'error', msg: 'slack_admin_failed', fields: { installId, stage: 'save-config-token', code: 'ECONNRESET' } }]`. Then delete the failure, set `w.slack.rotatedStillWork = true` (the time before Slack retires the old token), rename → 200, and the vault ref holds `mintedRefresh(2)`.
  - **e.** Replace `:1779` with `'writes the vault once, with the refresh token Slack minted; the minted access token goes nowhere but updateApp, the minted refresh token nowhere but the vault'`: vault calls since the mark are `[{ hook: 'credentials:get', ref }, { hook: 'credentials:set', ref }]`. The vault ref is `mintedRefresh(1)`. The access-token filter is unchanged (`['updateApp']`). No Slack call's args contain `'MINTEDREFRESH'` (check `JSON.stringify(c.args)`).
  - **f.** Extend `:1687` (reset mid-rename): also `expect(w.vault.has(ref)).toBe(false)` and `expect(w.trail.at(-1)).toBe('vault:delete config-refresh-token')`. `w.lines` stays `[]`.
  - **g.** Update `:1698` (rename then disconnect): the disconnect's part of the trail is `['store:current', 'vault:get config-refresh-token', 'slack:rotateConfigToken', 'vault:set config-refresh-token', 'slack:deleteApp']`, and its rotate arg is `mintedRefresh(1)`.

  Disconnect (`describe('POST /admin/slack/disconnect')`):
  - **h.** Happy test (`:1302`): also assert the trail since a mark taken before the disconnect: `['store:current', 'vault:get config-refresh-token', 'slack:rotateConfigToken', 'vault:set config-refresh-token', 'slack:deleteApp', 'store:remove', ...SECRET_NAMES.map((n) => \`vault:delete ${n}\`)]`.
  - **i.** Replace `:1393` with `'writes only the refresh token Slack minted, before deleting the app; the minted access token goes nowhere but deleteApp'`: the vault hooks since the mark are `['credentials:get', 'credentials:set', 'credentials:delete' ×4]`. The access-token filter is unchanged.
  - **j. NEW** `'storing the new refresh token failing still deletes the app with the token in hand; the row and secrets go; one error line'`: same `vaultFailures` entry as d. Disconnect → `{ status: 200, body: { appDeleted: true } }`. `deleteApp` was called with `MINTED_ACCESS`. Row count is 0 and `w.vault.size` is 0. `w.lines` equals exactly the one `save-config-token` error line.
  - **k.** Extend `:1403` (row won't delete): after the 500, `expect(w.vault.get(ref)).toBe(mintedRefresh(1))`. The retry answers `{ status: 200, body: { appDeleted: true } }`, and its rotate arg is `mintedRefresh(1)`. (Without Disconnect's write-back, the strict fake makes the retry answer `appDeleted: false`.)

  Leak (`describe('secrets never leave')`):
  - **l.** Add `mintedRefresh(1)` and `mintedRefresh(2)` to `SECRETS`. Add two worlds after `renameVault`: `renameSave` (connected; `vaultFailures.set('credentials:set config-refresh-token', leak('vault'))`; `rename()`) and `disconnectSave` (same failure; `disconnect()`). After the existing checks: `expect(seen).not.toContain('MINTEDREFRESH')`.

  Leave every other test as it is. If one fails under the strict fake, read why before editing it: it means some path rotates a token twice.

- [ ] **Step 3: Run and watch them fail**

  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts`
  Expected FAIL: every test from a to l. `l` fails because its two new worlds log nothing on main, since no save happens there. Some untouched tests fail too, and that's correct: the ones that slice `ONE_RENAME` at `'update-app'`, the row-write retry at `:1668`, and the two-renames test at `:1743`. On main's code those rotate one token twice. Nothing in the Disconnect describe outside h–k should fail.

- [ ] **Step 4: Implement in `admin-routes.ts`**

  - `saveRotatedToken` (Interfaces above), placed before `deleteSlackApp`, with the doc: "Keep the refresh token a rotate just minted, in place of the one it was minted from. Slack retires a rotated refresh token within minutes to hours (slack-api.ts), so without this the install's configuration token dies after its first use. True when stored. A failure is logged here, code-only, and the stored token then works only until Slack retires it."
  - `deleteSlackApp`: `const minted = await d.api.rotateConfigToken(refreshToken);` then `await saveRotatedToken(install, minted.refreshToken);` (the result is deliberately unused), then `stage = 'delete-app'` and `deleteApp(minted.accessToken, …)`. Add to its doc: the new refresh token is stored first, for the retry `disconnect()` keeps the secrets for when the row won't delete. If that store fails, the app is still deleted with the token in hand.
  - `updateSlackApp`: after the rotate, `if (!(await saveRotatedToken(install, minted.refreshToken))) return 'token-not-kept';`, then `stage = 'update-app'` and `updateApp(minted.accessToken, …)`. Add to its doc: the new refresh token is stored first, and if that fails nothing is sent (`'token-not-kept'`; a retry soon after may still work with the old one).
  - `rename`: before the 502 mapping, `if (refusal === 'token-not-kept') return INTERNAL;`. In the `InstallStoreError` branch, `await d.secrets.remove(install, 'config-refresh-token');` before `return json(409, { error: 'not-connected' })`, with a comment saying why: a reset removes installs without the admin lock. (As built, after the whole-branch review's F1: the reset deletes what is left of a removed install's secrets once the rows are gone, and this undo takes back a token stored after that sweep.)
  - Header `:44-48`: replace the REFRESH bullet with exactly:
    ```
     *   - The pasted REFRESH token is stored, and no route ever returns it. Only
     *     Disconnect and Rename read it, each to mint one access token that is
     *     used once: Disconnect to delete the app, Rename to update its
     *     manifest. That rotate also mints a new refresh token, and Slack
     *     retires the old one within minutes to hours (MEASURED, TASK-1097 walk;
     *     slack-api.ts), so the new one replaces it in the vault BEFORE the
     *     access token is used. If that write fails, Rename stops (a retry soon
     *     after may still work with the old token) and Disconnect deletes the
     *     app anyway.
    ```
  - `CONFIG_TOKEN_REFUSED` doc `:129-136`: "rotate's `invalid_refresh_token` once it was revoked on Slack's page" becomes "rotate's `invalid_refresh_token`: revoked on Slack's page, or retired by Slack after a rotate whose new token wasn't kept".
  - `:373` comment becomes `// The pasted one, until the first rotate (Rename, Disconnect) replaces it.`
  - `secrets.ts:31-33` becomes exactly:
    ```
     * The configuration refresh token stored here starts as the one the admin
     * pasted. After each rotate, admin-routes.ts writes the one Slack mints
     * alongside over it, because Slack retires a rotated refresh token within
     * minutes to hours (slack-api.ts). If that write fails, the old one stays,
     * and works only until Slack retires it.
    ```

- [ ] **Step 5: Run tests, build, lint**

  Run: `pnpm --filter @ax/channel-slack test` → PASS.
  Run: `pnpm --filter @ax/channel-slack build` → exit 0.
  Run: `pnpm exec eslint packages/channel-slack` → no errors.

- [ ] **Step 6: Three mutants: predict which test catches each, then run** (revert each one after)
  1. Move the `saveRotatedToken` call in `updateSlackApp` to after `updateApp` → c fails (and d: Slack is asked to update).
  2. Delete the `saveRotatedToken` call in `deleteSlackApp` → k fails (its retry answers `appDeleted: false`), and h and i fail.
  3. Pass the OLD `refreshToken` to `saveRotatedToken` in `updateSlackApp` → a, b and e fail.

  Write what each mutant actually broke into the decisions shard.

- [ ] **Step 7: security-checklist walk** for this task. Append its row to the decisions shard. It must cover:
  - the new vault write: exactly one ref, `slack:<installId>:config-refresh-token`, global scope, the same identity as Connect's write;
  - the ordering;
  - both failure modes;
  - the reset-race undo;
  - the leak test now covering the save path;
  - the residuals from the planner's row (lost rotate answer, crash window, in-process lock).

- [ ] **Step 8: Commit**

  ```bash
  git add packages/channel-slack/src/admin-routes.ts packages/channel-slack/src/secrets.ts packages/channel-slack/src/__tests__/admin-routes.test.ts .claude/memory/decisions/2026-11-15-TASK-1129.md
  git commit -m "[TASK-1129] Slack: Rename and Disconnect store the rotated refresh token before using it"
  ```

---

### Task 3: The composition test proves the write through the real vault `[tier: integration]`

**Files:**
- Test: `presets/k8s/src/__tests__/channel-slack-composition.test.ts` (`:99-101` constants, `:259-261` module counters, `:343-345` fake rotate, `:813-843` step 2b, `:954-968` step 6)

**Interfaces:**
- Consumes: Tasks 1–2 behaviour over HTTP. The fake answers `tooling.tokens.rotate` with `refresh_token`. Rename stores it, and Disconnect's rotate sends it.

- [ ] **Step 1: The fake mints a refresh token per rotate**

  Add `const rotatedRefreshToken = (n: number): string => join('xo', 'xe-', '1-', 'COMPOSITIONROTATEDREFRESH', String(n));` next to `ROTATED_ACCESS_TOKEN`, and `let rotateSeq = 0;` next to `streamSeq`. The `tooling.tokens.rotate` case does `rotateSeq += 1` and answers `{ ok: true, token: ROTATED_ACCESS_TOKEN, refresh_token: rotatedRefreshToken(rotateSeq), exp: 4_102_444_800 }`.

- [ ] **Step 2: Assert it end to end**

  - Step 2b, after the rename's existing assertions: `const kept = await readSecret(installId, 'config-refresh-token');`, then `expect(kept).toBe(rotatedRefreshToken(rotateSeq))` and `expect(kept).not.toBe(CONFIG_REFRESH_TOKEN)`. Update the 2b comment: the route stores the refresh token Slack minted before it sends the update.
  - Step 6: `expect(slackCalls.slice(mark)[0]!.body).toEqual({ refresh_token: kept })` (was `CONFIG_REFRESH_TOKEN`). Update the step-6 comment: Disconnect rotates the token the rename stored, because Slack retires a rotated one.

- [ ] **Step 3: Build, then run it**

  The preset imports `@ax/channel-slack` from its `dist` (`package.json` `exports`; there is no vitest alias), so build first or the test runs stale code.
  Run: `pnpm --filter @ax/channel-slack build && pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/channel-slack-composition.test.ts` (with `DOCKER_HOST` set).
  Expected: PASS, all scenarios.

- [ ] **Step 4: Confirm it bites.**
  1. Comment out the `saveRotatedToken` line in `updateSlackApp`.
  2. Rebuild channel-slack and re-run. Expected: step 2b's `readSecret` assertion fails.
  3. Restore the line, rebuild, re-run. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add presets/k8s/src/__tests__/channel-slack-composition.test.ts
  git commit -m "[TASK-1129] composition: a rename stores Slack's new refresh token in the real vault; Disconnect uses it"
  ```

---

### Task 4: Correct the lines that made this bug look safe `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md:196-198`, `:204-206`, `:215-217`, `:220-223`, `:729`, `:735`
- Modify: `.changeset/slack-bot-rename.md:6`
- Create: `.changeset/slack-config-token-rotation.md`

**Interfaces:** none (prose only).

- [ ] **Step 1: Design §3, step 5** (`:196-198`). Replace it with:
  ```
  5. AX keeps the **refresh token** and gets a fresh access token from it with
     `tooling.tokens.rotate` whenever it needs one. Each rotate also hands back a
     new refresh token, and Slack retires the old one within minutes to hours
     (§7, configuration tokens), so AX stores the new one before it uses the
     access token (TASK-1129). Access tokens are never stored past their 12 hours.
  ```

- [ ] **Step 2: Design §3, Renaming** (`:204-206`). Replace "The name people see changes; the @handle underneath stays as it was at install. Slack shows mentions by current name, so people don't notice." with:
  ```
  People see, and @mention, the bot by its new name: on the TASK-1097 walk,
  `@ax` became `@ax-walk`.
  ```

- [ ] **Step 3: Design §3, the secrets** (`:215-217`). Replace it with:
  ```
  The refresh token is the dangerous one. It can create apps in the workspace.
  Renewing it only trades it for a new one, and it **outlives `auth.revoke`**
  (§7, configuration tokens), so AX can't retire it through the API. Hence:
  ```
  At `:221`, "Replacing it isn't built yet (TASK-1128)." becomes "The token AX holds changes with every rotate (step 5). Pasting in a different one isn't built yet (TASK-1128)."

- [ ] **Step 4: Design §7, row 3 Rename** (`:729`). The answer cell becomes:
  ```
  `apps.manifest.update` changing only the name: `permissions_updated: false`, no reinstall, and the bot token kept working. `real_name` changed and the `name` field stayed as it was at install, but **the @handle people see and type follows the new name**: on the TASK-1097 walk, `@ax` became `@ax-walk`.
  ```
  The source cell becomes `Tested (spike; handle corrected by the TASK-1097 walk)`.

- [ ] **Step 5: Design §7, Configuration tokens** (`:735`). The answer cell becomes:
  ```
  Access tokens expire after 12 hours (we hit `token_expired`). `tooling.tokens.rotate` returns a new pair. **The old refresh token keeps working for a while, then Slack refuses it** (`invalid_refresh_token`), so AX stores the new one on every rotate (TASK-1129). How long "a while" is isn't pinned down. The TASK-1097 walk saw it work four times over 18 s, then found it dead about 6 minutes after the first rotate on one install and within 3 hours on the other. The 6 minutes has a confound: the admin also saved an Interactivity change on api.slack.com in that gap, which may be what retired it. The walk report names no confound for the 3 hours. The spike reused the old one before Slack refused it, and read that as "keeps working". Earlier access tokens kept working in the spike, which also checked within minutes. `auth.revoke` kills an access token, but **its refresh token still mints new ones afterwards**. Only Revoke on Slack's configuration-tokens page ends it (§3). Whether that Revoke also ends the refresh tokens rotates have minted since (the one AX holds after a rename) is unmeasured (TASK-1134).
  ```
  The source cell becomes `Tested (spike; corrected by the TASK-1097 walk)`.

- [ ] **Step 6: Changesets**
  - In `.changeset/slack-bot-rename.md`, replace "(The bot's @handle stays the one it got when Slack was first connected; Slack shows the new name in mentions anyway.)" with "People @mention it by its new name, too."
  - Create `.changeset/slack-config-token-rotation.md`:
    ```
    ---
    '@ax/channel-slack': patch
    ---

    Renaming the Slack bot now works more than once. Every time we use the configuration token, Slack hands us a fresh one and retires the old one some time later (minutes to hours, as far as we can tell). We used to keep the old one, so the second rename, and Disconnect after a rename, found it dead. Now we keep the fresh one each time. If we ever can't save it, we stop and ask you to try again. Sooner is better: the old one may still work for a little while.
    ```

- [ ] **Step 7: Sweep the prose spellings** (yolo-ship rule 5)

  Run:
  ```bash
  git grep -n -i -E "keeps? working|kept working|verbatim|never replaced|never hands|nothing can store|never sees|handle (stays|underneath|fixed)|stays as it was at install|stayed as it was at install|outlives both|no caller can store" -- packages/channel-slack/src packages/channel-web/src/components/admin packages/channel-web/src/lib/slack-admin.ts presets/k8s/src docs/plans/2026-11-09-channel-slack-design.md .changeset
  ```
  Expected: no hit says that a rotated configuration refresh token keeps working, that the rotate's new token is dropped or can't be stored, or that the bot's @handle stays. Every hit left is about something else (bot tokens, channels, admission emails, prompts, lifetime, other packages), or it is the corrected §7 row 3 at `:729`. If one isn't, fix it here.

- [ ] **Step 8: Commit**

  ```bash
  git add docs/plans/2026-11-09-channel-slack-design.md .changeset/slack-bot-rename.md .changeset/slack-config-token-rotation.md
  git commit -m "[TASK-1129] docs: Slack retires a rotated configuration refresh token; the @handle follows a rename"
  ```

---

## Ship-time steps (the builder; not implementer tasks)

1. **PR description** (squash title `[TASK-1129] Slack: keep the rotated configuration refresh token (Rename works more than once)`):
   - what broke and the measurement;
   - the design bullets above;
   - `## Security review`: the Task 1 and Task 2 walk rows from the shard;
   - boundary review: N/A, no hook or IPC change;
   - "Not measurable in CI: the real-Slack acceptance (two renames in a row, then Disconnect deletes the app) belongs to the TASK-1134 walk";
   - deploy note: TASK-1096's Rename should deploy only with this fix (prod rev 86 has neither, and its single rotate at Disconnect is unaffected).
2. **After the PR exists**, comment on merged PR #1183 (it says the handle stays and that reusing the refresh token is safe). Use this text, with handles only in backticks:
   > Correction (TASK-1129, #<this PR>): on real Slack (TASK-1097 walk) two things here turned out wrong. The bot's handle does change on rename (`@ax` became `@ax-walk`). And reusing the stored configuration refresh token across renames isn't safe: Slack retires a rotated refresh token some time after the rotate (within minutes to hours on that walk), so Rename worked once per install. TASK-1129 stores the refresh token every rotate returns, before using the access token, for Rename and Disconnect alike.
3. **Handoff `learnings:`**:
   - **TASK-1134**: its walk must cover the four "Unmeasured" items in the shard. These are the card's acceptance; Revoke on Slack's page after a rotate; whether earlier access tokens die; and whether an idle, never-rotated refresh token expires.
   - **TASK-1128**: the stored configuration token now changes on every rotate. Any replace route must take the same admin lock and write the same ref.
4. **Outside the repo** (not committed): the user's auto-memory `~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/project_channel_slack.md:19` still says "handle fixed at install" and "config refresh tokens survive rotate". Correct it at wrap-up.
