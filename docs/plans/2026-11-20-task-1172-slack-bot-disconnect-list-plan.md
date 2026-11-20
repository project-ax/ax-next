# TASK-1172: Disconnect a team agent's own Slack bot, and list every bot with its approver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team admin (agent settings) or an AX admin (Admin › Slack) can disconnect a team agent's own Slack bot, pending or live, with the same removal agent deletion uses; and Admin › Slack lists every such bot with its approver, marking an approver who is no longer an AX user.

**Architecture:** The removal already exists: `removeBot` inside `createBots` (`packages/channel-slack/src/bots.ts:295-301`), shared by Cancel and agent deletion. Two new domain methods take the one app lock and call it: `disconnect` (by agent, team admin, rights re-checked inside the lock) and `disconnectForAdmin` (by install id, bots only). A third, `listForAdmin`, reads every bot and its approver's name. A new route on the agent settings, a new small admin route module, and two channel-web surfaces (a Disconnect in the bot section, a "Team agents' own bots" card in Admin › Slack) sit on top. The shared bot answers for the agent again on its own: its bindings were never touched, and it steps aside only while the agent's bot is live.

**Tech Stack:** TypeScript, Kysely/Postgres (no migration), the hook bus (no new hook, no manifest change), React + shadcn in `packages/channel-web`, vitest + Testcontainers.

**Spec:**
- The card TASK-1172 as dispatched (scope, acceptance, Decisions 2026-11-19 and the 2026-11-20 update; learnings from TASK-1175 and TASK-1167).
- `docs/plans/2026-11-09-channel-slack-design.md` §4 (Lifecycle; As built TASK-1167).
- This card's decisions shard, `.claude/memory/decisions/2026-11-20-TASK-1172.md`: every call below, with its alternatives. Read it before Task 2.

---

## What the brief got right, and what it got wrong (checked against main at `3cf5673d0`)

1. **Right: a reusable delete exists.** `removeBot(bot)` (`bots.ts:295-301`) deletes the Slack app with the approver's token (`steps.deleteSlackApp`, `slack-apps.ts:329-349`: read, rotate, save the successor first, delete; `app_not_found` counts as gone), then in one statement removes the row and its bindings and, when Slack refused, moves the app to the leftover list naming the approver (`store.ts:544-570`), then deletes the three per-install secrets, then releases the approver's token only if nothing names them (`steps.release` → `releaseConfigToken` → `personHasApps`, which counts bot rows and leftovers). It takes **no** lock; `cancel` and `removeForAgent` take it and call it. The lock (`mutex.ts`) is a promise chain and **not re-entrant**.
2. **Wrong: "mint from the bot's stored refresh token", "under the bot install's lock".** There is no per-bot token (TASK-1175) and no per-install lock: there is one app lock for every Slack-app step (`plugin.ts:360-366`), and the token is the approver's per-person one. `removeBot` already does it this way.
3. **Right: the shared bindings are untouched, and the shared bot answers again with no restore step.** Bindings are keyed `(install_id, channel_id)` (`migrations.ts:202-211`); `store.remove` deletes only the bot install's (pinned by `store.test.ts:763`). The shared bot steps aside only while `botForAgent(agentId)` is `active` (`router.ts:576-583`, `:742-751`). Task 6 proves the whole path on Postgres.
4. **Refined: not `GET /admin/slack`.** The list and the admin Disconnect get their own routes in a new `admin-bot-routes.ts` (shard row 4: ~18 exact-body pins, sibling TASK-1169, bots outlive the shared install).
5. **Refuted: the "agent" and "team" columns.** No hook lets an AX admin read a team's name (teams and agents are member-only by design); the one ACL-free agent-name lookup, `agents:get-display-name`, is pinned to exactly one caller (`presets/k8s/src/__tests__/preset.test.ts:1853-1917`, `docs/plans/2026-05-24-current-architecture.md:426-430`). Neither is in the acceptance criteria. Cut; suggested follow-up card (shard row 6).
6. **Refuted: "when the token was added" per bot.** A person's token has no date; a bot row's `config_token_added_at` is its insert time and never moves. The list shows `addedAt` = when the bot was asked for, and Task 10 fixes the comment that made it look per-bot (`store.ts:55-60`).
7. **Wrong file:** the bot's UI is `AgentSlackBot.tsx`; `AgentSlack.tsx` hosts it. And the no-workspace view infers `canManage` from a pending bot (`AgentSlack.tsx:157`), so today a manager gets no controls on a live bot once the shared app is gone (Decision 4 makes that reachable). Task 4 adds `canManage` to that status.
8. **No `AlertDialog`** is installed; both existing disconnect dialogs use `Dialog` (`AgentSlack.tsx:546-615`, `SlackTab.tsx:434-495`). Use `Dialog`.

---

## Global Constraints

- **No new hook, no `calls`/`optionalCalls` change, no IPC action.** No boundary review; `presets/k8s` manifest pins stay as they are. channel-web mirrors the new HTTP shapes by shape, never by import.
- **One app lock, not re-entrant.** `disconnect` and `disconnectForAdmin` take `d.lock` once; `listForAdmin` takes none; routes never take it. Never call a lock-taking method from inside the lock.
- **Every bot removal goes through `removeBot`.** No second copy of: delete with the approver's token (successor saved first) → `remove(id, { appLeft: !appDeleted })` → `secrets.removeAll` → `steps.release`.
- **Leaks:** no response body or log line carries a token, a person's id, an agent id, or a Slack id other than an install id. Logs are code-only (`logCode`). The admin wire may carry bot `installId`s (the key its Disconnect takes) and approver emails (admins only, as `connectedBy` today).
- **Copy:** CLAUDE.md voice; the exact strings in Tasks 8-9 are pinned; no "AX" in a user-facing sentence (the existing "never writes the product name in a sentence" tests).
- **UI (invariant 6):** channel-web shadcn primitives and semantic tokens only: `Card`, `Table`, `Badge`, `Button`, `Dialog`, `Alert`, `Skeleton`, `Spinner`. Invoke the `shadcn` skill before Tasks 8-9.
- **Siblings in flight (TASK-1168, TASK-1169) edit the same package.** Keep edits to `bots.ts`, `agent-routes.ts`, `plugin.ts`, `AgentSlack*.tsx`, `SlackTab.tsx` minimal; new surfaces live in new files; no renames.
- **Tests:** `pnpm --filter @ax/<pkg> exec vitest run <file> [-t name]`. `plugin.test.ts`, `store.test.ts` and the memory canary need Docker (`DOCKER_HOST` set, CLAUDE.md). Run `pnpm --filter <pkg> build` (tsc) alongside vitest: channel-web type-checks its tests. Final gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.

## Review Focus

Each line has a named test in the task that owns it.

