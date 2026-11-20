# TASK-1167: A team agent's own Slack bot (self-approved path) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: BLOCKED on two questions only Vinay can answer (Q1, Q2 below).** Every other call is made and logged. Q1 changes one router step (Task 8, Step 4, marked BLOCKED). Q2 decides where a bot's configuration token lives, which Tasks 5, 6 and 10 depend on. Tasks 1–4 are safe under any answer. Do not build past them until both answers are recorded in the decisions shard and the marked steps are edited.

**Goal:** A team admin gives a team agent its own Slack bot with their own configuration token. Once they click Allow in Slack, @mentions of that bot in public channels it was invited to run turns for the agent, the shared bot stops answering for that agent, and deleting the agent deletes the bot's Slack app.

**Architecture:** A dedicated bot is a second kind of row in `channel_slack_v1_installs` (`kind = 'bot'`, with its `agent_id`). The per-install events route, interactions route, signing secret, vault refs and OAuth state therefore work for it unchanged. Admin › Slack's Slack-app steps move into one shared module (`slack-apps.ts`) first, with no behaviour change. A new `bots.ts` uses them to request, continue, cancel, show and remove a bot, all under one app lock. A new signed-in OAuth callback activates the bot only for the user who started it. The router gives a bot install its own mention path (channel check, then a binding written on the first mention) and makes the shared bot stay quiet for an agent whose own bot is live. channel-web gets an "Its own Slack bot" section, built from pieces extracted out of Admin › Slack.

**Tech Stack:** TypeScript, Kysely/Postgres (additive migration), the hook bus (`credentials:*`, `agents:*`, `auth:*`), React + shadcn (channel-web), vitest + Testcontainers.

**Spec:** card TASK-1167 (its "Decisions (Vinay, 2026-11-19)" override the card body), design `docs/plans/2026-11-09-channel-slack-design.md` §4, §7, §8, §9 phase 2, and `.claude/memory/decisions/2026-11-19-TASK-1167.md`. That shard holds every call below, with alternatives. Read it before Task 2.

---

## Open questions (BLOCKING: record each answer in the shard, then edit the marked steps)

### Q1 — Who does an outsider's turn on a dedicated bot run as? (blocks Task 8, Step 4)

Card Decision 1 says "the agent's owner, read when the turn runs, nothing recorded per binding". A dedicated bot only ever belongs to a team agent, and **a team agent has no owning person**:

- `Agent.ownerType` is `'team'` and `ownerId` is the team's id (`packages/agents/src/types.ts:44-47`).
- The agents plugin's own rule names the team's admins, plural: "the agent's 'owner': a team agent has no single owning person" (`packages/agents/src/plugin.ts:1180-1181`).
- Teams have only `admin` and `member` roles, no owner (`packages/teams/src/types.ts:13`; `migrations.ts:20` defers an owner role).
- A team agent can't move to another team (`packages/agents/src/store.ts:376-389`).
- `teams:list-members` answers only an admin actor (`packages/teams/src/plugin.ts:283-293`), so channel-slack can't even list a team's admins today.
- TASK-1090 rejected "the owner" for the shared app for exactly this reason (`.claude/memory/decisions/2026-11-12-TASK-1090.md`, row 2).

A turn must run as one real user (memory refuses synthetic owners, `packages/memory/src/owner.ts`; `agents:resolve` has no system actor). That user's access is what the outsider borrows, their Today gets the outsider's held calls, and their conversation holds the thread. Options:

- **A. The bot's requester.** This is the card's own Routing text, and the shared app's rule (whoever connected the channel). Cheapest: the materialized binding stores them, and the existing outsider path runs unchanged. If they lose the agent, outsiders get "a team admin needs to connect me again" until the bot is rebuilt. It contradicts Decision 1's "not the requester".
- **B. One of the team's current admins, picked when the turn runs** (for example the longest-standing one). This matches Decision 1's "follows an ownership change". It needs:
  - a new host-only teams hook (for example `teams:list-admins { teamId } → { userIds }`), with a boundary review and manifest/preset pin updates;
  - the agent's team id on the bot row (immutable, so safe to store);
  - a channel-store branch, because the outsider thread write can no longer check the run-as person in SQL.

  Outsiders' held calls then land in that admin's Today, whether or not they know the bot exists.
- **C. Members only on a dedicated bot.** Outsiders get silence (or one private line), and nobody's access is borrowed. Simplest and safest. But once an agent's bot is live, outsiders lose that agent in its channels, because the shared bot steps aside there.

Planner's lean: B is the only option that matches Decision 1's intent. C is the safe fallback if outsiders on dedicated bots can wait.

### Q2 — Can each bot keep its own copy of its approver's configuration token? (blocks Tasks 5, 6, 10)

Three measured facts combine:

1. Slack allows one configuration token per person per workspace (TASK-1163 decisions, row 3).
2. After AX's first rotate, the person's own copy dies within minutes to hours (design §7, TASK-1097).
3. Revoking a token also kills the rotated copy AX stores. TASK-1163 check 4: "Rename after the revoke and before the Replace failed at `rotate` with `invalid_refresh_token`" (`deploy/kind/walks/2026-11-19-TASK-1163/REPORT.md`). Design §3 `:299-303` and §7 `:926` still call this "unmeasured" (fixed in Task 11).

So **AX can keep a working token for only one Slack app per person.** Anyone who already gave AX a token has to revoke and generate a new one to approve a bot. That includes the shared bot's admin (Vinay, today) and anyone approving a second bot. The revoke silently kills the token AX holds for their other app: it can't be renamed or re-synced any more, and Disconnect or the agent's delete leaves its app on the leftover list.

- **(a) One stored token per person,** used by every app that person created, with each rotate writing back to that one slot. A person who already has a token in AX approves without pasting. This fixes the trap for every phase 2 path, ask-an-admin included. It changes the shared install's shipped storage (Connect, Rename, Replace, Disconnect, plus a migration of the stored token). Planner's lean: do this as a **prerequisite card**, then re-plan Tasks 5, 6 and 10 on top of it.
- **(b) Per bot, as decided (this plan as written),** plus one warning sentence on the form (Task 10): pasting a new token ends the one AX holds for their other Slack apps, which then each need Replace. No extra work. The trap stays, documented.

---

## What the brief got wrong (checked against the code; details in the shard)

1. **Decision 1 assumes a team agent has an owner.** It doesn't (Q1).
2. **"`removeAll()` scoped to `kind = 'shared'`" would strand dead rows.** Its only caller is the bootstrap reset (`plugin.ts:511-544`). `ax admin reset-bootstrap` wipes every credential, `slack:*` included (`packages/cli/src/commands/admin/reset-bootstrap.ts:162-200`), and TRUNCATEs every agent without firing `agents:deleted` (`packages/agents/src/plugin.ts:770-776`). So `removeAll()` keeps removing every install, bots included, and the reset log gains `kind`. Disconnect is scoped through `current()` alone, which gives Decision 4.
3. **"Under that agent's lock": no per-agent lock exists.** Name uniqueness spans every bot and the shared bot, so all Slack-app writes share the existing admin mutex, created once in `plugin.ts`.
4. **"Same peek-then-consume state as `OAUTH_CALLBACK_PATH`": today's peek and consume match any install's state** (`store.ts:239-282`). Both callbacks must be scoped to their own kind.
5. **"`events.ts`/`ingress.ts` already pick the signing secret by id and drop a body whose `api_app_id` doesn't match": true** (`ingress.ts:103-141`, `events.ts:265-277`). No change.
6. **`slackUrls()` hard-codes the admin callback, and `buildInstallUrl()` hard-codes `BOT_SCOPES`** (`manifest.ts:64-72`, `:120-128`). `manifest.test.ts:17-22` pins `slackUrls()` to exactly four keys. So the bot gets its own `botUrls()`, and `buildInstallUrl` gets a `scopes` argument.
7. **"Every failure after create reuses admin-routes' undo path, `rememberLeftoverApp`": only `undoCreate` remembers.** `undoConnect` forgets an app whose delete fails (`admin-routes.ts:482-516`). The bot path composes both. The shared `undoConnect` stays as it is (follow-up).
8. **The card has no way to cancel a pending request.** One failed or cancelled Allow would block the agent's bot for good (one bot per agent, pending included). Task 6 adds Cancel.
9. **`?slack=` is taken.** App.tsx reads it on any path and opens Admin › Slack for admins. The bot callback returns with `?slack-bot=`.
10. **`ConnectForm`'s refresh-token field and guide link are private to `SlackTab.tsx`** (`:86`, `:115-126`, `:308-344`), and the token/name error copy is private to `lib/slack-admin.ts` (`:323-366`). Task 10 extracts them before reuse.
11. **Decision 3's choice (self vs. "Ask an AX admin") can't ship yet.** Its second option has no path until the later card. This card shows the self path only, with no choice control (invariant 3).

