# TASK-1167: A team agent's own Slack bot (self-approved path) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS (revised 2026-11-20, against main at `9fb9644c9`): buildable.** The first version stopped on two questions. Vinay answered both on 2026-11-20, and TASK-1175 (#1207) shipped the second answer. Every file and line reference below was re-read on this branch after it merged `origin/main`.

**Goal:** A team admin gives a team agent its own Slack bot. If AX already holds their configuration token they paste nothing; otherwise they paste one. Once they click Allow in Slack, @mentions of that bot in public channels it was invited to run turns for the agent. The shared bot stops answering for that agent, and deleting the agent deletes the bot's Slack app.

**Architecture:** A dedicated bot is a second kind of row in `channel_slack_v1_installs` (`kind = 'bot'`, with its `agent_id` and its requester). Because of that, the per-install events and interactions routes, the signing-secret lookup and the OAuth state work for it unchanged. Its three per-install secrets live under `slack:<installId>:<name>`. Its configuration token is its approver's one per-person token (TASK-1175), and a bot never has a token of its own.

The Slack-app steps that Admin › Slack keeps as closures today move into one shared module (`slack-apps.ts`) first, with no change in behaviour. A new `bots.ts` uses them to request, continue, cancel, show and remove a bot, all under one app lock. A new signed-in OAuth callback activates the bot only for the person who started it.

The router gives a bot install its own mention path: a channel check, then a binding written on the first mention. An outsider's turn there runs as the bot's requester, but only while that requester is still a team admin. The shared bot stays quiet for an agent whose own bot is live. channel-web gets an "Its own Slack bot" section, built from pieces extracted out of Admin › Slack.