1. **Two disconnects of one bot at once** (a double click; a team admin and an AX admin together): one removes it, the other answers 409 `no-bot`, Slack is asked to delete the app once. Task 2, D10.
2. **The shared Slack app is gone** (Admin › Slack disconnected it; the bot stayed, Decision 4): the team admin still sees **Disconnect bot**, and it works. Task 2 D1b, Task 4 S2, Task 8 A2.
3. **An admin request naming the shared install's id** (hand-built): the shared app is never touched. Task 2, D9.
4. **A stale admin tab:** the bot was disconnected and re-requested since the page loaded; Disconnect on the old row must not remove the new bot. Task 2, D9.
5. **The "may still be on Slack" note survives the re-read** that follows a disconnect (AgentSlack's loading face; SlackTab's status re-read). Task 8 A1, Task 9 T1.

---

## File Structure

**channel-slack (`packages/channel-slack/src/`)**
- `person-name.ts` — modify: add `accountName` (null when auth has no account); `personName` delegates, behaviour unchanged.
- `bots.ts` — modify: `Bots` gains `disconnect`, `disconnectForAdmin`, `listForAdmin`; type `AdminSlackBot`; header.
- `agent-routes.ts` — modify: `POST …/bot/disconnect`; `no-workspace` gains `canManage`; header.
- `admin-bot-routes.ts` — **create**: `GET /admin/slack/bots`, `POST /admin/slack/bots/disconnect`.
- `plugin.ts` — modify: mount the admin bot routes; header route list (`:73-91`).
- `admin-routes.ts` — modify: one header line (`:45-52`) pointing at `admin-bot-routes.ts`.
- `store.ts` — modify: the `configTokenAddedAt` comment (`:55-60`).
- Tests: `__tests__/person-name.test.ts` (create), `bots.test.ts`, `agent-routes.test.ts`, `admin-bot-routes.test.ts` (create), `plugin.test.ts`.

**channel-web (`packages/channel-web/src/`)**
- `lib/agent-slack.ts` — modify: `disconnectSlackBot`, `canManage` on `no-workspace`, `no-bot` is stale; header.
- `components/workspace/AgentSlackBot.tsx` — modify: Disconnect bot + dialog on the live view; `BotCancelled.how`; header.
- `components/workspace/AgentSlack.tsx` — modify: pass `canManage` and `sharedChannels`.
- `lib/slack-bots-admin.ts` — **create**: the admin list and Disconnect client.
- `components/admin/SlackBotsCard.tsx` — **create**: the card.
- `components/admin/SlackTab.tsx` — modify: mount the card; header.
- Tests: `lib/__tests__/agent-slack.test.ts`, `components/workspace/__tests__/AgentSlackBot.test.tsx`, `…/AgentSlack.test.tsx`, `lib/__tests__/slack-bots-admin.test.ts` (create), `components/admin/__tests__/SlackBotsCard.test.tsx` (create), `…/SlackTab.test.tsx`, `…/AdminShellHeadings.test.tsx`, `src/__tests__/slack-install-return-app.test.tsx`.

**Elsewhere:** `presets/memory/src/__tests__/canary.test.ts` (reachability), `docs/plans/2026-11-09-channel-slack-design.md`, `.changeset/slack-bot-disconnect.md`.

---

### Task 1: `accountName` — a person's name, or null when auth no longer has them `[tier: mechanical]`

**Files:**
- Modify: `packages/channel-slack/src/person-name.ts`
- Create: `packages/channel-slack/src/__tests__/person-name.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function accountName(
    bus: HookBus,
    ctx: AgentContext,
    userId: string,
    o: { allowEmail: boolean; fallback: string; onFault: (err: unknown) => void },
  ): Promise<string | null>;
  ```
  `auth:get-user` throws → `o.onFault(err)`, answer `o.fallback`. Answers `null` → `null` (no account). Any other non-record → `o.fallback`. A record → cleaned display name, else (if `allowEmail`) cleaned email, else `o.fallback` (the same `cleanLabel` rule as today). `personName` becomes `(await accountName(…)) ?? o.fallback`.

- [ ] **Step 1: Write the failing tests** (a `HookBus` with `auth:get-user` registered by the test):
  - `accountName: a display name, cleaned to one line` — `displayName: '  Ada‮   Admin  '` (write the bidi character as an escape: `source-hygiene.test.ts`) → `'Ada Admin'`.
  - `accountName: the email only where allowEmail says so, else the fallback` — `{ displayName: null, email: 'ada@canopyworks.example' }`: `allowEmail: true` → the email; `false` → `'A teammate'`.
  - `accountName: null when auth no longer has the account` — auth answers `null` → `null`, `onFault` never called.
  - `accountName: an auth fault reaches onFault once and answers the fallback` — auth throws `Object.assign(new Error('x'), { code: 'ECONNRESET' })` → `'A teammate'`, `onFault` called once with that error.
  - `personName: an account auth no longer has still reads as the fallback` — auth answers `null` → `'A teammate'`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/person-name.test.ts` — expect FAIL (`accountName` is not exported).
- [ ] **Step 3: Implement** `accountName` and make `personName` delegate. Update the file's doc comment: `accountName` is for a page that must tell "gone" apart.
- [ ] **Step 4: Run** the new file, then `agent-routes.test.ts` and `admin-routes.test.ts` (both read names through `personName`): PASS, no other change.
- [ ] **Step 5: Commit** — `feat(channel-slack): accountName tells an account auth no longer has from a fault (TASK-1172)`

---

### Task 2: The domain — `disconnect` and `disconnectForAdmin` `[tier: sensitive]` — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/bots.ts` (the `Bots` interface, `createBots`, the header's list of what takes the lock)
- Test: `packages/channel-slack/src/__tests__/bots.test.ts`

**Interfaces:**
- Consumes: `removeBot` (internal), `checkRights` (`channels.ts:233`), `rightsRefused` (`bots.ts:246`).
- Produces (added to `Bots`):
  ```ts
  /** Team admin, by agent: takes the app lock; asks manage rights again inside it; pending or live. */
  disconnect(i: { ctx: AgentContext; actorUserId: string; agentId: string }): Promise<BotReply>;
  /** AX admin, by install id: takes the app lock; only a `kind 'bot'` row; never reads rights. */
  disconnectForAdmin(i: { installId: string }): Promise<BotReply>;
  ```
  Answers: `200 { appDeleted: boolean }`; `409 { error: 'no-bot' }` (no bot for the agent; or the id names no install, or a non-bot one). `disconnect` only: the in-lock `checkRights(…, 'manage')` refusal through `rightsRefused` (403 `forbidden`, 404 `not-found`, 409 `personal-agent`). A store `remove` that fails, or rights that can't be answered, **throws** (the route's 500).
  Order inside the lock: `disconnect` = rights → `botForAgent` → `removeBot` → log; `disconnectForAdmin` = `installs.get` → `kind === 'bot'` check → `removeBot` → log.
  Log: `slack_bot_disconnected { installId, appDeleted, by: 'team-admin' }` (or `by: 'admin'`) at info.