## Global Constraints

- Merge `origin/main` before Task 1 and again before the PR (Slack cards land daily).
- Ship ONE PR from this branch, several commits. The card's "stack" existed only to avoid a half-wired window.
- No new hook, IPC action or manifest `calls` entry, so no boundary review and no preset pin change. **Exception:** Q1 = B adds one teams hook, and with it a boundary review plus pins in `plugin.test.ts:548-614` and `presets/k8s/src/__tests__/preset.test.ts:1287-1367`.
- channel-web mirrors wire shapes and never imports `@ax/channel-slack` (invariant 2).
- No string literal starting with `slack:` anywhere outside `packages/channel-slack/` (`scripts/__tests__/channel-slack-boundaries.test.js`, rule 2; JSX attributes count). The new return parameter is `slack-bot`.
- Logs stay code-only:
  - Message names start with `slack_`.
  - Field keys stay within `installId`, `reason`, `stage`, `code`, `appDeleted`, plus `kind` on the reset line.
  - Never an agent id, a user id, a Slack id other than the install id, a name, a URL, an OAuth code or state, or a token.
  - Bot-path failures log `slack_bot_failed`, refusals `slack_bot_install_refused`, and successes `slack_bot_requested`, `slack_bot_connected`, `slack_bot_cancelled`, `slack_agent_bot_removed`.
- Where each token goes:
  - The pasted refresh token goes only to `tooling.tokens.rotate`.
  - The minted refresh token goes only to the vault, under the bot's own `slack:<installId>:config-refresh-token`, written as the requester.
  - The minted access token goes only to `apps.manifest.create`, `apps.icon.set` and the undo's `apps.manifest.delete`. Then it is dropped.
  - No response body ever carries a token.
- Every Slack-app write (admin routes, bot routes, bot callback, bot removal) runs under the one app lock (`Mutex.run`).
- POSTs keep http-server's CSRF check (no `bypassCsrf`). The new GET callback relies on the OAuth state, as the admin callback does.
- Migrations are additive and idempotent, because every boot runs them. The CLI reset test's raw insert (`packages/cli/src/__tests__/admin-reset-bootstrap.test.ts:401-409`) must keep working, as must its drop-only-the-installs-table `afterEach` (`:77`).
- UI rules:
  - shadcn primitives and semantic tokens only (invariant 6). Invoke the `shadcn` skill before editing.
  - Never write "AX" in a sentence (white-label rule, TASK-1093 decisions).
  - Copy is pinned in Task 10. A `ux-design` pass may change wording only if it records the change in the shard and updates every pin.
- Test rules:
  - The fake Slack stays strict: it retires a rotated token at once. Never loosen it.
  - Fake tokens come from `__tests__/fake-slack-tokens.ts` (channel-web: `test-utils/fake-slack-tokens.ts`). Never use a real token's shape.
  - No literal invisible characters (`source-hygiene.test.ts`).
- Single test files run as `pnpm --filter <pkg> exec vitest run <file>`. `pnpm --filter <pkg> test -- <file>` runs the whole package suite (TASK-1135 learning).
- Docker-backed files run one package at a time, with an explicit `DOCKER_HOST` and `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000` (the helper's maximum). In channel-slack those are `store`, `channel-store`, `agents-deleted` and `plugin`; the rest use fakes. Never add a hook or test budget above the package's vitest `hookTimeout` (channel-slack 120 000 ms, preset-k8s 180 000 ms; `scripts/__tests__/out-of-process-test-timeouts.test.js`).
- Run each touched package's build (tsc) alongside vitest. channel-slack's tsc excludes tests; channel-web's includes them.
- Final gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, plus `pnpm lint`.

## Review Focus

1. **A requester pastes a refresh token AX already rotated, or one that's revoked** (the Q2 trap's first symptom). Expected: 502 `slack-refresh-token`, no Slack app made, nothing stored. Pinned by Task 6 test b.
2. **A double click on "Create the Slack bot", or two team admins at once.** Expected: exactly one Slack app, and the other request gets 409 `bot-exists`. Pinned by Task 6 test h.
3. **The agent deleted while its bot request is running.** Expected: no bot is left for a deleted agent. Pinned by Task 5 test f and Task 6 test i.
4. **Someone else's browser opens the approver's Slack return link.** Expected: refused without spending the state, no agent id in the redirect, and the approver's own visit still works. Pinned by Task 7 test b.
5. **The shared bot mentioned in a channel whose agent's bot is still pending, or in another agent's channel.** Expected: the shared bot answers exactly as today. Only a live bot makes it step aside, and only for its own agent. Pinned by Task 8 tests f and g.

