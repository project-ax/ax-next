# TASK-1093: `@ax/channel-slack` (connect a workspace + personal-agent DMs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new host plugin, `@ax/channel-slack`. A Slack admin connects the workspace once from AX admin settings, and every AX user can then DM the shared bot to talk to their own personal agent, with the reply streamed into Slack.

**Architecture:** The plugin registers four admin routes, an OAuth callback and one public events route through `http:register-route`, and keeps one install row in its own Postgres table. The four Slack secrets go in the credentials vault. A small in-plugin Slack Web API client runs over an injected `fetch`. An event becomes a turn like this: verified ingress, then a users.info admission check, then `auth:find-user-by-email`, then the sender's oldest personal agent, then `conversations:find-or-create` (origin `'slack'`), then `agent:invoke`. Chat events are relayed into Slack's streaming API. No new hooks.

**Tech Stack:** TypeScript (exactOptionalPropertyTypes), Kysely on Postgres, vitest + Testcontainers, React + shadcn in `packages/channel-web`. No new dependencies: no Slack SDK.

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` (§1, §2, §3, §5, §6, §7; binding). Card: TASK-1093. Planner decisions: `.claude/memory/decisions/2026-11-13-TASK-1093.md`. Stack contracts: `.claude/memory/decisions/2026-11-12-TASK-1091.md` (source/audience, `conversation:busy`, serialize per conversation) and `.claude/memory/decisions/2026-11-13-TASK-1092.md` (`auth:find-user-by-email`, its caller allowlist, the not-mapped log line). Slack API facts below were read from docs.slack.dev on 2026-11-12, not recalled.

## Delivery: one card, two stacked PRs (recommended)

The card is about 14 tasks and an estimated 6–7k lines with tests. It is too big for one review. Proposed split, both PRs on this card. Neither merges alone: the stack 1091 → 1092 → 1093 → 1094 squashes as one with TASK-1094.

- **PR A, Tasks 1–7: connect a workspace + verified ingress.** Package, client, manifest, store, the events route (signature, replay window, dedupe, ack; events are logged and dropped until PR B), admin routes, OAuth callback, presets, canary, admin UI. It is reachable on its own: an admin can connect and disconnect, and Slack's deliveries get a correct 200/401/404. The ingress lands here so a dev install never sees 404s, which after 60 minutes would get the app's event subscriptions disabled by Slack.
- **PR B, Tasks 8–14: admission, DM turns, streamed replies, guards.** Builds on PR A's `EventDispatcher` seam.

If the builder keeps one PR, use the same task order and run a review gate after Task 7.

## What exists today (measured at `13a9d679b`)

- **Routes:** `http:register-route` takes `{ method, path, handler, bypassCsrf?, maxBodyBytes? }` (`packages/http-server/src/types.ts:220-248`). `req.body` is the raw `Buffer`, `req.rawPath` is undecoded, and `req.params` is URI-decoded (`:15-58`). `:param` routes outrank the SPA's `GET /*`. CSRF applies to every POST unless the route sets `bypassCsrf`. Admin guard: copy `requireAdmin` from `packages/branding/src/shared.ts:75-96`, which calls `auth:require-user` and uses `answerRequireUserFailure` from `@ax/core`. Admin JSON lives under `/admin/...`.
- **Webhook precedent:** routines' Slack v0 check (`packages/routines/src/webhook-signature.ts:48-57`, `:75-81`) and its raw-path check (`webhook-handler.ts:79-102`). Copy them, don't import them. The ack-then-work lifetime is `packages/routines/src/lifetime.ts`.
- **Public origin:** `presetPublicOrigin(config)` (`presets/k8s/src/index.ts:155-159`) is the `AX_PUBLIC_BASE_URL` origin, else `http://host:port`. No hook exposes it. mcp-oauth takes it as config (`:1337-1343`).
- **Turns:** `agent:invoke` takes `{ message: AgentMessage }`. Its outcome never carries reply text, and in keepAlive mode it resolves on the first turn-end. channel-web calls it fire-and-forget with `makeAgentContext({ sessionId: makeReqId(), agentId, userId, conversationId, reqId })` (`packages/channel-web/src/server/routes-chat.ts:694-700`, `:791-792`). Turn-end matching is `packages/channel-web/src/server/sse.ts:510-529`: same `ctx.conversationId`, then `payload.reqId` equal, absent, or listed in `foldedReqIds`. `chat:stream-chunk` kinds and their fields are in `packages/channel-web/src/server/types.ts:32-70`. Subscribers are fired without being awaited, so buffer synchronously.
- **Serialization:** nothing serializes same-mode turns. A second message mid-turn is folded into the running turn (`orchestrator.ts:2949-2952`). The channel must serialize per conversation (TASK-1091).
- **Conversations:** `conversations:find-or-create` takes `{ userId, agentId, externalKey, fallback: { title?, hidden?, origin? } }` and checks `assertAgentReachable` first. The origin union is `'web' | 'routine'` (`packages/conversations/src/types.ts:42,45`), it's a zod enum at `:557`, and both store projections map anything else to `'web'` (`store.ts:174`, `:907`). channel-web refuses posts into non-`'web'` conversations (`routes-chat.ts:568`). decisions treats every non-`'web'` origin as unattended (`packages/decisions/src/attendance.ts:95,127`).
- **Agents:** there is no default-agent concept. `agents:list-for-user({ userId, teamIds: [] })` returns only that user's personal agents, newest first. A user may have several. `Agent.createdAt` is a `Date`.
- **Credentials:** `credentials:set({ scope, ownerId, ref, kind, payload })` and `credentials:get({ ref, userId })`. Reads walk user → agent (only if `ctx.agentId` is non-empty) → global (`packages/credentials/src/plugin.ts:849-888`). A non-empty `ctx.agentId` that isn't an id makes the store throw. Nothing restricts which plugin reads a ref. `GET /admin/credentials` lists refs and metadata, never values.
- **Branding:** `branding:get` returns `{ name: string | null }` only. The logo is served publicly at `GET /api/branding/logo/light`, which answers 404 when unset.
- **Presets:** production runs the memory preset, which wraps `createK8sPlugins`. The one-shot CLI has no Postgres or HTTP server, so channel-slack is not added there. Host egress on 443 is already open to any destination (`deploy/charts/ax-next/templates/networkpolicies/agent-runtime-network.yaml:98-115`). The host is pinned to one replica with `strategy: Recreate` (`_helpers.tpl:466-471`).
- **Admin UI:** the tabs are in `packages/channel-web/src/components/admin/AdminSidebar.tsx:25-71` and `AdminShell.tsx:60-90,163-175`. There's no route grammar for admin tabs: `onOpenAdminSettings(tab?)` is at `App.tsx:480-494`. The OAuth full-page return precedent is `lib/oauth-full-page-return.ts:47-79`, called from `App.tsx:108-129`. Write headers: `lib/branding.ts:11-14`.

## Global Constraints

- **Paths and names:** plugin name `@ax/channel-slack`; package `packages/channel-slack`.
- **No new hooks.** `registers: []`. The only hook-surface change is the `'slack'` conversation origin (Task 8, boundary review below).
- **No new dependencies.** Reuse locked versions only: `kysely` `0.28.17`; test deps as in `packages/connector-directory/package.json`.
- **Allowed hosts:** only `https://slack.com/api/<method>` and `https://slack.com/oauth/v2/authorize`. `redirect: 'manual'`; any 3xx is an error.
- **Response cap:** 1 MiB via `capResponseBody` from `@ax/core/response-cap`. 10 s timeout per call.
- **Routes:**
  - `GET /admin/slack`
  - `POST /admin/slack/connect`
  - `POST /admin/slack/install-url`
  - `POST /admin/slack/disconnect`
  - `GET /admin/slack/oauth/callback`
  - `POST /slack/events/:installId` (`bypassCsrf: true`, `maxBodyBytes: 262144`)
- **`installId`:** 16 random bytes, base64url, matching `^[A-Za-z0-9_-]{22}$`.
- **Secrets:** ref `slack:<installId>:<name>`, with name one of `bot-token | signing-secret | client-secret | config-refresh-token`. Scope `global`, `ownerId: null`, kind `api-key`. Read with `userId: install.connectedByUserId` and a ctx whose `agentId` is `''`.
- **Config tokens:** store exactly the refresh token the admin pasted. Never store a rotated refresh token. Never store an access token.
- **Signature:** v0 HMAC-SHA256 over `v0:<ts>:<raw body>`. The timestamp matches `^\d{1,12}$` and is within 300 s in both directions. Constant-time compare.
- **Event dedupe:** in memory, TTL 1 h, at most 10,000 ids, recorded only after the signature passes.
- **Stream limits:** rotate the stream at 11,000 markdown characters or 9 minutes (Slack's caps are 12,000 and 10 minutes). Flush every 1,000 ms. One Slack call in flight per stream. Post fallback in parts of at most 11,000 characters.
- **Stream encoding:** every stream call (`chat.startStream`/`appendStream`/`stopStream`) uses `chunks`, never the `markdown_text` argument: Slack refuses mixing the two in one stream. `chat.postMessage` uses `markdown_text` and always sends `unfurl_links: false, unfurl_media: false`.
- **Turns:** a DM turn's ctx is `source: 'user'`, `audience: 'private'`, explicitly. At most 3 turns per conversation running or waiting. A turn ends at the first matching `chat:turn-end`, the same as channel-web; no text reconciliation. Hard cap 15 min.
- **Manifest:**
  - bot scopes exactly `['app_mentions:read', 'chat:write', 'im:history', 'users:read', 'users:read.email']`
  - bot events exactly `['app_mention', 'message.im']`
  - no interactivity, no slash commands
  - `token_rotation_enabled: false`
  - App Home messages tab on and writable
- **Logs:** code-only. Event names start `slack_`. Fields are at most `installId`, `reason`, `stage`, `code`. Never an email, Slack user id, message text, token, team name or Slack error text beyond a `/^[a-z0-9_]{1,64}$/` code.
- **Slack-facing copy:** comes only from `packages/channel-slack/src/copy.ts` (Task 9 creates it). Admin UI copy follows CLAUDE.md voice; run `ux-design` on it.
- **Commands:**
  - Put `--filter` before the script: `pnpm --filter @ax/channel-slack test`. Use `pnpm --filter <pkg> exec vitest run <file>` for one file.
  - Postgres tests need `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`, spelled literally.
  - Gate before each PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint` (with `DOCKER_HOST` set). Also run an isolated `pnpm --filter @ax/preset-k8s build` after cleaning its `dist` + tsbuildinfo.
- **Security:** each PR needs a `security-checklist` note (see Security notes below), and PR B also needs the Task 8 boundary review.

## Review Focus

1. **A Slack retry or a replayed delivery.** Same `event_id` → exactly one turn. A timestamp 301 s off in either direction → 401, no turn. A forged request must not poison the dedupe set (Task 4).
2. **A sender who isn't a confirmed full member** (guest, other workspace, `is_email_confirmed` false, bot, Slackbot) gets silence and no `auth:find-user-by-email` call. A mapped sender only ever reaches their own oldest personal agent, never another user's (Tasks 9, 11, 13).
3. **Two or three quick DMs in one thread.** The second waits for the first's turn-end, and replies never interleave. The fourth gets the queue-full reply and no turn (Task 11).
4. **A reply over 12,000 characters or a turn over 10 minutes** continues in a new stream message in the same thread. A stream error mid-reply posts exactly the unsent remainder via `chat.postMessage`, with nothing duplicated or lost (Task 10).
5. **Disconnect with a dead configuration token or an app already deleted.** The local row and all four secrets are still removed, `appDeleted: false` comes back, and the minted refresh token is never stored (Task 5).

## Boundary review (paste into PR B)

**`conversations` origin gains `'slack'`** (`ConversationOrigin`, `CONVERSATION_ORIGINS`, the `conversations:get-metadata` return enum, and both store projections):

- **Alternate impl:** any channel that opens conversations for the owner outside the web app (email-in → `'email'`, a Teams bot → `'teams'`). Each adds its own origin value.
- **Payload field names that might leak:** none new. The value names a channel, exactly as `'web'` does. That is the field's documented meaning (AW-6: the conversation's channel).
- **Subscriber risk:** consumers that branch on `origin === 'web'` treat `'slack'` as not-web.
  - channel-web refuses web posts into it, so a Slack thread is read-only in the web app.
  - decisions treats it as unattended, so a held call waits in Today.
  - Both are intended until Slack can show approval buttons. **TASK-1095 must flip decisions' attendance for Slack DMs when it adds buttons.**
  - The `z.enum` consumer is updated in the same task.
- **Wire surface:** none. Not an IPC action.

**channel-slack adds no hook.** It calls existing services and subscribes to `chat:stream-chunk`, `chat:turn-end`, `chat:turn-error` and `bootstrap:reset-cleanup`.

## Security notes (input for each PR's `security-checklist`)

- **Sandbox escape:** N/A. Host-side plugin. No sandbox, IPC or runner change. DM turns use the existing orchestrator path.
- **Untrusted input in:**
  - The events route is public. It's gated by HMAC over the raw body, the replay window, a high-entropy `installId` in the path, a 256 KiB cap and dedupe. CSRF is bypassed on that one route only.
  - Identity comes from `users.info` with the bot token, never from message text.
  - The email goes to `auth:find-user-by-email` verbatim.
  - A DM's text is the owner's own message to their own agent, the same trust as web chat.
- **Untrusted output out:**
  - Model text going to Slack has `<!`, `<@`, `<#` neutralized.
  - Link and media unfurling stay off: streams disable it, and `chat.postMessage` sets both flags false. Slack's servers never fetch a model-chosen URL.
  - Artifact titles are never sent. Turn errors are fixed copy, never the raw reason.
- **Secrets:**
  - Four per install, in the vault, never returned by a route, never logged.
  - Task 12's guard keeps other packages from naming `slack:` refs or calling `auth:find-user-by-email`.
  - The configuration refresh token can't be retired through Slack's API (spike). Disconnect tells the admin to Revoke it on Slack's page.
- **Supply chain:** no new dependencies.
- **Residuals to state in the PR:**
  - **TASK-1116 (separate card; TASK-1094 depends on it).** Email/password sign-up is open over the API, which allows pre-account takeover: someone registers a colleague's address before their first Google sign-in. That row only becomes verified, and so findable by this card, once the real owner's Google sign-in links into it, and then the password still works. Not fixed here.
  - Whoever controls a person's Slack session controls their personal agent (design §8 Q4). The connect screen says Slack keeps a copy of what the agent says.
  - Dedupe and the per-thread queue are in-process. The chart pins one replica. A restart during Slack's retry window can replay one event.
  - `GET /admin/credentials` shows the four refs' metadata to admins.
  - Any host plugin can still call `credentials:get` at runtime. The guard is a repo scan, not a runtime check.

## Out of scope (logged in the decisions shard)

- Channels, `/ax connect`, external turns and the `'shared'` audience: TASK-1094.
- Approval buttons and interactivity: TASK-1095.
- Rename and replacing the configuration token: TASK-1096.
- The walk: TASK-1097.
- Slack-side "agent is thinking" status (needs `assistant:write`).
- File reading.
- Per-agent bot name or avatar in DMs (`chat:write.customize`).
- A read-only banner for Slack conversations in the web app.
- `app_uninstalled` handling.
- Rate limiting beyond `@ax/usage-limits`.
- Auto-updating manifest URLs when the public origin changes.

---

## PR A — connect a workspace + verified ingress

### Task 1: Package scaffold, bot name rules and the app manifest [tier: mechanical]

**Files:**
- Create: `packages/channel-slack/package.json` (copy `packages/connector-directory/package.json`; deps `@ax/core`, `kysely` `0.28.17`; same devDependencies), `tsconfig.json` (copy), `src/index.ts`, `src/limits.ts`, `src/bot-name.ts`, `src/manifest.ts`
- Modify: root `tsconfig.json` (add the reference), `pnpm-lock.yaml` (`pnpm install`), `.changeset/channel-slack.md`
- Test: `src/__tests__/bot-name.test.ts`, `src/__tests__/manifest.test.ts`

**Interfaces:**
- Produces (`src/limits.ts`): every numeric constant named in Global Constraints, e.g. `SIGNATURE_TOLERANCE_S = 300`, `EVENT_DEDUPE_TTL_MS`, `EVENT_DEDUPE_MAX`, `EVENTS_MAX_BODY_BYTES = 262_144`, `SLACK_API_TIMEOUT_MS = 10_000`, `SLACK_RESPONSE_CAP_BYTES = 1_048_576`, `RETRY_AFTER_CAP_MS = 60_000`, `FLUSH_INTERVAL_MS = 1_000`, `STREAM_TEXT_LIMIT = 11_000`, `STREAM_MAX_AGE_MS = 540_000`, `POST_PART_LIMIT = 11_000`, `STATUS_TITLE_MAX = 120`, `MAX_TURNS_PER_CONVERSATION = 3`, `TURN_HARD_CAP_MS = 900_000`, `OAUTH_STATE_TTL_MS = 600_000`.
- Produces (`src/bot-name.ts`):
  - `RESERVED_BOT_NAMES = new Set(['slackbot', 'here', 'channel', 'everyone'])`
  - `type BotNameCheck = { ok: true; name: string } | { ok: false; reason: 'empty' | 'too-long' | 'bad-characters' | 'reserved' }`
  - `checkBotName(raw: string): BotNameCheck`: trim, collapse whitespace runs to one space, at most 35 chars, `^[A-Za-z0-9 ._-]+$` with at least one letter or digit. Reserved if the lowercased name, with spaces removed, is in the set.
  - `defaultBotName(brandingName: string | null): string`: the "handle form":
    1. NFKD, then drop `\p{M}`, then lowercase.
    2. Replace each run of chars outside `[a-z0-9._-]` with `-`; collapse repeated `-`.
    3. Trim `-._` at both ends; cut to 21 chars; trim again.
    4. Return it if `checkBotName` is ok, else `'ax'`.
- Produces (`src/manifest.ts`):
  - `BOT_SCOPES`, `BOT_EVENTS` (exact lists from Global Constraints)
  - `slackUrls(publicOrigin: string, installId: string): { eventsUrl: string; redirectUrl: string }`: `${origin}/slack/events/${installId}` and `${origin}/admin/slack/oauth/callback`
  - `buildAppManifest(botName: string, urls): Record<string, unknown>`
  - `buildInstallUrl({ clientId, redirectUrl, state }): string`: `https://slack.com/oauth/v2/authorize` with `client_id`, `scope` (`BOT_SCOPES` joined by `,`), `redirect_uri`, `state`, via `URLSearchParams`.

- [ ] **Step 1: Write failing tests.**
  - `bot-name.test.ts`:
    - `'Canopy Works'` → `canopy-works`; `'Café Société'` → `cafe-societe`; `'日本'` → `ax`; `'!!!'` → `ax`; `'Here'` → `ax`; `null` → `ax`
    - a 40-letter name → 21 chars
    - `checkBotName`: `''` → `empty`; 36 chars → `too-long`; `'a!'` → `bad-characters`; `'---'` → `bad-characters`; `'Every One'` → `reserved`; `'  Ada   Bot '` → `{ ok: true, name: 'Ada Bot' }`
  - `manifest.test.ts`: `buildAppManifest('ax', urls)` deep-equals this, and `buildInstallUrl` carries exactly the four params, with `redirect_uri` round-tripping through `URL`:
    ```json
    { "display_information": { "name": "ax", "description": "Talk to your AX agent." },
      "features": { "app_home": { "home_tab_enabled": false, "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
                    "bot_user": { "display_name": "ax", "always_online": true } },
      "oauth_config": { "redirect_urls": ["https://ax.example/admin/slack/oauth/callback"],
                        "scopes": { "bot": ["app_mentions:read", "chat:write", "im:history", "users:read", "users:read.email"] } },
      "settings": { "event_subscriptions": { "request_url": "https://ax.example/slack/events/AAAAAAAAAAAAAAAAAAAAAA",
                                             "bot_events": ["app_mention", "message.im"] },
                    "org_deploy_enabled": false, "socket_mode_enabled": false, "token_rotation_enabled": false } }
    ```
- [ ] **Step 2:** `pnpm --filter @ax/channel-slack test`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the scaffold and the three modules.
- [ ] **Step 4:** Tests pass. `pnpm --filter @ax/channel-slack build` is clean.
- [ ] **Step 5:** Commit `feat(channel-slack): package, bot name rules and app manifest (TASK-1093)`.

### Task 2: Slack Web API client over an injected fetch [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/slack-api.ts`
- Test: `packages/channel-slack/src/__tests__/slack-api.test.ts`

**Interfaces:**
- Consumes: `limits.ts` (Task 1).
- Produces:
  ```ts
  export class SlackApiError extends Error { readonly method: string; readonly code: string; readonly retryAfterMs?: number }
  export type StreamChunkOut =
    | { type: 'markdown_text'; text: string }
    | { type: 'task_update'; id: string; title: string; status: 'in_progress' | 'complete' | 'error' };
  export interface SlackApi {
    rotateConfigToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }>;
    createApp(configToken: string, manifest: Record<string, unknown>): Promise<{ appId: string; clientId: string; clientSecret: string; signingSecret: string }>;
    deleteApp(configToken: string, appId: string): Promise<void>;
    setAppIcon(configToken: string, appId: string, url: string): Promise<void>;
    oauthAccess(i: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<{ botToken: string; botUserId: string; appId: string; teamId: string; teamName: string; enterpriseInstall: boolean }>;
    usersInfo(botToken: string, userId: string): Promise<unknown>; // the raw `user` object; Task 9 validates it
    postMessage(botToken: string, a: { channel: string; threadTs: string; markdownText: string }): Promise<void>;
    postEphemeral(botToken: string, a: { channel: string; user: string; text: string; threadTs?: string }): Promise<void>;
    startStream(botToken: string, a: { channel: string; threadTs: string; recipientUserId: string; recipientTeamId: string; chunks: StreamChunkOut[] }): Promise<{ ts: string }>;
    appendStream(botToken: string, a: { channel: string; ts: string; chunks: StreamChunkOut[] }): Promise<void>;
    stopStream(botToken: string, a: { channel: string; ts: string; chunks?: StreamChunkOut[] }): Promise<void>;
  }
  export function createSlackApi(opts: { fetchImpl: typeof fetch; timeoutMs?: number }): SlackApi;
  ```
- Encoding per method:
  - **Form:** `tooling.tokens.rotate` (`refresh_token`, no auth header), `oauth.v2.access` (`code`, `redirect_uri`, HTTP Basic `client_id:client_secret`), `users.info` (`user`), `apps.manifest.create` (`manifest` = the JSON string), `apps.manifest.delete` (`app_id`), `apps.icon.set` (`app_id`, `url`).
  - **JSON:** every `chat.*` call. Snake_case keys: `thread_ts`, `recipient_user_id`, `recipient_team_id`, `markdown_text`.
  - **Auth:** everything else sends `Authorization: Bearer <token>`.
- `rotateConfigToken` deliberately does not return the new refresh token, so no caller can store one.

- [ ] **Step 1: Write failing tests** (fake `fetchImpl` records requests):
  - `users.info sends a form body with a Bearer header`: URL `https://slack.com/api/users.info`, POST, form content-type, body `user=U1`.
  - `chat.startStream sends JSON` matching the snake_case shape.
  - `postMessage always disables unfurling`.
  - `oauth.v2.access uses Basic auth and keeps the secret out of the body`.
  - `rotateConfigToken returns only accessToken and expiresAt`: `Object.keys` equals that pair; `expiresAt = exp*1000`.
  - `ok:false → SlackApiError with Slack's code`: `invalid_auth` stays `invalid_auth`; `'<script>'` becomes `unknown`.
  - `429 → ratelimited`: `Retry-After: 5` → 5000; `999` → 60000; missing → 1000.
  - `3xx → redirect`, and the request used `redirect: 'manual'`.
  - `body over 1 MiB → too-large`; `non-JSON → bad-response`.
  - `no response within timeoutMs → timeout` (timeoutMs 50).
  - `fetch throws → network`.
  - `oauthAccess with token_type other than bot or a missing field → bad-response`.
  - `an error message is "slack <method>: <code>" and never contains a token`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Narrow every response field with `typeof` checks; zod isn't needed.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(channel-slack): Slack Web API client over injected fetch (TASK-1093)`.

### Task 3: Install store, migration and secrets [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/migrations.ts`, `src/store.ts`, `src/secrets.ts`
- Test: `src/__tests__/store.test.ts` (one `PostgreSqlContainer('postgres:16-alpine')` per file, copying `packages/connector-directory/src/__tests__/` setup), `src/__tests__/secrets.test.ts` (fake bus)

**Interfaces:**
- Table `channel_slack_v1_installs`:
  - `install_id TEXT PRIMARY KEY`, `status TEXT NOT NULL` (`pending | active`; no CHECK)
  - `app_id TEXT NOT NULL`, `client_id TEXT NOT NULL`, `bot_name TEXT NOT NULL`
  - `team_id TEXT`, `team_name TEXT`, `bot_user_id TEXT`
  - `connected_by_user_id TEXT NOT NULL`, `connected_by_name TEXT NOT NULL`
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `installed_at TIMESTAMPTZ`
  - `oauth_state_hash TEXT`, `oauth_state_user_id TEXT`, `oauth_state_expires_at TIMESTAMPTZ`
  - plus `CREATE UNIQUE INDEX IF NOT EXISTS ... (oauth_state_hash) WHERE oauth_state_hash IS NOT NULL`.
  - `runMigrations(db)` uses idempotent `IF NOT EXISTS` statements.
- Produces (`store.ts`):
  ```ts
  export interface InstallRow { installId: string; status: 'pending' | 'active'; appId: string; clientId: string; botName: string;
    teamId: string | null; teamName: string | null; botUserId: string | null; connectedByUserId: string; connectedByName: string;
    createdAt: Date; installedAt: Date | null }
  export interface OAuthState { installId: string; userId: string; expiresAt: Date }
  export interface InstallStore {
    current(): Promise<InstallRow | null>;              // the one shared-app install, any status
    get(installId: string): Promise<InstallRow | null>;
    insertPending(r: Pick<InstallRow, 'installId' | 'appId' | 'clientId' | 'botName' | 'connectedByUserId' | 'connectedByName'>): Promise<void>;
    setOAuthState(installId: string, s: { stateHash: string; userId: string; expiresAt: Date }): Promise<void>;
    peekOAuthState(stateHash: string): Promise<OAuthState | null>;
    consumeOAuthState(stateHash: string): Promise<OAuthState | null>; // one UPDATE … SET state cols NULL … RETURNING; single use
    activate(installId: string, a: { teamId: string; teamName: string; botUserId: string; installedAt: Date }): Promise<void>;
    remove(installId: string): Promise<void>;
    removeAll(): Promise<void>;
  }
  export function createInstallStore(db: Kysely<unknown>): InstallStore;
  ```
  `activate` stores `teamName` after `replaceSurfaceRewriters` (`@ax/core/surface-text`) and a 120-character clamp.
- Produces (`secrets.ts`):
  ```ts
  export type SecretName = 'bot-token' | 'signing-secret' | 'client-secret' | 'config-refresh-token';
  export function secretRef(installId: string, name: SecretName): string; // `slack:${installId}:${name}`
  export interface SecretStore {
    put(install: { installId: string; connectedByUserId: string }, name: SecretName, value: string): Promise<void>;
    get(install: { installId: string; connectedByUserId: string }, name: SecretName): Promise<string | null>;
    removeAll(install: { installId: string }): Promise<void>; // tries all four; logs code-only; never throws
  }
  export function createSecretStore(bus: HookBus): SecretStore;
  ```
  - `put` → `credentials:set({ scope: 'global', ownerId: null, ref, kind: 'api-key', payload: utf-8 bytes })`.
  - `get` → `credentials:get({ ref, userId: connectedByUserId })` under `makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: connectedByUserId })`. The hook's not-found refusal → `null`; any other error propagates.
  - `removeAll` → `credentials:delete({ scope: 'global', ownerId: null, ref })` for each name.

- [ ] **Step 1: Write failing tests.**
  - `store.test.ts`:
    - `runMigrations twice is a no-op`
    - `insertPending then get/current round-trips`
    - `consumeOAuthState is single-use`: a second consume → `null`; two concurrent consumes → exactly one non-null
    - `peek does not consume`
    - `activate sets team, bot user, installedAt and status active`
    - `activate cleans a team name with a U+202E in it`
    - `remove and removeAll delete rows`
  - `secrets.test.ts`:
    - `put writes global api-key under slack:<id>:<name>`
    - `get reads with the connector's userId and agentId ''`
    - `get maps not-found to null and rethrows other errors`
    - `removeAll calls delete for all four names even when one throws, and logs only installId + code`
- [ ] **Step 2:** Run (with `DOCKER_HOST`). Expected: FAIL.
- [ ] **Step 3:** Implement. Keep every `selectFrom('channel_slack_v1_installs')` inside `store.ts`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(channel-slack): install store and vault-backed secrets (TASK-1093)`.

### Task 4: Events ingress (signature, replay window, dedupe, ack-then-run) [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/signature.ts`, `src/http-types.ts` (structural req/res types, like routines' duck types, without an `@ax/http-server` dep), `src/lifetime.ts` (copy of routines' `track/admit/stopAdmission/drain`; no `defer`), `src/events.ts`
- Modify: `deploy/charts/ax-next/templates/_helpers.tpl:382-398` (add "@ax/channel-slack's event-id dedupe set" to the replica-local list)
- Test: `src/__tests__/signature.test.ts`, `src/__tests__/events.test.ts`

**Interfaces:**
- Consumes: `InstallStore`, `SecretStore` (Task 3).
- Produces (`http-types.ts`):
  - `RouteRequest` (`{ method; path; rawPath; params; query; headers; body: Buffer }`)
  - `RouteResponse` (the `status`/`header`/`json`/`text`/`end`/`redirect` subset)
  - `RouteHandler = (req, res) => Promise<void>`
  - `RouteSpec = { method: 'GET' | 'POST'; path: string; handler: RouteHandler; bypassCsrf?: boolean; maxBodyBytes?: number }`
- Produces (`lifetime.ts`): `createLifetime(): Lifetime` with `track`, `admit`, `stopAdmission`, `drain`, and `export type Lifetime = ReturnType<typeof createLifetime>`.
- Produces:
  ```ts
  export function verifySlackSignature(i: { headers: Readonly<Record<string, string>>; body: Buffer; signingSecret: string; nowMs: number }): boolean;
  export interface SlackInnerEvent { type: string; subtype?: string; user?: string; botId?: string; text?: string;
    channel?: string; channelType?: string; ts?: string; threadTs?: string }
  export interface SlackEnvelope { teamId: string; apiAppId: string; eventId: string; isExtSharedChannel: boolean; event: SlackInnerEvent }
  export type ParsedBody = { kind: 'url_verification'; challenge: string } | { kind: 'event_callback'; envelope: SlackEnvelope } | { kind: 'other' };
  export function parseBody(json: unknown): ParsedBody | null;
  export type EventDispatcher = (install: InstallRow, envelope: SlackEnvelope) => Promise<void>;
  export function createSeenEvents(o: { ttlMs: number; max: number }): { firstSighting(eventId: string, nowMs: number): boolean };
  export const INSTALL_ID_RE = /^[A-Za-z0-9_-]{22}$/;
  export function createEventsHandler(d: { store: InstallStore; secrets: SecretStore; lifetime: Lifetime;
    seen: ReturnType<typeof createSeenEvents>; dispatch: EventDispatcher; logger: Logger; now: () => number }): RouteHandler;
  ```
- **Handler order:**
  1. `installId` matches `INSTALL_ID_RE` and `rawPath === '/slack/events/' + installId`, else 404.
  2. The install exists, else 404.
  3. The signing secret exists, else 404.
  4. The signature passes, else 401.
  5. The body is a JSON object, else 400.
  6. `url_verification` → 200 `{ challenge }`.
  7. `event_callback`:
     - `apiAppId` ≠ `install.appId`, status not `active`, or `teamId` ≠ `install.teamId` → 200 and ignore (log `slack_event_ignored`).
     - Seen before → 200, ignore.
     - Otherwise answer 200 with an empty body, then `lifetime.track(() => dispatch(...))`. Errors are caught and logged as `slack_event_failed` with `stage`.
  8. Anything else → 200.
  9. After `stopAdmission` → 503, so Slack retries against the next pod.
- **Parsing limits:** hand-written `typeof` checks. Ids at most 64 chars; `text` at most 40,000. `threadTs` comes from `thread_ts`, `botId` from `bot_id`, `channelType` from `channel_type`.

- [ ] **Step 1: Write failing tests.**
  - `signature.test.ts`:
    - **Slack's published vector:** secret `8f742231b10e8888abcd99yyyzzz85a5`, timestamp `1531420618`, `nowMs = 1531420618000`, and the body below give `v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503` → true.
      ```
      token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c
      ```
    - Window: ±300 s passes; ±301 s fails.
    - Fails: a timestamp `'1e9'`, an empty secret, a signature header over 8192 chars, a flipped byte in the body, and a missing header.
  - `events.test.ts` (fake store, secrets and dispatch; signed with a test secret):
    - `signed event_callback → 200 and dispatch once with the parsed envelope`
    - `same event_id twice → one dispatch`
    - `a forged request with a fresh event_id does not mark it seen` (then the real one dispatches)
    - `stale timestamp → 401, no dispatch`
    - `unknown installId → 404`; `malformed installId → 404`; `rawPath with %2F → 404`
    - `url_verification signed → 200 challenge`; `unsigned → 401`
    - `api_app_id mismatch → 200, no dispatch`
    - `pending install → 200, no dispatch`
    - `after stopAdmission → 503`
    - `dispatch rejects → response already 200 and slack_event_failed logged without the error text`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement (copy the routines helpers, not an import). Add the `_helpers.tpl` line.
- [ ] **Step 4:** Tests pass: `pnpm --filter @ax/channel-slack test`. The `_helpers.tpl` edit is inside a `{{/* */}}` comment; `pnpm --filter @ax/chart-tests test` still renders.
- [ ] **Step 5:** Commit `feat(channel-slack): signed events ingress with replay window and dedupe (TASK-1093)`.

### Task 5: Admin routes and the OAuth install callback [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/admin-auth.ts` (copy of branding's `requireAuthenticated`/`requireAdmin`, returning `{ id, displayName, isAdmin }`), `src/mutex.ts` (a promise-chain lock), `src/admin-routes.ts`
- Test: `src/__tests__/admin-routes.test.ts` (an in-memory `InstallStore`/`SecretStore` fake, fake `SlackApi`, fake bus)

**Interfaces:**
- Consumes: Tasks 1–3, and `RouteSpec` (Task 4).
- Produces (`mutex.ts`): `createMutex(): Mutex` with `run<T>(fn: () => Promise<T>): Promise<T>`, running one at a time in arrival order.
- Produces:
  ```ts
  export type SlackStatus =
    | { state: 'not-connected'; defaultBotName: string; canConnect: boolean }
    | { state: 'pending'; botName: string; connectedBy: string; connectedAt: string }
    | { state: 'connected'; botName: string; workspaceName: string; connectedBy: string; connectedAt: string };
  export function createAdminRoutes(d: { bus: HookBus; store: InstallStore; secrets: SecretStore; api: SlackApi; lock: Mutex;
    publicOrigin: string; iconUrl?: string; now: () => number; randomBytes: (n: number) => Buffer }): RouteSpec[];
  ```
- **Every route:** admin only (401 or 403 as branding does), and any route that mutates runs under `lock`.
- **`GET /admin/slack`:** returns `SlackStatus`.
  - `canConnect` is `new URL(publicOrigin).protocol === 'https:'`.
  - `defaultBotName` = `defaultBotName(name)` from `branding:get` when the service exists and doesn't throw, else `'ax'`.
- **`POST /admin/slack/connect`:** body `{ accessToken, refreshToken, botName? }`.
  - **Refusals, before calling Slack:**
    - `accessToken` must start `xoxe.xoxp-`, refreshToken `xoxe-`, both ≤ 512 chars of `[A-Za-z0-9._-]`, else 400 `invalid-access-token` / `invalid-refresh-token`.
    - Bad name → 400 `{ error: 'invalid-bot-name', reason }`.
    - Install exists → 409 `already-connected`.
    - Origin isn't https → 409 `public-origin-not-https`.
  - **Then:**
    1. Mint `installId` and call `createApp(accessToken, buildAppManifest(name, slackUrls(...)))`.
    2. `put` client-secret, signing-secret and config-refresh-token; then `insertPending`.
    3. If `iconUrl` is set, call `setAppIcon(accessToken, appId, iconUrl)`. Best-effort: `icon_not_accessible` → `iconSet: false` silently; other errors → `iconSet: false` plus a code-only log.
    4. Mint `state` (32 random bytes hex) and store its sha256 with the admin's id and `now + OAUTH_STATE_TTL_MS`.
    5. Return 200 `{ installUrl, iconSet }`.
  - **Slack errors map to 502 `{ error }`:**
    - `invalid_auth | not_authed | token_expired | token_revoked | account_inactive` → `slack-token`
    - `invalid_manifest` → `slack-name`
    - else `slack-error`
  - **Any failure after `createApp`** → `deleteApp` best-effort, `secrets.removeAll`, then 500.
  - The pasted access token is used for these two calls only and never stored.
- **`POST /admin/slack/install-url`:** only while `pending`. Mints a new state, so the old one stops matching. Returns `{ installUrl }`; otherwise 409 `not-pending`.
- **`GET /admin/slack/oauth/callback?code&state` or `?error&state`:**
  - requireAdmin.
  - `peekOAuthState(sha256(state))` → missing: 400. Other admin: 403, and the state is not consumed. Then consume.
  - Expired → redirect `failed`. `error` param → redirect `cancelled`.
  - `oauthAccess({ clientId, clientSecret, code, redirectUri })`. A wrong `appId` or an enterprise install → redirect `failed`, and the bot token is not stored.
  - `put` bot-token, then `activate`, then redirect `connected`.
  - Redirects are 302 to `${publicOrigin}/?slack=connected|cancelled|failed`.
- **`POST /admin/slack/disconnect`:** no install → 409 `not-connected`.
  - Read config-refresh-token, then `rotateConfigToken`, then `deleteApp` (`appDeleted` true only if both succeed).
  - Then `store.remove` and `secrets.removeAll`.
  - Return 200 `{ appDeleted }`.
  - The minted access token is used once. Nothing is written to `credentials:set` during disconnect.

- [ ] **Step 1: Write failing tests** (`admin-routes.test.ts`):
  - **Status:**
    - `status: not-connected with the branding default name; 'ax' when branding:get is absent or throws; canConnect false for an http origin`
    - `status: pending and connected carry botName, connectedBy and connectedAt (and workspaceName when connected)`
  - **Connect, happy path:**
    - `connect creates the app with the pasted access token and a manifest whose request_url holds the new installId`
    - `connect stores client-secret, signing-secret and the PASTED refresh token, then a pending row`
    - `connect returns an installUrl with client_id, scope, redirect_uri and state; the row holds sha256(state), never the raw state`
  - **Connect, refusals:**
    - `connect refuses swapped tokens (400 invalid-access-token / invalid-refresh-token) before calling Slack`
    - `connect refuses a reserved name with { error: 'invalid-bot-name', reason: 'reserved' }`
    - `connect → 409 already-connected / public-origin-not-https`
    - `createApp invalid_auth → 502 slack-token, invalid_manifest → 502 slack-name, other → 502 slack-error; nothing stored`
  - **Connect, partial failure and icon:**
    - `a store failure after createApp deletes the app and the secrets, then 500`
    - `icon_not_accessible → iconSet false and no log; another icon error → iconSet false and one code-only log`
  - **Install URL:**
    - `install-url while pending replaces the state (the old state no longer matches); otherwise 409 not-pending`
  - **OAuth callback:**
    - `callback: unknown state → 400; another admin → 403 and the state still works for the right admin`
    - `callback: expired → failed; error=access_denied → cancelled; both consume the state`
    - `callback success: oauthAccess uses the stored client secret and the exact redirect_uri; the bot token is stored; the row is active with the team; redirect connected`
    - `callback: wrong app_id or an enterprise install → failed, no bot token stored`
    - `a replayed callback after success → 400`
  - **Disconnect:**
    - `disconnect: rotate + deleteApp succeed → { appDeleted: true }, row and four secrets removed`
    - `disconnect: rotate fails or deleteApp fails → { appDeleted: false }, row and secrets still removed`
    - `disconnect never calls credentials:set`
  - **Cross-cutting:**
    - `no response body or log line contains any of the four secrets or either pasted token` (spy logger; scan the JSON)
    - `two concurrent connects → one 200, one 409`
    - `every route: non-admin → 403, unauthenticated → 401`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(channel-slack): admin connect/disconnect routes and OAuth install callback (TASK-1093)`.

### Task 6: Plugin assembly, presets, canary, build graph [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/plugin.ts`
- Modify: `src/index.ts` (export `createChannelSlackPlugin`, `ChannelSlackConfig`, `PLUGIN_NAME`)
- Modify (preset): `presets/k8s/src/index.ts`
  - Import.
  - `K8sPresetConfig.channelSlack?: { fetchImpl?: typeof fetch }`, like `connectorDirectory.fetchImpl` at `:555-562`.
  - Push right after `createChannelWebServerPlugin` (`:1499-1503`) with `{ publicOrigin: presetPublicOrigin(config), iconUrl: \`${presetPublicOrigin(config)}/api/branding/logo/light\`, ...(config.channelSlack?.fetchImpl ? { fetchImpl } : {}) }`.
- Modify (build graph): `presets/k8s/package.json`, `presets/k8s/tsconfig.json`, `pnpm-lock.yaml`
- Modify (preset tests):
  - `presets/k8s/src/__tests__/preset.test.ts`: the exact plugin list `:307-367`, plus a manifest pin.
  - `prod-bootstrap.test.ts` `REQUIRED_PROD_PLUGINS` (`:207-259`).
  - Add `'@ax/channel-slack'` to the drop lists of `acceptance.test.ts:130-300`, `multi-tenant-acceptance.test.ts`, `usage-limits-acceptance.test.ts` and `disk-quota-acceptance.test.ts`, with a comment pointing to the Task 13 composition test.
  - Update any exact plugin list in `presets/memory/src/__tests__/`.
- Modify (canary): `presets/memory/src/__tests__/canary.test.ts`. A reachability case against the real HTTP server:
  - `GET /admin/slack` as the canary admin → 200 `{ state: 'not-connected' }`.
  - `POST /slack/events/AAAAAAAAAAAAAAAAAAAAAA` → 404.
- Modify (docs):
  - `deploy/charts/ax-next/SECURITY.md:200`: "HTTPS (443), any destination: model providers, sign-in providers, connectors' servers and Slack (`slack.com`)".
  - The netpol header comment at `agent-runtime-network.yaml:10`: the same list.
- Test: `src/__tests__/plugin.test.ts`

**Interfaces:**
- `ChannelSlackConfig`:
  ```ts
  { publicOrigin: string; iconUrl?: string; fetchImpl?: typeof fetch; now?: () => number }
  ```
  An unparseable `publicOrigin`, or one that isn't http/https, is a `PluginError` `invalid-config` at construction.
- Manifest (PR A):
  - `registers: []`
  - `calls: ['http:register-route', 'auth:require-user', 'database:get-instance', 'credentials:get', 'credentials:set', 'credentials:delete']`
  - `optionalCalls: [{ hook: 'branding:get', degradation: 'the default bot name is "ax"' }]`
  - `subscribes: ['bootstrap:reset-cleanup']`
- `init`:
  - Run migrations and build the store, secrets, client and lifetime.
  - Register the admin routes and `POST /slack/events/:installId` (`bypassCsrf: true`, `maxBodyBytes: EVENTS_MAX_BODY_BYTES`). In PR A, `dispatch` logs `slack_event_not_handled` with `{ installId, type }`; Task 11 replaces it.
  - Subscribe `bootstrap:reset-cleanup` → `store.removeAll()`.
- `stopAdmission` → `lifetime.stopAdmission()`.
- `shutdown` → unregister routes and the subscription, then `lifetime.drain()`.

- [ ] **Step 1: Write failing tests:**
  - `plugin.test.ts`: `manifest pins` (registers empty, calls as above); `init registers the six routes, and only the events route bypasses CSRF`; `bootstrap:reset-cleanup empties the installs table` (Postgres); `an http publicOrigin boots, and status reports canConnect:false`; `an unparseable publicOrigin fails construction`.
  - The preset and canary cases above.
- [ ] **Step 2:** Run the package tests, then `pnpm --filter @ax/preset-k8s test` and `pnpm --filter @ax/preset-memory test` (with `DOCKER_HOST`). Expected: FAIL.
- [ ] **Step 3:** Implement and wire. Verify with an isolated `pnpm --filter @ax/preset-k8s build` (clean its `dist` and tsbuildinfo first) and `pnpm test:scripts` (`tsconfig-references`).
- [ ] **Step 4:** All pass.
- [ ] **Step 5:** Commit `feat(channel-slack): wire the plugin into the presets and the canary (TASK-1093)`.

### Task 7: Admin "Slack" settings tab [tier: integration]

**Invoke the `shadcn` skill first** (workspace `-c packages/channel-web`, run from the repo root). Every primitive needed is already installed: `card`, `field`, `input`, `button`, `alert`, `dialog`, `skeleton`, `empty`, `badge`. Then run the `ux-design` skill over the copy below before committing.

**Files:**
- Create: `packages/channel-web/src/lib/slack-admin.ts`, `src/lib/slack-install-return.ts`, `src/components/admin/SlackTab.tsx`
- Modify:
  - `src/components/admin/AdminSidebar.tsx`: add `'slack'` to `AdminTabId`, and an `ADMIN_NAV` entry `{ id: 'slack', label: 'Slack', icon: MessageSquare }` between Teams and Branding, so Usage stays right after Branding (`AdminSidebar.test.tsx:104`).
  - `src/components/admin/AdminShell.tsx`: `TAB_META`, `TAB_HELP`, the render line.
  - `src/App.tsx`: call the return handler next to `oauth-full-page-return` (`:108-129`); it opens `onOpenAdminSettings('slack')`.
- Test: `src/components/admin/__tests__/SlackTab.test.tsx` (mocks `@/lib/slack-admin`), `src/__tests__/admin-slack.test.tsx` (stubs `globalThis.fetch`: URLs, bodies, `x-requested-with: ax-admin`), `src/lib/__tests__/slack-install-return.test.ts`

**Interfaces:**
- Consumes: Task 5's routes and the `SlackStatus` JSON. Re-declare the type locally (structural mirror, no import).
- Produces:
  - `fetchSlackStatus(): Promise<SlackStatus | { state: 'unavailable' }>`: a 404 or non-JSON response → `unavailable`.
  - `connectSlack(b)`, `resumeSlackInstall()`, `disconnectSlack()`: each POSTs with `credentials: 'include'` and the write headers from `lib/branding.ts:11-14`.
  - `readSlackInstallReturn(search: string): 'connected' | 'cancelled' | 'failed' | null`.
- **States and copy** (warm, plain, no raw codes; errors via a fixed map):
  - **unavailable:** `Empty` "Slack isn't set up on this server."
  - **not-connected, canConnect false:** `Alert` "Slack can only reach AX at a public https address, and this server doesn't have one yet. Whoever runs AX can set it (`onboarding.publicBaseUrl` in the Helm values)."
  - **not-connected:**
    - A three-step guide: (1) "Open [Slack's app settings](https://api.slack.com/apps). Under **Your App Configuration Tokens**, click **Generate Token** for your workspace." (2) "Paste both values below. We keep only the refresh token, encrypted, and nobody can read it back." (3) "Pick the bot's name and click **Connect**. Slack will ask you to **Allow** it."
    - A note: "Slack keeps a copy of everything the agent says there, under your workspace's retention rules."
    - Fields: Access token and Refresh token (`Input type="password" autoComplete="off"`), Bot name (prefilled with `defaultBotName`).
    - On success: `window.location.assign(installUrl)`.
  - **pending:** "Almost there: finish installing the bot in Slack." Buttons: **Continue in Slack** (resume) and **Cancel** (disconnect dialog).
  - **connected:** "Connected to {workspaceName}. Bot name: {botName}. Configuration token added by {connectedBy} on {date}. People can now DM the bot to talk to their own AX agent." Button: **Disconnect**.
  - **Disconnect `Dialog`:** "Disconnect Slack?" / "The bot leaves Slack and people can't reach their agents there. Their conversations stay in AX."
  - **After disconnect, an `Alert`:** "Slack is disconnected. One more step only you can do: on [Slack's app settings](https://api.slack.com/apps), under **Your App Configuration Tokens**, click **Revoke**. Slack doesn't let us do that part." If `appDeleted` is false, add: "We couldn't remove the Slack app itself. Delete it on the same page."
  - **Error map:**
    - `invalid-access-token` → "That doesn't look like an access token. It starts with xoxe.xoxp-."
    - `invalid-refresh-token` → "…It starts with xoxe-."
    - `invalid-bot-name` reasons → "Give the bot a name." / "Keep the name to 35 characters or fewer." / "Use letters, numbers, spaces, dots, dashes or underscores." / "Slack keeps that name for itself. Pick another."
    - `slack-token` → "Slack didn't accept the access token. Generate a new pair and paste both again."
    - `slack-name` → "Slack didn't accept that bot name. Try another."
    - Anything else → "Something went wrong talking to Slack. Try again in a minute."
  - **Return toasts:** "Slack is connected." / "Slack install was cancelled." / "We couldn't finish connecting Slack. Try again." Clean the URL after.

- [ ] **Step 1: Write failing tests:**
  - Each state renders its copy and controls.
  - Connect posts the right body and then navigates.
  - The disconnect dialog, then the revoke alert, with and without `appDeleted`.
  - Secrets never appear in the DOM after submit (inputs cleared).
  - `readSlackInstallReturn` table.
  - The sidebar order stays as the existing pinned tests expect.
- [ ] **Step 2:** `pnpm --filter @ax/channel-web test`. Expected: FAIL.
- [ ] **Step 3:** Implement with shadcn primitives and semantic tokens only (no raw colors, no hand-styled `<div>` forms).
- [ ] **Step 4:** Tests and `pnpm --filter @ax/channel-web build` pass. channel-web's `tsc` checks its tests.
- [ ] **Step 5:** Commit `feat(channel-web): admin Slack tab to connect and disconnect a workspace (TASK-1093)`.

---

## PR B — admission, personal-agent DMs, streamed replies

### Task 8: Conversation origin `'slack'` [tier: integration]

**Files:**
- Modify: `packages/conversations/src/types.ts:42,45` (union and list), `:557` (`z.enum(CONVERSATION_ORIGINS)`, or the same three literals)
- Modify: `packages/conversations/src/store.ts:174,907`. One helper `readOrigin(raw: unknown): ConversationOrigin` returns the value if `CONVERSATION_ORIGINS` includes it, else `'web'`. Both projections use it.
- Test: the conversations store/plugin tests (find-or-create with `origin: 'slack'` round-trips through `conversations:get` and `conversations:get-metadata`); `packages/decisions/src/__tests__/` (attendance: a `'slack'` conversation → `unattended`, test named `a slack conversation is unattended until approval buttons exist (TASK-1095)`)

**Interfaces:**
- Produces: `ConversationOrigin = 'web' | 'routine' | 'slack'`. Nothing else changes. decisions needs no code change: its narrowing already maps unknown values to `'routine'`.

- [ ] **Step 1: Write the failing tests:**
  - `find-or-create stores origin slack and both get and get-metadata return it`
  - `an unknown stored origin still reads as web`
  - The decisions attendance test above.
- [ ] **Step 2:** Run `pnpm --filter @ax/conversations test` and `pnpm --filter @ax/decisions test`. Expected: the conversations cases FAIL (validation rejects `'slack'`).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Pass. Run `pnpm build` (consumers that switch on the union must still compile).
- [ ] **Step 5:** Commit `feat(conversations): 'slack' origin, read-only in web and unattended for decisions (TASK-1093)`.

### Task 9: Admission and the mention refusal [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/admission.ts`, `src/copy.ts`
- Test: `src/__tests__/admission.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RefusalReason = 'bot' | 'deactivated' | 'guest' | 'other-workspace' | 'invited' | 'email-unconfirmed' | 'no-email' | 'lookup-failed';
  export type Admission = { ok: true; email: string } | { ok: false; reason: RefusalReason };
  export function admitSlackUser(user: unknown, teamId: string): Admission;        // pure
  export async function admitSender(api: SlackApi, botToken: string, slackUserId: string, teamId: string): Promise<Admission>; // users.info; any API error → lookup-failed
  ```
- Rules, in order. The first that fires wins:
  1. Not an object → `lookup-failed`.
  2. `id === 'USLACKBOT'`, `is_bot === true` or `is_workflow_bot === true` → `bot`.
  3. `deleted === true` → `deactivated`.
  4. `is_restricted === true` or `is_ultra_restricted === true` → `guest`.
  5. `is_stranger === true` or `team_id !== teamId` → `other-workspace`.
  6. `is_invited_user === true` → `invited`.
  7. `is_email_confirmed !== true` → `email-unconfirmed`.
  8. `profile.email` isn't a 1–320-character string → `no-email`.
  9. Otherwise `{ ok: true, email: profile.email }`, verbatim: no trim, no lowercasing.
- `copy.ts`: all Slack-facing strings.
  ```ts
  export const COPY = {
    notMapped: (o: string) => `I couldn't match your Slack account to an AX account. Sign in to [AX](${o}) once with your work account, then send your message again.`,
    noAgent: (o: string) => `You don't have a personal agent in [AX](${o}) yet. Make one there, then send your message again.`,
    mentionRefusal: "I only answer direct messages for now. Send me a DM to talk to your own AX agent.",
    filesUnsupported: "I can't read files in Slack yet. Send your message as text, or share the file with me in AX.",
    queueFull: "I'm still working on your earlier messages in this thread. Send this one again after I reply.",
    busy: "I'm busy with something else in this conversation. Try again in a moment.",
    turnFailed: "Something went wrong and I couldn't finish. Try again in a moment.",
    emptyReply: "I didn't have anything to add.",
    artifactLink: (link: string) => `I made something you can open in AX: [Open it in AX](${link})`,
    statusDefault: 'Working',
  } as const;
  ```

- [ ] **Step 1: Write failing tests:**
  - A table with one case per rule.
  - Rule order: a deactivated guest → `deactivated`.
  - `is_email_confirmed` absent → `email-unconfirmed`, which fails closed.
  - `is_app_user: true` on a normal member is admitted (it means "authorized this app", not a bot).
  - `admitSender maps users.info errors to lookup-failed and passes the bot token`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Pass.
- [ ] **Step 5:** Commit `feat(channel-slack): admission from users.info, never from message text (TASK-1093)`.

### Task 10: Reply streamer [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/format.ts`, `src/reply-stream.ts`
- Test: `src/__tests__/format.test.ts`, `src/__tests__/reply-stream.test.ts` (fake `SlackApi` with controllable latency and failures; injected clock and timers)

