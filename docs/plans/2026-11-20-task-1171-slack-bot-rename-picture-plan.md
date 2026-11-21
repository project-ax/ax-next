# TASK-1171 Slack phase 2: rename a team agent's live bot, or change its picture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team admin of a team agent's team can rename the agent's live Slack bot, or change its picture, from the agent's Slack settings. Both use the bot approver's stored configuration token, with no new approval and no reinstall.

**Architecture:** One step, "change a Slack app with its person's stored token" (read, rotate, save the successor BEFORE use, then map Slack's refusal), moves out of Admin › Slack's Rename into `slack-apps.ts`. The shared rename and the new bot changes both use it. A new domain module, `bot-changes.ts`, renames a live bot (the whole bot manifest, then the row, then a best-effort handle re-read) or sets its picture (`apps.icon.set` only), each under the one app lock. Two new `agent-routes.ts` routes front it. channel-web adds a client, the copy, and two shadcn dialogs on the live bot.

**Tech Stack:** TypeScript, vitest, React + shadcn (channel-web), the existing Slack client (`slack-api.ts`, no new method), the existing install store (no schema or store change).

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` §4 "Lifecycle" (with §3 "Renaming", §7 Q3/Q5, §8 Q5–Q6). Card TASK-1171. Decisions: `.claude/memory/decisions/2026-11-20-TASK-1171.md` (read it; every choice below has a row there).

---

## Brainstorm, self-answered

- **What and why.** Design §4: "The owner can rename the bot or change its avatar later from agent settings … the same rename path the shared bot uses (TASK-1096), and the same name check … Neither needs a new approval." Today a team has to disconnect and re-request a bot to fix its name, and every channel then needs `/invite` again.
- **Who clicks.** Any team admin of the agent's team, as with Cancel and Disconnect. **Whose token:** always the bot's approver's (`connectedByUserId`). Only the creator's token can manage the app (§8 Q5), and there's one token per person (TASK-1175).
- **Approaches.**
  - A (chosen): a new `bot-changes.ts` on an extracted shared step.
  - B: new methods on `Bots` in `bots.ts`. Rejected: it's both siblings' hottest file, and its interface and return line would conflict.
  - C: copy `updateSlackApp` into the bot module. Rejected: two copies of the token rules, which TASK-1167 row 37 already turned down.
  - D: export closures from `createAdminRoutes`. Rejected: it couples the admin and bot modules.
- **Non-goals.** Replacing a bot's token (approver-only, a later card). Renaming from Admin › Slack. The shared bot's picture. Picking a picture at request time. Storing or showing the picture in AX.
- **Anti-goals.** Reading or rotating the clicking admin's own token. Writing AX's row before Slack says yes. A second copy of the save-before-use rule or the handle check. A fourth spelling of "bot is live". Any change in the shared rename's behaviour.

## What the brief got wrong (refuted or corrected — decisions row 1)

1. "Reuse `renameError`/`updateSlackApp` from the module TASK-1167 extracted." They were never extracted. `renameError` is at `admin-routes.ts:285` and `updateSlackApp` is a closure at `:621`, and TASK-1167's plan (`:159`) kept both admin-only. **Task 1 extracts them, generalized.**
2. UI file: the bot section is `components/workspace/AgentSlackBot.tsx`. `AgentSlack.tsx` needs no change.
3. "Re-read the bot user's `name` … into `bot_handle`": we do. But whether Slack changes `name` on a rename is UNMEASURED, and the spike saw it stay as at install. So the live view must also show the bot's NAME (Task 6), or a rename can look like it did nothing.
4. "Open requests, once TASK-1169 adds them": TASK-1169 is NOT on main (origin/main = `b9ac9f8a1`). Its branch adds requests to `namesInUse` itself, so using `namesInUse` covers them on arrival with nothing extra built here.
5. The card's body `{ icon }` is `{ iconPng }` on the wire (Connect's and the request's spelling). "An agent without a live bot" gets a NEW 409 `not-live`, because no existing code means that.

## Before you start

- [ ] `cd /Users/vpulim/dev/ai/ax-next/.claude/worktrees/agent-ad29e1797476de88c && git fetch origin main && git log --oneline HEAD..origin/main`. If `[TASK-1169]` or `[TASK-1172]` is there, `git rebase origin/main` now (nothing is committed yet, so it's free), then `pnpm install --frozen-lockfile && pnpm build`.
- [ ] Repeat the fetch, and the rebase if needed, before Tasks 3, 6 and 7 (each touches a sibling hot file). Commit before rebasing. Expected conflicts, all mechanical:
  - `agent-routes.ts`: the header route list, `createAgentSlackRoutes`' params (TASK-1169 adds `requests`; put `changes` LAST), and the route list.
  - `plugin.ts`: the header mount list, and the `createAgentSlackRoutes(...)` call.
  - `AgentSlackBot.tsx`: TASK-1172 widens `Live`'s props to include `agentId` and `onChanged`; keep theirs and add the one element.
  - `lib/agent-slack.ts`: TASK-1172 adds `no-bot` to `agentSlackBotStale`; keep both codes.
  - Tests: `agent-routes.test.ts` (route pin, `EVERY_ROUTE`); `plugin.test.ts` (route shapes, and the `toHaveLength` counts become main's count + 2); `canary.test.ts` (suffix loop).
  - The design doc's §9 progress sentence.
  - After any rebase: `pnpm build`.
- [ ] Copy no code from the sibling branches. Read them only to resolve conflicts.

## Global Constraints

- Gate: `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. One package: `pnpm --filter @ax/<pkg> test <file>` (the filter goes BEFORE the script; `-- <file>` does not filter). Run `pnpm --filter @ax/<pkg> build` (tsc) alongside vitest: vitest tolerates type errors, and channel-web's tsc also checks its test files.
- Every use of a configuration token runs under the one app lock (`plugin.ts` `appLock`). `mutex.ts` isn't re-entrant, so code under it never takes it again.
- A rotate's successor is saved as its person's token BEFORE the access token it came with is used. If that save fails, nothing is sent and the answer is 500 `internal`.
- The token is the bot approver's (`bot.connectedByUserId`). The clicking team admin's own token slot is never read, rotated or written. The domain takes no actor.
- Refusals come in this order: route gate (401 / 404 / 403 / 409 `personal-agent`), body (413 / 400), then in the lock `not-live`, `public-origin-not-https` (rename), `bot-name-taken`. All of them come before any vault read or Slack call.
- Log lines are code-only: `slack_bot_failed { installId?, stage, code }` and outcome lines `{ installId }`. Never a token, a person's or agent's id, a name, a handle, or a Slack id other than the install's.
- Slack's text (the `users.info` `name`) is stored only after `handleFrom` accepts it.
- No cross-plugin imports. channel-web mirrors wire types by shape. UI uses only installed shadcn primitives (`Dialog`, `Button`, `Input`, `Field*`, `Alert`, `Spinner`) and semantic tokens; invoke the `shadcn` skill for Task 6.
- Body caps: rename `ADMIN_BODY_MAX_BYTES` (16,384). Picture `ADMIN_CONNECT_BODY_MAX_BYTES` (16,384 + 4·⌈1,048,576/3⌉ = 1,414,488).
- Fake tokens in tests keep Slack's prefix with short digit groups (use `fake-slack-tokens.ts`). Never type a backslash-u escape: `source-hygiene.test.ts` fails on literal invisible characters. A `beforeEach` gets a block body.
- Copy is pinned verbatim in Tasks 5–6. The one card-given sentence: "This bot's Slack token needs replacing by {approver}."

## Review Focus

1. **The approver's token is dead, while the clicking admin has their own live token stored.** Only the approver's ref is read or rotated, the answer is 502 `slack-config-token`, name and handle stay unchanged, and the dialog names the approver. Tests: Task 2 "R5", Task 6 "token line".
2. **Slack keeps the bot user's `name` after the rename** (the spike). The handle stays, but the manager still sees the new name. Test: Task 6 "Bot name row".
3. **An image the browser can't draw** (HEIC, a renamed text file, an SVG that taints the canvas): "We couldn't use that picture. Try another image.", Save stays off, nothing is sent. Tests: Task 5 "drawPickedSlackAvatar → null", Task 6 "undrawable".
4. **A double-clicked Rename, or two admins at once.** They run one at a time under the lock, each whole, and the later name stays. Test: Task 2 "R9".
5. **A stale page** (the bot was disconnected, or a new request is pending): 409 `not-live` closes the dialog and re-reads, with no error. Tests: Task 2 "R4", Task 6 "stale".

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/channel-slack/src/slack-apps.ts` (modify) | + `AppChangeRefusal`, `CONFIG_TOKEN_REFUSED`, `appChangeError`, `AppSteps.changeApp` | 1 |
| `packages/channel-slack/src/admin-routes.ts` (modify) | Rename uses `changeApp`; local copies removed | 1 |
| `packages/channel-slack/src/bots.ts` (modify, small) | + `export function handleFrom`; `keepHandle` uses it | 2 |
| `packages/channel-slack/src/bot-changes.ts` (create) | `createBotChanges` → `{ rename, setPicture }` | 2 |
| `packages/channel-slack/src/agent-routes.ts` (modify) | `POST …/bot/rename`, `POST …/bot/icon`, body readers | 3 |
| `packages/channel-slack/src/plugin.ts` (modify) | `createBotChanges` on `appLock`; header | 3 |
| `presets/k8s/src/__tests__/channel-slack-composition.test.ts` (modify) | rename + picture in the real assembly | 4 |
| `packages/channel-web/src/lib/agent-slack.ts` (modify) | client fns, copy, error mapping, stale code | 5 |
| `packages/channel-web/src/lib/slack-avatar.ts` (modify) | `drawPickedSlackAvatar(file)` | 5 |
| `packages/channel-web/src/components/workspace/AgentSlackBotChanges.tsx` (create) | the name/picture rows and two dialogs | 6 |
| `packages/channel-web/src/components/workspace/AgentSlackBot.tsx` (modify, small) | `Live` renders `BotChanges` for managers | 6 |
| docs, comments, `.changeset/slack-bot-rename-picture.md` | stale lines, as-built, release note | 7 |

---

### Task 1: One shared "change an app with its person's stored token" step [tier: sensitive] — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/slack-apps.ts`: header `:12-28`; constants after `REFRESH_TOKEN_REFUSED` `:53`; the `AppSteps` interface `:143-232`; the `createAppSteps` body and return `:254-452`.
- Modify: `packages/channel-slack/src/admin-routes.ts`: imports `:16-35`; `RenameRefusal` `:214-215` and `CONFIG_TOKEN_REFUSED` `:221-233` (both removed); `renameError` `:279-292` (removed); `updateSlackApp` `:610-642` (becomes a wrapper).
- Test (UNCHANGED, the proof): `packages/channel-slack/src/__tests__/admin-routes.test.ts` `describe('POST /admin/slack/rename')` `:2398-2887`, and `'secrets never leave'` `:4016`.

**Interfaces — Produces (slack-apps.ts):**
```ts
/** Why Slack didn't take a change to an app (a rename, or a team bot's picture), as the person is told it (a 502). */
export type AppChangeRefusal = 'slack-config-token' | 'slack-app-gone' | 'slack-name' | 'slack-error';
/** Moved verbatim from admin-routes.ts, doc and all: REFRESH_TOKEN_REFUSED + 'no_permission' + 'app_not_owned_by_manager_app'. */
export const CONFIG_TOKEN_REFUSED: ReadonlySet<string>;
export function appChangeError(stage: string, err: unknown): AppChangeRefusal;
// AppSteps gains:
changeApp(
  app: SecretOwner,
  stage: 'update-app' | 'icon',
  use: (accessToken: string) => Promise<void>,
): Promise<AppChangeRefusal | 'token-not-kept' | null>;
```
`appChangeError` maps, in order:
1. not a `SlackApiError` → `'slack-error'`;
2. `CONFIG_TOKEN_REFUSED.has(code)` → `'slack-config-token'`;
3. stage `'update-app'` and `invalid_manifest` → `'slack-name'`;
4. stage `'update-app'` **or `'icon'`** and `app_not_found` → `'slack-app-gone'`;
5. anything else → `'slack-error'`.

`changeApp` is today's `updateSlackApp` body, minus the manifest:
- `getConfigToken(app)`: a throw propagates.
- `null` → log `warn` `${logPrefix}_failed { installId, stage: 'config-token', code: 'missing' }`, then `'slack-config-token'`.
- Stage `'rotate'`: `rotateConfigToken`, then `saveRotatedToken`. A failed save → `'token-not-kept'`, and `use` is never called.
- Stage becomes `stage`, then `use(minted.accessToken)`.
- `catch` → `failed(stage, err, app.installId)`, then `appChangeError(stage, err)`.
- `null` on success. It never takes the lock: its callers hold it.

- [ ] **Step 1:** Baseline: `pnpm --filter @ax/channel-slack test src/__tests__/admin-routes.test.ts`. Expected: PASS.
- [ ] **Step 2:** Add the four exports and `changeApp` to `slack-apps.ts` (add `changeApp` to the returned object). Extend the header's step list: "…the steps that make, **change**, finish and take back a Slack app … a change (Admin › Slack's Rename, a team bot's rename or picture, TASK-1171) goes through `changeApp`".
- [ ] **Step 3:** In `admin-routes.ts`, delete `RenameRefusal`, `CONFIG_TOKEN_REFUSED` and `renameError`, and import `appChangeError`'s type (`AppChangeRefusal`) where `RenameRefusal` was used. `updateSlackApp(install, botName)` keeps its name and return type. It builds `buildAppManifest(botName, slackUrls(d.publicOrigin, install.installId))` FIRST, then returns `steps.changeApp(install, 'update-app', (t) => d.api.updateApp(t, install.appId, manifest))`. Trim its doc to what's left (the save-before-use text now lives on `changeApp`). `REFRESH_TOKEN_REFUSED`, `NOT_APP_MANAGER` and `replaceCheckError` stay.
- [ ] **Step 4:** `pnpm --filter @ax/channel-slack build && pnpm --filter @ax/channel-slack test src/__tests__/admin-routes.test.ts`. Expected: PASS with zero test edits (`git diff --stat -- packages/channel-slack/src/__tests__` is empty).
- [ ] **Step 5:** Commit: `[TASK-1171] channel-slack: one step changes a Slack app with its person's stored token (Admin › Slack's Rename now uses it, unchanged)`.
- [ ] **Step 6:** Mutation check, under the brief's protocol: committed first, restore with `git checkout HEAD -- packages/channel-slack/src/slack-apps.ts`, and `git status --short` empty between mutants. Predict, then run `admin-routes.test.ts`:
  - (a) call `use` before `saveRotatedToken`: `:2488` "stored before Slack is asked to update" and `:2508` "storing … failing → 500; Slack is never asked" fail.
  - (b) drop `'no_permission'` from `CONFIG_TOKEN_REFUSED`: `:2612` fails.
  - (c) drop the `'icon'` arm: nothing here fails (Task 2's P2 pins it). Record that.
- [ ] **Step 7:** Security note lines (checklist walk; record in the decisions shard):
  - Sandbox: no new egress method, hook or vault ref.
  - The credential rules are moved, not changed.
  - Injection: only Slack's narrowed code is read.
  - Supply chain: N/A.

### Task 2: `bot-changes.ts`: rename and picture for a live bot [tier: sensitive] — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/bots.ts`. Insert `handleFrom` RIGHT AFTER `const HANDLE_RE` (`:239`), and nowhere near `:241-246`, where TASK-1172 inserts. Rewrite only `keepHandle`'s two checks (`:483-491`) to use it, keeping the same log lines.
- Create: `packages/channel-slack/src/bot-changes.ts`
- Test: Create `packages/channel-slack/src/__tests__/bot-changes.test.ts`. Must stay green, unchanged: `packages/channel-slack/src/__tests__/bot-callback.test.ts` (`:721-770` pins `keepHandle`'s handle table).

**Interfaces:**
- Consumes:
  - Task 1's `createAppSteps(...).changeApp` and `.release`, and `.failed` with `logPrefix: 'slack_bot'`.
  - `liveOwnBot(installs, agentId)` (`channels.ts:281`, the one "live" helper; do not spell `status === 'active'`).
  - `namesInUse(installs, { except })`, `isBotNameTaken`, `isHttps`, `isRecord` (`slack-apps.ts` / `bot-name.ts`).
  - `buildBotManifest`, `botUrls` (`manifest.ts`), `InstallStoreError`, and `BotReply` (`bots.ts`).
- Produces:
```ts
// bots.ts
/** Slack's users.info answer about `botUserId` as the @handle we keep, or why not. Read at the Allow (keepHandle) and after a rename (bot-changes.ts). */
export function handleFrom(user: unknown, botUserId: string):
  { ok: true; handle: string } | { ok: false; code: 'user-mismatch' | 'unusable-handle' };

// bot-changes.ts
export interface BotChangesDeps {
  /** The full store, not a Pick: namesInUse reads the shared install, every bot and (TASK-1169) every open request. */
  installs: InstallStore;
  /** The plugin's one cached secret store, the one bots.ts gets. */
  secrets: SecretStore;
  api: SlackApi;
  /** The one app lock. Not re-entrant: each method takes it once. */
  lock: Mutex;
  publicOrigin: string;
  logger: Logger;
  now: () => number;
  randomBytes: (n: number) => Buffer;
}
export interface BotChanges {
  /** 200 { botName }; 409 not-live | public-origin-not-https | bot-name-taken; 502 AppChangeRefusal; 500 internal. A vault or store fault throws. */
  rename(i: { agentId: string; botName: string }): Promise<BotReply>;
  /** 200 {}; 409 not-live; 502 slack-config-token | slack-app-gone | slack-error; 500 internal. A vault or store fault throws. */
  setPicture(i: { agentId: string; png: Buffer }): Promise<BotReply>;
}
export function createBotChanges(d: BotChangesDeps): BotChanges;
```
**`rename`, inside one `d.lock.run`, in this order:**
1. `bot = await liveOwnBot(d.installs, agentId)`. `null` → 409 `{ error: 'not-live' }`.
2. `!isHttps(d.publicOrigin)` → 409 `{ error: 'public-origin-not-https' }`.
3. `isBotNameTaken(botName, await namesInUse(d.installs, { except: bot.installId }))` → 409 `{ error: 'bot-name-taken' }`.
4. `steps.changeApp(bot, 'update-app', t => d.api.updateApp(t, bot.appId, buildBotManifest(botName, botUrls(d.publicOrigin, bot.installId))))`. `'token-not-kept'` → 500 `{ error: 'internal' }`; any other refusal → 502 `{ error: refusal }`.
5. `d.installs.setBotName(bot.installId, botName)`. `InstallStoreError` → `await steps.release(bot)`, then 409 `not-live` (a reset removed the row without the lock). Any other error propagates.
6. `await refreshHandle(bot)`, which never throws:
   - `token = await d.secrets.get(bot, 'bot-token')` (a vault fault → `steps.failed('bot-handle', err, installId)`, then stop).
   - `token` or `bot.botUserId` null → warn `slack_bot_failed { installId, stage: 'bot-handle', code: 'missing' }`.
   - `usersInfo` throws → `steps.failed('bot-handle', err, installId)`.
   - `handleFrom` not ok → warn with its code.
   - ok and `handle !== bot.botHandle` → `setBotHandle` (a throw → `steps.failed('bot-handle', err, installId)`).
7. info `slack_bot_renamed { installId }`, then 200 `{ botName }`.

**`setPicture`, inside one `d.lock.run`:**
1. `liveOwnBot` `null` → 409 `not-live`.
2. `steps.changeApp(bot, 'icon', t => d.api.setAppIcon(t, bot.appId, png))` → 500 or 502 as above.
3. `(await d.installs.get(bot.installId)) === null` → `await steps.release(bot)`, then 409 `not-live` (the reset race).
4. info `slack_bot_picture_changed { installId }`, then 200 `{}`.

**Header doc** (`bot-changes.ts`): what each method does; that the token is always the approver's, whoever asked (the route let only a team admin through); each method takes the lock once and nothing under it does; log lines.

**Test world** (`bot-changes.test.ts`): copy `bots.test.ts`' idioms, not its file.
- Wiring: `memoryStore(() => NOW_MS, trail)`, `busVault(bus, trail)`, `createSecretStore(bus, { logger })`, `fakeSlack(trail)`, `createMutex()` (or one injected), and a captured logger.
- Seeds, written through the store API, then the trail cleared:
  - the shared install, live, connected by Ada, with `configTokenRef(ADA)` = `ADA_STORED`;
  - the support agent's live bot: approver and requester GRACE, `botName: 'Support Helper'`, handle `supporthelper`, `botUserId: GRANT.botUserId`, its `bot-token`, and `configTokenRef(GRACE)` = `GRACE_STORED`;
  - the sales agent's live bot: `'Sales Desk'`, handle `deskbot`. The handle differs from the name on purpose, so a handle clash is told apart from a name clash.
- `fakeSlack.on.usersInfo` answers `BOT_USER` (name `supporthelper`) unless a test swaps it.

- [ ] **Step 1: Write the failing tests** (names and the assertions that decide them):
  - `R1 renames with the APPROVER's token: rotate, save its successor, then Slack gets the whole bot manifest with only the name changed; the row keeps the new name`.
    - `w.trail` equals `['store:botForAgent', 'store:current', 'store:listBots', 'vault:get config-refresh-token', 'slack:rotateConfigToken', 'vault:set config-refresh-token', 'slack:updateApp', 'store:setBotName', 'vault:get bot-token', 'slack:usersInfo']`. Use the labels `busVault`/`memoryStore` really write (see `admin-routes.test.ts` `ONE_RENAME`). Once TASK-1169 is on main, `namesInUse` adds `store:listBotRequests`.
    - The `updateApp` args are `[MINTED_ACCESS, <bot appId>, buildBotManifest('Quill Desk', botUrls(ORIGIN, <bot installId>))]`.
    - The vault: `configTokenRef(GRACE)` now holds `mintedRefresh(1)`, and `configTokenRef(ADA)` still holds `ADA_STORED`, named by no vault call.
    - The reply is `{ status: 200, body: { botName: 'Quill Desk' } }`, the row's `botName` is `'Quill Desk'`, and the lines equal `[{ level: 'info', msg: 'slack_bot_renamed', fields: { installId } }]`.
  - `R2 keeps the handle Slack reports after the rename: written only when usable and changed; anything else keeps the stored one and still answers 200`.
    - `name: 'quilldesk'` → the handle becomes `quilldesk`, written once.
    - `name: 'supporthelper'` → no `store:setBotHandle` in the trail.
    - Each of `'channel'`, `'Quill Desk'`, `{ id: 'U07SOMEONE1' }` (user-mismatch), a `SlackApiError('users.info','ratelimited')`, a missing bot token (`code: 'missing'`), and `setBotHandle` failing with ECONNRESET:
      - the handle stays `supporthelper`;
      - the reply is still 200;
      - there's exactly one `slack_bot_failed { installId, stage: 'bot-handle', code }` line, before `slack_bot_renamed`.
  - `R3 refuses a name the shared bot, another bot, or another bot's handle has, by the 21-char key, before the vault or Slack; its own name in another case is fine`.
    - `'Canopy Works'` (the shared bot is `canopy-works`), `'sales desk'`, `'Sales-Desk'` (another bot's name) and `'Desk Bot'` (another bot's HANDLE `deskbot`) → 409 `bot-name-taken`, with no `vault:` or `slack:` entry in the trail.
    - `'support helper'` (its own name, lower case) → 200, and the stored name is `'support helper'`. The domain receives names the route already tidied, so no test here passes it an untidied one.
  - `R4 409 not-live for an agent with no bot, or a pending bot; 409 public-origin-not-https on an http origin (rename only); none touches the vault or Slack`. Neither the picture's `not-live` nor the rename's https refusal adds any `vault:` or `slack:` entry.
  - `R5 the approver's token refused (each of invalid_refresh_token, token_revoked, invalid_auth at the rotate; no_permission and app_not_owned_by_manager_app at the update), or missing → 502 slack-config-token; name and handle unchanged; Ada's token untouched`. The missing case logs `{ installId, stage: 'config-token', code: 'missing' }`.
  - `R6 invalid_manifest → 502 slack-name; app_not_found → 502 slack-app-gone; ratelimited and timeout → 502 slack-error; the row unchanged`.
  - `R7 the successor won't save → 500 internal; Slack is never asked to update; the stored token is left as it was`. Set `vaultFailures` on `credentials:set` of `configTokenRef(GRACE)`.
  - `R8 the bot's row gone at the write (a reset takes no lock) → 409 not-live; the token just saved goes, unless something still names the approver`. Make `memory.failures.set('setBotName', new InstallStoreError('install-not-active'))`. The vault no longer holds `configTokenRef(GRACE)` when GRACE has no other app, and still holds it when a leftover app names her.
  - `R9 two renames at once take turns under the app lock, each whole; the later name stays`. Start two `rename` calls without awaiting. Assert `slack:updateApp` and `store:setBotName` alternate as pairs and never interleave, and the row ends with the second name. A third case: a `lock.run` holding a deferred keeps a rename from touching anything until it resolves.
  - `P1 setPicture: rotate, save, then apps.icon.set with exactly the PNG; no manifest, no row write`.
    - The trail is `['store:botForAgent', 'vault:get config-refresh-token', 'slack:rotateConfigToken', 'vault:set config-refresh-token', 'slack:setAppIcon', 'store:get']`.
    - The `setAppIcon` args are `[MINTED_ACCESS, <bot appId>, png]`, with the bytes equal to `pngHeader(512, 512)`.
    - The reply is 200 `{}`, and the lines are `slack_bot_picture_changed { installId }`.
  - `P2 setPicture refusals: no_permission → 502 slack-config-token; app_not_found → 502 slack-app-gone; error_bad_format → 502 slack-error; the successor won't save → 500; a pending bot → 409 not-live; a vault fault reading the token rejects (the route's 500) before Slack`.
  - `P3 setPicture: the row gone after Slack took it → release, 409 not-live`. `memory.failures` is not needed here: delete the row inside a swapped `on.setAppIcon`.
  - `L1 no reply or log line carries a token, a person id, the agent id, a bot name or handle, the app id, or a failure's text` (`FAILURE_CANARY`). Gather it across R1, R2's failures, R5, R7 and P1, like `bots.test.ts:1072-1160`.
- [ ] **Step 2:** `pnpm --filter @ax/channel-slack test src/__tests__/bot-changes.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Add `handleFrom` and switch `keepHandle` to it. Write `bot-changes.ts` to the order above.
- [ ] **Step 4:** `pnpm --filter @ax/channel-slack build && pnpm --filter @ax/channel-slack test src/__tests__/bot-changes.test.ts src/__tests__/bot-callback.test.ts src/__tests__/bots.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `[TASK-1171] channel-slack: rename a team agent's live bot or change its picture with its approver's token`.
- [ ] **Step 6:** Mutation check (protocol as Task 1). Predict, then confirm:
  - `setBotName` before `changeApp` → R5, R6;
  - drop `except` → R3's own-name case;
  - `botForAgent` instead of `liveOwnBot` → R4's pending case;
  - drop the release on `InstallStoreError` → R8;
  - drop the picture's row re-read → P3;
  - read `configTokenRef` of anyone but `bot.connectedByUserId` → R1, R5.
- [ ] **Step 7:** Security note lines:
  - Sandbox: no new egress method. `updateApp`'s manifest is always `buildBotManifest(name, botUrls(config origin, row installId))` with the code-fixed six scopes, so the only request input is the name. `setAppIcon` gets bytes that `parseIconPng` passed. The vault touches the approver's person token and the bot's own `bot-token`, nothing else.
  - Injection: the `users.info` name passes `handleFrom` before it's stored, and only Slack's narrowed code is read.
  - Supply chain: N/A.

### Task 3: The two routes, wired into the plugin [tier: sensitive] — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/agent-routes.ts`: header `:23-59`; imports; `createAgentSlackRoutes` params `:206-209`; new handlers after `cancelBot` `:404-409`; route list `:454-464`.
- Modify: `packages/channel-slack/src/plugin.ts`: header mount list `:73-91`; `createBotChanges` after `const bots = createBots(...)` `:370-380`; `createAgentSlackRoutes(channelDeps, bots)` `:468`.
- Test: `packages/channel-slack/src/__tests__/agent-routes.test.ts`: `Suffix`/`EVERY_ROUTE` `:266-287`; `stubBots` `:302-335`; the `createAgentSlackRoutes` call `:411`; the route pin `:482-531`; the no-body loop `:625-654`; plus a new describe.
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts`: route shapes `:675-728`; `toHaveLength(20)` at `:2086`, `:2108`, `:2137` and `:2423`.
- Test: `presets/memory/src/__tests__/canary.test.ts`: suffix loop `:855`.

**Interfaces:**
- Consumes: Task 2's `BotChanges`, `createBotChanges`, `BotChangesDeps`.
- Produces (wire, for Task 5):
  - `POST /settings/slack/:agentId/bot/rename { botName }` → 200 `{ botName }`.
  - `POST /settings/slack/:agentId/bot/icon { iconPng }` → 200 `{}`.
  - Plus the route gate and the body refusals: 413 `body-too-large`; 400 `invalid-body`; 400 `invalid-bot-name {reason}`; 400 `invalid-icon {reason: 'icon-not-base64'|'icon-too-large'|'icon-not-png'|'icon-bad-size'}`.
  - Signature: `createAgentSlackRoutes(d: ChannelDeps, bots: Pick<Bots, 'request' | 'installUrl' | 'cancel' | 'status'>, changes: BotChanges): RouteSpec[]`. After TASK-1169 it is `(d, bots, requests, changes)`.

**Body readers** (module functions beside `readBotBody`):
- `readRenameBody(req)`: over `ADMIN_BODY_MAX_BYTES` → 413. `bodyObject` null, or any key but `botName` → 400 `invalid-body`. The name goes through the same three checks `readBotBody` `:175-180` applies: missing → `empty`; non-string → `bad-characters`; then `checkBotName`. If TASK-1169's `botNameOf()` is in the file, call it instead of repeating them.
- `readPictureBody(req)`: over `ADMIN_CONNECT_BODY_MAX_BYTES` → 413. Null, or any key but `iconPng` → 400 `invalid-body`. Then `parseIconPng(fields['iconPng'])`: not ok → 400 `{ error: 'invalid-icon', reason: icon.code }`; ok → `{ png }`.
- Handlers `renameBot` and `setBotPicture` are like `cancelBot`: `manages(a)` → `refused`, then the body, then `changes.rename({ agentId, botName })` or `changes.setPicture({ agentId, png })`. No user id or ctx reaches the domain.
- Routes, right after `/bot/cancel`:
  - `route('POST', '/bot/rename', 'bot-rename', renameBot)`;
  - `route('POST', '/bot/icon', 'bot-icon', setBotPicture, { maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES })`.
- `plugin.ts`:
  - `const botChanges = createBotChanges({ installs: store, secrets, api, lock: appLock, publicOrigin, logger, now, randomBytes })`, using the SAME `appLock` and cached `secrets` as `createBots`;
  - then `...createAgentSlackRoutes(channelDeps, bots, botChanges)`.
- Headers:
  - `agent-routes.ts`: two lines in the route list (`… → { botName }, a live bot only (the approver's token, TASK-1171)` and `{ iconPng } → {}`), and the body paragraph says the picture route has Connect's cap.
  - `plugin.ts`: `POST /settings/slack/:agentId/bot{,/install-url,/cancel,/rename,/icon}`, plus "…renames it or changes its picture (TASK-1171, bot-changes.ts)".

- [ ] **Step 1: Write the failing tests:**
  - **Route pin:** add, after `/bot/cancel`, `{ method: 'POST', path: '/settings/slack/:agentId/bot/rename', bypassCsrf: undefined, maxBodyBytes: ADMIN_BODY_MAX_BYTES }` and `{ …'/bot/icon', maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES }`.
  - **Tables:** `Suffix` gets `'/bot/rename' | '/bot/icon'`. `EVERY_ROUTE` gets `{ method: 'POST', suffix: '/bot/rename', body: { botName: 'Support Helper' } }` and `{ method: 'POST', suffix: '/bot/icon', body: { iconPng: pngBase64(512, 512) } }`. The no-body loop's suffixes get both.
  - **Stub:** `stubBots()` also returns `changes: BotChanges`, recording `'rename' | 'setPicture'` into the SAME `calls` array, so every existing `expect(w.bots.calls).toEqual([])` covers the new routes. It answers `{ status: 200, body: { botName: 'Quill Desk' } }` and `{ status: 200, body: {} }` by default.
  - **New `describe("the agent's own bot's name and picture (TASK-1171)")`:**
    - `a team admin's rename reaches the domain with the tidied name and nothing else, and its answer is the route's`: as GRACE, body `{ botName: '  Quill   Desk ' }` → the call input is exactly `{ agentId: SUPPORT.id, botName: 'Quill Desk' }`, and the reply equals the stub's answer.
    - `a name the rules refuse is 400 invalid-bot-name with its reason, before the domain`: `''` → `empty`; `'x'.repeat(36)` → `too-long`; `'Café'` → `bad-characters`; `'here'` → `reserved`; `42` → `bad-characters`; a missing key → `empty`.
    - `a rename body must be an object holding botName alone`: `{ botName, agentId }`, `[]`, `'garbage'` → 400 `invalid-body`; 16,385 bytes → 413 `body-too-large`.
    - `a team admin's picture reaches the domain as the PNG's bytes`: the call input is `{ agentId: SUPPORT.id, png }`, with `png.equals(pngHeader(512, 512))`.
    - `a picture that isn't one is 400 invalid-icon with icon.ts's reason, before the domain`: `'not base64!'` → `icon-not-base64`; `pngBase64(511, 511)` → `icon-bad-size`; a GIF header in base64 → `icon-not-png`; a missing key → `icon-not-base64`.
    - `a picture body holding anything but iconPng → 400 invalid-body; over Connect's cap → 413`.
    - `a domain that throws → 500 internal, logged slack_channel_route_failed { stage: 'bot-rename' | 'bot-icon', code } only`.
  - **plugin.test.ts:** the two shapes after `/bot/cancel`, and each `toHaveLength` +2.
  - **canary.test.ts:** the suffix loop gets `'/bot/rename'` and `'/bot/icon'` (no CSRF → 403; with it → the route's own 404).
- [ ] **Step 2:** `pnpm --filter @ax/channel-slack test src/__tests__/agent-routes.test.ts src/__tests__/plugin.test.ts`. Expected: FAIL (no such routes).
- [ ] **Step 3:** Implement the readers, handlers, routes, the plugin wiring and the headers.
- [ ] **Step 4:** `pnpm --filter @ax/channel-slack build && pnpm --filter @ax/channel-slack test && pnpm --filter @ax/preset-memory test`. Expected: PASS.
- [ ] **Step 5:** Commit: `[TASK-1171] channel-slack: a team admin renames the agent's live bot or changes its picture from its settings`.
- [ ] **Step 6:** Security note lines (Sandbox; Injection; Supply chain N/A):
  - two signed-in routes, CSRF kept, caps 16 KiB / 1,414,488 bytes, unknown keys 400;
  - rights before the body; name and picture checked before the lock;
  - the actor never reaches the domain;
  - the routes share `appLock` with every other token use.

### Task 4: The real assembly renames and re-pictures the bot [tier: integration]

**Files:**
- Modify: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`: the TASK-1167 scenario `:1966-2140`. Insert new steps after step 5 (it ends `expect(invokes).toHaveLength(2);` before `// 6.` `:2092`). Step 5 asserts the bot's OLD name in the step-aside line, so the steps can't go earlier. `const adaSuccessor` `:1993` becomes `let`.

**Interfaces — Consumes:** Task 3's routes; the scenario's `callRoute`, `jsonBody`, `slackCalls`, `rotatedRefreshToken(rotateSeq)`, `ROTATED_ACCESS_TOKEN`, `OWN_APP_ID`, `OWN_BOT_HANDLE`, `ICON_PNG`, `readConfigToken`, `query`.

- [ ] **Step 1: Write the steps** (as Ada, `actor = { id: 'usr_ada', isAdmin: false }`, reset to `null` after):
  - **5b. Rename.**
    - `POST /settings/slack/:agentId/bot/rename` with `{ botName: 'Support Desk' }` → `{ status: 200, body: { botName: 'Support Desk' } }`.
    - Slack methods since the mark: `['tooling.tokens.rotate', 'apps.manifest.update', 'users.info']`. The rotate's body is `{ refresh_token: adaSuccessor }`, and the update's auth is `Bearer ${ROTATED_ACCESS_TOKEN}` with `app_id` `OWN_APP_ID`.
    - `JSON.parse(update.body.manifest)` equals the manifest the request step's `apps.manifest.create` sent (capture it from `requestCalls[1]`), with only `display_information.name` and `features.bot_user.display_name` set to `'Support Desk'`.
    - The bot row has `bot_name: 'Support Desk'` and `bot_handle: OWN_BOT_HANDLE` (the fake's `users.info` keeps the name).
    - `readConfigToken('usr_ada')` is `rotatedRefreshToken(rotateSeq)`.
  - **5c. Picture.**
    - `POST …/bot/icon` with `{ iconPng: ICON_PNG.toString('base64') }` → `{ status: 200, body: {} }`.
    - Methods: `['tooling.tokens.rotate', 'apps.icon.set']`, with the icon call's `app_id` `OWN_APP_ID` (and its file part equal to `ICON_PNG` if the fake records multipart files).
    - The row is unchanged.
  - Then `adaSuccessor = rotatedRefreshToken(rotateSeq)`, so steps 6–7 assert the latest token.
- [ ] **Step 2:** `pnpm --filter @ax/preset-k8s test src/__tests__/channel-slack-composition.test.ts`. Docker: set `DOCKER_HOST` per CLAUDE.md. Expected: PASS. If local Docker is too slow, say so in the handoff; CI runs it.
- [ ] **Step 3:** Commit: `[TASK-1171] preset-k8s: the real assembly renames a team bot and changes its picture`.

### Task 5: channel-web client, copy, and drawing a picked image [tier: mechanical]

**Files:**
- Modify: `packages/channel-web/src/lib/agent-slack.ts`: header route list `:7-14`; new functions after `cancelSlackBot` `:352-358`; copy and mapping after `agentSlackBotErrorCopy` `:448-485`; `agentSlackBotStale` `:493-499`.
- Modify: `packages/channel-web/src/lib/slack-avatar.ts`.
- Test: `packages/channel-web/src/lib/__tests__/agent-slack.test.ts`, `packages/channel-web/src/lib/__tests__/slack-avatar.test.ts`.

**Interfaces — Produces (for Task 6):**
```ts
// agent-slack.ts
export async function renameAgentSlackBot(agentId: string, botName: string): Promise<{ botName: string }>;
export async function setAgentSlackBotPicture(agentId: string, iconPng: string): Promise<void>;
export const AGENT_SLACK_BOT_CHANGE_COPY: Readonly<{
  tokenNeedsReplacing: (approver: string) => string;
  appGone: string;
  badPicture: string;
  pictureChanged: string;
}>;
/** One sentence for a refused rename or picture change, and whether it belongs under the name field. */
export function agentSlackBotChangeErrorCopy(err: unknown, approver: string): { field: 'botName' | null; message: string };
// slack-avatar.ts
/** A picked image file as the PNG Slack gets (drawn by slack-avatar-draw.ts), or null. Never rejects. */
export function drawPickedSlackAvatar(file: File): Promise<string | null>;
```
**Exact copy:**
- `tokenNeedsReplacing: (a) => \`This bot's Slack token needs replacing by ${a}.\``
- `appGone: "Slack no longer has this bot's app. It may have been deleted on api.slack.com/apps."`
- `badPicture: "We couldn't use that picture. Try another image."`
- `pictureChanged: 'Slack has the new picture.'`

**Mapping:**
- `invalid-bot-name` → `BOT_NAME_COPY[reason] ?? BOT_NAME_FALLBACK`, field `botName`.
- `bot-name-taken` and `slack-name` → `SLACK_TOKEN_COPY[code]`, field `botName`.
- `invalid-icon` → `badPicture`.
- `slack-config-token` → `tokenNeedsReplacing(approver)`.
- `slack-app-gone` → `appGone`.
- `public-origin-not-https` → `SLACK_ERROR_COPY['public-origin-not-https']`.
- `slack-error` → `SLACK_ERROR_COPY.generic`.
- Anything else → `AGENT_SLACK_COPY.generic`.
- Every case without a field above gets field `null`.

`agentSlackBotStale` adds 409 `not-live`, and its doc says "a rename or picture change too".

`drawPickedSlackAvatar`:
- `URL.createObjectURL(file)`;
- `loadAvatarImage(url, SLACK_AVATAR_TIMEOUT_MS)`, then `drawSlackAvatar(image)`;
- any throw → `null`;
- `URL.revokeObjectURL(url)` in `finally`.

- [ ] **Step 1: Write the failing tests:**
  - `renameAgentSlackBot posts { botName } to /settings/slack/<id>/bot/rename with the write headers and reads back the name`: `a 1` encodes as `a%201`; `x-requested-with: ax-admin`; a missing or empty `botName` in the answer → `bad-response`; 409 `{ error: 'not-live' }` → `AgentSlackError(409, 'not-live')`.
  - `setAgentSlackBotPicture posts { iconPng } to …/bot/icon`: 400 `{ error: 'invalid-icon', reason: 'icon-bad-size' }` → `AgentSlackError(400, 'invalid-icon', 'icon-bad-size')`.
  - `agentSlackBotChangeErrorCopy`: a table over every code above. `slack-config-token` with `'Ada Lovelace'` → `"This bot's Slack token needs replacing by Ada Lovelace."`, and with `'A teammate'` → `"…replacing by A teammate."`. A `TypeError` → `AGENT_SLACK_COPY.generic`.
  - `agentSlackBotStale(new AgentSlackError(409, 'not-live')) === true`, and `(409, 'bot-name-taken') === false`.
  - `drawPickedSlackAvatar` (mock `../slack-avatar-draw` as `slack-avatar.test.ts` does; stub `URL.createObjectURL`/`revokeObjectURL`):
    - resolves to the drawing, with load called as `(<object url>, 5_000)`, and the URL revoked;
    - a load rejection → `null`, URL revoked;
    - a draw returning `null` → `null`.
- [ ] **Step 2:** `pnpm --filter @ax/channel-web test src/lib/__tests__/agent-slack.test.ts src/lib/__tests__/slack-avatar.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `renameAgentSlackBot` and `setAgentSlackBotPicture` use the file's `post()`.
- [ ] **Step 4:** Same command, plus `pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 5:** Commit: `[TASK-1171] channel-web: client and words for renaming an agent's bot or changing its picture`.

### Task 6: Rename and Change picture on the live bot [tier: integration] — `shadcn` skill

**Files:**
- Create: `packages/channel-web/src/components/workspace/AgentSlackBotChanges.tsx`
- Modify: `packages/channel-web/src/components/workspace/AgentSlackBot.tsx`: header `:14-15`; `case 'live'` `:155-156`; `Live` `:351-368`.
- Test: Create `packages/channel-web/src/components/workspace/__tests__/AgentSlackBotChanges.test.tsx`. Modify `__tests__/AgentSlackBot.test.tsx` `describe('live')` `:404-437`.

**Interfaces:**
- Consumes: Task 5's functions and copy, `ALLOWED_LOGO_TYPES` (`lib/branding.ts`), `AgentSlackBot` (the live member).
- Produces:
```ts
export function BotChanges(props: {
  agentId: string;
  bot: Extract<AgentSlackBot, { state: 'live' }>;
  /** A rename landed, or a refusal said the page is stale: read the status again. */
  onChanged: () => void;
}): JSX.Element;
```
- `AgentSlackBot.tsx`:
  - `case 'live'` passes `agentId` and `onChanged` to `Live`;
  - `Live` renders `{canManage && <BotChanges agentId={agentId} bot={bot} onChanged={onChanged} />}` after the `needsClaim` paragraph (and before TASK-1172's Disconnect, if it's there);
  - the header's `live` line adds "…a manager can also rename it or change its picture (TASK-1171)".

**Layout and copy** (model: SlackTab `ConnectedCard` `:842-863` and `RenameDialog` `:497-632`; keep a local `Busy`):
- A `dl` with two rows:
  - `dt` "Bot name" / `dd` `<span className="text-muted-foreground">{bot.botName}</span>` and an outline small `Button` "Rename";
  - `dt` "Picture" / `dd` an outline small `Button` "Change picture".
- Then, after a picture lands, `<Alert><AlertDescription>Slack has the new picture.</AlertDescription></Alert>`. Opening either dialog clears it.
- **Rename dialog:**
  - Title "Rename the bot".
  - Description "Only the name changes. It stays in the channels it's in, and nobody has to invite it again."
  - `FieldLabel` "Bot name" (id `slack-agent-bot-rename`), prefilled with `bot.botName`; `FieldDescription` "The name people see in Slack."
  - Buttons "Cancel" / "Rename"; busy reads "Renaming…".
  - The dialog owns `busy` and ignores close requests while busy. The form under `DialogContent` remounts on each open.
  - On success it clears busy, closes, then calls `onChanged()`.
  - Field errors go in a `FieldError` and refocus the input. Other errors go in a destructive `Alert`.
  - A stale refusal (`agentSlackBotStale`) closes and calls `onChanged()`.
- **Picture dialog:**
  - Title "Change the bot's picture".
  - Description "Pick an image from your computer. We'll center it on a white square for Slack."
  - A visually hidden `<input type="file" accept={ALLOWED_LOGO_TYPES.join(',')} aria-label="Image file">`, as in BrandingTab `:81-101`. A `Button` "Choose an image" (after a pick, "Choose another") clicks it.
  - The picked file goes to `drawPickedSlackAvatar`. A string shows `<img src={\`data:image/png;base64,${png}\`} alt="The new picture" className="size-32 rounded-md border border-border" />`. `null` shows the `badPicture` line, and Save stays disabled.
  - Buttons "Cancel" / "Save picture"; busy reads "Saving…".
  - On success it closes and shows the notice, with NO `onChanged()` (nothing in the status changed).
  - Errors and stale refusals are handled as in Rename.

- [ ] **Step 1: Write the failing tests** (`AgentSlackBotChanges.test.tsx`; mock `renameAgentSlackBot`, `setAgentSlackBotPicture` and `drawPickedSlackAvatar`; the copy and mapping are real; `LIVE` = `{ state: 'live', botName: 'Quill Bot', handle: 'quill_bot', approver: 'Ada Lovelace', needsClaim: false }`):
  - `shows the bot's name with Rename, and a Change picture button`.
  - `Rename opens on the current name; saving sends the typed name, closes the dialog, then reads the status again`: the call is `('a1', 'Quill Desk')`; the dialog is gone; `onChanged` was called once.
  - `a refused name stays in the dialog under the field, and focus returns to it`: `invalid-bot-name/too-long` → `BOT_NAME_COPY['too-long']`; `bot-name-taken` → `SLACK_TOKEN_COPY['bot-name-taken']`; no `onChanged`.
  - **token line:** `a token Slack refuses names the approver, and nothing is re-read`: `slack-config-token` shows "This bot's Slack token needs replacing by Ada Lovelace." in an alert, with no `onChanged`.
  - **stale:** `not-live, forbidden and not-found close the dialog and read the status again`.
  - `while Slack answers, Escape doesn't close the dialog and the button reads Renaming…`.
  - `picking an image shows what Slack will get; saving sends exactly that PNG and says Slack has it, without re-reading`: the img `alt="The new picture"` has `src` `data:image/png;base64,UE5H`; the call is `('a1', 'UE5H')`; the alert reads "Slack has the new picture."; no `onChanged`.
  - **undrawable:** `an image the browser can't draw says so, and Save stays off`: the draw resolves `null` → the `badPicture` text shows, `Save picture` is disabled, and nothing is sent.
  - `picture refusals: invalid-icon → the picture line; slack-config-token → the approver line; slack-app-gone → the gone line; slack-error → SLACK_ERROR_COPY.generic`.
  - `AgentSlackBot.test.tsx` `describe('live')`:
    - **Bot name row:** `a manager sees the bot's name with Rename and Change picture, even when the handle doesn't match it` (`LIVE` with handle `support_helper` and name `Quill Bot`: both texts show);
    - `a member sees neither`.
- [ ] **Step 2:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/AgentSlackBotChanges.test.tsx src/components/workspace/__tests__/AgentSlackBot.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Invoke the `shadcn` skill (`-c packages/channel-web`), then implement. Every primitive is already installed, and nothing is added.
- [ ] **Step 4:** Same command, plus `pnpm --filter @ax/channel-web build` and `pnpm --filter @ax/channel-web test`. Expected: PASS.
- [ ] **Step 5:** Commit: `[TASK-1171] channel-web: Rename and Change picture on an agent's live Slack bot`.

### Task 7: Stale lines, as-built, changeset [tier: mechanical]

**Files** (fetch and rebase first):
- `docs/plans/2026-11-09-channel-slack-design.md`
  - §4: after the TASK-1167 "As built" list (`:509-544`), add an **"As built (TASK-1171)."** paragraph. It says:
    - a team admin of the agent's team renames a live bot or changes its picture, both with the approver's stored token (rotated, its successor saved first, under the one app lock), with no new approval and no reinstall;
    - Rename checks the name as a request does, sends the whole bot manifest, stores the name, then keeps the `users.info` `name` as the handle when it changed (unmeasured whether Slack changes it, §7 Q3);
    - Change picture draws the chosen image on a white 512 px square in the browser and sends that PNG with `apps.icon.set`, and AX keeps no copy;
    - a token Slack refuses, or `no_permission`, changes nothing in AX, and the settings say the token needs replacing by the approver.
  - §9 `:1108-1111`: drop "rename, avatar change" from "still to do", and add a TASK-1171 sentence (merge with whatever the siblings wrote).
- `packages/channel-slack/src/migrations.ts:16-17` and `store.ts:49-50`: "read once at its Allow" → "read at its Allow, and again after a rename (TASK-1171)".
- `store.ts:145-150` (`setBotHandle`): "the callback's check" → "`handleFrom`'s check (bots.ts)".
- `bots.ts:64-66`: "Its @handle is read once there" → "Its @handle is read there (and again after a rename, bot-changes.ts)".
- Create `.changeset/slack-bot-rename-picture.md`:
  ```md
  ---
  '@ax/channel-slack': patch
  '@ax/channel-web': patch
  ---

  A team admin can now rename a team agent's own Slack bot, or change its picture, from the agent's settings. Both use the token of whoever set the bot up, so nobody approves anything again and nobody has to invite the bot again. If that token stopped working, nothing changes and the settings say whose token needs replacing.
  ```

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** `rg -n "read once at its Allow|Its @handle is read once|rename, avatar change" packages docs/plans/2026-11-09-channel-slack-design.md`. Expected: no output.
- [ ] **Step 3:** Commit: `[TASK-1171] docs: rename and picture of a team bot as built; stale handle lines; changeset`.

---

## Security checklist and boundary review

- **`security-checklist`: required, one walk covering Tasks 1–3** (record the notes in the decisions shard and the PR body). What triggers it:
  - credential handling moved into a shared step;
  - another person's configuration token used for any team admin;
  - two new signed-in routes taking untrusted input (a typed name, a base64 PNG);
  - Slack's `users.info` text stored.
- Not triggered by Tasks 4–7: tests, the browser's own file drawn to its own canvas, docs. No dependency change.
- **Boundary review: not required.** No hook, IPC action or manifest `calls` entry is added or changed. The routes go through the existing `http:register-route`, and no preset `.toEqual` pin moves.

## Final gate

- [ ] `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. A Docker teardown timeout in an untouched package is load, not a failure: re-run that package alone.

## Follow-ups to hand back (decisions row "Follow-ups")

1. A bot's approver replaces their configuration token from the bot's settings (design: "Replace … of a live bot … still to do").
2. A "viewer is the approver" field, so the token line can say "your token".
3. The phase 2 walk measures whether Slack's `name` (the handle) follows a rename, and whether a new picture shows in the client.
4. Picking the picture at request time (design §4 step 1).