## File map

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/slack-apps.ts` (new) | shared Slack-app steps and helpers; `namesInUse` | 1, 4 |
| `packages/channel-slack/src/admin-routes.ts` | uses `slack-apps.ts`; kind-scoped state; `bot-name-taken` on Connect and Rename | 1, 2, 4 |
| `packages/channel-slack/src/manifest.ts` | `buildInstallUrl` scopes; bot manifest, `botUrls`, constants; header | 1, 3, 11 |
| `packages/channel-slack/src/migrations.ts` | four columns, CHECK, partial unique index, header | 2 |
| `packages/channel-slack/src/store.ts` | `InstallRow` fields, bot methods, kind-scoped state, docs | 2 |
| `packages/channel-slack/src/bot-name.ts` | `botNameKey`, `isBotNameTaken`, header | 4 |
| `packages/channel-slack/src/bots.ts` (new) | `removeBot` (5); `createBots`: request, installUrl, cancel, status (6); finish (7) | 5, 6, 7 |
| `packages/channel-slack/src/agents-deleted.ts` | bot removal under the app lock | 5 |
| `packages/channel-slack/src/agent-routes.ts` | three bot routes, `bot` in the status, wider deps | 6 |
| `packages/channel-slack/src/bot-callback.ts` (new) | `GET /slack/bots/oauth/callback` | 7 |
| `packages/channel-slack/src/router.ts`, `commands.ts`, `copy.ts` | bot mention path, the shared bot steps aside, `/ax` ignores bots | 8 |
| `packages/channel-slack/src/channel-store.ts` | only if Q1 = B | 8 |
| `packages/channel-slack/src/plugin.ts` | one app lock, wiring, route order, reset log `kind`, header | 2, 5, 6, 7, 11 |
| `packages/channel-slack/src/__tests__/{memory-install-store,fake-slack-config,fake-vault}.ts` (new) | fakes moved out of `admin-routes.test.ts` (1), extended (2) | 1, 2 |
| `presets/memory/src/__tests__/canary.test.ts`, `presets/k8s/src/__tests__/channel-slack-composition.test.ts` | reachability; the whole path with the real vault | 9 |
| `packages/channel-web/src/components/slack/SlackConfigToken.tsx`, `lib/slack-token-copy.ts` (new) | extracted from Admin › Slack | 10 |
| `packages/channel-web/src/components/workspace/AgentSlackBot.tsx`, `lib/slack-bot-return.ts` (new) | the bot section; the return param | 10 |
| `packages/channel-web/src/{components/admin/SlackTab.tsx,lib/slack-admin.ts,lib/agent-slack.ts,components/workspace/AgentSlack.tsx,App.tsx}` | reuse, API, mounting, return handling | 10 |
| `docs/plans/2026-11-09-channel-slack-design.md`, `.changeset/slack-dedicated-bot.md` | stale lines; what shipped | 11 |

---

### Task 1: Share the Slack-app steps, with no behaviour change [tier: integration]

Safe under any Q1/Q2 answer. `admin-routes.test.ts` is the guard: its test bodies don't change.

**Files:**
- Create: `packages/channel-slack/src/slack-apps.ts`
- Modify: `packages/channel-slack/src/admin-routes.ts`. Moves out: the token prefixes and regexes `:183-192`, `TOKEN_ERRORS`/`REFRESH_TOKEN_REFUSED`/`UNCONFIRMED_CODES`/`HTTP_5XX` `:194-240`, the helpers `:281-335`, and the steps `mintInstallUrl`, `setIcon`, `undoConnect`, `undoCreate` (`:436-516`), the core of `finishInstall` (`:619-674`), `saveRotatedToken` and `deleteSlackApp` (`:683-723`). Everything else stays.
- Modify: `packages/channel-slack/src/manifest.ts:120-128`. `buildInstallUrl` takes an optional `scopes` (default `BOT_SCOPES`).
- Create, moved verbatim from `admin-routes.test.ts`: `__tests__/memory-install-store.ts` (`memoryStore`, `:201-360`), `__tests__/fake-slack-config.ts` (`fakeSlack`, `:378-460`), `__tests__/fake-vault.ts` (the bus vault, `:499-539`).
- Test: `admin-routes.test.ts` imports the moved fakes. Nothing else changes.

**Interfaces — Produces:**
```ts
// slack-apps.ts
export const ACCESS_TOKEN_PREFIX: 'xoxe.xoxp-';
export const REFRESH_TOKEN_PREFIX: 'xoxe-';
export const STATE_RE: RegExp;
export const OAUTH_CODE_RE: RegExp;
export function sha256Hex(text: string): string;
export function isHttps(origin: string): boolean;
export function bodyObject(body: Buffer): Record<string, unknown> | null;
export function configToken(value: unknown, prefix: string): string | null;
export function createAppError(err: unknown): 'slack-token' | 'slack-name' | 'slack-unconfirmed' | 'slack-error';
export function refreshTokenError(err: unknown): 'slack-refresh-token' | 'slack-error';
export interface InstallLink { redirectUrl: string; scopes: readonly string[] }
export interface AppStepsDeps {
  store: Pick<InstallStore, 'setOAuthState' | 'remove' | 'rememberLeftoverApp' | 'activate'>;
  secrets: SecretStore; api: SlackApi; logger: Logger;
  now: () => number; randomBytes: (n: number) => Buffer;
  /** Every failure line is `${logPrefix}_failed`: admin passes 'slack_admin', so its lines are unchanged. */
  logPrefix: 'slack_admin' | 'slack_bot';
}
export interface AppSteps {
  failed(stage: string, err: unknown, installId?: string, level?: 'warn' | 'error'): void;
  mintInstallUrl(installId: string, clientId: string, userId: string, link: InstallLink): Promise<string>;
  setIcon(accessToken: string, appId: string, installId: string, icon: ParsedIcon | null): Promise<boolean>;
  undoCreate(accessToken: string, appId: string, installId: string, botName: string): Promise<void>;
  undoConnect(accessToken: string, appId: string, installId: string): Promise<void>;
  saveRotatedToken(owner: SecretOwner, refreshToken: string): Promise<boolean>;
  deleteSlackApp(install: InstallRow): Promise<boolean>;
  /** Client secret → oauth.v2.access → app id and enterprise checks. Logs `oauth-access` itself; the caller logs the other refusals. */
  exchangeCode(install: InstallRow, code: string, redirectUrl: string):
    Promise<{ ok: true; granted: OAuthInstall } | { ok: false; reason: 'no-client-secret' | 'oauth-access' | 'app-mismatch' | 'enterprise-install' }>;
  /** Bot token first, then activate; on failure, logs the stage and removes the bot token. */
  storeGrant(install: InstallRow, granted: OAuthInstall): Promise<boolean>;
}
export function createAppSteps(d: AppStepsDeps): AppSteps;
```

- [ ] **Step 1: Baseline.** Run `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts src/__tests__/manifest.test.ts`. Expected: PASS. Write down both test counts (admin-routes has 103).
- [ ] **Step 2: Move the three fakes** out of `admin-routes.test.ts` into their own files, unchanged, and import them. Re-run Step 1: same counts, PASS. Commit `[TASK-1167] channel-slack: move Admin › Slack's test fakes into shared files`.
- [ ] **Step 3: Create `slack-apps.ts`** and make `admin-routes.ts` use it (`logPrefix: 'slack_admin'`, links built from `slackUrls(...).redirectUrl` and `BOT_SCOPES`). Every log line keeps its name, level and fields. Add `scopes` to `buildInstallUrl`.
- [ ] **Step 4: Verify.** Re-run Step 1, then `pnpm --filter @ax/channel-slack build`. Expected: same counts, PASS, and no edit to any test body.
- [ ] **Step 5: Prove the guard bites.** Work on the committed tree. In `deleteSlackApp`, move the `saveRotatedToken` call after `deleteApp`. An admin-routes test must fail (Disconnect stores the new refresh token before using it). Restore with `git checkout HEAD -- packages/channel-slack/src/slack-apps.ts` and check that `git status --short` is clean. If no test fails, the extraction has no order guard: add that order test to `admin-routes.test.ts` (against the pre-extraction code, in its own commit) before going on.
- [ ] **Step 6: Commit** `[TASK-1167] channel-slack: share the Slack-app steps between Admin › Slack and the bot routes (no behaviour change)`.

### Task 2: Store: bot rows, kind-scoped OAuth state, and a reset that still removes everything [tier: sensitive]

Needs `security-checklist` (OAuth state binding, per-install secrets, reset cleanup). Safe under any Q1/Q2 answer: a per-person token, if chosen, lives in the vault, not in this table.

**Files:**
- Modify: `packages/channel-slack/src/migrations.ts`. Add after `:252`: the four columns, the CHECK and the index. Also update the header (`:8-15`: "later cards add per-agent installs here" is now done; describe the bot rows).
- Modify: `packages/channel-slack/src/store.ts`. The new fields and methods; `current()` doc `:63` ("The one shared-app install, any status"); `toRow`.
- Modify: `packages/channel-slack/src/admin-routes.ts`. The callback reads `peekOAuthState(hash, 'shared')` and `consumeOAuthState(hash, 'shared')`.
- Modify: `packages/channel-slack/src/plugin.ts:525-532`. The reset log line gains `kind`.
- Modify: `__tests__/memory-install-store.ts`. Mirror the new methods and the kind-scoped state.
- Test: `store.test.ts` (Docker), `admin-routes.test.ts`, `plugin.test.ts` (Docker). Run only: `packages/cli/src/__tests__/admin-reset-bootstrap.test.ts` (Docker).

**Interfaces — Produces:**
```ts
export type InstallKind = 'shared' | 'bot';
// InstallRow gains:
kind: InstallKind; agentId: string | null; requestedByUserId: string | null; botHandle: string | null;
export type RemovedInstall = Pick<InstallRow, 'installId' | 'appId' | 'teamId' | 'kind'>;
// InstallStoreError['code'] gains 'bot-exists'.
// InstallStore gains / changes:
current(): Promise<InstallRow | null>;                // kind 'shared' only, any status, oldest
insertPendingBot(r: Pick<InstallRow, 'installId' | 'appId' | 'clientId' | 'botName' | 'connectedByUserId'>
  & { agentId: string; requestedByUserId: string }): Promise<void>;   // unique violation → InstallStoreError('bot-exists')
botForAgent(agentId: string): Promise<InstallRow | null>;  // kind 'bot', any status
listBots(): Promise<InstallRow[]>;                          // kind 'bot', any status, oldest first
setBotHandle(installId: string, handle: string): Promise<void>;     // ACTIVE bot only, else InstallStoreError('install-not-active')
peekOAuthState(stateHash: string, kind: InstallKind): Promise<OAuthState | null>;
consumeOAuthState(stateHash: string, kind: InstallKind): Promise<OAuthState | null>;
removeAll(): Promise<RemovedInstall[]>;                     // EVERY kind: the bootstrap reset's (see "What the brief got wrong" 2)
```

Schema, each statement idempotent:
- `ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'shared' CHECK (kind IN ('shared','bot'))`
- `agent_id TEXT NULL`, `requested_by_user_id TEXT NULL`, `bot_handle TEXT NULL`
- Constraint `channel_slack_v1_installs_kind_fields`: `CHECK ((kind = 'shared' AND agent_id IS NULL AND requested_by_user_id IS NULL) OR (kind = 'bot' AND agent_id IS NOT NULL AND requested_by_user_id IS NOT NULL))`. Add it in a `DO $$ … $$` block guarded by an advisory lock and a `pg_constraint` lookup, as `packages/conversations/src/migrations.ts:259-290` does.
- `CREATE UNIQUE INDEX IF NOT EXISTS channel_slack_v1_installs_bot_agent ON channel_slack_v1_installs (agent_id) WHERE kind = 'bot'`

For a bot row, `connected_by_user_id` and `config_token_added_at` mean the approver, the same as the shared install's "who added the token".