**Interfaces:**
- Consumes: `SlackApi`, `StreamChunkOut` (Task 2), `COPY` (Task 9).
- Produces:
  ```ts
  export function neutralizeSlackControls(text: string): string; // '<' before '!' '@' '#' → '<' + U+200B
  export function cleanStatusTitle(text: string): string;         // replaceSurfaceRewriters, collapse whitespace, clamp STATUS_TITLE_MAX, neutralize
  export function splitForPost(text: string, limit: number): string[]; // parts ≤ limit, cut at the last '\n' (else ' ') in each window
  export interface ReplyTarget { channel: string; threadTs: string; recipientUserId: string; recipientTeamId: string }
  export type ReplyOutcome = 'complete' | 'error' | 'busy';
  export interface ReplyStream { text(delta: string): void; status(title: string): void; artifact(): void; finish(o: ReplyOutcome): Promise<void> }
  export function createReplyStream(d: { api: SlackApi; botToken: string; target: ReplyTarget; agentLink: string; logger: Logger;
    clock: { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void } }): ReplyStream;
  ```
- **Behavior:**
  - `text`, `status` and `artifact` are synchronous: they buffer and schedule a flush within `FLUSH_INTERVAL_MS`.
  - The first flush with content starts the stream: `startStream` with the pending chunks. Text goes as `markdown_text` chunks after neutralizing. The status is one `task_update` with id `'status'`, `in_progress`, and a cleaned title.
  - Later flushes `appendStream` the coalesced chunks. One call in flight. Order is preserved.
  - **Rotation:** before a flush would take the stream's markdown total past `STREAM_TEXT_LIMIT`, or once the stream is `STREAM_MAX_AGE_MS` old:
    1. Send what fits.
    2. `stopStream`, marking that message's status card `complete`.
    3. `startStream` a new one in the same thread with the rest, and the status again if it's still in progress.
  - **`ratelimited`:** hold the buffer and retry after `retryAfterMs`.
  - **Any other stream error:** switch to post mode. Nothing else goes to stream calls.
  - **`finish`:**
    1. Flush.
    2. Append the line: `COPY.artifactLink(agentLink)` if `artifact()` was called (once), `COPY.turnFailed` for `error`, `COPY.busy` for `busy`.
    3. `stopStream` with the status set to `complete` (or `error`).
    4. In post mode, `postMessage` each `splitForPost(unsent, POST_PART_LIMIT)` part, the final line included.
    5. With no text, no status and no line, post `COPY.emptyReply`.
  - `finish` is idempotent; later `text`/`status` calls are ignored.