- [ ] **Step 1: Write the failing tests.** Extend `world()` with `disconnect(as, agentId = SUPPORT.id)` and `disconnectForAdmin(installId)` (both through `keep`), and a seeding helper for the Support agent's bot: `addBot(w, { agentId: SUPPORT.id, approver, botName: BOT_NAME, live, handle })`, its three secrets under `secretRef(installId, …)`, and the approver's stored token under `configTokenRef(approver)`, then `forget(w)`. New `describe('disconnect')`:
  - **D1** `disconnect: a live bot's app is deleted with its approver's token (rotate, save, delete); its row and three secrets go; the token is released once nothing names its person` — Grace approver, as Grace → `{ status: 200, body: { appDeleted: true } }`; `w.trail` equals cancel's pinned trail (`bots.test.ts:881-896`): `store:botForAgent`, `vault:get config-refresh-token`, `slack:rotateConfigToken`, `vault:set config-refresh-token`, `slack:deleteApp`, `store:remove`, the four `vault:delete` of `SECRET_NAMES`, `store:personHasApps`, `vault:delete config-refresh-token`; row gone, `leftovers.size === 0`, `expectNoSecretsOf`, Grace's token gone, every `sharedVault()` entry intact; `w.lines` equals `[{ level: 'info', msg: 'slack_bot_disconnected', fields: { installId, appDeleted: true, by: 'team-admin' } }]`.
  - **D1b** `disconnect: with no shared install at all (Admin › Slack disconnected it), the bot still goes` — no `seedShared`; same answer and row/secrets gone.
  - **D2** `disconnect: a pending bot goes the same way` — `live: false` → 200 `{ appDeleted: true }`, row gone.
  - **D3** `disconnect: Slack won't delete the app: it is listed as left over naming the approver, the install still goes, the approver's token stays` — `failRotate(w, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'))` → `{ appDeleted: false }`; `[...w.memory.leftovers.values()]` equals `[{ installId, appId: 'A07OTHERBOT1', botName: BOT_NAME, leftAt: new Date(NOW_MS), connectedByUserId: GRACE }]`; Grace's token still stored; lines: `slack_bot_failed { installId, stage: 'rotate', code: 'invalid_refresh_token' }` (warn) then `slack_bot_disconnected { installId, appDeleted: false, by: 'team-admin' }`. Second world: `w.slack.on.deleteApp` throws `no_permission` → same outcome, stage `delete-app`.
  - **D4** `disconnect: an approver whose shared app still names them keeps their token` — Ada approver, `seedShared` → `w.vault.get(configTokenRef(ADA))` is the delete's successor (the last `mintedRefresh(n)` the fake minted), and `w.trail.at(-1)` is `store:personHasApps`.
  - **D5** `disconnect: rights are asked again inside the lock: a team admin demoted while it was held gets 403, an agent deleted meanwhile 404, and nothing is touched` — `const lock = createMutex()`, `world({ lock })`, `holdLock(lock)`, start `w.disconnect(GRACE)`, then `w.people.setRole(SUPPORT_TEAM, GRACE, 'member')`, `free()` → `{ status: 403, body: { error: 'forbidden' } }`, `w.slack.calls` and `w.vaultCalls` empty, the bot still `active`. Second world: `w.people.agents.delete(SUPPORT.id)` while held → `{ status: 404, body: { error: 'not-found' } }`.
  - **D6** `disconnect: an agent with no bot is 409 no-bot, with no vault or Slack call`.
  - **D7** `disconnect: a row that won't go throws; the bot's secrets and its approver's token stay for a retry` — `w.memory.failures.set('remove', connectionReset())` → rejects with `code: 'ECONNRESET'`; the three secrets and Grace's token are still in the vault; no leftover.
  - **D8** `disconnectForAdmin: removes a bot by its install id the same way, without asking anyone's rights, and logs by: 'admin'` — `w.people.inputs('agents:resolve')` is empty; first trail entry `store:get`; line `by: 'admin'`.
  - **D9** `disconnectForAdmin: the shared install's id, an id no install has, or an old bot's id after a new request is 409 no-bot, and nothing is touched` — `SHARED_INSTALL` → 409, shared row and `sharedVault()` intact; `'A'.repeat(22)` → 409; disconnect Support's bot, `w.request({ as: GRACE, refreshToken: PASTED })` a new one, then `disconnectForAdmin(<old id>)` → 409 and `supportBot(w)` is the new pending row.
  - **D10** `two disconnects at once remove the bot once: the other is 409 no-bot` — `Promise.all([w.disconnect(GRACE), w.disconnectForAdmin(installId)])` → one 200, one `{ status: 409, body: { error: 'no-bot' } }`; exactly one `deleteApp` in `w.slack.calls`.
  - **D11** `both wait for the one app lock: nothing is read, rotated or deleted until the step holding it lets go` — `holdLock`, start both, flush microtasks, `w.trail` is `[]`; `free()`, then both settle.
  - Extend `no reply body or log line carries a token or a person id` (`bots.test.ts:1072`) to run D1's and D8's calls.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/bots.test.ts` — expect the new tests to FAIL (`w.disconnect is not a function` / missing methods).
- [ ] **Step 3: Implement** both methods inside `createBots`, next to `cancel`, each inside one `d.lock.run`, each calling `removeBot`. Add `const NO_BOT = json(409, { error: 'no-bot' })`. Update the header: who takes the lock now lists `disconnect` and `disconnectForAdmin`.
- [ ] **Step 4: Run** the file — PASS, existing tests unchanged. `pnpm --filter @ax/channel-slack build` passes.
- [ ] **Step 5: security-checklist walk** of this diff (three threat models); record the PR note lines as a row in this card's decisions shard.
- [ ] **Step 6: Commit** — `feat(channel-slack): disconnect a team agent's own bot, by agent or by install, under the one app lock (TASK-1172)`

---

### Task 3: The domain — `listForAdmin` `[tier: sensitive]` — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/bots.ts`
- Test: `packages/channel-slack/src/__tests__/bots.test.ts`