- [ ] **Step 1: Write the failing tests in `store.test.ts`:**
  - `'a row from before TASK-1167 reads as shared, with null bot fields'`. A raw insert without the new columns reads back as `kind 'shared'`, with `agentId`, `requestedByUserId` and `botHandle` all null.
  - `'the database refuses a bot without its agent or requester, a shared row with an agent, and an unknown kind'`. Each raw insert rejects with Postgres code `23514`.
  - `'one bot per agent, pending or active'`. A second `insertPendingBot` for the same agent throws `InstallStoreError` `bot-exists`. A bot for another agent is fine.
  - `'current() never returns a bot'`. An older bot row plus a newer shared row gives the shared one. Bots only gives null.
  - `'botForAgent and listBots see bots only, any status; listBots oldest first'`.
  - `'setBotHandle writes only an active bot'`.
  - `'a bot state is invisible to the shared peek and consume, and the reverse'`. The right kind consumes exactly once.
  - `'removeAll removes bots too, returns their kind, and takes their bindings'`.
  - `'the migrations run twice cleanly, and again after the installs table alone is dropped'`.
  - Update the key-set pin `:214-216`.
- [ ] **Step 2: Write the failing tests elsewhere:**
  - `admin-routes.test.ts`: `'the admin callback refuses a bot install's state without spending it'`. Redirect `/?slack=failed`, and the bot's `peek(hash, 'bot')` still answers afterwards.
  - `plugin.test.ts`: `'a reset removes bot installs too, logs their kind, and deletes their leftover secrets'`.
- [ ] **Step 3: Run them to see them fail:**
  - `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack exec vitest run src/__tests__/store.test.ts src/__tests__/plugin.test.ts`
  - `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts`
- [ ] **Step 4: Implement** the migration, the store, the admin callback's `'shared'` argument, the reset log's `kind`, the fake's mirror, and the two header docs.
- [ ] **Step 5: Run Step 3 again, plus the CLI test.** Expected: PASS. CLI test: `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/cli exec vitest run src/__tests__/admin-reset-bootstrap.test.ts` → PASS (its raw insert still works).
- [ ] **Step 6: Commit** `[TASK-1167] channel-slack: bot installs in the installs table; OAuth state scoped by kind`.

### Task 3: The dedicated bot's manifest [tier: mechanical]

Safe under any answer.

**Files:** Modify `packages/channel-slack/src/manifest.ts`. Test: `manifest.test.ts`.

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
    - `display_information { name, description: 'Talk to your team agent.' }`
    - `features.app_home { home_tab_enabled: false, messages_tab_enabled: false, messages_tab_read_only_enabled: false }`
    - `features.bot_user { display_name, always_online: true }`, and **no `slash_commands` key**
    - `oauth_config { redirect_urls: [<bot callback>], scopes: { bot: [6 scopes] } }`
    - `settings { event_subscriptions: { request_url: <events/<id>>, bot_events: ['app_mention'] }, interactivity: { is_enabled: true, request_url: <interactions/<id>> }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false }`
  - `'a dedicated bot can't read DMs, join channels or take commands'`. `DEDICATED_BOT_SCOPES` has none of `im:history`, `channels:join`, `commands`, `channels:history`, `chat:write.public`, `chat:write.customize`, `groups:*`, `mpim:*`, `im:*`. `toHaveLength(6)`.
  - `'botUrls drops trailing slashes and encodes the id'`.
  - `'an install link for a bot asks for the six scopes; the shared link is unchanged'`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/manifest.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `slackUrls` and `SlackUrls` stay exactly as they are (the pin at `:17-22`).
- [ ] **Step 4: Run Step 2 again.** Expected: PASS. Commit `[TASK-1167] channel-slack: the dedicated bot's manifest`.

### Task 4: One name per bot, across every bot and the shared bot [tier: integration]

Safe under any answer. Needs Task 2's `listBots()`.

**Files:**
- Modify: `packages/channel-slack/src/bot-name.ts`. The header `:11-12` ("uniqueness would be ours to enforce; one install per AX instance has nothing to collide with yet") is now done: say so.
- Modify: `slack-apps.ts` (`namesInUse`).
- Modify: `admin-routes.ts`. Connect and Rename refuse a taken name before any Slack call.
- Test: `bot-name.test.ts`, `admin-routes.test.ts`.

**Interfaces — Produces:**
```ts
// bot-name.ts (pure)
export function botNameKey(name: string): string;               // lowercase ASCII letters and digits only
export function isBotNameTaken(name: string, taken: readonly (string | null)[]): boolean;  // empty/null keys never match
// slack-apps.ts
export function namesInUse(store: Pick<InstallStore, 'current' | 'listBots'>, o?: { except?: string }): Promise<string[]>;
// the shared install's name, then every bot's name and stored handle; `except` leaves one install out (a rename of itself)
```
New refusal `409 { error: 'bot-name-taken' }` on `POST /admin/slack/connect` (inside the lock, after the https check and before `deleteLeftoverApps`) and on `POST /admin/slack/rename` (after the active check, excepting the install itself).

- [ ] **Step 1: Failing tests:**
  - `'names that differ only in case, spaces, dots, dashes or underscores share a key'`. `Ada Bot`, `ada-bot`, `ADA_BOT`, `ada.bot` and `adabot` all give `adabot`.
  - `'a taken name or handle is refused; a different one is not'`. `('Ada Bot', ['adabot'])` → true. `('ada', ['ada2'])` → false. `('Ada 2', [null, 'ada2'])` → true.
  - admin: `'Connect refuses a name a bot already has, before Slack is called'`. 409, and the fake Slack saw no calls.
  - admin: `'Rename refuses a bot's name, and renaming to a variant of its own name still works'`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/bot-name.test.ts src/__tests__/admin-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Step 2 again.** Expected: PASS. Commit `[TASK-1167] channel-slack: Slack bot names are unique across the shared bot and every team bot`.

### Task 5: Removing a bot, and deleting it with its agent [tier: sensitive]

Needs `security-checklist` (configuration tokens, secret cleanup). Depends on Q2: under (a), the token read here changes.

**Files:**
- Create: `packages/channel-slack/src/bots.ts` (`BotDeps`, `removeBot`).
- Modify: `agents-deleted.ts`.
- Modify: `plugin.ts`. One `const appLock = createMutex()`, handed to the admin routes and here. A `createAppSteps({ … logPrefix: 'slack_bot' })` for the bot side, over the same cached `secrets` instance, so a removal also drops the events route's cached signing secret.
- Test: `agents-deleted.test.ts` (Docker; real stores, `fake-vault.ts`, `fake-slack-config.ts`).

**Interfaces — Produces:**
```ts
export interface BotDeps {
  bus: HookBus; installs: InstallStore; secrets: SecretStore; api: SlackApi; steps: AppSteps; lock: Mutex;
  publicOrigin: string; logger: Logger; now: () => number; randomBytes: (n: number) => Buffer;
}
/** Caller holds d.lock. steps.deleteSlackApp (rotate → save the new refresh token → delete; app_not_found = deleted),
 *  then installs.remove(id, { appLeft: !appDeleted }), then secrets.removeAll. */
export function removeBot(d: Pick<BotDeps, 'installs' | 'secrets' | 'steps'>, bot: InstallRow): Promise<{ appDeleted: boolean }>;
export function subscribeAgentsDeleted(
  bus: HookBus,
  d: { channels: Pick<ChannelStore, 'removeForAgent'>; bots: Pick<BotDeps, 'installs' | 'secrets' | 'steps' | 'lock'> },
  logger: Logger,
): () => void;
```

- [ ] **Step 1: Failing tests in `agents-deleted.test.ts`.** The existing 10 keep passing.
  - a. `'deleting the agent deletes its bot's Slack app with a token minted from the bot's own refresh token, saved first'`.
    - Calls in this order: `tooling.tokens.rotate(<bot's stored refresh>)`, then a vault write of the new refresh token, then `apps.manifest.delete` with `app_id` = the bot's app and `Bearer <minted>`.
    - The row is gone, and so are all four `slack:<botId>:*` refs.
    - The leftover list is empty.
    - The shared install's row and secrets are untouched.
    - Log `slack_agent_bot_removed { installId, appDeleted: true }`.
  - b. `'a dead bot token puts the app on the leftover list under the bot's name; row and secrets gone'` (rotate refused).
  - c. `'Slack refusing the delete puts the app on the leftover list; app_not_found counts as deleted'`.
  - d. `'a pending bot is deleted the same way'`.
  - e. `'an agent with no bot costs no Slack call'`.
  - f. `'the removal waits for the app lock'`. Hold the real mutex, fire the delete, and assert no Slack call until it's released.
  - g. `'a fault is logged code-only and never thrown'`.