- [ ] **Step 1: Write failing tests:**
  - `format.test.ts`:
    - `'<!channel> hi <@U1> <#C1>'` keeps every character plus three U+200B.
    - `cleanStatusTitle` with a U+202E becomes a space, and a 200-character title is clamped.
    - `splitForPost` (25,000 chars with newlines): the parts rejoin to the input and each is ≤ 11,000.
  - `reply-stream.test.ts`:
    - `no Slack call until there is something to show`
    - `deltas within one interval are one append`
    - `one call in flight; appended text equals input in order` (slow fake)
    - `status is a single task card updated in place and completed at finish` (exactly one distinct task id)
    - `25,000 characters span three streams, each ≤ 11,000, concatenation equals input`
    - `a stream 9 minutes old is closed and a new one started in the same thread`
    - `ratelimited pauses then resumes with nothing lost`
    - `an append failure posts exactly the unconfirmed text via postMessage and makes no further stream call`
    - `startStream failure → whole reply posted at finish`
    - `finish('error') adds the failure line and marks the card error`
    - `finish('complete') with nothing → one postMessage of emptyReply`
    - `artifact() twice → one link line at the end`
    - `model text is neutralized before it leaves`
    - `finish twice is a no-op`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Pass.
- [ ] **Step 5:** Commit `feat(channel-slack): stream replies into Slack threads with rotation and post fallback (TASK-1093)`.