**Tech Stack:** TypeScript, Kysely/Postgres (additive migration), the hook bus (`credentials:*`, `agents:*`, `auth:*`, all already in channel-slack's `calls`), React + shadcn (channel-web), vitest + Testcontainers.

**Spec:**
- Card TASK-1167. Its "Decisions update (Vinay, 2026-11-20)" overrides Decision 1 and the card's storage text.
- The design, `docs/plans/2026-11-09-channel-slack-design.md` §4, §7, §8 Q5/Q6 and §9 phase 2.
- TASK-1175's learnings: `.claude/memory/decisions/2026-11-20-TASK-1175.md`, rows 22–23.
- This card's shard, `.claude/memory/decisions/2026-11-19-TASK-1167.md`, which holds every call below with its alternatives. Read it before Task 2. The 2026-11-20 rows supersede the two BLOCKED rows.

---

## The two answers, as built here

### Q1 — Who an outsider's turn on a dedicated bot runs as

**Vinay, 2026-11-20:** the bot's **requester**, the team admin who asked for it, recorded on the bot. If the requester is no longer an admin of that team (or no longer exists), outsiders are refused politely, members' turns still work, and the agent's Slack status shows the bot "needs a team admin to claim it". The claim action is TASK-1173.

How it's built:

- **Where the run-as lives.** It is `requested_by_user_id` on the bot row. The router writes each channel's binding on its first mention with `connected_by_user_id = requested_by_user_id`. That column already means "whom this channel's outsiders run as" (`channel-store.ts:10-15`). So the existing outsider path runs unchanged: it builds the `…:external` conversation, runs the job-time `reconnected` check, and passes `recordThread`'s `runAs` check. **TASK-1173's claim must move the row's requester and every binding of that bot install together**, or outsiders keep running as the old requester (learning, below).
- **The stricter check uses existing hooks only.** For a shared install, the router asks whether the connector can still *use* the agent (`agentAccess`, `channels.ts:172-179`). For a bot install it asks whether the requester is still a *team admin* of the agent's team. The new `teamAdminAccess` asks `agents:resolve` and then `agents:can-set-shared-credential` with `actor: { userId, isAdmin: false }`. That's the same pair `checkRights(…, 'manage')` asks (`channels.ts:187-216`), and the agents plugin answers true only for team role `admin` (`agents/src/plugin.ts:1227-1244`). A deleted user is refused by `agents:resolve`. **There is no new hook, so no boundary review and no preset pin change.**
- **What the outsider sees.** A refusal reaches only an admitted outsider, as the private line `COPY.botUnavailable`. Members still run attended, as themselves.
- **The status.** A live bot carries `needsClaim`, computed by the same `teamAdminAccess`. It is display-only; the router enforces the rule on every mention.

### Q2 — Whose configuration token a bot uses

**Vinay, 2026-11-20, shipped by TASK-1175:** one rotating token per person, `slack:person:<userId>:config-refresh-token` (`secrets.ts:106-110`), shared by every app that person made through AX. So:

- **No per-bot configuration-token storage.** `SecretStore.put` can't even take the name any more (`secrets.ts:128-132`). A bot's per-install secrets are the bot token, signing secret and client secret.
- **A bot's approver is the person on its row** (`connected_by_user_id`). In this card that's always the requester. Every configuration-token use for a bot goes through `secrets.getConfigToken` / `putConfigToken` for that person, under the app lock.
- **An approver with a stored token pastes nothing.** The request uses it: read it, rotate it, save the successor first, then use the minted access token.
  - Only someone with no stored token pastes, or someone whose stored token Slack now refuses.
  - The agent's Slack status tells a managing viewer `configTokenStored: boolean` about *their own* token. It's never the token itself.
- **"Dead" means one thing.** The stored token's rotate is refused with a `REFRESH_TOKEN_REFUSED` code: `invalid_refresh_token`, or one of `TOKEN_ERRORS` (`admin-routes.ts:224-236`).
  - The request then answers `502 slack-config-token` and makes nothing. The stored token is left as it is, because other apps still name the person.
  - The form then shows the token field. The paste overwrites the person's slot, which fixes every app of theirs at once.
  - A rotate that simply fails (timeout, 5xx) is `slack-error`, "try again".
- **`personHasApps` counts bot rows.** No code change is needed: it reads the installs table with no kind filter (`store.ts:246-253`). Tasks 2 and 6 pin it with tests at the store, fake and route level, so a later "scope everything to shared" edit can't quietly break it.
- **Every new path that ends a bot follows Disconnect's sequence** (`admin-routes.ts:1201-1222`), under the app lock. That covers cancel, agent delete and the request's own undo:
  1. Delete the app with the approver's token (read it, rotate it, save the successor, delete).
  2. `remove(id, { appLeft })`, then `secrets.removeAll`.
  3. Release the approver's token through the same `releaseConfigToken`, which drops it only when nothing names them.

---

## What the brief got wrong (checked against main at `9fb9644c9`; details in the shard)

1. **"`removeAll()` scoped to `kind = 'shared'`" would strand dead rows.** Its only caller is the bootstrap reset (`plugin.ts:537-597`). The reset wipes every credential (`slack:*` included) and TRUNCATEs every agent without firing `agents:deleted`. So `removeAll()` keeps removing every kind, and the reset line gains `kind`. The reset's existing per-person sweep (`plugin.ts:568-594`) then releases bot approvers' tokens too. Disconnect is scoped through `current()` alone, which gives Decision 4.
2. **"Under that agent's lock": no per-agent lock exists.** Name uniqueness spans every bot and the shared bot, and one person's token serves all their apps. So every Slack-app write and every token use shares the one admin mutex, today created inline at `plugin.ts:356`. **It isn't re-entrant** (`mutex.ts`): a function called under it must never take it again.
3. **"Same peek-then-consume state as `OAUTH_CALLBACK_PATH`": today's peek and consume match any install's state** (`store.ts:290-333`). Both callbacks must be scoped to their own kind.
4. **True as the brief says:** `events.ts`/`ingress.ts` pick the signing secret by id, and drop a body whose `api_app_id` doesn't match (`ingress.ts:104-111`, `events.ts:266`; `interactions.ts:161-162` the same). No change.
5. **`slackUrls()` hard-codes the admin callback, and `buildInstallUrl()` hard-codes `BOT_SCOPES`** (`manifest.ts:64-72`, `:120-128`). `manifest.test.ts` pins `slackUrls()` to four keys. So the bot gets its own `botUrls()`, and `buildInstallUrl` gets a `scopes` argument.
6. **"Move the shared helpers out of `admin-routes.ts`" is still to do.** TASK-1175 moved only `releaseConfigToken` and `moveConfigTokens` into `config-tokens.ts`. Every Slack-app step is still a closure inside `createAdminRoutes`: `release :510`, `undoConnect :532`, `undoCreate :578`, `mintForPass :612`, `deleteLeftoverApps :665`, `saveRotatedToken :853`, `deleteSlackApp :874`. The old plan's note that "`undoConnect` forgets an app whose delete fails" is **stale**: TASK-1175 fixed it (`:516-568`). The bot request now reuses `undoConnect` as it is.
7. **The card has no way to cancel a pending request.** One failed or cancelled Allow would block the agent's bot for good, since there's one bot per agent, pending included. Task 7 adds Cancel.
8. **`?slack=` is taken.** App.tsx reads it on any path and opens Admin › Slack for admins (`App.tsx:136-150`, `lib/slack-install-return.ts`). The bot callback returns with `?slack-bot=`.
9. **`ConnectForm`'s refresh-token field and guide link are private to `SlackTab.tsx`** (`:86`, `:115-126`, `:308-344`). The token and name error copy is private to `lib/slack-admin.ts` (`:297-332`). Task 11 extracts them before reuse.
10. **Decision 3's choice (self vs. "Ask an AX admin") can't ship yet.** Its second option has no path until a later card. This card shows the self path only, with no choice control (invariant 3).
11. **The card's storage text ("each bot has its own … rotated configuration refresh token") and its route body (`{ botName, refreshToken, icon? }`, token required) predate TASK-1175.** A bot keeps three per-install secrets. `refreshToken` is optional, and the status says whether the viewer has a stored token.
12. **The card's acceptance says "external as the requester for an outsider".** The 2026-11-20 decision adds: only while the requester is still a team admin.
13. **New with this card: the shared Disconnect notice always says "whoever generated the token clicks Revoke"** (`SlackTab.tsx:164-175`). With bots, that token is kept, because a bot still names the person, and revoking it would leave their bots unmanageable: no rename, and an agent delete puts the app on the leftover list. TASK-1175 handed this to phase 2 (its shard, row 23, and round-2 nit 6). Task 6 makes the advice depend on whether the token was kept.

## Global Constraints

- Merge `origin/main` before Task 1 and again before the PR (Slack cards land daily).
- Ship ONE PR from this branch, several commits. The card's "stack" existed only to avoid a half-wired window.
- No new hook, IPC action or manifest `calls`/`optionalCalls` entry. `teamAdminAccess` uses `agents:resolve` and `agents:can-set-shared-credential`, both already in `calls` (`plugin.ts:225-240`). So there's no boundary review and no change to `presets/k8s/src/__tests__/preset.test.ts`.
- channel-web mirrors wire shapes and never imports `@ax/channel-slack` (invariant 2).
- No string literal starting with `slack:` anywhere outside `packages/channel-slack/` (`scripts/__tests__/channel-slack-boundaries.test.js`, rule 2; JSX attributes count). The new return parameter is `slack-bot`.
- Logs stay code-only:
  - Message names start with `slack_`.
  - Field keys stay within `installId`, `reason`, `stage`, `code`, `appDeleted`, plus `kind` on the reset line.
  - Never an agent id, a user or person id, a Slack id other than the install id, a name, a URL, an OAuth code or state, or a token.
  - Bot-path step failures log `slack_bot_failed` (through `createAppSteps({ logPrefix: 'slack_bot' })`), callback refusals `slack_bot_install_refused`, and successes `slack_bot_requested`, `slack_bot_connected`, `slack_bot_cancelled`, `slack_agent_bot_removed`.
- Where each token goes:
  - A pasted refresh token goes only to `tooling.tokens.rotate`.
  - Every refresh token AX keeps is a rotate's successor. It is stored only as the approver's person token (`secrets.putConfigToken` / `steps.saveRotatedToken`), and before its access token is used.
  - A minted access token goes only to `apps.manifest.create`, `apps.icon.set` and `apps.manifest.delete`, then is dropped.
  - No response body carries a token. The one token fact any route answers is `configTokenStored`, about the viewer's own.
- Every configuration-token rotate and every Slack-app create or delete runs under the one app lock (`Mutex.run`). The status's `configTokenStored` read is the one unlocked read, and it only checks that a token is there. `bots.finish` and the internal `removeBot` run under a caller's lock and never take it.
- Every path that ends a bot (cancel, agent delete, the request's undo) releases the approver's token only through `steps.release`, after the row is gone.
- POSTs keep http-server's CSRF check (no `bypassCsrf`). The new GET callback relies on the OAuth state, as the admin callback does.
- Migrations are additive and idempotent, because every boot runs them, the CLI reset's process included. Two things must keep working: the CLI reset test's raw insert (`packages/cli/src/__tests__/admin-reset-bootstrap.test.ts:406`) and its drop of only the installs table (`:82`).
- UI rules:
  - shadcn primitives and semantic tokens only (invariant 6). Invoke the `shadcn` skill before editing.
  - Never write "AX" in a sentence (TASK-1093 ux row: the product is white-labeled through Branding).
  - Copy is pinned in Tasks 6 and 11. A `ux-design` pass may change wording only if it records the change in the shard and updates every pin.
- Test rules:
  - The fake Slack stays strict: it retires a rotated token at once. Never loosen it.
  - Fake tokens come from `__tests__/fake-slack-tokens.ts` (channel-web: `test-utils/fake-slack-tokens.ts`). Never use a real token's shape.
  - No literal invisible characters (`source-hygiene.test.ts`). Under zsh, keep test file lists in arrays.
- Single test files run as `pnpm --filter <pkg> exec vitest run <file>`. `pnpm --filter <pkg> test -- <file>` runs the whole package suite.
- Docker-backed files run one package at a time, with an explicit `DOCKER_HOST` and `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000` (the helper's maximum).
  - In channel-slack those are `store`, `channel-store`, `agents-deleted` and `plugin`; the rest use fakes.
  - Never add a hook or test budget above the package's vitest `hookTimeout` (channel-slack 120 000 ms, preset-k8s 180 000 ms).
- Run each touched package's build (tsc) alongside vitest. channel-slack's tsc excludes tests; channel-web's includes them.
- Final gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, plus `pnpm lint`.

## Review Focus

1. **An approver whose stored token Slack now refuses** (they revoked it on Slack's page). Expected: 502 `slack-config-token`, no Slack app made, nothing stored or deleted, and the form asks for a paste. The paste then stores a fresh successor that serves every app of theirs. Pinned by Task 7 test e and Task 11's form tests.
2. **The shared bot's admin, who also approved a team bot, clicks Disconnect.** Expected: the bot row, its secrets and the admin's person token all stay, and the notice says not to revoke. A bootstrap reset still removes everything. Pinned by Task 6 and Task 2's reset test.
3. **A double click on "Create the Slack bot", or two team admins at once.** Expected: exactly one Slack app, and the other request gets 409 `bot-exists`. Pinned by Task 7 test m.
4. **The agent deleted while its bot request is running.** Expected: no bot is left behind for a deleted agent. Pinned by Task 5 test g and Task 7 test n.
5. **The requester leaves the agent's team, or stays only as a member.** Expected: an admitted outsider gets one polite private line and no turn, members are still answered, and the settings show "needs a team admin to claim it". Pinned by Task 9 test g and Task 7 test r.

## File map

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/slack-apps.ts` (new) | shared Slack-app constants, helpers and steps; `namesInUse` | 1, 4, 6 |
| `packages/channel-slack/src/admin-routes.ts` | uses `slack-apps.ts`; kind-scoped state; `bot-name-taken`; Disconnect answers `tokenKept` | 1, 2, 4, 6 |
| `packages/channel-slack/src/manifest.ts` | `buildInstallUrl` scopes; bot manifest, `botUrls`, constants; header | 1, 3 |
| `packages/channel-slack/src/migrations.ts` | four columns, CHECK, partial unique index, header | 2 |
| `packages/channel-slack/src/store.ts` | `InstallRow` fields, bot methods, kind-scoped state, docs | 2 |
| `packages/channel-slack/src/config-tokens.ts` | `releaseConfigToken` returns `'kept' \| 'released'` | 6 |
| `packages/channel-slack/src/bot-name.ts` | `botNameKey`, `isBotNameTaken`, header | 4 |
| `packages/channel-slack/src/bots.ts` (new) | `createBots`: `removeForAgent` (5); `request`, `installUrl`, `cancel`, `status` (7); `finish` (8) | 5, 7, 8 |
| `packages/channel-slack/src/agents-deleted.ts` | bot removal under the app lock | 5 |
| `packages/channel-slack/src/channels.ts` | `teamAdminAccess`; export `connectable` | 7, 9 |
| `packages/channel-slack/src/agent-routes.ts` | three bot routes, `bot` in the status, `route()` body cap | 7 |
| `packages/channel-slack/src/bot-callback.ts` (new) | `GET /slack/bots/oauth/callback` | 8 |
| `packages/channel-slack/src/router.ts`, `commands.ts`, `copy.ts` | bot mention path, requester check, the shared bot steps aside, `/ax` ignores bots | 9 |
| `packages/channel-slack/src/plugin.ts` | one app lock, wiring, route order, reset log `kind`, header | 2, 5, 7, 8, 12 |
| `packages/channel-slack/src/__tests__/{memory-install-store,fake-slack-config,fake-vault}.ts` (new) | fakes moved out of `admin-routes.test.ts` (1), extended (2) | 1, 2 |
| `presets/memory/src/__tests__/canary.test.ts`, `presets/k8s/src/__tests__/channel-slack-composition.test.ts` | reachability; the whole path with the real vault | 10 |
| `packages/channel-web/src/lib/slack-admin.ts`, `components/admin/SlackTab.tsx` | `tokenKept` notice (6); shared token pieces, `bot-name-taken` (11) | 6, 11 |
| `packages/channel-web/src/components/slack/SlackConfigToken.tsx`, `lib/slack-token-copy.ts` (new) | extracted from Admin › Slack | 11 |
| `packages/channel-web/src/components/workspace/AgentSlackBot.tsx`, `lib/slack-bot-return.ts` (new) | the bot section; the return param | 11 |
| `packages/channel-web/src/{lib/agent-slack.ts,components/workspace/AgentSlack.tsx,App.tsx}` | API, mounting, return handling | 11 |
| `docs/plans/2026-11-09-channel-slack-design.md`, `.changeset/slack-dedicated-bot.md` | stale lines; what shipped | 12 |

---

### Task 1: Share the Slack-app steps, with no behaviour change [tier: integration]

Security-checklist: no walk of its own, because it moves credential code without changing it. `admin-routes.test.ts` is the guard: its test bodies don't change, and the PR-level walk covers the moved code.

**Files:**
- Create: `packages/channel-slack/src/slack-apps.ts`.
- Modify `packages/channel-slack/src/admin-routes.ts`. These move out:
  - constants `ACCESS_TOKEN_PREFIX`, `REFRESH_TOKEN_PREFIX`, `CONFIG_TOKEN_CHARS`, `STATE_RE`, `OAUTH_CODE_RE` (`:213-222`); `TOKEN_ERRORS`, `REFRESH_TOKEN_REFUSED` (`:224-236`); `UNCONFIRMED_CODES`, `HTTP_5XX` (`:269-270`);
  - helpers `sha256Hex`, `isHttps`, `bodyObject`, `configToken`, `createAppError`, `refreshTokenError` (`:308-362`);
  - steps `mintInstallUrl` (`:463-475`), `setIcon` (`:484-502`), `release` (`:510-514`), `undoConnect` (`:532-568`), `saveRotatedToken` (`:853-861`) and `deleteSlackApp` (`:874-894`);
  - the core of `finishInstall` (`:793-839`): client secret, `oauthAccess`, the app-id and enterprise checks, bot token, activate.

  Everything admin-only stays: `CONFIG_TOKEN_REFUSED`, `NOT_APP_MANAGER`, `endsLeftoverPass`, `renameError`, `replaceCheckError`, `undoCreate`, `mintForPass`, `deleteLeftoverApps`, `createInstall`, `updateSlackApp` and the routes.
- Modify `packages/channel-slack/src/manifest.ts:120-128`. `buildInstallUrl` takes an optional `scopes` (default `BOT_SCOPES`).
- Create, moved verbatim from `admin-routes.test.ts`:
  - `__tests__/memory-install-store.ts`: `Row`, `StoreMethod`, `memoryStore` (`:198-391`).
  - `__tests__/fake-slack-config.ts`: `SlackBehaviour`, `fakeSlack` (`:394-492`).
  - `__tests__/fake-vault.ts`: the bus vault inside `world()` (`:533-576`), as `busVault(bus, trail)` returning `{ vault, vaultCalls, vaultAs, vaultFailures }`.
- Test: `admin-routes.test.ts` imports the moved fakes. Nothing else in it changes.

**Interfaces — Produces:**
```ts
// slack-apps.ts
export const ACCESS_TOKEN_PREFIX: 'xoxe.xoxp-';
export const REFRESH_TOKEN_PREFIX: 'xoxe-';
export const STATE_RE: RegExp;
export const OAUTH_CODE_RE: RegExp;
export const TOKEN_ERRORS: ReadonlySet<string>;
export const REFRESH_TOKEN_REFUSED: ReadonlySet<string>;
export const UNCONFIRMED_CODES: ReadonlySet<string>;
export const HTTP_5XX: RegExp;
export function sha256Hex(text: string): string;
export function isHttps(origin: string): boolean;
export function bodyObject(body: Buffer): Record<string, unknown> | null;
export function configToken(value: unknown, prefix: string): string | null;
export function createAppError(err: unknown): 'slack-token' | 'slack-name' | 'slack-unconfirmed' | 'slack-error';
export function refreshTokenError(err: unknown): 'slack-refresh-token' | 'slack-error';
export interface InstallLink { redirectUrl: string; scopes: readonly string[] }
export interface AppStepsDeps {
  store: Pick<InstallStore, 'setOAuthState' | 'remove' | 'rememberLeftoverApp' | 'activate' | 'personHasApps'>;
  secrets: SecretStore; api: SlackApi; logger: Logger;
  now: () => number; randomBytes: (n: number) => Buffer;
  /** Every step-failure line is `${logPrefix}_failed`: admin passes 'slack_admin', so its lines are unchanged. */
  logPrefix: 'slack_admin' | 'slack_bot';
}
export interface AppSteps {
  failed(stage: string, err: unknown, installId?: string, level?: 'warn' | 'error'): void; // default level as today
  mintInstallUrl(installId: string, clientId: string, userId: string, link: InstallLink): Promise<string>;
  setIcon(accessToken: string, appId: string, installId: string, icon: ParsedIcon | null): Promise<boolean>;
  release(app: SecretOwner): Promise<void>;                   // Task 6 changes the return type
  saveRotatedToken(app: SecretOwner, refreshToken: string): Promise<boolean>;
  deleteSlackApp(install: InstallRow): Promise<boolean>;      // the install's person's token, as today
  undoConnect(accessToken: string, appId: string, owner: SecretOwner, botName: string, rowStored: boolean): Promise<void>;
  /** Client secret → oauth.v2.access → app id and enterprise checks. Logs `oauth-access` itself; the caller logs the other refusals. A vault fault throws. */
  exchangeCode(install: InstallRow, code: string, redirectUrl: string):
    Promise<{ ok: true; granted: OAuthInstall } | { ok: false; reason: 'no-client-secret' | 'oauth-access' | 'app-mismatch' | 'enterprise-install' }>;
  /** Bot token first, then activate (`installedAt` = now); on failure, logs the stage and removes the bot token. */
  storeGrant(install: InstallRow, granted: OAuthInstall): Promise<boolean>;
}
export function createAppSteps(d: AppStepsDeps): AppSteps;
```
`createAdminRoutes(d: AdminRoutesDeps)` keeps its signature and builds `createAppSteps({ ...d, logPrefix: 'slack_admin' })` itself. Its links are `{ redirectUrl: slackUrls(publicOrigin, id).redirectUrl, scopes: BOT_SCOPES }`.

- [ ] **Step 1: Baseline.** Run `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts src/__tests__/manifest.test.ts src/__tests__/config-tokens.test.ts`. Expected: PASS. Write down the three test counts.
- [ ] **Step 2: Move the three fakes** into their own files, bodies unchanged, and import them. Re-run Step 1: same counts, PASS. Commit `[TASK-1167] channel-slack: move Admin › Slack's test fakes into shared files`.
- [ ] **Step 3: Create `slack-apps.ts`** and make `admin-routes.ts` use it. Every log line keeps its name, level and fields: `setIcon`'s icon refusal and `deleteSlackApp`'s `missing` line become `${logPrefix}_failed`, which is `slack_admin_failed` for admin. Add `scopes` to `buildInstallUrl`.
- [ ] **Step 4: Verify.** Re-run Step 1, then `pnpm --filter @ax/channel-slack build`. Expected: same counts, PASS, no test body edited.
- [ ] **Step 5: Prove the guard bites.** Commit first, then work on the committed tree:
  - (a) In `deleteSlackApp`, move `saveRotatedToken` after `deleteApp`. A Disconnect trail test must fail.
  - (b) In `undoConnect`, drop `release(owner)`. A Connect-undo test must fail (TASK-1175's R7 family).
  - Restore each with `git checkout HEAD -- packages/channel-slack/src/slack-apps.ts` and check that `git status --short` is empty.
  - If either mutant survives, add the missing order test to `admin-routes.test.ts` (against the pre-extraction code, in its own commit) before going on.
- [ ] **Step 6: Commit** `[TASK-1167] channel-slack: share the Slack-app steps between Admin › Slack and the bot routes (no behaviour change)`.

### Task 2: Store: bot rows, kind-scoped OAuth state, a reset that still removes everything [tier: sensitive]

**Needs `security-checklist`:** OAuth state binding, per-install secrets, reset cleanup, a migration.

**Files:**
- Modify `packages/channel-slack/src/migrations.ts`:
  - Add the four columns, the CHECK and the index after `:274`.
  - Rewrite the installs paragraph of the header (`:8-18`). "At most one shared-app install … later cards add per-agent installs here" is now done. Describe the bot rows: `kind`, `agent_id`, `requested_by_user_id` (whom its channels' outsiders run as), `bot_handle`, and `connected_by_user_id` as the approver whose person token manages the app.
- Modify `packages/channel-slack/src/store.ts`:
  - the new fields, types and methods;
  - `ROW_COLUMNS`, `toRow` (`kind` reads `'shared'` only for exactly `'shared'`, anything else as `'bot'`, the more restricted kind);
  - `current()` filtered `WHERE kind = 'shared'`, with its doc at `:76`;
  - kind-scoped peek and consume;
  - `removeAll` returning `kind`;
  - one added doc line each on `personHasApps` and `list` ("any kind: a team bot's row names its approver"). **Their queries stay as they are.**
- Modify `admin-routes.ts`. The callback uses `peekOAuthState(hash, 'shared')` and `consumeOAuthState(hash, 'shared')`.
- Modify `plugin.ts:551-557`. The `slack_install_removed_by_reset` line gains `kind`.
- Modify `__tests__/memory-install-store.ts`. Mirror the new methods, kind-scoped `current()` and kind-scoped state.
  - Bot rows go in the same `rows` map, so the fake's `personHasApps` counts them exactly as the real one does.
  - A second `insertPendingBot` for an agent throws `InstallStoreError('bot-exists')`.
- Test: `store.test.ts` (Docker), `admin-routes.test.ts`, `plugin.test.ts` (Docker). Run only: `packages/cli/src/__tests__/admin-reset-bootstrap.test.ts` (Docker).

**Interfaces — Produces:**
```ts
export type InstallKind = 'shared' | 'bot';
// InstallRow gains:
kind: InstallKind; agentId: string | null; requestedByUserId: string | null; botHandle: string | null;
export type RemovedInstall = Pick<InstallRow, 'installId' | 'appId' | 'teamId' | 'connectedByUserId' | 'kind'>;
// InstallStoreError['code'] gains 'bot-exists'.
// InstallStore gains / changes:
current(): Promise<InstallRow | null>;                                  // kind 'shared' only, any status, oldest
insertPendingBot(r: Pick<InstallRow, 'installId' | 'appId' | 'clientId' | 'botName' | 'connectedByUserId'>
  & { agentId: string; requestedByUserId: string }): Promise<void>;      // unique violation (23505) → InstallStoreError('bot-exists')
botForAgent(agentId: string): Promise<InstallRow | null>;                // kind 'bot', any status
listBots(): Promise<InstallRow[]>;                                       // kind 'bot', any status, oldest first
setBotHandle(installId: string, handle: string): Promise<void>;          // ACTIVE bot only, else InstallStoreError('install-not-active')
peekOAuthState(stateHash: string, kind: InstallKind): Promise<OAuthState | null>;
consumeOAuthState(stateHash: string, kind: InstallKind): Promise<OAuthState | null>;
removeAll(): Promise<RemovedInstall[]>;                                  // EVERY kind (brief-got-wrong 1)
personHasApps(userId: string): Promise<boolean>;                         // UNCHANGED: any kind, so bot rows count
list(): Promise<InstallRow[]>;                                           // UNCHANGED: any kind (only the boot move reads it)
```

Schema, each statement idempotent:
- `ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'shared' CHECK (kind IN ('shared','bot'))`.
- `agent_id TEXT NULL`, `requested_by_user_id TEXT NULL`, `bot_handle TEXT NULL`.
- Constraint `channel_slack_v1_installs_kind_fields`: `CHECK ((kind = 'shared' AND agent_id IS NULL AND requested_by_user_id IS NULL) OR (kind = 'bot' AND agent_id IS NOT NULL AND requested_by_user_id IS NOT NULL))`. Add it in a `DO $$ … $$` block with `pg_advisory_xact_lock` and a `pg_constraint` lookup, the recipe of `conversations_v1_events_event_kind_check` in `packages/conversations/src/migrations.ts`. The CLI process runs these migrations too.
- `CREATE UNIQUE INDEX IF NOT EXISTS channel_slack_v1_installs_bot_agent ON channel_slack_v1_installs (agent_id) WHERE kind = 'bot'`.

- [ ] **Step 1: Write the failing tests in `store.test.ts`:**
  - `'a row from before TASK-1167 reads as shared, with null bot fields'`. A raw insert without the new columns reads back as `kind 'shared'`, with `agentId`, `requestedByUserId` and `botHandle` all null.
  - `'the database refuses a bot without its agent or requester, a shared row with an agent, and an unknown kind'`. Each raw insert rejects with Postgres code `23514`.
  - `'one bot per agent, pending or active'`. A second `insertPendingBot` for the same agent throws `InstallStoreError` `bot-exists`. A bot for another agent is fine.
  - `'current() never returns a bot'`. An older bot plus a newer shared row gives the shared one. Bots only gives null.
  - `'botForAgent and listBots see bots only, any status; listBots oldest first'`.
  - `'setBotHandle writes only an active bot'`.
  - `'a bot state is invisible to the shared peek and consume, and the reverse'`. The right kind consumes exactly once.
  - `'personHasApps counts a pending bot and an active bot that name the person as approver, and stops once the bot is removed'`. Seed Grace only as the approver of a pending bot: true. Activate it: true. `remove(id)`: false. With `remove(id, { appLeft: true })`: true (the leftover names her).
  - `'removeAll removes bots too, returns their kind and approver, and takes their bindings'`.
  - `'the migrations run twice cleanly, and again after the installs table alone is dropped'`.
  - Update the `InstallRow` key-set pin (`store.test.ts:258`).
- [ ] **Step 2: Write the failing tests elsewhere:**
  - `admin-routes.test.ts`: `'the admin callback refuses a bot install's state without spending it'`. Redirect `/?slack=failed`, and `peekOAuthState(hash, 'bot')` still answers afterwards.
  - `plugin.test.ts`: `'a reset removes bot installs too, logs their kind, deletes their leftover secrets and releases their approver's token'`. Seed a shared install (Ada) and a bot (approver Grace) with stored person tokens. After the reset there are no install rows, every `slack_install_removed_by_reset` line carries `kind`, and both person tokens are gone.
- [ ] **Step 3: Run them to see them fail:**
  - `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack exec vitest run src/__tests__/store.test.ts src/__tests__/plugin.test.ts`
  - `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts`
- [ ] **Step 4: Implement** the migration, the store, the admin callback's `'shared'`, the reset line's `kind`, the fake's mirror and the header docs.
- [ ] **Step 5: Run Step 3 again, plus the CLI test.** Expected: PASS. The CLI test is `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/cli exec vitest run src/__tests__/admin-reset-bootstrap.test.ts`, and its raw insert still works.
- [ ] **Step 6: Prove the guard bites.** On the committed tree, add `AND kind = 'shared'` to `personHasApps`. The new store test must fail. Restore with `git checkout HEAD -- packages/channel-slack/src/store.ts` and check that `git status --short` is empty.
- [ ] **Step 7: Commit** `[TASK-1167] channel-slack: bot installs in the installs table; OAuth state scoped by kind`.

### Task 3: The dedicated bot's manifest [tier: mechanical]

**Files:**
- Modify `packages/channel-slack/src/manifest.ts`. Its header (`:1-24`) now says it describes two apps: the shared one, and a team agent's channel-only bot.
- Test: `manifest.test.ts`.

**Interfaces — Produces:**
```ts
export const DEDICATED_BOT_SCOPES: readonly ['app_mentions:read', 'chat:write', 'reactions:write', 'users:read', 'users:read.email', 'channels:read'];
export const DEDICATED_BOT_EVENTS: readonly ['app_mention'];
export const BOT_OAUTH_CALLBACK_PATH = '/slack/bots/oauth/callback';
export interface BotUrls { eventsUrl: string; redirectUrl: string; interactionsUrl: string }
export function botUrls(publicOrigin: string, installId: string): BotUrls;   // redirect = <origin>/slack/bots/oauth/callback
export function buildBotManifest(botName: string, urls: BotUrls): Record<string, unknown>;
```

- [ ] **Step 1: Failing tests:**
  - `'the bot manifest is the smallest a channel-only bot needs'`. One `toStrictEqual` on the whole object:
    - `display_information { name, description: 'Talk to your team agent.' }`;
    - `features.app_home { home_tab_enabled: false, messages_tab_enabled: false, messages_tab_read_only_enabled: false }`;
    - `features.bot_user { display_name, always_online: true }`, and **no `slash_commands` key**;
    - `oauth_config { redirect_urls: [<bot callback>], scopes: { bot: [6 scopes] } }`;
    - `settings { event_subscriptions: { request_url: <events/<id>>, bot_events: ['app_mention'] }, interactivity: { is_enabled: true, request_url: <interactions/<id>> }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false }`.
  - `'a dedicated bot can't read DMs, join channels or take commands'`. `DEDICATED_BOT_SCOPES` has none of `im:history`, `channels:join`, `commands`, `channels:history`, `chat:write.public`, `chat:write.customize`, `groups:*`, `mpim:*` or `im:*`, and `toHaveLength(6)`.
  - `'botUrls drops trailing slashes and encodes the id'`.
  - `'an install link for a bot asks for the six scopes; the shared link is unchanged'`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/manifest.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `slackUrls` and `SlackUrls` stay exactly as they are.
- [ ] **Step 4: Run Step 2 again.** Expected: PASS. Commit `[TASK-1167] channel-slack: the dedicated bot's manifest`.

### Task 4: One name per bot, across every bot and the shared bot [tier: integration]

**Files:**
- Modify `packages/channel-slack/src/bot-name.ts`. The header (`:10-12`: "uniqueness would be ours to enforce; one install per AX instance has nothing to collide with yet") is now done: say so.
- Modify `slack-apps.ts` (add `namesInUse`).
- Modify `admin-routes.ts`. Connect and Rename refuse a taken name before any Slack call.
- Test: `bot-name.test.ts`, `admin-routes.test.ts`.

**Interfaces — Produces:**
```ts
// bot-name.ts (pure)
/** Lowercase ASCII letters and digits only, cut to BOT_HANDLE_MAX (21): how Slack's handle collides. */
export function botNameKey(name: string): string;
export function isBotNameTaken(name: string, taken: readonly (string | null)[]): boolean;  // an empty key never matches
// slack-apps.ts
/** The shared install's name, then every bot's name and stored handle; `except` leaves one install out (a rename of itself). */
export function namesInUse(store: Pick<InstallStore, 'current' | 'listBots'>, o?: { except?: string }): Promise<string[]>;
```
The new refusal is `409 { error: 'bot-name-taken' }`:
- on `POST /admin/slack/connect`, inside the lock, after `configTokenRef(actor.id)` (`:1001-1006`) and before `deleteLeftoverApps`;
- on `POST /admin/slack/rename`, after the active and https checks, excepting the install itself.

- [ ] **Step 1: Failing tests:**
  - `'names that differ only in case, spaces, dots, dashes or underscores share a key'`. `Ada Bot`, `ada-bot`, `ADA_BOT`, `ada.bot` and `adabot` all give `adabot`.
  - `'a key is cut where Slack cuts the handle'`. `botNameKey('Customer Support Agents 1') === 'customersupportagents'`, and so is `'Customer Support Agents 2'`.
  - `'a taken name or handle is refused; a different one is not'`. `('Ada Bot', ['adabot'])` → true. `('ada', ['ada2'])` → false. `('Ada 2', [null, 'ada2'])` → true. `('ada', [''])` → false.
  - admin: `'Connect refuses a name a bot already has, before Slack is called'`. 409, and the fake Slack saw no calls.
  - admin: `'Rename refuses a bot's name, and renaming to a variant of its own name still works'`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/bot-name.test.ts src/__tests__/admin-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The existing private `handleKey` stays as it is: it serves the reserved-word check, and its job differs.
- [ ] **Step 4: Run Step 2 again.** Expected: PASS. Commit `[TASK-1167] channel-slack: Slack bot names are unique across the shared bot and every team bot`.

### Task 5: Removing a bot, and deleting it with its agent [tier: sensitive]

**Needs `security-checklist`:** the approver's configuration token, secret cleanup, the lock.

**Files:**
- Create `packages/channel-slack/src/bots.ts` (`BotDeps`, `Bots`, `createBots` with `removeForAgent`, and the internal `removeBot`).
- Modify `agents-deleted.ts`. Signature and header.
- Modify `plugin.ts`:
  - One `const appLock = createMutex()`, handed to `createAdminRoutes` (replacing the inline `createMutex()` at `:356`) and to `createBots`.
  - `createBots` gets the same cached `secrets` instance, so a removal also drops the events route's cached signing secret.
- Test: `agents-deleted.test.ts` (Docker: real stores, `fake-vault.ts`, `fake-slack-config.ts`).

**Interfaces — Produces:**
```ts
export interface BotDeps {
  bus: HookBus; installs: InstallStore; secrets: SecretStore; api: SlackApi; lock: Mutex;
  publicOrigin: string; logger: Logger; now: () => number; randomBytes: (n: number) => Buffer;
}
export interface Bots {
  /** Takes the app lock. The agent's bot, if any, goes as removeBot does; logs `slack_agent_bot_removed { installId, appDeleted }`. Never throws: a fault logs `slack_bot_failed { stage: 'agent-deleted', code }`. */
  removeForAgent(agentId: string): Promise<void>;
  // Task 7 adds request, installUrl, cancel, status; Task 8 adds finish.
}
export function createBots(d: BotDeps): Bots;   // builds createAppSteps({ ...d, store: d.installs, logPrefix: 'slack_bot' })
// internal, caller holds d.lock:
//   removeBot(bot): steps.deleteSlackApp(bot) → installs.remove(id, { appLeft: !appDeleted }) → secrets.removeAll(bot) → steps.release(bot)
export function subscribeAgentsDeleted(
  bus: HookBus,
  d: { channels: Pick<ChannelStore, 'removeForAgent'>; bots: Pick<Bots, 'removeForAgent'> },
  logger: Logger,
): () => void;   // bindings and threads first, as today, then d.bots.removeForAgent(agentId)
```

- [ ] **Step 1: Failing tests in `agents-deleted.test.ts`.** The existing 10 change only their `subscribeAgentsDeleted` call to the object form, with a no-op `bots` stub.
  - a. `'deleting the agent deletes its bot's Slack app with an access token minted from the approver's own token, saved first'`. Check:
    - The calls happen in exactly this order: `credentials:get slack:person:<approver>:config-refresh-token`, `tooling.tokens.rotate(<stored>)`, `credentials:set` of that same person ref (the successor), then `apps.manifest.delete` with `app_id` = the bot's app and `Bearer <minted>`.
    - The row is gone. So are the bot's `slack:<botId>:{bot-token,signing-secret,client-secret}`, and so is the approver's person token, since nothing else names them.
    - The leftover list is empty.
    - The shared install's row, its secrets and its person's token are untouched.
    - Log `slack_agent_bot_removed { installId, appDeleted: true }`.
  - b. `'the approver's token stays when their shared install or another bot still names them'`.
  - c. `'a dead approver token lists the app as left over naming the approver; row and per-install secrets gone; the token kept for the leftover'` (rotate refused).
  - d. `'Slack refusing the delete lists the app as left over; app_not_found counts as deleted'`.
  - e. `'a pending bot is deleted the same way'`.
  - f. `'an agent with no bot costs no vault read and no Slack call'`.
  - g. `'the removal waits for the app lock'`. Hold the real mutex, fire the delete, and assert no vault or Slack call until it's released.
  - h. `'a fault is logged code-only and never thrown, and no line carries a token or a person id'`.
- [ ] **Step 2: Run** `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack exec vitest run src/__tests__/agents-deleted.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Step 2 again**, plus `plugin.test.ts` (Docker). Expected: PASS.
- [ ] **Step 5: Prove the guard bites.** On the committed tree, in `removeBot`, call `steps.release(bot)` before `installs.remove`. Test a must fail, because the row still names the approver and the token is kept. Restore with `git checkout HEAD -- packages/channel-slack/src/bots.ts` and check that `git status --short` is empty.
- [ ] **Step 6: Commit** `[TASK-1167] channel-slack: deleting an agent deletes its own Slack bot`.

### Task 6: Disconnect keeps a token a team bot still needs, and says so [tier: integration]

Security-checklist: no walk of its own, because it adds no new reach. It changes a return value and the advice the admin is given about revoking a credential, and the PR-level note records it.

**Files:**
- Modify `packages/channel-slack/src/config-tokens.ts` (`releaseConfigToken`, `:163-196`, and its doc).
- Modify `slack-apps.ts` (`AppSteps.release`).
- Modify `admin-routes.ts`:
  - `disconnect()` (`:1201-1222`);
  - the header line `:42` (`→ { appDeleted, tokenKept }`).
- Modify `packages/channel-web/src/lib/slack-admin.ts`:
  - `disconnectSlack()` (`:255-261`);
  - doc `:11`.
- Modify `packages/channel-web/src/components/admin/SlackTab.tsx`:
  - `DisconnectedNotice` (`:164-175`);
  - the `disconnected` notice kind and `onDisconnected` (`:93-101`, `:487-510`, `:997-1023`).
- Test: `config-tokens.test.ts`, `admin-routes.test.ts`, channel-web `__tests__/admin-slack.test.tsx` (it pins `disconnectSlack`) and `components/admin/__tests__/SlackTab.test.tsx`.

**Interfaces — Produces:**
```ts
// config-tokens.ts
export function releaseConfigToken(d, app, o): Promise<'kept' | 'released'>;
//   'kept': an install or leftover names the person, or the check failed. 'released': removeConfigToken ran, or (onlyIfStored) nothing was stored.
// slack-apps.ts
AppSteps.release(app: SecretOwner): Promise<'kept' | 'released'>;
// POST /admin/slack/disconnect → { appDeleted: boolean; tokenKept: boolean }
// channel-web
export function disconnectSlack(): Promise<{ appDeleted: boolean; tokenKept: boolean }>;   // either missing or non-boolean → bad-response
```

**Copy (pinned):**
- `tokenKept: false` (unchanged): "Slack is disconnected. One more step that Slack doesn't let us do: on {SlackAppsLink}, under **Your App Configuration Tokens**, whoever generated the token clicks **Revoke**."
- `tokenKept: true`: "Slack is disconnected. Don't revoke the configuration token on {SlackAppsLink} yet: other Slack apps made with it still use it, like a team agent's own bot."

- [ ] **Step 1: Failing tests:**
  - `config-tokens.test.ts`: `'releaseConfigToken says whether the token was kept'`. A person who is named gives `'kept'`. A check fault gives `'kept'`. A person nobody names gives `'released'`. With `onlyIfStored` and nothing stored, it gives `'released'`.
  - `admin-routes.test.ts`: `'Disconnect keeps the person's token while their team bot names them, and answers tokenKept'`.
    - Seed a pending bot through the memory store's `insertPendingBot`, with Ada (the shared install's person) as its approver.
    - Disconnect answers `{ appDeleted: true, tokenKept: true }`.
    - The vault still holds Ada's person token, and the trail ends `store:personHasApps` with no `vault:delete config-refresh-token` after it.
    - The same holds for an active bot.
  - `admin-routes.test.ts`: `'"I deleted it" keeps a maker's token while their bot names them'`.
  - Update every exact assertion of the Disconnect answer to carry `tokenKept`. `git grep -n "appDeleted" -- packages/channel-slack packages/channel-web presets` finds them, including the composition test's.
  - channel-web: `disconnectSlack` parses `tokenKept` and refuses an answer without it. The notice shows each variant's pinned text after a Disconnect.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/config-tokens.test.ts src/__tests__/admin-routes.test.ts` and the channel-web files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Step 2 again**, plus `pnpm --filter @ax/channel-web build`. Expected: PASS. Commit `[TASK-1167] Slack: Disconnect keeps a configuration token a team bot still needs, and says not to revoke it`.

### Task 7: Request a bot, continue it in Slack, cancel it, and see it [tier: sensitive]

**Needs `security-checklist`:** new signed-in routes, the approver's configuration token (stored or pasted), cross-agent rights.

**Files:**
- Modify `bots.ts` (`request`, `installUrl`, `cancel`, `status`).
- Modify `channels.ts` (`teamAdminAccess`).
- Modify `agent-routes.ts`:
  - three routes;
  - `route()` gains an optional `maxBodyBytes`;
  - the status gains `bot`;
  - `createAgentSlackRoutes(d: ChannelDeps, bots: Pick<Bots, 'request' | 'installUrl' | 'cancel' | 'status'>)`.
- Modify `plugin.ts` (wiring).
- Test:
  - `bots.test.ts` (new): uses `memory-install-store`, `fake-slack-config`, `fake-vault`, `fake-agents`, `fake-png` and `fake-slack-tokens`, with the real `createSecretStore` over the bus vault.
  - `channels.test.ts`, `agent-routes.test.ts`, `plugin.test.ts`.

**Interfaces — Produces:**
```ts
// channels.ts
/** agentAccess, narrowed to a team admin of the agent's team (agents:can-set-shared-credential, isAdmin: false): a member who isn't one is 'no'; not-found → 'agent-gone'. Other errors propagate. */
export async function teamAdminAccess(bus: HookBus, ctx: AgentContext, agentId: string, userId: string): Promise<AgentAccess>;
// bots.ts
export type AgentSlackBot =
  | { state: 'none'; configTokenStored: boolean }
  | { state: 'pending'; botName: string; approver: string; canContinue: boolean }
  | { state: 'live'; botName: string; handle: string | null; approver: string; needsClaim: boolean };
type Reply = { status: number; body: unknown };
// Bots gains:
request(i: { ctx: AgentContext; actorUserId: string; agentId: string; botName: string; refreshToken: string | null; icon: ParsedIcon | null }): Promise<Reply>;  // takes the lock
installUrl(i: { actorUserId: string; agentId: string }): Promise<Reply>;                                                                                       // takes the lock
cancel(i: { agentId: string }): Promise<Reply>;                                                                                                               // takes the lock
status(i: { ctx: AgentContext; viewerUserId: string; agentId: string; manages: boolean; sharedActive: boolean }): Promise<AgentSlackBot>;                       // no lock
// agent-routes.ts: AgentSlackStatus becomes
//   { state: 'no-workspace'; bot: AgentSlackBot } | personal-agent (unchanged) | { state: 'ready'; …as today; bot: AgentSlackBot }
```

**The routes.** Each answers, in this order, before any body is read or Slack is asked anything:
1. 401 when signed out.
2. The same 404 for a bad id, an agent the person can't see, and a missing one.
3. Rights: `checkRights … 'manage'` gives 409 `personal-agent` or 403 `forbidden`.

| Route | Cap | Body | Answers |
|---|---|---|---|
| `POST /settings/slack/:agentId/bot` | `ADMIN_CONNECT_BODY_MAX_BYTES` | Keys `botName` (required), `refreshToken` (optional) and `iconPng` (optional); any other key → 400 `invalid-body`. A `refreshToken` that is present must pass `configToken(v, REFRESH_TOKEN_PREFIX)`, else 400 `invalid-refresh-token` (`null` included). `iconPng` goes through `parseIconPng` and is never a 400. | 413 `body-too-large`. 400 `invalid-bot-name {reason}`. Then from the domain: 409 `no-workspace`, `public-origin-not-https`, `bot-exists`, `bot-name-taken`, `config-token-needed`. 502 `slack-refresh-token`, `slack-config-token`, `slack-token`, `slack-name`, `slack-unconfirmed`, `slack-error`. 500 `internal`. 200 `{ installUrl, iconSet }`. |
| `POST …/bot/install-url` | `ADMIN_BODY_MAX_BYTES` | ignored | 409 `not-pending`; 403 `not-approver`; 200 `{ installUrl }` |
| `POST …/bot/cancel` | `ADMIN_BODY_MAX_BYTES` | ignored | 409 `not-pending` (a live bot isn't cancelled here); 200 `{ appDeleted }` |

**`request`, inside `lock.run`, in this order** (the stages in brackets are its `slack_bot_failed` stages):
1. Re-check manage rights (`checkRights`). This closes the race with Task 5's removal.
2. The 409s, all before Slack:
   - no ACTIVE shared install (`current()`): `no-workspace`;
   - `!isHttps(publicOrigin)`: `public-origin-not-https`;
   - `botForAgent` is not null: `bot-exists`;
   - `isBotNameTaken(name, await namesInUse(installs))`: `bot-name-taken`.
3. `configTokenRef(actorUserId)`. If it throws, log `[request]` with code `invalid-person-id` and answer 500 before Slack.
4. `installId` = `randomBytes(INSTALL_ID_BYTES).toString('base64url')`, and `owner = { installId, connectedByUserId: actorUserId }`.
5. The configuration access token:
   - **Paste** (`refreshToken !== null`), which wins over a stored one:
     - Run `api.rotateConfigToken(paste)` `[try-refresh-token]`. A failure answers 502 `refreshTokenError(err)` with nothing stored.
     - Then `secrets.putConfigToken(owner, minted.refreshToken)` `[save-config-token]`, straight away. Generating the pasted token revoked any older one, so this is now the person's only live token. If the save fails, answer 500.
   - **Stored:**
     - `secrets.getConfigToken(owner)`: null answers 409 `config-token-needed`; a fault is the route's 500.
     - `api.rotateConfigToken(stored)` `[rotate]`: a `REFRESH_TOKEN_REFUSED` code answers 502 `slack-config-token`, and anything else 502 `slack-error`. Nothing is stored, and the stored token is left as it is.
     - `steps.saveRotatedToken(owner, minted.refreshToken)`: false answers 500 and creates nothing (as Rename does, `admin-routes.ts:920`).
6. `api.createApp(minted.accessToken, buildBotManifest(name, botUrls(publicOrigin, installId)))` `[create-app]`. A failure runs `steps.release(owner)`, then answers 502 `createAppError(err)`.
7. Then:
   - `secrets.put(owner, 'client-secret' | 'signing-secret', …)`;
   - `installs.insertPendingBot({ installId, appId, clientId, botName, connectedByUserId: actor, agentId, requestedByUserId: actor })`, then set `rowStored = true`;
   - `iconSet = steps.setIcon(minted.accessToken, …)`;
   - `installUrl = steps.mintInstallUrl(installId, clientId, actor, { redirectUrl: botUrls(…).redirectUrl, scopes: DEDICATED_BOT_SCOPES })`;
   - log `slack_bot_requested { installId }`, and answer 200.

   Any throw logs `[request]` and runs `steps.undoConnect(minted.accessToken, appId, owner, name, rowStored)`: it deletes the app or lists it as left over, removes the row and secrets, and releases. After it, `InstallStoreError` `bot-exists` answers 409 and anything else 500.

**`installUrl`, in the lock:**
1. `botForAgent`: not pending answers 409 `not-pending`.
2. `actor !== bot.connectedByUserId` answers 403 `not-approver`.
3. `steps.mintInstallUrl` with the bot link. An `InstallStoreError` answers 409 `not-pending`.

**`cancel`, in the lock:** `botForAgent`. None, or an active bot, answers 409 `not-pending`. Otherwise run `removeBot`, then log `slack_bot_cancelled { installId, appDeleted }`. Any team admin who manages the agent may cancel; the deletion uses the approver's token, as any admin's Disconnect uses the install person's.

**`status`** (no lock):
- **No bot:** `{ state: 'none', configTokenStored }`.
  - It reads `secrets.getConfigToken({ installId: '', connectedByUserId: viewerUserId })` only when `manages && sharedActive`; otherwise `false`, with no vault read.
  - A fault (`invalid-person-id` included) gives `false` and a warn line `[status-config-token]`.
- **Pending:** for a manager, `{ state: 'pending', botName, approver, canContinue: viewer === bot.connectedByUserId && sharedActive }`. A non-manager gets `{ state: 'none', configTokenStored: false }`.
- **Active:**
  - `{ state: 'live', botName, handle: bot.botHandle, approver, needsClaim }`, shown to every viewer.
  - `needsClaim` is `(await teamAdminAccess(bus, ctx, agentId, bot.requestedByUserId)) !== 'yes'`. A fault gives `false` and a warn line `[status-claim]`.
- `approver` is `personName(bus, ctx, bot.connectedByUserId, { allowEmail: false, fallback: 'A teammate', … })`.

**`status()` in `agent-routes.ts`, reordered:**
1. View rights; 404 as today.
2. `current()`, giving `sharedActive`.
3. A personal agent: `no-workspace` with `bot: { state: 'none', configTokenStored: false }` and no bot read, or `personal-agent` as today.
4. A team agent: `manages`, then `bots.status`, then `{ state: 'no-workspace', bot }`, or `ready` with `bot`.

- [ ] **Step 1: Failing tests in `bots.test.ts`:**
  - a. `'an approver with a stored token pastes nothing: it is rotated under the lock, its successor saved first, then the bot app is created with the minted access token'`. Check:
    - The trail is exactly: `vault:get` person, `rotate(stored)`, `vault:set` person (the successor), `apps.manifest.create` (`Bearer <minted>`, `buildBotManifest(…)`), `vault:set client-secret`, `vault:set signing-secret`, `store:insertPendingBot`, `apps.icon.set`, `store:setOAuthState`.
    - No `slack:<newId>:config-refresh-token` is ever written.
    - The row is `kind 'bot'`, `pending`, with the agent, and requester = approver = actor.
    - The install link is Slack's authorize URL, with `scope` = the six scopes and `redirect_uri` = the bot callback.
    - `peekOAuthState(sha256(state), 'bot').userId === actor`.
    - The shared install's secrets and its person's token are untouched.
  - b. `'a pasted refresh token is rotated once and its successor stored as the approver's token before Slack makes the app; the pasted one is never stored'`.
  - c. `'a paste wins over a stored token: the stored one is not read or rotated, and the slot ends with the paste's successor'`.
  - d. `'no paste and no stored token: 409 config-token-needed, no Slack call'`.
  - e. `'a stored token Slack refuses (invalid_refresh_token, token_revoked): 502 slack-config-token; no app; the stored token left as it was'`. A rotate timeout gives `slack-error`.
  - f. `'a refused pasted token: 502 slack-refresh-token, no app, nothing stored'`. A timeout gives `slack-error`.
  - g. `'a successor that won't save: 500 and no app made'` (stored path).
  - h. `'create fails: 502 by createAppError; a first-time approver's token is released, while one whose other app still names them is kept'`.
  - i. `'a failure after the app exists deletes it, or lists it as left over naming the approver; row and per-install secrets gone; the token released unless something names them'` (the vault throws on `signing-secret`).
  - j. `'no active shared install, or an http origin: 409 before Slack'`.
  - k. `'the agent already has a bot, pending or live: 409 bot-exists before Slack'`.
  - l. `'a name the shared bot, a bot or a bot's handle has (by key): 409 bot-name-taken before Slack'`.
  - m. `'two requests at once make one app; the other gets 409 bot-exists'` (`Promise.all`).
  - n. `'an agent deleted after the route's rights check is refused inside the lock, with no Slack call'`.
  - o. `'a requester whose id can't name a vault ref: 500 before Slack'`.
  - p. `installUrl`: `'the approver gets a fresh link and the old state stops matching; another team admin gets 403 not-approver; none or live gets 409 not-pending'`.
  - q. `cancel`:
    - `'a pending bot's app is deleted with the approver's token (rotate, save, delete); row and secrets go; the token released unless named'`;
    - `'a dead token lists it as left over, token kept'`;
    - `'a live bot gets 409 not-pending'`.
  - r. `status`:
    - none: `configTokenStored` is true or false for a manager; false, with no vault read, for a non-manager or with no active shared install; false on a vault fault.
    - pending: `canContinue` only for the approver, and only while the shared install is active. A non-manager sees `none`.
    - live: the handle and the approver are shown, and the approver is never an email (else "A teammate"). `needsClaim` is false for a requester who is still a team admin, true for one who is only a member now or deleted, and false on a fault.
  - s. `'no reply body or log line carries a token or a person id'`. Scan every reply and line for the fake token prefixes and the seeded user ids.
- [ ] **Step 2: Failing tests elsewhere:**
  - `channels.test.ts`: `'teamAdminAccess: yes for a team admin; no for a member, a stranger or a deleted user; agent-gone for a missing agent; not-team for a personal agent; an outage propagates'`.
  - `agent-routes.test.ts`:
    - Add `'/bot'`, `'/bot/install-url'` and `'/bot/cancel'` to `Suffix`, `EVERY_ROUTE` and `WRITES` (`:233-243`), so the existing loops prove 401, the same 404, 403, `personal-agent`, CSRF and the body cap.
    - Grow the ordered route list (`:376`) from 5 to 8, with `/bot`'s cap.
    - Add `'POST /bot: an unknown key, an access token in the refresh field, a null refreshToken, or a bad name is a 400 before the domain'` and `'POST /bot without refreshToken reaches the domain with null'`.
    - The status gains `bot` on `ready` and `no-workspace`: `:616` becomes `{ state: 'no-workspace', bot: { state: 'none', configTokenStored: false } }`. Back the routes with a stub `bots`.
  - `plugin.test.ts`:
    - The ordered route list (`:665`, titled "sixteen") and the counts at `:1995`, `:2017`, `:2046` and `:2224` go to 19.
    - The `no-workspace` shape at `:2090` gains `bot`.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/bots.test.ts src/__tests__/channels.test.ts src/__tests__/agent-routes.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run Step 3 again**, plus `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack exec vitest run src/__tests__/plugin.test.ts`, plus the package build. Expected: PASS.
- [ ] **Step 6: Prove the guard bites.** On the committed tree:
  - (a) Swap the stored path's save and `createApp`. Test a must fail.
  - (b) Drop the in-lock `checkRights`. Test n must fail.
  - Restore with `git checkout HEAD -- packages/channel-slack/src/bots.ts` and check that `git status --short` is empty.
- [ ] **Step 7: Commit** `[TASK-1167] channel-slack: a team admin requests the agent's own Slack bot`.

### Task 8: The bot's OAuth callback [tier: sensitive]

**Needs `security-checklist`:** a new signed-in callback, state-user binding, login CSRF, workspace binding.

**Files:**
- Create `packages/channel-slack/src/bot-callback.ts`.
- Modify `bots.ts` (`finish`).
- Modify `plugin.ts`: register the callback right after `createAgentSlackRoutes(...)`.
- Test: `bot-callback.test.ts` (new, fakes), `plugin.test.ts`.

**Interfaces — Produces:**
```ts
export function createBotCallbackRoute(d: {
  bus: HookBus; installs: Pick<InstallStore, 'peekOAuthState' | 'consumeOAuthState' | 'get'>; lock: Mutex;
  bots: Pick<Bots, 'finish'>; publicOrigin: string; logger: Logger; now: () => number;
}): RouteSpec;   // GET BOT_OAUTH_CALLBACK_PATH
// Bots gains (caller holds the lock; finish never takes it):
finish(i: { actorUserId: string; ctx: AgentContext; install: InstallRow; code: string }):
  Promise<{ outcome: 'connected' } | { outcome: 'failed'; reason: string }>;
```

**Redirect.** Every answer is a 302 to `<publicOrigin>/?slack-bot=<connected|cancelled|failed>`, built with `URLSearchParams`. `&agentId=<id>` is appended only once the state's user matched the actor, and the agent id comes from the row, never from the request.

**Order of checks:**
1. Signed in (`checkUser`). Otherwise `failed`, logging `unauthenticated`.
2. `state` matches `STATE_RE`.
3. Exactly one of `code` (matching `OAUTH_CODE_RE`) or `error`.
4. Inside `lock.run`:
   1. `peekOAuthState(h, 'bot')`.
   2. The peeked user must be the actor. If not, refuse `state-user-mismatch` **without spending** the state.
   3. `consumeOAuthState(h, 'bot')`.
   4. An expired state is `failed`. `error=access_denied` is `cancelled`; any other error is `failed`.
   5. `bots.finish`:
      - the row is a pending `kind 'bot'`, and `install.connectedByUserId === actor` (else `not-approver`);
      - the actor still manages `install.agentId` (`checkRights … 'manage'`);
      - `current()` is an ACTIVE shared install;
      - `steps.exchangeCode(install, code, botUrls(origin, id).redirectUrl)`;
      - `granted.teamId === shared.teamId` (else `team-mismatch`);
      - `steps.storeGrant`;
      - then, best-effort: `usersInfo(granted.botToken, granted.botUserId)`, and `setBotHandle` only for a `user.name` that matches `^[a-z0-9][a-z0-9._-]{0,79}$` and isn't in `RESERVED_BOT_NAMES`. The handle is Slack's untrusted text and goes into copy lines as `@<handle>`, so `channel`, `here` or `everyone` must never be stored.
   6. Log `slack_bot_connected { installId }`.

Refusals log `slack_bot_install_refused { installId?, reason }`: at info for `cancelled`, `invalid-state`, `invalid-request` and `unauthenticated`, and at warn otherwise. A `team-mismatch` bot stays pending, and its app sits in the other workspace until Cancel deletes it with the approver's token.

- [ ] **Step 1: Failing tests in `bot-callback.test.ts`:**
  - a. `'the approver's Allow activates the bot, stores its token, reads its handle and lands on its agent'`. Location is exactly `<origin>/?slack-bot=connected&agentId=<id>`. `oauth.v2.access`'s `redirect_uri` is the bot callback. The row is active with team and bot user. The handle is stored. Log `slack_bot_connected`.
  - b. `'another signed-in user's browser is refused without spending the state, with no agent id; the approver's visit then works'`.
  - c. `'signed out: failed, state not spent'`.
  - d. `'a shared install's state is unknown here'`.
  - e. `'expired → failed; access_denied → cancelled; another error → failed'`.
  - f. `'an app-id mismatch, an enterprise install, another workspace's team, or no active shared install: failed, still pending, no bot token stored'`.
  - g. `'an approver who no longer manages the agent: failed, nothing stored'`.
  - h. `'users.info failing, a name outside the handle pattern, or a reserved one (channel, here, everyone): active with a null handle'`.
  - i. `'a state works once'`.
  - j. `'no redirect or log line carries the code, the state, a token or a Slack id'`.
- [ ] **Step 2: `plugin.test.ts`.**
  - The route list and counts go to 20.
  - Add `'the bot callback is mounted: signed out it redirects to /?slack-bot=failed'`.
  - The file's `request()` helper (`:329-343`, `query: {}` hard-coded) gains a `query` option for this.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/bot-callback.test.ts`. Expected: FAIL. Implement. Re-run it, plus `plugin.test.ts` (Docker). Expected: PASS.
- [ ] **Step 4: Commit** `[TASK-1167] channel-slack: the bot's OAuth callback activates it only for the person who started it`.

### Task 9: Mentions of a bot run its agent; the shared bot steps aside [tier: sensitive]

**Needs `security-checklist`:** untrusted Slack event bodies routed by install id, and who an outsider runs as.

**Files:**
- Modify `router.ts`, `commands.ts`, `copy.ts`, `channels.ts` (export `connectable`, `:342-345`).
- Test: `router.test.ts`, `commands.test.ts`, `copy.test.ts`.

**Interfaces — Produces:**
```ts
// RouterDeps.installs: Pick<InstallStore, 'get' | 'botForAgent'>
// RouterDeps.channels: Pick<ChannelStore, 'get' | 'recordThread' | 'upsert'>
// router.ts, internal:
async function bindBotChannel(d: RouterDeps, install: InstallRow, botToken: string, channelId: string):
  Promise<{ ok: true; binding: ChannelBinding } | { ok: false; reason: 'channel-not-allowed' | 'slack-error' }>;
// copy.ts — exact copy:
COPY.answersAsOwnBot(botName: string, handle: string | null): string;
//   handle:  `${botName} answers as @${handle} now. Invite it with /invite @${handle}.`
//   null:    `${botName} has its own Slack bot now. Invite it to this channel to keep talking to it here.`
COPY.botUnavailable: "I can't answer you here right now. A team admin needs to check my settings in the web app.";
// commands.ts: IgnoreReason gains 'kind'
```
A name in these lines goes through copy.ts's `shown()`, as every outside name does.

- [ ] **Step 1: A bot install ignores DMs.** In `route()`, a screened DM on `kind 'bot'` logs `slack_event_ignored { reason: 'bot-dm' }` and calls nothing (Decision 2).
- [ ] **Step 2: The bot mention path, inside `routeMention`.** Steps 1–6 here and steps 3–4 below are what this task adds; the existing flow keeps every other line.
  1. On `kind 'bot'`, a missing binding never gets the "no agent here" reply.
  2. Admit the sender first.
  3. Then, if `channels.get(botId, channel)` is null, run `bindBotChannel`:
     - `conversationsInfo` with the bot token;
     - the answer's id must equal the channel;
     - `connectable(info)` must hold: public, live, neither Slack Connect nor a pending one;
     - then `channels.upsert({ installId: botId, channelId, agentId: install.agentId, connectedByUserId: install.requestedByUserId, channelName: info.name })`, and read it back.
  4. A refused channel is silent, logged `slack_event_ignored { reason: 'channel-not-allowed' }`. A Slack failure tells the admitted sender `COPY.turnFailed`.
  5. A binding whose `agentId !== install.agentId` is silent (`reason: 'binding-agent'`).
  6. From there, the existing tier, conversation, queue, job, `recordThread` and `runTurn` run with the bot's install.
- [ ] **Step 3: Who an outsider on a bot runs as.** This is Q1, as decided.
  - When `runsAsConnector(sender)`, a `kind 'bot'` install asks `teamAdminAccess(d.bus, lookupCtx(connectorId), agentId, connectorId)` instead of `agentAccess` (`router.ts:451-459`). The connector is the binding's `connectedByUserId`, which is the requester.
  - A `tier === 'unavailable'` on a bot install tells the sender `COPY.botUnavailable` instead of `COPY.channelUnavailable`, logged `slack_channel_unavailable { reason }` as today.
  - Members (`attended`) never ask about the requester.
- [ ] **Step 4: The shared bot steps aside.** On `kind 'shared'`, once the binding is found:
  - If `botForAgent(binding.agentId)` is `active`, answer `answerAdmitted(…, COPY.answersAsOwnBot(bot.botName, bot.botHandle))` and log `slack_event_ignored { reason: 'own-bot' }`.
  - A failed read logs and tells an admitted sender `turnFailed`. This fails closed: no shared turn.
  - In the queued job, after the binding re-read, a bot that is now active drops the turn silently (`slack_turns_dropped { reason: 'own-bot' }`).
- [ ] **Step 5: `/ax` ignores a bot install.** In `commands.ts:303`, `install.kind !== 'shared'` comes first in the ignore chain: an empty 200 with `slack_command_ignored { reason: 'kind' }`.
- [ ] **Step 6: Failing tests in `router.test.ts`.** First, the test world:
  - It forwards `agents:can-set-shared-credential` from its `fakeAgents` bus too; today it forwards only `agents:resolve` and `agents:list-for-user`, at `:345-360`.
  - The inline install store gains `botForAgent`.
  - `fakeSlack` answers `conversationsInfo`.
  - A `BOT` install (kind `bot`, its own id, app, bot user, `agentId` = the support agent, requester Ada, a team admin) sits beside `INSTALL`.

  The tests:
  - a. `'a member's mention of a bot in a public channel binds the channel to the bot's agent and runs an attended turn there'`:
    - one `conversations.info`, with the bot token;
    - the binding is `(botId, channel) → install.agentId`, connected by the requester, remember on;
    - `agent:invoke` for the bot's agent, as the member;
    - the conversation key is `slack:<botId>:<channel>:<ts>`;
    - a second mention makes no `conversations.info` call.
  - b. `'a private, archived, Slack Connect or pending-Connect channel, or an answer about another channel: no binding, no turn, no line'`.
  - c. `'a refused sender costs no conversations.info and binds nothing'`.
  - d. `'a binding on a bot install naming another agent runs nothing'`.
  - e. `'a DM to a bot does nothing'`.
  - f. `'an outsider's mention runs external as the requester while they are a team admin'`: key `…:external`, `recordThread` `runAs` = the requester.
  - g. `'an outsider gets the polite line and no turn once the requester is only a member, or gone; a member's mention there still runs attended'`.
  - h. `'the shared bot in a channel whose agent's bot is live: no turn; an admitted sender gets the line (with or without a handle); anyone else, silence'`.
  - i. `'the shared bot answers as today while the agent's bot is pending, and in another agent's channel'`.
  - j. `'a shared turn queued when the agent's bot goes live is dropped'`.
- [ ] **Step 7: Failing tests elsewhere:**
  - `commands.test.ts`: `'a signed /ax for a bot install is ignored'` (empty 200, no Slack call).
  - `copy.test.ts`: both `answersAsOwnBot` forms and `botUnavailable`, pinned exactly. None contains `@channel`, `@here`, `@everyone`, `AX`, `<` or `>`.
- [ ] **Step 8: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/router.test.ts src/__tests__/commands.test.ts src/__tests__/copy.test.ts`. Expected: FAIL. Implement. Re-run: PASS.
- [ ] **Step 9: Prove the guards bite.** On the committed tree:
  - (a) Remove Step 4's mention-time check. Test h must fail.
  - (b) Use `agentAccess` instead of `teamAdminAccess` in Step 3. Test g must fail.
  - Restore with `git checkout HEAD -- packages/channel-slack/src/router.ts` and check that `git status --short` is empty.
- [ ] **Step 10: Commit** `[TASK-1167] channel-slack: a bot's mentions run its agent, outsiders run as its requester, and the shared bot steps aside`.

### Task 10: Reachable from the canary; the whole path with the real vault [tier: integration]

**Files:**
- Test: `presets/memory/src/__tests__/canary.test.ts`. That's the channel-slack `it` at `:738`; add TASK-1167 to its title.
- Test: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`. One new `it`, appended **last**. The file's raw SQL (`:716`, `:727`, `:872`, `:926`, `:1061`, `:1853`) assumes a single install row, and this `it` leaves none behind.

- [ ] **Step 1: Canary (invariant 3).** Signed in as `CANARY_ADMIN`:
  - `POST /settings/slack/no-such-agent/bot`: without the CSRF header → 403; with it → 404 `{ error: 'not-found' }`. That's the route's own answer; an unmounted POST would be the router's 405.
  - The same for `/bot/install-url` and `/bot/cancel`.
  - Signed out, `GET /slack/bots/oauth/callback?state=x` → 302, with a Location ending `/?slack-bot=failed`.
- [ ] **Step 2: Composition test.** Title: `'a team agent's own bot: requested, allowed, mentioned, the shared bot steps aside, Disconnect leaves it and keeps its approver's token, deleting the agent deletes it (TASK-1167)'`.
  1. A team admin of the agent's team with no stored token requests a bot, pasting a refresh token. The fake Slack answers `tooling.tokens.rotate`, `apps.manifest.create` and `apps.icon.set`; extend its method list where it says `unknown_method` (`:422`).
  2. The callback runs, with `oauth.v2.access` and `users.info` for the bot user.
  3. Check the vault and the row:
     - three refs under the bot's id;
     - the requester's `slack:person:<id>:config-refresh-token` holds the rotate's successor, never the paste;
     - the shared install's refs and its person's token are unchanged;
     - the row is active, with its handle.
  4. A member mentions the bot in `SUPPORT_CHANNEL`, signed with the bot's signing secret on `/slack/events/<botId>`. Expect the binding written, and an invoked turn for the agent with key `slack:<botId>:…`.
  5. The shared bot is mentioned in the same channel. Expect no new turn, and one `chat.postEphemeral` carrying `answersAsOwnBot`.
  6. Admin › Slack Disconnect. Expect the bot row still active, its refs and the requester's person token intact, and `tokenKept: false` (the shared install's person approved no bot here).
  7. `dropAgent`. Expect the requester's token rotated and `apps.manifest.delete` for the bot's app. Then the row, its three refs and the requester's person token are gone.
- [ ] **Step 3: Run**, one package at a time:
  - `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/preset-memory exec vitest run src/__tests__/canary.test.ts`
  - `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/channel-slack-composition.test.ts src/__tests__/preset.test.ts`

  Expected: PASS. To show the new `it` bites, remove Task 5's `bots.removeForAgent` call in `agents-deleted.ts` on the committed tree: step 7 must fail. Restore with `git checkout HEAD -- …`. If local Docker can't run these, say so in the handoff.
- [ ] **Step 4: Commit** `[TASK-1167] presets: a team agent's own Slack bot is reachable from the canary and works end to end`.

### Task 11: Agent settings: "Its own Slack bot" [tier: integration]

Invoke the `shadcn` skill first. The `ux-design` skill is advisory.

**Files:**
- Create `packages/channel-web/src/components/slack/SlackConfigToken.tsx`. It takes, moved from `components/admin/SlackTab.tsx`: `SLACK_APPS_URL` `:86`, `SlackAppsLink` `:115-126` and `TokenField` `:308-344`.
- Create `packages/channel-web/src/lib/slack-token-copy.ts`. It takes, moved from `lib/slack-admin.ts:297-332`: `BOT_NAME_COPY`, the name fallback, and the copy for `invalid-refresh-token`, `slack-refresh-token`, `slack-name`, `slack-unconfirmed` and `slack-token`. Add `bot-name-taken`.
- Modify `SlackTab.tsx` and `lib/slack-admin.ts`. Import the moved pieces, and map Task 4's `bot-name-taken` to the name field.
- Modify `lib/agent-slack.ts`: types, parsing `bot` on both states, `requestSlackBot`, `continueSlackBot`, `cancelSlackBot` and `agentSlackBotErrorCopy`.
- Create `components/workspace/AgentSlackBot.tsx`.
- Modify `components/workspace/AgentSlack.tsx`:
  - Render the section on `no-workspace` and `ready`.
  - Hide `ChannelPicker` while the bot is live.
  - Add one line above the channel list while it's live.
- Create `lib/slack-bot-return.ts`.
- Modify `App.tsx`.
- Tests:
  - `components/admin/__tests__/SlackTab.test.tsx` and `__tests__/admin-slack.test.tsx`: existing bodies unchanged, plus one test each.
  - `lib/__tests__/agent-slack.test.ts` (its `no-workspace` case at `:73-74` gains `bot`) and `components/workspace/__tests__/AgentSlack.test.tsx` (`:82`, `:104` gain `bot`).
  - New: `components/workspace/__tests__/AgentSlackBot.test.tsx`, `lib/__tests__/slack-bot-return.test.ts` and `__tests__/slack-bot-return-app.test.tsx`.

**Interfaces — Produces:**
```ts
// lib/agent-slack.ts (mirrors the wire by shape)
export type AgentSlackBot = /* Task 7's union */;
export function requestSlackBot(agentId: string, i: { botName: string; refreshToken?: string; iconPng?: string }): Promise<{ installUrl: string; iconSet: boolean }>;
export function continueSlackBot(agentId: string): Promise<{ installUrl: string }>;
export function cancelSlackBot(agentId: string): Promise<{ appDeleted: boolean }>;
/** `revealToken`: the refusal means "paste a token" (slack-config-token, config-token-needed, slack-token). */
export function agentSlackBotErrorCopy(err: unknown): { field: 'botName' | 'refreshToken' | null; message: string; revealToken: boolean };
// lib/slack-bot-return.ts
export function readSlackBotReturn(search: string): { outcome: 'connected' | 'cancelled' | 'failed'; returnPath: string | null } | null;
export function withoutSlackBotReturn(search: string): string;
```
`returnPath` is built only through `parseWorkspaceRoute(`/workspace/agents/${encodeURIComponent(id)}/settings/slack`)` and then `workspaceRoutePath`, as `lib/oauth-full-page-return.ts:60-66` does. An empty id, `.`, `..` and bad escapes give `null`.

**The token field.** It shows when `bot.state === 'none' && !bot.configTokenStored`, or after a refusal whose `revealToken` is true; while it shows, it is `required`. It's otherwise absent, and the request then carries no `refreshToken`. A shown field's value is trimmed, cleared as the request goes out, and sent as `refreshToken`. It stays uncontrolled, as `SlackTab.tsx:358-363` does.

**Copy (pinned):**

| Where | Text |
|---|---|
| Title | "Its own Slack bot" |
| `none`, manager, `ready` | "Give {agentName} its own name in Slack. People mention it directly, and you add it to a channel with /invite. You need to be able to install apps in Slack." |
| …with the token field | Steps: "Open {SlackAppsLink}. Under **Your App Configuration Tokens**, click **Generate Token** for your workspace." then "Paste the refresh token below. We keep it for every Slack app you set up here, so you only do this once." Field: `TokenField id="slack-bot-refresh-token" label="Refresh token" hint="Starts with xoxe-"` |
| …without it (`configTokenStored`) | "We'll use the configuration token you gave us before." |
| Fields | "Bot name" (prefilled with `agentName`; the server judges it) |
| Button | "Create the Slack bot" |
| `pending`, approver | "Almost there: finish adding {botName} in Slack." Buttons "Continue in Slack" (only when `canContinue`) and "Cancel request" |
| `pending`, other manager | "{approver} is finishing this in Slack." Button "Cancel request" |
| `live` | "@{handle} is live. Invite it to a channel with /invite @{handle}." (with a null handle: "{botName} is live. Invite it to a channel with /invite.") Managers also see "Set up by {approver}." |
| `live`, `needsClaim` | "{botName} needs a team admin to claim it. Until then it answers team members only." (to everyone who sees the live line) |
| `live`, above the channel list | "Mentioning the shared bot in these channels no longer reaches {agentName}. Invite @{handle} to each one." |
| Return toasts | connected: "The Slack bot is live. Invite it to a channel with /invite." · cancelled (info): "Slack install was cancelled. You can continue it from the agent's Slack settings." · failed (error): "We couldn't finish adding the Slack bot. Try again from the agent's Slack settings." |
| Errors, on a field | `bot-name-taken` (name): "Another Slack bot here already uses that name. Pick another." `invalid-bot-name` and `slack-name` (name), and `invalid-refresh-token` and `slack-refresh-token` (token): the shared copy. |
| Errors that reveal the token field | `slack-config-token`: "The configuration token we kept for you stopped working. Generate a new one on {SlackAppsLink} and paste it below." `config-token-needed`: "Paste a configuration token to continue." `slack-token`: "Slack didn't accept the configuration token. Generate a new one and paste it below." |
| Other errors | `bot-exists`, `not-pending`: re-read the status. `no-workspace`: "Slack isn't connected yet. An admin connects it first." `not-approver`: "Only the person who set this up can continue it in Slack." `public-origin-not-https`, `slack-unconfirmed` and anything else: Admin › Slack's existing copy. |

Non-managers see only the `live` lines. The picture is `renderSlackAvatar()`; a `null` sends no `iconPng`. Navigation goes through `goToSlack(installUrl)` from `lib/slack-admin.ts`.

- [ ] **Step 1: Extract** `SlackConfigToken.tsx` and `slack-token-copy.ts`, and import them in `SlackTab.tsx` and `slack-admin.ts`. Run `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/SlackTab.test.tsx src/__tests__/admin-slack.test.tsx`: same counts, PASS. Commit `[TASK-1167] channel-web: share the Slack token field, guide link and copy`.
- [ ] **Step 2: Failing tests:**
  - `AgentSlackBot.test.tsx` (mock `@/lib/agent-slack` partially, plus `@/lib/slack-avatar` and `goToSlack`):
    - one render per state and role from the table;
    - with `configTokenStored: true`, no token field, and the request carries no `refreshToken`;
    - with `false`, the field is shown and required, and the submit trims, clears and sends `{ botName, refreshToken, iconPng }` (no `iconPng` when the avatar is null), then calls `goToSlack`;
    - a `slack-config-token` refusal reveals the field with its line, and the next submit sends the paste;
    - each other refusal code lands where the table says;
    - Continue calls `continueSlackBot`, then `goToSlack`. Cancel calls `cancelSlackBot`, then re-reads;
    - `needsClaim` shows its line;
    - members see only the live lines, and the picker is hidden while the bot is live.
  - `agent-slack.test.ts`: the three POSTs (path, `x-requested-with`, credentials, body, and no `refreshToken` key when none is given), and the status parsing `bot` on both states, with a malformed `bot` treated as a bad response.
  - `slack-bot-return.test.ts`: only the three outcomes, the `returnPath` rules, and both params stripped.
  - `slack-bot-return-app.test.tsx`: `/?slack-bot=connected&agentId=a1` ends on `/workspace/agents/a1/settings/slack` with one toast, **for a non-admin too**. `?slack=` behaves as before.
  - `SlackTab.test.tsx` and `admin-slack.test.tsx`: `bot-name-taken` shows under the name field.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-web exec vitest run <those files>` (a zsh array). Expected: FAIL. Implement. Re-run: PASS. Then `pnpm --filter @ax/channel-web build` (its tsc checks tests) and `pnpm lint`.
- [ ] **Step 4: Commit** `[TASK-1167] channel-web: request, continue and see a team agent's own Slack bot`.

### Task 12: Stale lines, the design doc, and the changeset [tier: mechanical]

**Files:**
- Modify `docs/plans/2026-11-09-channel-slack-design.md`.
- Modify the `packages/channel-slack/src/plugin.ts` header (`:69-93`): the route list now has the three bot routes and the bot callback, and "It keeps one install row" becomes the shared install plus one row per team bot.
- Create `.changeset/slack-dedicated-bot.md`.

- [ ] **Step 1: The design's stale lines.** These are what made the card's text look right, and they'd mislead the next phase 2 card.
  - §3 `:303-309`. "Disconnect Slack deletes the apps … then tells whoever generated the token to click Revoke" becomes: it says so only when nothing else needs the token. While a team bot or a leftover app still names the person, the token is kept and the notice says not to revoke it (TASK-1167).
  - §3 `:384-385`. "Admin › Slack › Disconnect (and a reset) removes every channel connection with the install" becomes: Disconnect removes the shared install and its channels and leaves team bots alone. A bootstrap reset (`ax admin reset-bootstrap`) wipes every agent and secret, so it removes every install, team bots included, and logs each app id with its kind.
- [ ] **Step 2: Add an "As built (TASK-1167)" paragraph to §4.** It covers:
  - the self path only (ask-an-admin is a later card), with the approver = the requester;
  - an approver with a stored token pastes nothing; a dead one is re-asked;
  - Cancel for a pending request;
  - the name rule, with a 21-character letters-and-digits key, spanning the shared bot too;
  - the binding written on the first mention, after the channel check;
  - outsiders run as the requester while they're a team admin, else a polite line and "needs a team admin to claim it";
  - the shared bot steps aside only for a live bot;
  - deletion with the agent.

  Update §6's routes paragraph (`:778-787`) with the four routes. Add a progress line to §9 phase 2 item 8.
- [ ] **Step 3: Changeset**, `'@ax/channel-slack': patch` and `'@ax/channel-web': patch`, in the repo's voice: "A team agent can now have its own Slack bot. A team admin picks its name and clicks Allow in Slack. If we already hold their Slack configuration token they paste nothing; otherwise they paste one once. People then mention the bot by name in any public channel it's invited to, and the shared bot steps aside for that agent. Deleting the agent deletes its bot. Disconnecting the shared bot leaves team bots alone, and no longer tells you to revoke a token they still use."
- [ ] **Step 4: Commit** `[TASK-1167] docs: the Slack design catches up with the first team bots`.

---

## Final gate

- [ ] `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, with `DOCKER_HOST` set and `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000`, then `pnpm lint`.
  - `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js` passes without edits. `channel_slack_v1_installs` gains `agent_id`, but `store.ts` already holds `DELETE FROM channel_slack_v1_installs` and `agents-deleted.ts` subscribes. That guard can't see whether bot rows actually go; Task 5's tests prove it.
  - `channel-slack-boundaries.test.js` passes with no new allowlist entry.
- [ ] `security-checklist` once for the PR, covering Tasks 2, 5, 7, 8 and 9. Threats to answer:
  - the approver's token: every use under the app lock, the successor saved before use, the paste never stored, release only through `personHasApps`, no per-bot token, and `configTokenStored` as the only token fact answered;
  - state-user binding and login CSRF (Task 8 b, c, i);
  - kind-scoped state (Task 2, Task 8 d);
  - cross-agent rights: the in-lock re-check, the callback's re-check, `/ax` ignoring bot installs, and a bot binding only for `install.agentId`;
  - who outsiders run as: the requester, only while a team admin;
  - shared-install isolation: `current()`, Disconnect and the admin callback;
  - untrusted Slack bodies routed by install id: ingress unchanged, DMs ignored on bots, `conversations.info` answers checked, and the handle checked before it's stored;
  - no new egress: every Slack method used is one `slack-api.ts` already sends.

  Residuals to state:
  - (a) A paste of someone else's token overwrites the paster's own slot (Connect has the same).
  - (b) No workspace in the token key: a shared Connect in another workspace overwrites the connecting admin's slot, and their bots in the old workspace lose management.
  - (c) A bot request racing a CLI reset (which takes no shared lock) can leave a bot row for a TRUNCATEd agent.
  - (d) Members' words in a bot's channels are remembered by default, with no switch yet.
  - (e) A failed first-time request releases the pasted token's successor, so the retry needs the paste again.
- [ ] Before the PR, run `git grep -n "OAUTH_CALLBACK_PATH\|peekOAuthState\|consumeOAuthState\|removeAll()\|createMutex()"`. Every state read must pass a kind, `removeAll()` must be only the reset's, and `createMutex()` must be created once in `plugin.ts`.

## For the builder's handoff

- **`followups`:**
  1. The phase 2 real-Slack walk card. Cover the self path with a stored-token approver and a paste approver, Allow, `/invite`, a mention, the shared bot stepping aside, a demoted requester's outsiders, the Disconnect notice while a bot lives, and agent delete. Also check that a dedicated bot's app can't be DMed (`messages_tab_enabled: false`).
  2. The ask-an-admin path (Decision 3's second option).
  3. Bot rename, avatar and Replace (approver only, Decision 5), and Disconnect of a live bot.
  4. Admin › Slack lists each bot with its approver (design §4 Lifecycle).
  5. A bot's channels with their remember switch in agent settings: today they're remembered by default, with no switch.
  6. TASK-1173 (claim) must move the row's `requested_by_user_id` and the bot install's bindings' `connected_by_user_id` in one statement.
  7. A workspace in the per-person token key before one person's apps can span two workspaces (TASK-1175 residual h).
  8. If a card was filed for TASK-1175's round-2 nit 6 ("the Disconnect notice says Revoke while the token is kept"), Task 6 does it: close that card.
- **`learnings`:**
  - A dedicated bot is a `kind 'bot'` row in the installs table, with three per-install secrets. Its configuration token is its approver's person token (`connected_by_user_id`); there's no per-bot token.
  - `current()` is shared-only; `removeAll()`, `list()` and `personHasApps()` see every kind.
  - OAuth state reads take a kind.
  - Every Slack-app write and token use shares one app lock (`plugin.ts`), and it isn't re-entrant.
  - Outsiders on a bot run as `requested_by_user_id`, copied into each binding at its first mention. The router's connector check on a bot is `teamAdminAccess`.
  - `releaseConfigToken` answers `'kept' | 'released'`, and Disconnect answers `tokenKept`.
  - Bot names are unique by a 21-character letters-and-digits key across the shared bot and every bot.
  - The bot callback lands on `/?slack-bot=…&agentId=…`.