- [ ] **Step 2: Run** `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack exec vitest run src/__tests__/agents-deleted.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Bindings and threads go first (`removeForAgent`, as today), then the bot inside `lock.run`.
- [ ] **Step 4: Run Step 2 again**, plus `plugin.test.ts`. Expected: PASS. Commit `[TASK-1167] channel-slack: deleting an agent deletes its own Slack bot`.

### Task 6: Request a bot, continue it in Slack, cancel it, and see it [tier: sensitive]

Needs `security-checklist` (new signed-in routes, configuration tokens per bot, cross-agent rights). Depends on Q2 (the token and the form).

**Files:**
- Modify: `bots.ts` (`createBots`).
- Modify: `agent-routes.ts`. Three routes. `route()` gains an optional `maxBodyBytes`. The status gains `bot`. `createAgentSlackRoutes(d: ChannelDeps, bots: ReturnType<typeof createBots>)`.
- Modify: `plugin.ts` (wiring).
- Test: `bots.test.ts` (new; `memory-install-store`, `fake-slack-config`, `fake-vault`, `fake-agents`, `fake-png`, `fake-slack-tokens`), `agent-routes.test.ts`, `plugin.test.ts`.

**Interfaces — Produces:**
```ts
export type AgentSlackBot =
  | { state: 'none' }
  | { state: 'pending'; botName: string; approver: string; canContinue: boolean }
  | { state: 'live'; botName: string; handle: string | null; approver: string };
// AgentSlackStatus: { state: 'no-workspace'; bot: AgentSlackBot } and 'ready' gains `bot: AgentSlackBot`; 'personal-agent' unchanged.
export function createBots(d: BotDeps): {
  request(i: { ctx: AgentContext; actorUserId: string; agentId: string; botName: string; refreshToken: string; icon: ParsedIcon | null }): Promise<{ status: number; body: unknown }>;
  installUrl(i: { actorUserId: string; agentId: string }): Promise<{ status: number; body: unknown }>;
  cancel(i: { agentId: string }): Promise<{ status: number; body: unknown }>;
  status(i: { ctx: AgentContext; viewerUserId: string; agentId: string; manages: boolean }): Promise<AgentSlackBot>;
};
```

**The routes.** Each answers, in order: 401 signed out; the same 404 for a bad id, an unseen agent or a missing one; then rights (`checkRights … 'manage'`: 409 `personal-agent`, 403 `forbidden`). All of that happens before a body is read or Slack is asked anything.

| Route | Cap | Body | Answers |
|---|---|---|---|
| `POST /settings/slack/:agentId/bot` | `ADMIN_CONNECT_BODY_MAX_BYTES` | `{ botName, refreshToken, iconPng? }`; unknown key → 400 `invalid-body`; `iconPng` goes through `parseIconPng` and is never a 400 (an unusable one is skipped and logged, as Connect does) | 413 `body-too-large`; 400 `invalid-refresh-token` (via `configToken(v, 'xoxe-')`), `invalid-bot-name {reason}`; in the lock: same rights re-check (404/409/403), 409 `no-workspace` (no ACTIVE shared install), `public-origin-not-https`, `bot-exists`, `bot-name-taken`; 502 `slack-refresh-token` \| `slack-error` (rotate), `slack-token` \| `slack-name` \| `slack-unconfirmed` \| `slack-error` (create); 500 `internal`; 200 `{ installUrl, iconSet }` |
| `POST …/bot/install-url` | `ADMIN_BODY_MAX_BYTES` | ignored | 409 `not-pending`; 403 `not-approver`; 200 `{ installUrl }` |
| `POST …/bot/cancel` | `ADMIN_BODY_MAX_BYTES` | ignored | 409 `not-pending` (a live bot isn't cancelled here); 200 `{ appDeleted }` |

**`request`, inside `lock.run`, in order:**
1. Re-check manage rights. This closes the race with Task 5.
2. Run the 409 checks.
3. Rotate the pasted refresh token (stage `try-refresh-token`).
4. Make a fresh `installId` (`INSTALL_ID_BYTES`, base64url).
5. `createApp(minted.accessToken, buildBotManifest(name, botUrls(origin, id)))`.
6. Put the client secret, signing secret and minted refresh token, then `insertPendingBot` (approver = requester = actor), then `setIcon` with the minted access token, then `mintInstallUrl` with the bot link (`botUrls().redirectUrl`, `DEDICATED_BOT_SCOPES`).

A failure in step 6 runs the undo:
- `deleteApp`, where `app_not_found` counts as gone;
- otherwise `rememberLeftoverApp`;
- then `installs.remove(id)` and `secrets.removeAll`.

After an undo, `bot-exists` answers 409 and anything else 500. On success, log `slack_bot_requested { installId }`.

**`cancel`, in the lock:** `removeBot`, then log `slack_bot_cancelled { installId, appDeleted }`. Any team admin who manages the agent may cancel.

**`status`:**
- The approver's name comes from `personName(…, { allowEmail: false, fallback: 'A teammate' })`.
- `canContinue` = `manages && viewer === bot.connectedByUserId`.
- A viewer who doesn't manage the agent sees `pending` as `none`.

- [ ] **Step 1: Failing tests in `bots.test.ts`:**
  - a. `'a request rotates, creates the bot app with the minted token, stores only the minted refresh token, and returns an install link bound to the requester'`. Check:
    - The Slack calls, exactly in order: `tooling.tokens.rotate(pasted)`, `apps.manifest.create` (Bearer minted, manifest `buildBotManifest(…)`), `apps.icon.set` (Bearer minted).
    - The vault holds `slack:<newId>:{client-secret,signing-secret,config-refresh-token}`, and the refresh one is the minted token, never the pasted one.
    - The row is `kind 'bot'`, `pending`, with the agent, and requester = approver = actor.
    - The install link points at the Slack authorize URL, with `scope` = the six scopes and `redirect_uri` = the bot callback.
    - `peekOAuthState(sha256(state), 'bot').userId === actor`.
    - The shared install's secrets are untouched.
  - b. `'a refused refresh token: 502 slack-refresh-token, no app made, nothing stored'`; a timeout gives `slack-error`.
  - c. `'create fails: 502 by createAppError, nothing stored'`.
  - d. `'a failure after the app exists deletes it, or lists it as left over when Slack won't; row and secrets gone'` (the vault throws on `signing-secret`).
  - e. `'no active shared install, or an http origin: 409 before Slack'`.
  - f. `'the agent already has a bot, pending or live: 409 bot-exists before Slack'`.
  - g. `'a name the shared bot, a bot or a bot's handle uses: 409 bot-name-taken before Slack'`.
  - h. `'two requests at once make one app; the other gets 409 bot-exists'` (`Promise.all`).
  - i. `'an agent deleted after the route's rights check is refused inside the lock, with no Slack call'`.
  - j. `installUrl`: `'the approver gets a fresh link and the old state stops matching; another team admin gets 403 not-approver; none or live gets 409 not-pending'`.
  - k. `cancel`: `'a pending bot's app is deleted, its row and secrets go'`, `'a dead token leaves it on the leftover list'`, `'a live bot gets 409 not-pending'`.
  - l. `status`: none, pending (canContinue only for the approver; a non-manager sees none), live (handle and approver; the approver is never an email, else "A teammate").
  - m. `'no reply body or log field carries a token'`. Scan every reply and log for the fake token prefixes.