### Task 11: DM turns and the event router [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/turn-queue.ts`, `src/turn-registry.ts`, `src/dm-turn.ts`, `src/router.ts`
- Modify:
  - `src/plugin.ts`: add to `calls`: `'auth:find-user-by-email'`, `'agents:list-for-user'`, `'conversations:find-or-create'`, `'agent:invoke'`. Add to `subscribes`: `'chat:stream-chunk'`, `'chat:turn-end'`, `'chat:turn-error'`. Subscribe the registry at init. `dispatch` = the router. `shutdown` also unsubscribes the three and calls `queue.close()`.
  - `presets/k8s/src/__tests__/preset.test.ts`: the manifest pin.
  - `presets/memory/src/__tests__/canary.test.ts`: `authStub` also registers `auth:find-user-by-email` (returns `null`).
  - `deploy/charts/ax-next/templates/_helpers.tpl`: add "its per-conversation turn queue and active-turn registry".
- Test: `src/__tests__/turn-queue.test.ts`, `src/__tests__/turn-registry.test.ts`, `src/__tests__/router.test.ts` (fake bus services: `auth:find-user-by-email`, `agents:list-for-user`, `conversations:find-or-create`, and an `agent:invoke` that fires `chat:stream-chunk`/`chat:turn-end`/`chat:turn-error` on the bus for its `ctx.reqId`; fake `SlackApi`)