**Interfaces:**
- Consumes: `accountName` (Task 1), `installs.listBots()`.
- Produces:
  ```ts
  /** Admin › Slack's view of one bot. Only admins read it: the approver may be an email. */
  export interface AdminSlackBot {
    installId: string;
    botName: string;
    /** Slack's @handle for the bot user, or null when Slack never said. */
    handle: string | null;
    /** Display name, else email; "A teammate" when auth can't answer; null when auth has no such account. */
    approver: string | null;
    state: 'pending' | 'live';
    /** When the bot was asked for: its row's `createdAt`, ISO 8601. */
    addedAt: string;
  }
  /** Added to `Bots`. No lock, no vault read, no Slack call. */
  listForAdmin(i: { ctx: AgentContext }): Promise<AdminSlackBot[]>;
  ```
  Approver: `accountName(d.bus, i.ctx, bot.connectedByUserId, { allowEmail: true, fallback: APPROVER_FALLBACK, onFault: (err) => steps.failed('approver', err, bot.installId, 'warn') })`. `state: bot.status === 'active' ? 'live' : 'pending'`. In `listBots()` order. A `listBots` fault throws.

- [ ] **Step 1: Write the failing tests** (add `listForAdmin(as = ADA)` to `world()`, and a `getUserFault` option to `world()`'s `auth:get-user`):
  - **L1** `listForAdmin: every bot, pending and live, never the shared app: name, handle, approver, state and when it was asked for` — `seedShared`; Grace's pending bot for Support (`w.request`), Sam's live one for Sales (`addBot` with `handle: 'salesdesk'`) → `toHaveLength(2)` and `toEqual(expect.arrayContaining([…]))` with `{ installId: <Support's>, botName: BOT_NAME, handle: null, approver: 'Grace Hopper', state: 'pending', addedAt: new Date(NOW_MS).toISOString() }` and `{ installId: 'U2FsZXNCb3RJbnN0YWxsMQ', botName: 'Sales Desk', handle: 'salesdesk', approver: 'Sam Sales', state: 'live', addedAt: new Date(NOW_MS).toISOString() }` (both rows share the fake clock, so their order is the store's tie-break, already pinned in `store.test.ts:461`).
  - **L2** `listForAdmin: an approver without a display name reads as their email (only admins read this list)` — `w.users.get(SAM)!.displayName = null` → `'sam@canopyworks.example'`.
  - **L3** `listForAdmin: an approver auth no longer has is null; an auth fault reads "A teammate" and is logged code-only` — `w.users.delete(SAM)` → `approver: null`; with `getUserFault: connectionReset()` → `'A teammate'` and `{ level: 'warn', msg: 'slack_bot_failed', fields: { installId, stage: 'approver', code: 'ECONNRESET' } }`.
  - **L4** `listForAdmin: no bots is [] and asks auth nothing`.
  - **L5** `listForAdmin: each item holds exactly the six fields, and no person id, token, app id or agent id` — `Object.keys(item).sort()` equals `['addedAt', 'approver', 'botName', 'handle', 'installId', 'state']`; `JSON.stringify(answer)` contains none of `GRACE`, `SAM`, `SUPPORT.id`, `SALES.id`, `'A07OTHERBOT1'`, `APP.appId`, or any vault value.
- [ ] **Step 2: Run** `… vitest run src/__tests__/bots.test.ts -t listForAdmin` — FAIL.
- [ ] **Step 3: Implement** `listForAdmin` and export `AdminSlackBot`.
- [ ] **Step 4: Run** the file — PASS. `pnpm --filter @ax/channel-slack build` passes.
- [ ] **Step 5: security-checklist walk** (what crosses to an admin's browser: names from auth, cleaned; install ids; no secret) — PR note row in the shard.
- [ ] **Step 6: Commit** — `feat(channel-slack): list every team bot with its approver for Admin › Slack (TASK-1172)`

---

### Task 4: Agent settings route `POST /settings/slack/:agentId/bot/disconnect`, and `canManage` on `no-workspace` `[tier: sensitive]` — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/agent-routes.ts` (route list `:28-35`, `AgentSlackStatus`, `status` `:221-271`, the `bots` Pick, the returned routes `:423-433`)
- Test: `packages/channel-slack/src/__tests__/agent-routes.test.ts`
- Modify (pins): `packages/channel-slack/src/__tests__/plugin.test.ts` (route shapes `:682-726`; the no-workspace body `:2183`), `presets/memory/src/__tests__/canary.test.ts` (the TASK-1167 bot-route loop)

**Interfaces:**
- Consumes: `Bots.disconnect` (Task 2).
- Produces (wire):
  - `POST /settings/slack/:agentId/bot/disconnect`, no body read → whatever `bots.disconnect` answers; before it, the existing 401 / same-404 / 403 / 409 `personal-agent` from `manages(a)`. Route stage `bot-disconnect`. Body cap `ADMIN_BODY_MAX_BYTES`, CSRF kept.
  - `AgentSlackStatus` `no-workspace` becomes `{ state: 'no-workspace'; canManage: boolean; bot: AgentSlackBot }`: `manage.ok` for a team agent, `false` on the personal-agent branch (`:228`).
  - `createAgentSlackRoutes(d, bots: Pick<Bots, 'request' | 'installUrl' | 'cancel' | 'disconnect' | 'status'>)`.

- [ ] **Step 1: Write the failing tests.**
  - Add `'/bot/disconnect'` to `Suffix` and `EVERY_ROUTE` (POST, no body): the existing 401 / 500 / same-404 / 403 / 409 `personal-agent` / body-before-rights loops now cover it.
  - Extend `stubBots` with `disconnect` (answer default `{ status: 200, body: { appDeleted: true } }`).
  - **R1** `disconnect reaches the domain for a team admin of the agent, as the person asking, and never reads a body` — body `'garbage'` → `{ status: 200, body: { appDeleted: true } }`; `w.bots.calls` equals `[{ method: 'disconnect', input: { ctxUserId: ADA, actorUserId: ADA, agentId: SUPPORT.id } }]`.
  - Extend `answers exactly what the domain answers` (`:1049`) with `w.bots.answers.disconnect = { status: 409, body: { error: 'no-bot' } }`.
  - Extend `a fault in the domain is a 500` (`:1084`) to `/bot/disconnect`, stage `bot-disconnect`.
  - Extend `serves the section under /settings/slack/:agentId…` (`:445`) with `POST /settings/slack/:agentId/bot/disconnect`, `maxBodyBytes: ADMIN_BODY_MAX_BYTES`, no `bypassCsrf`.
  - **S1** `no-workspace says whether the person reading manages the agent: a team admin true, a member false, a personal agent false`; update the exact no-workspace bodies at `:719`, `:1115`, `:1117`, `:1134`.
  - **S2** `no-workspace with a live bot: a team admin reads canManage true, so the bot can still be disconnected after Slack is` (Review Focus 2).
  - `plugin.test.ts`: add `{ method: 'POST', path: '/settings/slack/:agentId/bot/disconnect', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES }` after `/bot/cancel`; `:2183` gains `canManage: true`.
  - Canary: add `'/bot/disconnect'` to `for (const suffix of ['/bot', '/bot/install-url', '/bot/cancel'])`; add TASK-1172 to that test's title.
- [ ] **Step 2: Run** `… vitest run src/__tests__/agent-routes.test.ts` — FAIL.
- [ ] **Step 3: Implement** the route (`disconnectBot(a)`: `manages(a)` → `refused`, else `bots.disconnect({ ctx: a.ctx, actorUserId: a.userId, agentId: a.agentId })`), the `canManage` field, the Pick, and the header's route list.
- [ ] **Step 4: Run** `agent-routes.test.ts`, then (Docker) `plugin.test.ts` and `pnpm --filter @ax/preset-memory exec vitest run src/__tests__/canary.test.ts` — PASS.
- [ ] **Step 5: security-checklist walk** (a new signed-in route that deletes a Slack app; rights before the domain, and again inside the lock) — PR note row in the shard.
- [ ] **Step 6: Commit** — `feat(channel-slack): a team admin can disconnect the agent's own bot from its settings (TASK-1172)`

---

### Task 5: Admin › Slack routes `GET /admin/slack/bots` and `POST /admin/slack/bots/disconnect` `[tier: sensitive]` — security-checklist

**Files:**
- Create: `packages/channel-slack/src/admin-bot-routes.ts`
- Create: `packages/channel-slack/src/__tests__/admin-bot-routes.test.ts`
- Modify: `packages/channel-slack/src/plugin.ts` (mount right after `...createAdminRoutes({…})` at `:382-392`; header `:73-91`), `packages/channel-slack/src/admin-routes.ts` (one header line, `:45-52`: "Its team bots' list and Disconnect: admin-bot-routes.ts")
- Modify (pins): `plugin.test.ts` route shapes; the memory canary

**Interfaces:**
- Consumes: `Bots.listForAdmin` (Task 3), `Bots.disconnectForAdmin` (Task 2), `checkAdmin` (`admin-auth.ts:65`), `INSTALL_ID_RE` (`ingress.ts:39`), `bodyObject` (`slack-apps.ts:82`), `logCode`.
- Produces:
  ```ts
  export const ADMIN_BOTS_PATH = '/admin/slack/bots';
  export const ADMIN_BOT_DISCONNECT_PATH = '/admin/slack/bots/disconnect';
  export interface AdminBotRoutesDeps {
    bus: HookBus;
    bots: Pick<Bots, 'listForAdmin' | 'disconnectForAdmin'>;
    logger: Logger;
  }
  export function createAdminBotRoutes(d: AdminBotRoutesDeps): RouteSpec[];
  ```
  Every route: `checkAdmin` first (401 `unauthenticated`, 403 `forbidden`, 500 `internal`), with a system gate ctx as `admin-routes.ts:309-314` builds it. GET → `200 { bots: await d.bots.listForAdmin({ ctx }) }`, `ctx = makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: actor.id, logger })`. POST (`maxBodyBytes: ADMIN_BODY_MAX_BYTES`, CSRF kept): 413 `body-too-large` past the cap (backstop); 400 `invalid-body` unless a JSON object whose only key is `installId`; 400 `invalid-install-id` unless a string matching `INSTALL_ID_RE`; then exactly what `disconnectForAdmin` answers. A throw → 500 `{ error: 'internal' }`, logged `slack_admin_failed { stage: 'bots' | 'bot-disconnect', code }` at error. **The module takes no lock** (the domain does).

- [ ] **Step 1: Write the failing tests** (`admin-bot-routes.test.ts`: a `HookBus` with `auth:require-user` reading `x-test-user`, as `admin-routes.test.ts:231-239` does, and a recording stub for the two domain methods):
  - **A1** `both routes: 401 signed out, 403 for someone who isn't an admin, 500 logged by code when auth fails; the domain is never asked`.
  - **A2** `GET lists what the domain lists, asked as the admin` — `{ status: 200, body: { bots: [<one AdminSlackBot>] } }`; the stub saw `ctx.userId === ADA`.
  - **A3** `POST takes { installId } and nothing else: an unknown key, a missing, non-string or malformed id is a 400 before the domain; past the cap a 413` — bodies `{ installId: 'x', extra: 1 }` → `invalid-body`; `{}`, `{ installId: 42 }`, `{ installId: 'short' }`, `{ installId: 'A'.repeat(21) + '/' }` → `invalid-install-id`; `'[]'` → `invalid-body`; stub never called.
  - **A4** `POST answers what the domain answers: 200 { appDeleted }, 409 no-bot` — and the stub saw `{ installId }`.
  - **A5** `a fault in the domain is a 500, logged with the route's stage and a code, never its message` — `{ level: 'error', msg: 'slack_admin_failed', fields: { stage: 'bot-disconnect', code: 'ECONNRESET' } }`.
  - **A6** `the routes keep the CSRF check; the POST caps its body at ADMIN_BODY_MAX_BYTES` — no `bypassCsrf` on either spec.
  - `plugin.test.ts` route shapes: after `/admin/slack/oauth/callback`, add `{ method: 'GET', path: '/admin/slack/bots', bypassCsrf: false, maxBodyBytes: undefined }` and `{ method: 'POST', path: '/admin/slack/bots/disconnect', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES }`.
  - Canary: `GET /admin/slack/bots` → `{ status: 200, json: { bots: [] } }` as `CANARY_ADMIN`, 403 as `ALICE`, 401 signed out; `POST /admin/slack/bots/disconnect` without the CSRF header → 403; with it, `{ installId: 'A'.repeat(22) }` → `{ status: 409, json: { error: 'no-bot' } }` (an unmounted POST would be the router's 405).
- [ ] **Step 2: Run** `… vitest run src/__tests__/admin-bot-routes.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** the module, mount it in `plugin.ts` with `{ bus, bots, logger }`, and update both headers.
- [ ] **Step 4: Run** the new file, then (Docker) `plugin.test.ts` and the canary — PASS. `pnpm --filter @ax/channel-slack build` passes.
- [ ] **Step 5: security-checklist walk** (two new admin routes: gate, CSRF, body validation, what the answer carries) — PR note row in the shard.
- [ ] **Step 6: Commit** — `feat(channel-slack): Admin › Slack lists team bots and can disconnect one (TASK-1172)`

---

### Task 6: Through the wiring, on Postgres — the acceptance path `[tier: integration]`

**Files:**
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts` (next to the TASK-1167 composition test at `:2222`)

**Interfaces:**
- Consumes: everything above, mounted by `plugin.ts`. Note `plugin.test.ts`'s fakes: Ada (`ADMIN.id`) is the only team admin of `TEAM_AGENT`; `auth:get-user` knows only Ada, so Grace reads as no account.

- [ ] **Step 1: Write the tests.** A `fetchImpl` wrapping `fakeSlackFetch()` that also answers `tooling.tokens.rotate` with `{ ok: true, token: fakeConfigAccessToken('DISCONNECTACCESS<n>'), refresh_token: fakeConfigRefreshToken('DISCONNECTREFRESH<n>'), exp: 4_102_444_800 }` (don't change the shared helper). Seed as the TASK-1167 composition test does: `insertActiveInstall()`, the shared signing secret and bot token, Ada's token; Grace's live bot `BOT_INSTALL_ID` for `TEAM_AGENT` with its three secrets and Grace's token; a shared binding `(INSTALL_ID, SUPPORT_CH, TEAM_AGENT, connectedBy ADMIN.id)` and a bot binding `(BOT_INSTALL_ID, SUPPORT_CH, TEAM_AGENT, connectedBy GRACE)`.
  - **C1** `after a team admin disconnects the agent's own bot, a mention of the shared bot in the agent's channel runs a turn again; the bot's app, row, binding, secrets and its approver's token go, the shared binding stays (TASK-1172)`:
    1. A shared-bot mention from `ADA_SLACK` (`mentionBody`, signed) → no turn (`s.invokes` empty), `slack_event_ignored { installId: INSTALL_ID, reason: 'own-bot' }`.
    2. `POST /settings/slack/agt_support/bot/disconnect` as `ADMIN.id` → `{ status: 200, body: { appDeleted: true } }`; Slack saw `tooling.tokens.rotate` (Grace's token) then `apps.manifest.delete` with `app_id: BOT_APP_ID`.
    3. `installCount() === 1`; `channels.listAll(INSTALL_ID)` is `[SUPPORT_CH]`, `channels.listAll(BOT_INSTALL_ID)` is `[]`; no `secretRef(BOT_INSTALL_ID, …)` and no `configTokenRef(GRACE)` in `s.vault`; Ada's token and the shared secrets still there.
    4. A second mention (new event id and ts) → `s.invokesReturned` reaches 1, its ctx `conversationId: conv:slack:${INSTALL_ID}:${SUPPORT_CH}:<ts>`, `userId: ADMIN.id`.
  - **C2** `Admin › Slack lists the bot with its approver, marks one auth no longer has, and an AX admin disconnects it through the wiring (TASK-1172)` — `GET /admin/slack/bots` as `ADMIN.id` → `bots` equals `[{ installId: BOT_INSTALL_ID, botName: 'support-helper', handle: null, approver: null, state: 'live', addedAt: expect.any(String) }]`; as `usr_bob` → 403; `POST /admin/slack/bots/disconnect { installId: BOT_INSTALL_ID }` as `ADMIN.id` → `{ appDeleted: true }` (the harness calls handlers directly: CSRF is the canary's job, Task 5); GET again → `{ bots: [] }`.
- [ ] **Step 2: Run** (Docker) `… vitest run src/__tests__/plugin.test.ts -t "TASK-1172"` — PASS. If C1 step 4 fails, the shared step-aside or the binding scope regressed: debug, don't loosen the test.
- [ ] **Step 3: Commit** — `test(channel-slack): after a bot is disconnected the shared bot answers in the agent's channels again (TASK-1172)`

---

### Task 7: channel-web wire client for the agent route `[tier: mechanical]`

**Files:**
- Modify: `packages/channel-web/src/lib/agent-slack.ts` (header `:7-15`, `AgentSlackStatus`, `parseStatus` `:163-199`, `agentSlackBotStale` `:472-478`)
- Test: `packages/channel-web/src/lib/__tests__/agent-slack.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Take the agent's own bot away. `appDeleted` false: its Slack app may still be on Slack. */
  export async function disconnectSlackBot(agentId: string): Promise<{ appDeleted: boolean }>;
  // AgentSlackStatus: { state: 'no-workspace'; canManage: boolean; bot: AgentSlackBot }
  ```
  `parseStatus` no-workspace: a boolean `canManage` is kept; a missing one (an older host) reads as `bot.state === 'pending'` (today's inference); any other type is `bad-response`. `agentSlackBotStale` also answers true for 409 `no-bot`.

- [ ] **Step 1: Write the failing tests.**
  - `disconnectSlackBot POSTs /settings/slack/:agentId/bot/disconnect with the write headers and an empty JSON body, and reads appDeleted`.
  - `disconnectSlackBot: an answer without a boolean appDeleted is a bad-response; a refusal is an AgentSlackError with its code`.
  - `no-workspace carries canManage; an older host without it reads as before (true only for a pending bot); a non-boolean is a bad-response`; update the existing no-workspace expectations (`:84-85`, `:120-121`, `:141`).
  - `agentSlackBotStale: 409 no-bot reads the status again`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/agent-slack.test.ts` — FAIL.
- [ ] **Step 3: Implement**, following `cancelSlackBot` (`:341-346`). Then add `canManage` to every `no-workspace` fixture in `components/workspace/__tests__/AgentSlack.test.tsx` with today's inferred value (`true` for a pending bot, else `false`), so the type-checked tests still build; `AgentSlack.tsx` itself changes in Task 8.
- [ ] **Step 4: Run** the lib test and `AgentSlack.test.tsx` — PASS; `pnpm --filter @ax/channel-web build` (it type-checks tests) passes.
- [ ] **Step 5: Commit** — `feat(channel-web): wire client for disconnecting an agent's own Slack bot (TASK-1172)`

---

### Task 8: Agent settings UI — Disconnect a live bot `[tier: integration]`

**Files:**
- Modify: `packages/channel-web/src/components/workspace/AgentSlackBot.tsx` (header `:1-25`, `BotCancelled` `:53-57`, `AgentSlackBotProps`, `AppLeftOverNote` `:110-127`, the dispatcher `:129-158`, `Live` `:351-368`)
- Modify: `packages/channel-web/src/components/workspace/AgentSlack.tsx` (`:151-160` no-workspace, `:325-332` ready)
- Test: `.../workspace/__tests__/AgentSlackBot.test.tsx`, `.../workspace/__tests__/AgentSlack.test.tsx`

**Interfaces:**
- Consumes: `disconnectSlackBot`, `agentSlackBotStale`, `agentSlackBotErrorCopy` (Task 7).
- Produces: `BotCancelled` gains `how: 'cancelled' | 'disconnected'` (Cancel passes `'cancelled'`); `AgentSlackBotProps` gains `sharedChannels?: boolean` (default `false`): "the agent has channels on the shared bot, which answers there again once this bot goes". `ReadySection` passes `sharedChannels={channels.length > 0}`; the no-workspace view passes `canManage={state.canManage}` and no `sharedChannels`.

**Pinned copy** (`who` = `@${handle}` when there is a handle, else `botName`):
- Live view, managers only, after "Set up by …": `<Button variant="outline">Disconnect bot</Button>`.
- Dialog (`Dialog`, as `AgentSlack.tsx:546-615`): title `` `Disconnect ${who}?` ``; description `` `${botName} leaves every Slack channel it's in, and ${handle !== null ? `@${handle}` : 'mentioning it'} stops working. We'll delete its Slack app.` `` followed, when `sharedChannels`, by `` ` The shared bot answers for ${agentName} again in the channels it was connected to before.` ``; buttons `Keep it` (outline) and `Disconnect` (destructive, busy `Disconnecting…`); a failure shows `agentSlackBotErrorCopy(err).message` in a destructive `Alert` inside the dialog.
- `AppLeftOverNote` first sentence when `how === 'disconnected'`: `We disconnected the bot, but we couldn't confirm its Slack app was deleted, so it may still be on Slack.` (the `'cancelled'` sentence and the rest of the note unchanged).
- On success: `onCancelled({ how: 'disconnected', appDeleted, approverIsViewer: false, approver: bot.approver })`, then `onChanged()`. A stale refusal (`agentSlackBotStale`) closes the dialog and calls `onChanged()`.

- [ ] **Step 1: Write the failing tests.**
  - AgentSlackBot (`describe('live')`): `a manager sees Disconnect bot; a member doesn't` · `Disconnect bot asks first: the dialog says the bot leaves every channel, @handle stops working, its Slack app is deleted, and the shared bot answers again; Keep it sends nothing` (render with `sharedChannels`) · `with no handle the dialog names the bot and says mentioning it stops working; without shared channels it promises nothing about the shared bot` · `confirming disconnects, hands up { how: 'disconnected', appDeleted, approverIsViewer: false, approver } and reads the status again` · `no-bot (someone got there first) closes the dialog and reads the status again; a failure says so in the dialog and keeps the bot` · `a disconnect whose Slack app couldn't be deleted says so in its own words` (`AppLeftOverNote` with `how: 'disconnected'`); extend `never writes the product name in a sentence` (`:440`) to the open dialog; existing cancel tests now expect `how: 'cancelled'`.
  - AgentSlack: **A1** `ready: a disconnect whose Slack app couldn't be deleted leaves the note above the request form once the status is read again` (Review Focus 5) · **A2** `no workspace: a manager can disconnect a live bot (canManage from the server); a member sees no Disconnect bot` (Review Focus 2; the fixtures already carry `canManage` from Task 7).
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/AgentSlackBot.test.tsx src/components/workspace/__tests__/AgentSlack.test.tsx` — FAIL.
- [ ] **Step 3: Implement** (invoke the `shadcn` skill first). Update `AgentSlackBot.tsx`'s header (`live`: a manager can disconnect it).
- [ ] **Step 4: Run** both files — PASS; `pnpm --filter @ax/channel-web build` passes.
- [ ] **Step 5: Commit** — `feat(channel-web): disconnect a team agent's own Slack bot from its settings (TASK-1172)`

---

### Task 9: Admin › Slack — the "Team agents' own bots" card `[tier: integration]`

**Files:**
- Create: `packages/channel-web/src/lib/slack-bots-admin.ts`, `packages/channel-web/src/lib/__tests__/slack-bots-admin.test.ts`
- Create: `packages/channel-web/src/components/admin/SlackBotsCard.tsx`, `packages/channel-web/src/components/admin/__tests__/SlackBotsCard.test.tsx`
- Modify: `packages/channel-web/src/components/admin/SlackTab.tsx` (header `:9-21`; mount in the root `div`, after the `StatusView` block, outside the `load` switch)
- Modify (tests that render SlackTab): `components/admin/__tests__/SlackTab.test.tsx` (`vi.mock('@/lib/slack-bots-admin', …)`, default `{ state: 'ready', bots: [] }`), `src/__tests__/slack-install-return-app.test.tsx` (same mock), `components/admin/__tests__/AdminShellHeadings.test.tsx` (stub `/\/admin\/slack\/bots(\?|$)/` → `{ bots: [] }`)

**Interfaces:**
- Produces (`lib/slack-bots-admin.ts`; errors are `SlackAdminError` from `lib/slack-admin.ts`, requests through `httpFetch`, POSTs with `{ 'content-type': 'application/json', 'x-requested-with': 'ax-admin' }`):
  ```ts
  export interface AdminSlackBot { installId: string; botName: string; handle: string | null; approver: string | null; state: 'pending' | 'live'; addedAt: string }
  export type SlackBotsRead = { state: 'ready'; bots: AdminSlackBot[] } | { state: 'unavailable' };
  /** 404, or a page that isn't JSON: unavailable. Not ok: throws. A malformed list or item: SlackAdminError 'bad-response' (never "no bots"). */
  export async function fetchSlackBots(): Promise<SlackBotsRead>;
  export async function disconnectTeamBot(installId: string): Promise<{ appDeleted: boolean }>;
  /** 409 no-bot: someone got there first; read the list again. */
  export function teamBotGone(err: unknown): boolean;
  ```
  An item is kept only with `installId` matching `/^[A-Za-z0-9_-]{22}$/`, `botName` a 1-80 character string, `handle` and `approver` string or null, `state` `pending`/`live`, `addedAt` a string; extra fields are dropped.
- Produces (`SlackBotsCard.tsx`): `export function SlackBotsCard(p: { sharedConnected: boolean; onAppsChanged: () => void })`. SlackTab passes `sharedConnected={load.kind === 'ready' && load.status.state === 'connected'}` and `onAppsChanged={() => void read()}`.

**Pinned copy:**
- `Card variant="settings"`; `CardTitle role="heading" aria-level={2}`: `Team agents' own bots`; `CardDescription`: `A team admin can give a team agent its own bot. Only the person who set one up can change its Slack app.`
- `Table` with sr-only caption `Team agents' own bots`; headers `Bot`, `Set up by`, `Added`, `Status`, and an sr-only `Actions`.
- Bot cell: `botName`, with a muted `@{handle}` line when there is one. Set up by: the approver, or `<Badge variant="warning">A former member</Badge>` when `null`. Added: `toLocaleDateString(undefined, { dateStyle: 'medium' })` (as SlackTab's `shortDate`). Status: `<Badge variant="secondary">Live</Badge>` or `<Badge variant="warning">Not finished</Badge>`. Action: `<Button variant="outline" size="sm" aria-label={`Disconnect ${botName}`}>Disconnect</Button>`.
- When any approver is `null`, one muted line under the table: `When the person who set up a bot has left, nobody can change its Slack app any more. Disconnect it, and a team admin can set up a new one.`
- Nothing at all when the list is empty or `unavailable`. A failed read: destructive `Alert` `We couldn't load the team agents' own bots.` with a `Try again` button.
- Dialog, live: title `` `Disconnect ${botName}?` ``; body `` `${botName} leaves every Slack channel it's in, and mentioning it stops working. We'll delete its Slack app.` `` plus, when `sharedConnected`, `` ` The shared bot answers for its agent again in the channels it was connected to before.` ``; `Keep it` / `Disconnect` (destructive, busy `Disconnecting…`).
- Dialog, pending: title `` `Stop setting up ${botName}?` ``; body `We'll delete the Slack app that was started for it. A team admin can ask for a bot again any time.`; `Keep going` / `Stop setting up` (busy `Stopping…`).
- A failure in the dialog: `Something went wrong. Try again in a minute.` A `teamBotGone` refusal closes the dialog and re-reads the list.
- After a disconnect: the card re-reads its list and calls `onAppsChanged()`. When `appDeleted` is false, an `Alert` in the card (kept across its own re-read): `` `${botName} is disconnected, but we couldn't confirm its Slack app was deleted. It's listed above, with the Slack apps we couldn't delete.` ``

- [ ] **Step 1: Write the failing tests.**
  - lib: `fetchSlackBots GETs /admin/slack/bots with the session cookie and keeps only the six fields` · `fetchSlackBots: a 404 or a page that isn't JSON is unavailable; a missing list or a malformed item is a bad-response` · `disconnectTeamBot POSTs { installId } with the write headers and reads appDeleted; a refusal is a SlackAdminError with its code` · `teamBotGone is true only for 409 no-bot`.
  - Card: `lists each bot: its name, @handle, who set it up, when it was added, and whether it's live or not finished` · `an approver auth no longer has is marked "A former member", with the line saying what that means` · `no bots, or a server without the route: nothing at all` · `a failed read says so, with Try again` · `Disconnect asks first, in words for a live bot or an unfinished one; Keep it sends nothing` · `the shared-bot sentence shows only while Slack is connected` · `confirming disconnects by install id, reads the list again and tells the tab its apps changed` · `a disconnect whose Slack app couldn't be deleted says so in the card` · `no-bot (someone got there first) closes the dialog and reads the list again; a failure says so in the dialog` · `never writes the product name in a sentence`.
  - SlackTab: **T1** `the team bots card sits below the status, outlives the status re-read its disconnect asks for, and keeps its note` (Review Focus 5).
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/slack-bots-admin.test.ts src/components/admin/__tests__/SlackBotsCard.test.tsx src/components/admin/__tests__/SlackTab.test.tsx` — FAIL.
- [ ] **Step 3: Implement** (invoke the `shadcn` skill first): the module, the card, the SlackTab mount and header, the three test-file stubs.
- [ ] **Step 4: Run** those files plus `AdminShellHeadings.test.tsx` and `slack-install-return-app.test.tsx` — PASS; `pnpm --filter @ax/channel-web build` passes.
- [ ] **Step 5: Commit** — `feat(channel-web): Admin › Slack lists team agents' own bots and can disconnect one (TASK-1172)`

---

### Task 10: Docs, the stale lines, the changeset `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`
- Modify: `packages/channel-slack/src/store.ts:55-60`
- Create: `.changeset/slack-bot-disconnect.md`

- [ ] **Step 1: Design doc.** §4 Lifecycle `:461` (Disconnect) and `:470-471`: say where — "a team admin from agent settings, an AX admin from Admin › Slack (TASK-1172)", and that Admin › Slack's list shows each bot's approver and marks one who has left. As built `:503-505`: "A live bot isn't cancelled that way, because its channels would go with it" → "…; it's disconnected instead (TASK-1172)". Add an **As built (TASK-1172)** paragraph: Disconnect runs the same removal as agent delete under the one app lock (a team admin's is re-checked inside it); it works with no shared install; the shared bot answers again in the agent's old shared channels, untouched all along; Admin › Slack's list (bot, handle, approver or "A former member", added, status) has no agent or team column yet (shard row 6). §9 `:1083-1086`: TASK-1172 did Disconnect and the admin list; asking an admin, rename, avatar change and Replace remain.
- [ ] **Step 2: `store.ts:55-60`.** Keep the shared-install sentence; add: a bot's row keeps the time it was asked for, because one person's token serves all their apps (TASK-1175) and has no date of its own: a Replace or a paste through another of their apps changes the token without moving this date.
- [ ] **Step 3: Changeset** (patch for `@ax/channel-slack` and `@ax/channel-web`), in the CLAUDE.md voice: a team admin can now disconnect the agent's own Slack bot from its settings, and Admin › Slack lists every team bot with whoever set it up (and flags one who has left), with a Disconnect of its own; the shared bot answers again where it used to.
- [ ] **Step 4: Run** `pnpm test:scripts` (doc and memory guards) — PASS.
- [ ] **Step 5: Commit** — `docs: TASK-1172 as built; a bot row's configTokenAddedAt; changeset`

---

## Security checklist

Required for **Tasks 2, 3, 4 and 5**: one `security-checklist` walk each, recorded as rows in this card's decisions shard and gathered into the PR's security note. Not required for Task 1 (reuses `cleanLabel`, no new reach), Task 6 (tests), Tasks 7-9 (they render server-cleaned text as React text and build no link or HTML from server data), or Task 10 (docs).

Residuals to state in the note (planner's view; the walks add their own):
- An AX admin can now remove any team's bot (the card's ask), logged `slack_bot_disconnected { by: 'admin' }`.
- Admins see an approver's email when auth has no display name for them, as `connectedBy` already shows.
- An AX admin demoted while a Disconnect waits on the lock still runs it (as the shared Disconnect); a team admin's is re-checked.
- A Disconnect queued behind a slow leftover pass may outlive the browser's request; the next read shows the truth.
- A bot turn already running when its bot is disconnected may fail to post its reply (the deleted app's bot token stops working); logged by the existing reply path.

---

## Self-review

- **Spec coverage:** Disconnect for team admins (Tasks 2, 4, 8) and AX admins (Tasks 2, 5, 9); delete with the approver's stored token, install, secrets and bindings removed, leftover on refusal (Task 2 D1-D3); the admin list with approver and former-member mark (Tasks 3, 5, 9); 403 / same-404 (Task 4's loops, Task 5's A1); the shared bot answers again (Task 6 C1); unit tests for routes, list and both UIs (Tasks 2-9). Cut, with reasons: agent and team columns, "token added" per bot (shard rows 6-7).
- **Types:** `disconnect` / `disconnectForAdmin` / `listForAdmin` / `AdminSlackBot` (Tasks 2-3) are used under those names in Tasks 4, 5 and 6; channel-web's `AdminSlackBot` mirrors the server's six fields; `BotReply`'s `no-bot` code is the one Tasks 7 and 9 treat as stale.
- **Review Focus:** each of the five lines has its named test (D10; D1b/S2/A2; D9; D9; A1/T1).