- [ ] **Step 2: Failing tests elsewhere:**
  - `agent-routes.test.ts`: add `'/bot'`, `'/bot/install-url'` and `'/bot/cancel'` to `Suffix`, `EVERY_ROUTE` and `WRITES` (`:233-243`), so the existing loops prove 401, the same 404, 403, `personal-agent`, CSRF and the body cap. Grow the ordered route list (`:372-399`) from 5 to 8, with the `/bot` cap. Add `'POST /bot: an unknown key, an access token in the refresh field, or a bad name is a 400 before Slack'`. Add the status gaining `bot` on `ready` and `no-workspace`. Back the routes with a stub `bots` object here; the domain is tested in `bots.test.ts`.
  - `plugin.test.ts`: the ordered route list (`:663-696`, title "sixteen") and the count (`:1955`) go to 19.
  - Run `git grep -n "'no-workspace'"` over `packages/` and `presets/`. Every assertion on the agent status's `no-workspace` shape (channel-slack, the canary, the composition test, channel-web) gains `bot: { state: 'none' }`.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/bots.test.ts src/__tests__/agent-routes.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run Step 3 again**, plus `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack exec vitest run src/__tests__/plugin.test.ts`, plus the package build. Expected: PASS. Commit `[TASK-1167] channel-slack: a team admin requests the agent's own Slack bot`.

### Task 7: The bot's OAuth callback [tier: sensitive]

Needs `security-checklist` (a new signed-in callback, state-user binding, login CSRF, workspace binding). Safe under any Q2 answer.

**Files:**
- Create: `packages/channel-slack/src/bot-callback.ts`.
- Modify: `bots.ts` (`finish`).
- Modify: `plugin.ts`. Register the callback right after `createAgentSlackRoutes(...)`.
- Test: `bot-callback.test.ts` (new, fakes), `plugin.test.ts`.

**Interfaces — Produces:**
```ts
export function createBotCallbackRoute(d: BotDeps & { bots: ReturnType<typeof createBots> }): RouteSpec; // GET BOT_OAUTH_CALLBACK_PATH
// bots.finish(i: { actorUserId: string; ctx: AgentContext; install: InstallRow; code: string }):
//   Promise<{ outcome: 'connected' } | { outcome: 'failed'; reason: string }>
```

**Redirect.** Every answer is a 302 to `<publicOrigin>/?slack-bot=<connected|cancelled|failed>`, built with `URLSearchParams`. `&agentId=<id>` is appended only once the state's user matched the actor. The agent id comes from the row, never from the request.

**Order of checks:**
1. Signed in (`checkUser`; otherwise `failed`, logging `unauthenticated`).
2. `state` matches `STATE_RE`.
3. Exactly `code` (matching `OAUTH_CODE_RE`) or `error`.
4. Inside `lock.run`:
   - `peekOAuthState(h, 'bot')`.
   - The peeked user is the actor. If not, refuse `state-user-mismatch` **without spending** the state.
   - `consumeOAuthState(h, 'bot')`.
   - Expired → `failed`.
   - `error=access_denied` → `cancelled`; any other error → `failed`.
   - `bots.finish`:
     - the row is a pending bot;
     - the actor still manages `install.agentId` (`checkRights … 'manage'`);
     - `current()` is an ACTIVE shared install;
     - `steps.exchangeCode(install, code, botUrls(origin, id).redirectUrl)`;
     - `granted.teamId === shared.teamId` (else `team-mismatch`);
     - `steps.storeGrant`;
     - then, best-effort: `usersInfo(botToken, granted.botUserId)`, and `setBotHandle` only for a `name` matching `^[a-z0-9][a-z0-9._-]{0,79}$`.
   - Log `slack_bot_connected { installId }`.

Refusals log `slack_bot_install_refused { installId?, reason }`: at info for `cancelled`, `invalid-state`, `invalid-request` and `unauthenticated`, and at warn otherwise.

- [ ] **Step 1: Failing tests in `bot-callback.test.ts`:**
  - a. `'the approver's Allow activates the bot, stores its token, reads its handle and lands on its agent'`. Location is exactly `<origin>/?slack-bot=connected&agentId=<id>`. `oauth.v2.access`'s `redirect_uri` is the bot callback. The row is active with team and bot user. The handle is stored. Log `slack_bot_connected`.
  - b. `'another signed-in user's browser is refused without spending the state, with no agent id; the approver's visit then works'`.
  - c. `'signed out: failed, state not spent'`.
  - d. `'a shared install's state is unknown here'`.
  - e. `'expired → failed; access_denied → cancelled; another error → failed'`.
  - f. `'an app-id mismatch, an enterprise install, another workspace's team, or no active shared install: failed, still pending, no bot token stored'`.
  - g. `'an approver who no longer manages the agent: failed, nothing stored'`.
  - h. `'users.info failing, or a name outside the handle pattern: active with a null handle'`.
  - i. `'a state works once'`.
  - j. `'no redirect or log line carries the code, the state, a token or a Slack id'`.
- [ ] **Step 2: `plugin.test.ts`.** The route list and count go to 20. Add `'the bot callback is mounted: signed out it redirects to /?slack-bot=failed'`. The file's `request()` helper (`:321-335`) needs a `query` option for this.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/bot-callback.test.ts`. Expected: FAIL. Implement. Re-run it, plus `plugin.test.ts` (Docker). Expected: PASS.
- [ ] **Step 4: Commit** `[TASK-1167] channel-slack: the bot's OAuth callback activates it only for the person who started it`.

### Task 8: Mentions of a bot run its agent; the shared bot steps aside [tier: sensitive]

Needs `security-checklist` (untrusted Slack event bodies routed by install id; who an outsider runs as). **Step 4 is BLOCKED on Q1.**

**Files:**
- Modify: `router.ts`, `commands.ts`, `copy.ts`.
- Modify `channel-store.ts` only if Q1 = B.
- Test: `router.test.ts`, `commands.test.ts`, `copy.test.ts` (+ `channel-store.test.ts` if Q1 = B).

**Interfaces — Produces:**
```ts
// RouterDeps.installs: Pick<InstallStore, 'get' | 'botForAgent'>
// router.ts, internal:
async function bindBotChannel(d: RouterDeps, install: InstallRow, botToken: string, channelId: string): Promise<ChannelBinding | null>;
// copy.ts — exact copy:
COPY.answersAsOwnBot(botName: string, handle: string | null): string;
//   handle:  `${botName} answers as @${handle} now. Invite it with /invite @${handle}.`
//   null:    `${botName} has its own Slack bot now. Invite it to this channel to keep talking to it here.`
// commands.ts: IgnoreReason gains 'kind'
```

- [ ] **Step 1: A bot install ignores DMs.** In `route()`, a screened DM on `kind 'bot'` logs `slack_event_ignored { reason: 'bot-dm' }` and calls nothing (Decision 2).
- [ ] **Step 2: The bot mention path, inside `routeMention`.**
  - For `kind 'bot'`, skip the "no agent here" reply.
  - Admit the sender first.
  - Then, if `channels.get(botId, channel)` is null, `bindBotChannel`:
    - `conversationsInfo` with the bot token;
    - the answer's id must equal the channel;
    - public, live, and neither Slack Connect nor a pending one;
    - then `channels.upsert({ installId: botId, channelId, agentId: install.agentId, connectedByUserId: install.requestedByUserId, channelName: info.name })`, and read it back.
  - A refused channel is silent, logged `slack_event_ignored { reason: 'channel-not-allowed' }`. A transient Slack failure tells the admitted sender `COPY.turnFailed`.
  - A binding whose `agentId !== install.agentId` is silent (`reason: 'binding-agent'`).
  - From there, the existing tier, conversation, queue, job, `recordThread` and `runTurn` run with the bot's install.
- [ ] **Step 3: The shared bot steps aside.** On `kind 'shared'`, once the binding is found: if `botForAgent(binding.agentId)` is `active`, `answerAdmitted(…, COPY.answersAsOwnBot(bot.botName, bot.botHandle))` and log `slack_event_ignored { reason: 'own-bot' }`. A failed read logs and tells the sender `turnFailed` (fail closed: no shared turn). In the queued job, after the binding re-read, a now-active bot drops the turn silently (`slack_turns_dropped { reason: 'own-bot' }`).
- [ ] **Step 4: BLOCKED (Q1). Who an outsider on a bot install runs as.** Edit this step to the recorded answer before building it:
  - A: `connector = binding.connectedByUserId` (the requester written in Step 2). Nothing else changes.
  - B: a per-turn pick through the new teams hook. The job re-picks and drops on a change (`reason: 'reconnected'`). `recordThread` gains an outsider variant without the connector check. Add a boundary review and the manifest/preset pins.
  - C: on a bot install, `runsAsConnector(sender)` is silence, logged `slack_sender_refused { reason: 'outsider-on-bot' }`.