**Interfaces:**
- Consumes: Tasks 3, 4 (`EventDispatcher`, `SlackEnvelope`), 8 (`origin: 'slack'`), 9, 10.
- Local types:
  - `StreamChunkIn`: a structural mirror of `packages/channel-web/src/server/types.ts:32-70`. Every field is optional and checked with `typeof`.
  - `DmTurnDeps = { bus; api; registry; publicOrigin; logger; clock }`
  - `RouterDeps = DmTurnDeps & { secrets; queue }`
- Produces:
  ```ts
  export function createKeyedQueue(o: { maxPerKey: number }): { enqueue(key: string, job: () => Promise<void>): 'queued' | 'full'; close(): void };
  export interface TurnSink { reqId: string; conversationId: string; chunk(c: StreamChunkIn): void; end(): void; error(): void }
  export function createTurnRegistry(): { register(s: TurnSink): () => void;
    onStreamChunk(payload: unknown): void; onTurnEnd(ctx: AgentContext, payload: unknown): void; onTurnError(payload: unknown): void };
  export function pickPersonalAgent(agents: ReadonlyArray<{ id: string; ownerId: string; ownerType: string; visibility: string; createdAt: Date }>, userId: string): string | null;
  export function runDmTurn(d: DmTurnDeps, r: { install: InstallRow; botToken: string; channel: string; threadTs: string;
    senderSlackId: string; userId: string; agentId: string; conversationId: string; text: string }): Promise<void>;
  export function createEventRouter(d: RouterDeps): EventDispatcher;
  ```
- **`createKeyedQueue`:** jobs with the same key run one after another; different keys run in parallel. `maxPerKey` counts running plus waiting. `close()` drops jobs not yet started.
- **Registry:** one plugin-level subscriber per hook dispatches to the registered sink.
  - **chunk:** `payload.reqId === sink.reqId`.
  - **end:** mirror `channel-web/src/server/sse.ts:510-529`. Find the sink by `ctx.conversationId`. If `payload.reqId` is a non-empty string that isn't `sink.reqId` and isn't in `foldedReqIds` (a real array), ignore it. Otherwise `end()`.
  - **error:** `payload.reqId === sink.reqId`.
  - Check malformed payloads with `typeof`.
- **`pickPersonalAgent`:** keep `ownerType === 'user' && visibility === 'personal' && ownerId === userId`; take the oldest `createdAt`, tie-break on `id`.
- **`runDmTurn`:**
  1. `reqId = makeReqId()`; `ctx = makeAgentContext({ sessionId: makeReqId(), reqId, agentId, userId, conversationId, source: 'user', audience: 'private' })`.
  2. Create the stream with `agentLink = ${publicOrigin}/workspace/agents/${encodeURIComponent(agentId)}`.
  3. Register the sink **before** calling `agent:invoke`. Wire the chunks:
     - `text` → `stream.text`.
     - `tool-use` → remember `toolName` by `toolCallId`, then `stream.status(activityPhrase ?? COPY.statusDefault)`.
     - `step-summary` → `stream.status(text)`.
     - `tool-result` that isn't an error or held, for `artifact_publish`, `show_visual` or their `mcp__ax-sandbox-tools__` spellings → `stream.artifact()`.
     - `thinking` → ignored.
  4. `agent:invoke({ message: { role: 'user', content: text } })`. A `terminated` outcome ends the turn as `busy` when the reason is `conversation:busy`, else as `error`. A throw ends it as `error`. A `complete` outcome waits for the sink.
  5. The first of sink `end` (`complete`), sink `error` (`error`), the invoke outcome, or `TURN_HARD_CAP_MS` decides. Then unregister and `stream.finish(outcome)`.