- [ ] **Step 5: `/ax` ignores a bot install.** In `commands.ts`, a signed command for `kind !== 'shared'` is an empty 200 with `slack_command_ignored { reason: 'kind' }`, checked before `command`.
- [ ] **Step 6: Failing tests in `router.test.ts`.** The inline install store gains `botForAgent`, and `fakeSlack` gains `conversationsInfo`.
  - a. `'a member's mention of a bot in a public channel binds the channel to the bot's agent and runs an attended turn there'`:
    - one `conversations.info`, with the bot token;
    - the binding is `(botId, channel) → install.agentId`, connected by the requester, remember on;
    - `agent:invoke` for the bot's agent, as the member;
    - the conversation key is `slack:<botId>:<channel>:<ts>`;
    - a second mention makes no `conversations.info` call.
  - b. `'a private, archived or Slack Connect channel, or an answer about another channel: no binding, no turn, no line'`.
  - c. `'a refused sender costs no conversations.info and binds nothing'`.
  - d. `'a binding on a bot install naming another agent runs nothing'`.
  - e. `'a DM to a bot does nothing'`.
  - f. `'the shared bot in a channel whose agent's bot is live: no turn; an admitted sender gets the line (with or without a handle); anyone else, silence'`.
  - g. `'the shared bot answers as today while the agent's bot is pending, and in another agent's channel'`.
  - h. `'a shared turn queued when the agent's bot goes live is dropped'`.
  - i. The Q1 case, written to the recorded answer.
- [ ] **Step 7: Failing tests elsewhere:**
  - `commands.test.ts`: `'a signed /ax for a bot install is ignored'` (empty 200, no Slack call).
  - `copy.test.ts`: both lines pinned exactly, and neither contains `@channel`, `@here`, `@everyone` or "AX".
- [ ] **Step 8: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/router.test.ts src/__tests__/commands.test.ts src/__tests__/copy.test.ts`. Expected: FAIL. Implement. Re-run: PASS.
- [ ] **Step 9: Prove the guard bites.** On the committed tree, remove Step 3's mention-time check: test f must fail. Restore with `git checkout HEAD -- packages/channel-slack/src/router.ts` and check that `git status --short` is clean.
- [ ] **Step 10: Commit** `[TASK-1167] channel-slack: a bot's mentions run its agent, and the shared bot steps aside for it`.

### Task 9: Reachable from the canary; the whole path with the real vault [tier: integration]

**Files:**
- Test: `presets/memory/src/__tests__/canary.test.ts` (the channel-slack `it`, `:738-859`; add TASK-1167 to its title).
- Test: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`. One new `it`, appended **last**, because the file's raw SQL (`:716`, `:727-728`, `:856-859`, `:909`, `:1044`) assumes a single install row.

- [ ] **Step 1: Canary (invariant 3).** Signed in as `CANARY_ADMIN`:
  - `POST /settings/slack/no-such-agent/bot`: without the CSRF header → 403; with it → 404 `{ error: 'not-found' }` (the route's own answer; an unmounted POST is the router's 405).
  - The same for `/bot/install-url` and `/bot/cancel`.
  - Signed out, `GET /slack/bots/oauth/callback?state=x` → 302, Location ending `/?slack-bot=failed`.
- [ ] **Step 2: Composition test.** Title: `'a team agent's own bot: requested, allowed, mentioned, the shared bot steps aside, Disconnect leaves it, deleting the agent deletes it (TASK-1167)'`.
  1. A team admin requests a bot. The fake Slack answers `tooling.tokens.rotate`, `apps.manifest.create` and `apps.icon.set`; extend its method list where it says `unknown_method`.
  2. The callback runs with `oauth.v2.access` and `users.info` for the bot user.
  3. Check the vault and the row:
     - four refs under the bot's id;
     - the shared install's refs unchanged;
     - the row active, with its handle.
  4. A member mentions the bot in `SUPPORT_CHANNEL`, signed with the bot's signing secret on `/slack/events/<botId>`. Expect the binding written and an invoked turn for the agent, with key `slack:<botId>:…`.
  5. The shared bot is mentioned in the same channel. Expect no new turn and one `chat.postEphemeral` carrying `answersAsOwnBot`.
  6. Admin › Slack Disconnect. Expect the bot row still active and its refs intact.
  7. `dropAgent`. Expect the bot's `tooling.tokens.rotate` and `apps.manifest.delete`, then its row and refs gone.
- [ ] **Step 3: Run**, one package at a time:
  - `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/preset-memory exec vitest run src/__tests__/canary.test.ts`
  - `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/channel-slack-composition.test.ts src/__tests__/preset.test.ts`

  Expected: PASS. To show the new `it` bites, remove Task 5's bot branch in `agents-deleted.ts` on the committed tree: step 7 must fail. Restore with `git checkout HEAD -- …`. If local Docker can't run these, say so in the handoff.
- [ ] **Step 4: Commit** `[TASK-1167] presets: a team agent's own Slack bot is reachable from the canary and works end to end`.

### Task 10: Agent settings: "Its own Slack bot" [tier: integration]

Invoke the `shadcn` skill first; the `ux-design` skill is advisory. Depends on Q2: under (b), add the warning line below.

**Files:**
- Create: `packages/channel-web/src/components/slack/SlackConfigToken.tsx`. Moved from `components/admin/SlackTab.tsx`: `SLACK_APPS_URL` `:86`, `SlackAppsLink` `:115-126`, `TokenField` `:308-344`.
- Create: `packages/channel-web/src/lib/slack-token-copy.ts`. Moved from `lib/slack-admin.ts:323-366`: `BOT_NAME_COPY` and the copy for `invalid-refresh-token`, `slack-refresh-token`, `invalid-bot-name`, `slack-name`, `slack-unconfirmed` and `slack-token`. Add `bot-name-taken`.
- Modify: `SlackTab.tsx`, `lib/slack-admin.ts`. Import the moved pieces, and map Task 4's `bot-name-taken` to the name field.
- Modify: `lib/agent-slack.ts`. Types, `requestSlackBot`, `continueSlackBot`, `cancelSlackBot`, `agentSlackBotErrorCopy`.
- Create: `components/workspace/AgentSlackBot.tsx`.
- Modify: `components/workspace/AgentSlack.tsx`. Render the section on `no-workspace` and `ready`. Hide `ChannelPicker` while the bot is live. Add one line above the channel list while live.
- Create: `lib/slack-bot-return.ts`.
- Modify: `App.tsx`.
- Tests: `components/admin/__tests__/SlackTab.test.tsx` and `__tests__/admin-slack.test.tsx` (existing bodies unchanged, plus one test each); `lib/__tests__/agent-slack.test.ts`; `components/workspace/__tests__/AgentSlack.test.tsx`; new `components/workspace/__tests__/AgentSlackBot.test.tsx`, `lib/__tests__/slack-bot-return.test.ts`, `__tests__/slack-bot-return-app.test.tsx`.

**Interfaces — Produces:**
```ts
// lib/agent-slack.ts (mirrors the wire by shape)
export type AgentSlackBot = /* Task 6's union */;
export function requestSlackBot(agentId: string, i: { botName: string; refreshToken: string; iconPng?: string }): Promise<{ installUrl: string; iconSet: boolean }>;
export function continueSlackBot(agentId: string): Promise<{ installUrl: string }>;
export function cancelSlackBot(agentId: string): Promise<{ appDeleted: boolean }>;
export function agentSlackBotErrorCopy(err: unknown): { field: 'botName' | 'refreshToken' | null; message: string };
// lib/slack-bot-return.ts
export function readSlackBotReturn(search: string): { outcome: 'connected' | 'cancelled' | 'failed'; returnPath: string | null } | null;
export function withoutSlackBotReturn(search: string): string;
```
`returnPath` is built only through `parseWorkspaceRoute(`/workspace/agents/${encodeURIComponent(id)}/settings/slack`)` and then `workspaceRoutePath`, as `lib/oauth-full-page-return.ts:60-69` does. Empty, `.`, `..` and bad escapes give `null`.

**Copy (pinned):**