- **Router:**
  - **Pre-filters:**
    - `isExtSharedChannel` → ignore (`slack-connect`).
    - No `user`, a `botId`, or `user === install.botUserId` → ignore (`bot`).
    - The bot token comes from secrets. If missing → log `slack_bot_token_missing`, stop.
  - **`message` with `channelType === 'im'`:**
    1. A `subtype` other than `file_share` → ignore.
    2. Admission. A refusal → log `slack_sender_refused` with the reason, silence.
    3. `threadTs = event.threadTs ?? event.ts`.
    4. `file_share` → `postMessage(COPY.filesUnsupported)`.
    5. Empty text → ignore.
    6. `auth:find-user-by-email({ email })`. `null` → log `slack_sender_not_mapped` (`{ installId }` only, every time), then `postMessage(COPY.notMapped(publicOrigin))`.
    7. `agents:list-for-user({ userId, teamIds: [] })` → `pickPersonalAgent`. None → log `slack_no_personal_agent`, `postMessage(COPY.noAgent(publicOrigin))`.
    8. `conversations:find-or-create({ userId, agentId, externalKey: \`slack:${installId}:${channel}:${threadTs}\`, fallback: { origin: 'slack' } })`.
    9. `queue.enqueue(conversationId, () => runDmTurn(...))`. `'full'` → `postMessage(COPY.queueFull)`.
  - **`app_mention`:** admission. A refusal → silence. Otherwise `postEphemeral({ channel, user, text: COPY.mentionRefusal, ...(event.threadTs ? { threadTs } : {}) })`.
  - **Anything else** → ignore.
  - **Contexts:** hook calls before the turn use `makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId })`, with the mapped `userId` once known, else `''`.

- [ ] **Step 1: Write failing tests:**
  - `turn-queue.test.ts`: `same key runs in order`, `different keys overlap`, `the fourth for one key is full`, `close drops waiting jobs`.
  - `turn-registry.test.ts`: `another reqId's chunk is ignored`, `turn-end for the same conversation with a different reqId is ignored`, `a folded reqId ends the turn`, `a turn-end with no reqId ends it` (channel-web parity).
  - `router.test.ts`:
    - `owner DM streams a reply`: the fake invoke emits `text` 'Hel', 'lo', then `turn-end`. The ctx carries `source: 'user'`, `audience: 'private'`, the owner's `userId`, their oldest personal agent, and the conversation from find-or-create with externalKey `slack:<id>:D1:<ts>` and origin `'slack'`. Slack received `startStream` and then `stopStream`, with markdown text 'Hello', in thread `<ts>`.
    - `a reply in a thread keys on thread_ts`.
    - `user B's DM reaches only B's agent and B's conversation` (two mapped users, separate fakes).
    - `a guest/stranger/unconfirmed sender → no lookup, no invoke, no Slack post`.
    - `not mapped → slack_sender_not_mapped logged with only installId, notMapped posted, no invoke`.
    - `no personal agent → noAgent, no invoke`.
    - `the second DM in a thread starts only after the first turn-end`.
    - `the fourth queued DM gets queueFull`.
    - `invoke terminated conversation:busy → busy line, no retry`.
    - `turn-error → turnFailed line`.
    - `app_mention from a member → one ephemeral refusal; from a guest → nothing`.
    - `Slack Connect envelope → nothing`.
    - `our own bot's message → nothing`.
    - `file_share → filesUnsupported`.
    - `team agents are never picked`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and wire. Run `pnpm --filter @ax/preset-k8s test` and the memory canary.
- [ ] **Step 4:** Pass.
- [ ] **Step 5:** Commit `feat(channel-slack): personal-agent DMs routed by verified email, serialized per conversation (TASK-1093)`.

### Task 12: Caller allowlist and secret-ref guard [tier: mechanical] (security control)

**Files:**
- Create: `scripts/__tests__/channel-slack-boundaries.test.js`. Copy the structure of `scripts/__tests__/slot-vocabulary-single-owner.test.js`: `git ls-files` under `packages/` and `presets/`, JS/TS only, TypeScript-compiler parse, and a parse error counts as an offender.
- Modify:
  - `packages/ipc-core/src/__tests__/dependencies.test.ts:66-72` (the comment names this file).
  - `docs/plans/2026-11-09-channel-slack-design.md` §6 (name the file; see Task 14).

**Interfaces:**
- **Rule 1:** a `StringLiteral` or `NoSubstitutionTemplateLiteral` whose text is exactly `auth:find-user-by-email` may appear only under `packages/auth-better/` or `packages/channel-slack/`, or in exactly these files:
  - `presets/memory/src/__tests__/canary.test.ts`
  - `presets/k8s/src/__tests__/channel-slack-composition.test.ts`
  - `presets/k8s/src/__tests__/preset.test.ts` (its manifest pin)

  The scan covers tests too. Comments don't count. Adding a file to the list needs a one-line reason beside it in the test.
- **Rule 2:** a string literal, or a template head, whose text starts with `slack:` may appear only under `packages/channel-slack/` or in `presets/k8s/src/__tests__/channel-slack-composition.test.ts`.
- The header says what the guard can't see: names built at runtime, and non-JS files.

- [ ] **Step 1: Write the test, with an in-file case table that runs the scanner over inline sources:**
  - `bus.call('auth:find-user-by-email', …)` in `packages/agents/src/x.ts` → offender.
  - The same in `packages/channel-slack/src/x.ts` → clean.
  - A comment naming the hook → clean.
  - `` `slack:${id}:bot-token` `` in `packages/memory/src/y.ts` → offender.
  - A parse error → offender.
- [ ] **Step 2: Run `pnpm test:scripts`.** Expected: PASS on the tree (the allowlisted files are the only callers). Then prove it isn't vacuous: copy `packages/channel-slack/src/router.ts` aside with `cp`, add `bus.call('auth:find-user-by-email', ctx, {email:''})` to `packages/agents/src/plugin.ts`, run → FAIL naming that file. Restore with `cp`, run → PASS. Never `git checkout`/`stash`.
- [ ] **Step 3:** Update the ipc-core comment.
- [ ] **Step 4:** `pnpm test:scripts` passes.
- [ ] **Step 5:** Commit `test(scripts): only auth-better and channel-slack name auth:find-user-by-email or slack: refs (TASK-1093)`.

### Task 13: Preset composition test with a faked Slack [tier: integration]

**Files:**
- Create: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`. Model it on `connector-directory-composition.test.ts`: a KEEP set filtering `createK8sPlugins(config)`, a stub plugin, Postgres testcontainer, global `fetch` stubbed to throw.

**Interfaces:**
- **KEEP:** `@ax/database-postgres`, `@ax/storage-postgres`, `@ax/credentials`, `@ax/credentials-store-db`, `@ax/agents`, `@ax/conversations`, `@ax/channel-slack`. Add the smallest further set that boot demands.
- **Stub:**
  - `http:register-route` (capture handlers)
  - `auth:require-user` (the test picks the actor)
  - `auth:find-user-by-email` (`alice@canopyworks.com` → `usr_alice`, `bob@…` → `usr_bob`, else `null`)
  - `agent:invoke` (records ctx and input, then fires `chat:stream-chunk` text and `chat:turn-end` for `ctx.reqId`/`ctx.conversationId`)
  - `branding:get`
- **Slack:** a fake `fetchImpl` through `K8sPresetConfig.channelSlack.fetchImpl` that answers `apps.manifest.create`, `oauth.v2.access`, `users.info` (per user id), `chat.*` and `tooling.tokens.rotate`/`apps.manifest.delete`, and records every call.

- [ ] **Step 1: Write the test. One flow, end to end:**
  1. Seed personal agents for `usr_alice` and `usr_bob` through `agents:create`.
  2. An admin `POST /admin/slack/connect`, then `GET` the callback with the minted state. Status reads `connected`.
  3. A signed Alice DM produces a streamed Slack reply in her thread. The recorded invoke ctx is Alice's agent and a conversation whose `get-metadata` origin is `'slack'`.
  4. A signed Bob DM reaches Bob's agent only.
  5. A signed DM from an unmapped confirmed member gets the not-mapped reply and no invoke.
  6. Disconnect → `appDeleted: true`; the row is gone and `credentials:get` for each `slack:<id>:*` ref fails.
- [ ] **Step 2:** Run with `DOCKER_HOST`. Expected: it fails until any wiring gap is fixed. Record each gap found in the decisions shard.
- [ ] **Step 3:** Fix wiring only. A behavior change goes back to its owning task with a failing unit test first.
- [ ] **Step 4:** `pnpm --filter @ax/preset-k8s test` passes.
- [ ] **Step 5:** Commit `test(preset-k8s): channel-slack composition with real agents, conversations and vault (TASK-1093)`.

### Task 14: Correct the design doc's stale lines [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`

- [ ] **Step 1: Edit these lines.**
  - **`:168-169`:** "Admin settings shows who added the token (an AX admin; configuration tokens belong to one person). Replacing it comes with the rename card (TASK-1096)."
  - **`:255-258`:** the stream line. "A stream lasts at most 10 minutes and holds at most 12,000 characters, so a long reply closes the stream and starts a new one in the same thread (Slack's own advice). If a stream call fails, the rest of the reply is posted with `chat.postMessage`."
  - **`:259`:** "Send the reply as Markdown (`markdown_text` chunks); Slack renders it. No mrkdwn conversion."
  - **`:260`:** add "(one `task_update` card that changes in place)".
  - **`:261`:** "…a link to the agent's page in the web app (no per-artifact or per-conversation page exists yet)".
  - **After `:263`:** "Until TASK-1095, a Slack conversation (origin `'slack'`) is unattended for decisions, so held calls wait in Today."
  - **`:371`:** "Decision: streaming API; past 10 minutes or 12,000 characters, a new stream in the same thread (§5)."
  - **§6 caller allowlist:** name `scripts/__tests__/channel-slack-boundaries.test.js`.
  - **`:408`:** "presets and the canary acceptance test. No Helm secrets: they live in the credentials store. Host egress on 443 is already open."
- [ ] **Step 2:** `grep -n "chat.update\|mrkdwn\|Helm secrets" docs/plans/2026-11-09-channel-slack-design.md`. Expected: only the rewritten wording remains (`chat.update` appears nowhere as a fallback).
- [ ] **Step 3:** Commit `docs(plans): channel-slack design matches Slack's streaming limits and the shipped plugin (TASK-1093)`.