| Where | Text |
|---|---|
| Title | "Its own Slack bot" |
| `none`, manager, `ready` | "Give {agentName} its own name in Slack. People mention it directly, and you add it to a channel with /invite. You need to be able to install apps in Slack." |
| Steps | "Open {SlackAppsLink}. Under **Your App Configuration Tokens**, click **Generate Token** for your workspace." then "Paste the refresh token below." |
| Fields | "Bot name" (prefilled with `agentName`; the server judges it); `TokenField id="slack-bot-refresh-token" label="Refresh token" hint="Starts with xoxe-"` |
| Button | "Create the Slack bot" |
| `pending`, approver | "Almost there: finish adding {botName} in Slack." Buttons "Continue in Slack" and "Cancel request" |
| `pending`, other manager | "{approver} is finishing this in Slack." Button "Cancel request" |
| `live` | "@{handle} is live. Invite it to a channel with /invite @{handle}." (null handle: "{botName} is live. Invite it to a channel with /invite.") Managers also see "Set up by {approver}." |
| `live`, above the channel list | "Mentioning the shared bot in these channels no longer reaches {agentName}. Invite @{handle} to each one." |
| Return toasts | connected: "The Slack bot is live. Invite it to a channel with /invite." · cancelled (info): "Slack install was cancelled. You can continue it from the agent's Slack settings." · failed (error): "We couldn't finish adding the Slack bot. Try again from the agent's Slack settings." |
| Errors | `bot-name-taken` (name field): "Another Slack bot here already uses that name. Pick another." · `bot-exists`, `not-pending`: re-read the status · `no-workspace`: "Slack isn't connected yet. An admin connects it first." · `not-approver`: "Only the person who set this up can continue it in Slack." · `public-origin-not-https`: Admin › Slack's existing copy |
| Q2 = (b) only | add to the `none` description: "If you've pasted a configuration token here before, generating a new one stops the old one working for the Slack apps it manages." |

Non-managers see only the `live` lines. A refusal code routes to the name or token field as `slackErrorCopy` does, and anything else goes to one `Alert`. Before the request goes out, the token input is trimmed and cleared (`SlackTab.tsx:362-366`). The picture is `renderSlackAvatar()`; a `null` sends no `iconPng`. Navigation goes through `goToSlack(installUrl)` from `lib/slack-admin.ts`.

- [ ] **Step 1: Extract** `SlackConfigToken.tsx` and `slack-token-copy.ts`, and import them in `SlackTab.tsx` and `slack-admin.ts`. Run `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/SlackTab.test.tsx src/__tests__/admin-slack.test.tsx`: same counts, PASS. Commit `[TASK-1167] channel-web: share the Slack token field, guide link and copy`.
- [ ] **Step 2: Failing tests:**
  - `AgentSlackBot.test.tsx` (mock `@/lib/agent-slack` partially, and `@/lib/slack-avatar` and `goToSlack`):
    - one render per state and role from the table;
    - submit trims, clears, sends `{ botName, refreshToken, iconPng }` (no `iconPng` when the avatar is null) and calls `goToSlack`;
    - each refusal code lands under the right field;
    - Continue calls `continueSlackBot` then `goToSlack`;
    - Cancel calls `cancelSlackBot` then re-reads;
    - members see only the live line;
    - the picker is hidden while live.
  - `agent-slack.test.ts`: the three POSTs (path, `x-requested-with`, credentials, body), and the status parsing `bot` on both states.
  - `slack-bot-return.test.ts`: only the three outcomes, `returnPath` rules, both params stripped.
  - `slack-bot-return-app.test.tsx`: `/?slack-bot=connected&agentId=a1` ends on `/workspace/agents/a1/settings/slack` with one toast, **for a non-admin too**; `?slack=` behaves as before.
  - `SlackTab.test.tsx` and `admin-slack.test.tsx`: `bot-name-taken` shows under the name field.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-web exec vitest run <those files>`. Expected: FAIL. Implement. Re-run: PASS. Then `pnpm --filter @ax/channel-web build` (its tsc checks tests) and `pnpm lint`.
- [ ] **Step 4: Commit** `[TASK-1167] channel-web: request, continue and see a team agent's own Slack bot`.

### Task 11: Stale lines, the design doc, and the changeset [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`.
- Modify: `packages/channel-slack/src/plugin.ts` header (`:68-89`: the route list, and "It keeps one install row").
- Modify: `packages/channel-slack/src/manifest.ts` header (two apps now).
- Create: `.changeset/slack-dedicated-bot.md`.

- [ ] **Step 1: The stale lines.** These made the card's storage plan look safe.
  - §3 `:299-303` and §7 `:926`. "Whether that Revoke also ends the refresh tokens rotates have minted since … is unmeasured" becomes: measured by the TASK-1163 walk (check 4). It does: the token AX stored, rotated from the revoked one, then failed at `rotate` with `invalid_refresh_token`. Since one person has one token per workspace, AX can keep a working token for only one of their apps (Q2's answer goes here).
  - §3 `:312-313`. "Whether a new token can delete an app an earlier token of the same person made is unmeasured" becomes: yes (TASK-1163 check 1).
- [ ] **Step 2: Update §3 `:376-377`.** "Admin › Slack › Disconnect (and a reset) removes every channel connection with the install" becomes: Disconnect removes the shared install and its channels, and leaves team bots alone. A bootstrap reset (`ax admin reset-bootstrap`) wipes every agent and secret, so it removes every install, team bots included, and logs each app id.
- [ ] **Step 3: Update §4.** Say what TASK-1167 built:
  - the self path only (ask-an-admin is a later card);
  - Cancel for a pending request;
  - the name rule now spans the shared bot too;
  - the binding written on the first mention, after the channel check;
  - the shared bot stepping aside only for a live bot;
  - deletion with the agent;
  - the outsider rule as Q1 decided it.
  
  Update §6's route list ("No other new hooks" paragraph) with the four routes, and add a progress line to §9 phase 2 item 8.
- [ ] **Step 4: Changeset**, `'@ax/channel-slack': patch` and `'@ax/channel-web': patch`, in the repo's voice: "A team agent can now have its own Slack bot. A team admin picks its name, pastes their own Slack configuration token, and clicks Allow in Slack. People then mention the bot by name in any public channel it's invited to, and the shared bot steps aside for that agent. Deleting the agent deletes its bot. Disconnecting the shared bot leaves team bots alone."
- [ ] **Step 5: Commit** `[TASK-1167] docs: Slack design catches up with the TASK-1163 walk and the first team bots`.

---

## Final gate

- [ ] `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, with `DOCKER_HOST` set and `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000`, then `pnpm lint`. `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js` passes without edits: `channel_slack_v1_installs` gains `agent_id`, but `store.ts` already deletes from it inside `sql`, and `agents-deleted.ts` subscribes. That guard can't see whether bot rows actually go; Task 5's tests prove it. `channel-slack-boundaries.test.js` passes with no new allowlist entry.
- [ ] `security-checklist` once for the PR, covering Tasks 2 and 5–8. Threats to answer:
  - state-user binding and login CSRF (Task 7 b, c, i);
  - kind-scoped state (Task 2, Task 7 d);
  - cross-agent rights (in-lock re-check, the callback's re-check, `/ax` ignoring bot installs, a bot binding only for `install.agentId`);
  - secrets scoped per install id (four refs per bot, written as the approver, removed on cancel, delete and reset);
  - shared-install isolation (`current()`, Disconnect, the admin callback);
  - untrusted Slack bodies routed by install id (unchanged ingress; DMs ignored on bots; `conversations.info` answers checked; the handle checked before it's stored);
  - no new egress: the only Slack methods are ones `slack-api.ts` already sends.
- [ ] Before the PR, `git grep -n "OAUTH_CALLBACK_PATH\|peekOAuthState\|consumeOAuthState\|removeAll()"`. Every caller must pass a kind or be the reset.

## For the builder's handoff

- **`needs-input`** (before any work past Tasks 1–4): Q1 and Q2 above.
- **`followups`:**
  1. The phase 2 real-Slack walk card: self path, Allow, `/invite`, mention, the shared bot stepping aside, agent delete. Also check that a dedicated bot's app can't be DMed (`messages_tab_enabled: false`).
  2. Q2 (a), if chosen: "Slack: keep one configuration token per person" as a prerequisite card.
  3. Ask-an-admin path (Decision 3's second option).
  4. Bot rename, avatar and Replace (approver only, Decision 5), and Disconnect of a live bot.
  5. Admin › Slack lists each bot with its approver (design §4 Lifecycle).
  6. A bot's channels with their remember switch in agent settings: today they're remembered by default with no switch.
  7. The shared `undoConnect` forgets an app whose delete fails (`admin-routes.ts:482-494`).
  8. If Q1 = B: the teams hook card, if it's split out.
- **`learnings`:**
  - A dedicated bot is a `kind 'bot'` row in the installs table, so ingress, interactions and vault refs are per install for free.
  - `current()` is shared-only; `removeAll()` is every kind, because the bootstrap reset wipes every agent and secret.
  - OAuth state reads take a kind.
  - Every Slack-app write shares one app lock (`plugin.ts`).
  - Bot names are unique by a letters-and-digits key across the shared bot and every bot.
  - The bot callback lands on `/?slack-bot=…&agentId=…`.
