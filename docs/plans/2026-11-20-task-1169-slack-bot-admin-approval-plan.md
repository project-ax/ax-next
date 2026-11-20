# TASK-1169: Ask an AX admin to approve a team agent's Slack bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team admin who can't install Slack apps asks for their agent's own bot without a token; an AX admin approves it in Admin › Slack with their own configuration token (the stored one, or a paste only when none is stored or it's dead), through the same create path the self-approved bot uses, and becomes the bot's approver while the requester stays the person outsiders run as.

**Architecture:** A new `channel_slack_v1_bot_requests` table (one open request per agent, no secret, no picture). `bots.ts`'s self-path request is split into `create()` (the one shared create path, run under the caller's app lock) and `request()` (lock + rights + `create`). A new `bot-requests.ts` domain owns ask / cancel / list / approve / decline, and calls `bots.create` with approver = the AX admin, requester = the request's requester. `finish()` learns a second rule for a bot whose approver isn't its requester, and the bot callback sends that approver back to Admin › Slack. New routes live in `agent-routes.ts` (two) and a new `bot-request-routes.ts` (three admin routes). No new hook.

**Tech Stack:** TypeScript, Kysely + Postgres (testcontainers in tests), vitest, React + shadcn (channel-web).

**Spec:** the TASK-1169 card (brief: `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/b9feba9b-916e-4979-b5be-adabf94d3c15/scratchpad/cards/TASK-1169-brief.md`, including its "Decisions update (2026-11-20)" and predecessor learnings) and `docs/plans/2026-11-09-channel-slack-design.md` §4 steps 2–3, §8 Q6. Planner decisions: `.claude/memory/decisions/2026-11-20-TASK-1169.md`. The code was read at `3cf5673d0` (main); file:line refs below are from that read.

---

## What the brief got wrong (evidence; the plan follows the code)

1. **"The bot OAuth callback already checks the state's user, so the admin finishes it."** Only half true. `bots.finish` then re-checks `checkRights(actor, 'manage')` (`bots.ts:512-513`): `agents:resolve` lets only the agent's team members see it (`packages/agents/src/acl.ts:55-110`), and `agents:can-set-shared-credential` is asked with `isAdmin: false` (`channels.ts:188-206`). An AX admin who isn't that team's admin is refused `not-found`/`forbidden`, so an admin-approved bot would never go live. The callback also lands the browser on the agent's settings (`bot-callback.ts:124-128`, `channel-web/src/lib/slack-bot-return.ts`), a page such an admin can't open. **Task 2 and Task 7 fix both.**
2. **`icon_png BYTEA NULL` / "picture from the request's PNG" / a picture column in the admin list.** The requester's browser draws the deployment's logo (`channel-web/src/lib/slack-avatar.ts:28-34`, called with no per-agent input at `AgentSlackBot.tsx:200`); the requester chooses nothing. Storing it would keep up to 1 MiB (`SLACK_ICON_MAX_BYTES`) of requester-supplied bytes per request that only icon.ts's header check has seen, and listing it means rendering them in an admin's browser. The approving admin's browser draws the same picture at Approve, as Connect and the self path draw theirs. **No column, no picture in the list.** What made it look true: design §4 step 1 "picks the name and avatar" (stale, fixed in Task 8).
3. **"Approve opens a dialog asking for the admin's OWN refresh token."** Superseded by the card's own 2026-11-20 update (TASK-1175): an approver with a stored token pastes nothing. The list answer carries `configTokenStored` for the viewing admin (this is the "approver flag" the TASK-1167 learnings route here), and the dialog shows the field only when it's false or after a token refusal.
4. **"Admin (`admin-routes.ts`, …)".** The three admin routes go in a new `bot-request-routes.ts`. `admin-routes.ts` and its pinned eight-route list (`admin-routes.test.ts:435-457`) stay untouched, because TASK-1172 is changing that file in parallel.
5. **Confirmed, not wrong:** `personHasApps` never counts a request (it reads only the installs and leftover-apps tables, `store.ts:336-343`, and a request names no approver); Task 1 pins it. No new hook is needed: `agents:resolve`, `agents:can-set-shared-credential` and `auth:get-user` are already in `calls`, and `teams:list-for-user` is already optional (`plugin.ts:234-261`).
6. **A trap in a correct sentence:** "an approve that fails leaves the request open" holds only if deleting the request is the LAST step that can fail (after `mintInstallUrl`). Task 2 pins the order with a test and a mutant.

## Design decisions (rows in the decisions shard)

- **D1. One create path.** `bots.ts` gains `create(i: BotCreate)`, the body of today's `request()` after its rights check, run under the CALLER's app lock. The self path calls it with approver = requester = the actor. Approve calls it with approver = the AX admin, requester = the request's requester, and `requestId`. `create` deletes that request as its last step.
- **D2. One rule for "one per agent".** An agent has at most one of: an open request, or a bot (pending or live). `create` refuses `bot-requested` when another request is open, and `ask` refuses `bot-exists` / `bot-requested`. A unique index on `agent_id` is the last word for requests, as it is for bots.
- **D3. Names stay unique across everything.** `namesInUse` also reads open requests, so a shared Connect or Rename, a self request, an ask and an approve all see request names. Approve leaves out its own request (`except: requestId`; install and request ids are both 22 random base64url characters, so they never collide).
- **D4. The app lock.** `ask`, `cancel` (the request), `approve` and `decline` each take the one app lock once. `create` and `finish` never take it. `list` and `status` take none and never rotate. So a cancel or decline waits for an approve in flight, and two approves serialize: the second finds the request gone (404).
- **D5. Admin routes key on the request id**, not the agent id, so an approve can only take the request the admin saw. (The team could cancel and re-ask with another name in between.)
- **D6. finish() for an admin-approved bot** (approver ≠ requester): the approver must still be an AX admin (`auth:get-user` → `isAdmin === true`), and the requester must still be a team admin of the agent's team (`teamAdminAccess === 'yes'`). The self path keeps `checkRights(actor, 'manage')` unchanged.
- **D7. The callback's landing.** A bot whose approver isn't its requester lands its approver on `/?slack-bot=<outcome>&from=admin`, with no `agentId`. channel-web opens Admin › Slack for an admin and ignores the word for anyone else.
- **D8. The admin list reads names as the requester sees them.** That's `agents:resolve` as the requester (agent name and team id), `teams:list-for-user` for the team name when that hook is loaded, and `personName` for the requester (email allowed: admins only). The team admin chose to send the request to AX admins, and the design's DM copy names the same things (§4 step 2). A requester who left the team leaves fallbacks ("A team agent", no team), and Approve then refuses.
- **D9. No picture stored or listed** (brief item 2). **No declined marker** (card).
- **D10. Requests need the shared bot live and an https origin**, as the self path does, so nothing is asked that can't be approved. A reset (`removeAll`) deletes every request with the installs (it TRUNCATEs every agent without announcing it, TASK-1167 row 9).
- **D11. YAGNI cuts:** Continue in Slack for an admin approver who isn't a team admin (follow-up with TASK-1172's bot list); Slack DMs (their own card); a `viewerIsApprover` field on the agent-side pending shape (TASK-1167's round-3 nit, not made reachable by this card; follow-up); per-request rights on the list (Approve re-checks in the lock).

## Global Constraints

- No new hook, IPC action or manifest change. `manifest.calls` / `optionalCalls` / `subscribes` stay exactly as they are (`plugin.test.ts:567-633`, `presets/k8s/src/__tests__/preset.test.ts:1287-1367` must not change). `teams:list-for-user` is called only behind `bus.hasService('teams:list-for-user')`.
- Every Slack-app create and every configuration-token use runs under the ONE app lock (`plugin.ts:366`). It isn't re-entrant: `create` and `finish` never call `lock.run`, and nothing inside `lock.run` calls `request`, `cancel`, `installUrl`, `removeForAgent`, `ask`, `approve` or `decline`.
- Log lines are code-only: an `installId`, a `requestId` (our own random id), a `stage`, a `reason` or a `code` from `logCode(err)`. Never a token, a person's or an agent's id, a name, an email, or a Slack id other than the install's.
- No response carries a token or a person's id. The admin list carries display names only.
- A pasted refresh token is never stored (rotate, keep the successor), and in the browser it's never React state: an uncontrolled `TokenField`, read once on submit and cleared as the request goes out.
- UI: channel-web's shadcn primitives and semantic tokens only (invariant 6); invoke the `shadcn` skill before the UI tasks. Copy is the fixed sentences in this plan, in CLAUDE.md's voice. Nothing from a response is shown except names and dates.
- Footprint (TASK-1168 and TASK-1172 are building in parallel): don't edit `admin-routes.ts`, `admin-routes.test.ts`, `channels.ts`, `router.ts`, `slack-admin.ts` or `slack-token-copy.ts` (importing from them is fine). Add the new code in new files where this plan says so, and keep edits to shared files to the hunks named here.
- Fake tokens in tests keep Slack's prefix with short digit groups (`xoxe-1-…`), never a real token's exact shape (`.claude/memory/mistakes/2026-11-13-TASK-1093.md`).
- Under zsh, keep vitest file lists in an array: `T=(a.test.ts b.test.ts); pnpm --filter @ax/channel-slack exec vitest run "${T[@]}"`.
- Docker-backed tests (`store.test.ts`, `agents-deleted.test.ts`, the presets) need `DOCKER_HOST` set to your daemon's socket and `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000` (never above 600000).
- channel-web's tsc checks its test files: run `pnpm --filter @ax/channel-web build` after its tests pass.

## Review Focus

These are the failure modes most likely to bite a person, each pinned by a test in the task that owns the code:

1. **Two AX admins (or a double-click) approve the same request at once.** Exactly one Slack app is made; the second approve answers 404 and the dialog refreshes. Task 3: `approve › two at once make one app`.
2. **The team cancels while an approve is talking to Slack.** The cancel waits for the lock, then answers 409 `not-requested`, and the agent shows the pending bot. Task 3: `cancel › waits for an approve in flight`.
3. **An AX admin who isn't on the agent's team clicks Allow.** The bot goes live (brief item 1). Task 2: `finish › goes live for an AX admin who is not on the agent's team`.
4. **The admin's stored token has died.** The answer is 502 `slack-config-token`, the dialog reveals the token field, the request stays listed, and nothing is made. Task 3: `approve › a dead stored token makes nothing and keeps the request`; Task 6: `reveals the token field after slack-config-token`.
5. **Something fails after Slack made the app, the request's delete included.** The app is taken back and the request stays open. Task 2: `create › leaves the request open when its last step fails`.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/channel-slack/src/migrations.ts` | the new table + index; header prose | 1 |
| `packages/channel-slack/src/store.ts` | `BotRequest`, six store methods, `removeAll` takes requests | 1 |
| `packages/channel-slack/src/limits.ts` | `BOT_REQUESTS_MAX` | 1 |
| `packages/channel-slack/src/__tests__/memory-install-store.ts` | in-memory parity | 1 |
| `packages/channel-slack/src/slack-apps.ts` | `namesInUse` reads requests | 2 |
| `packages/channel-slack/src/bots.ts` | `create`, self `request`, `finish` admin rule, `status` requested, `removeForAgent` request | 2 |
| `packages/channel-slack/src/bot-callback.ts` | `from=admin` landing | 2 |
| `packages/channel-slack/src/bot-requests.ts` (new) | ask / cancel / list / approve / decline | 3 |
| `packages/channel-slack/src/agent-routes.ts` | two agent routes | 4 |
| `packages/channel-slack/src/bot-request-routes.ts` (new) | three admin routes | 4 |
| `packages/channel-slack/src/plugin.ts` | wiring, header | 4 |
| `packages/channel-web/src/lib/agent-slack.ts` | `requested` state, two calls, copy | 5 |
| `packages/channel-web/src/components/workspace/AgentSlackBot.tsx` | the two-way choice, the waiting view | 5 |
| `packages/channel-web/src/components/workspace/AgentSlack.tsx` | no-workspace view lets a manager cancel a request | 5 |
| `packages/channel-web/src/lib/slack-bot-requests.ts` (new) | admin wire client + copy | 6 |
| `packages/channel-web/src/components/admin/SlackBotRequests.tsx` (new) | list, Approve dialog, Decline | 6 |
| `packages/channel-web/src/components/admin/SlackTab.tsx` | one mount | 6 |
| `packages/channel-web/src/lib/slack-bot-return.ts`, `App.tsx` | admin landing after Allow | 7 |
| `docs/plans/2026-11-09-channel-slack-design.md`, `.changeset/` | stale lines, as-built, changeset | 8 |

---

### Task 1: Storage — the bot-requests table [tier: sensitive]

Sensitive: a migration (persistent state), and the one-request-per-agent rule lives in a unique index. **security-checklist: required** (storage of untrusted input, the bot name; covered by the PR's walk, Final gate).

**Files:**
- Modify: `packages/channel-slack/src/migrations.ts` (header `:8-26` and `:57-77`; types `:115-173`; new SQL after `:330-334`)
- Modify: `packages/channel-slack/src/store.ts` (`InstallRow.connectedByUserId` doc `:31-39`; `InstallStoreError` `:290-301`; interface `:100-227`; `removeAll` `:572-596`)
- Modify: `packages/channel-slack/src/limits.ts`
- Modify: `packages/channel-slack/src/__tests__/memory-install-store.ts`
- Test: `packages/channel-slack/src/__tests__/store.test.ts` (its `beforeEach` TRUNCATE at `:30-32` gains the new table)

**Interfaces:**
- Produces (store.ts):
  ```ts
  /** A team admin's open ask for their agent's own bot, waiting for an AX admin (TASK-1169). No secret, no Slack app, no picture. */
  export interface BotRequest {
    requestId: string;          // 22 base64url chars, minted by bot-requests.ts
    agentId: string;
    requestedByUserId: string;  // becomes the bot's requested_by_user_id when approved
    botName: string;            // already passed checkBotName
    createdAt: Date;
  }
  // InstallStore gains:
  insertBotRequest(r: Pick<BotRequest, 'requestId' | 'agentId' | 'requestedByUserId' | 'botName'>): Promise<void>; // agent already has one → InstallStoreError('request-exists')
  getBotRequest(requestId: string): Promise<BotRequest | null>;
  botRequestForAgent(agentId: string): Promise<BotRequest | null>;
  listBotRequests(): Promise<BotRequest[]>;                    // every open request, oldest first (created_at, then request_id), uncapped
  removeBotRequest(requestId: string): Promise<boolean>;       // true when a row went
  removeBotRequestForAgent(agentId: string): Promise<string | null>; // the removed request's id, or null
  // InstallStoreError.code adds 'request-exists'; removeAll() also deletes every request (return type unchanged)
  ```
- Produces (limits.ts): `export const BOT_REQUESTS_MAX = 20;` (how many open requests Admin › Slack lists).
- Produces (memory-install-store.ts): `memoryStore()` also returns `requests: Map<string, BotRequest>`.

- [ ] **Step 1: Write the failing store tests** in a new `describe('bot requests')` in `store.test.ts`:
  - `stores a request and reads it by id, by agent and in the list, oldest first`: insert `r1` (agent `a1`), then `r2` (agent `a2`). `listBotRequests()` returns them in that order; `getBotRequest('r1…')` equals `{ requestId, agentId: 'a1', requestedByUserId: 'usr_ada', botName: 'Ada Bot', createdAt: expect.any(Date) }`; `botRequestForAgent('a2')` returns `r2`; an unknown id or agent returns `null`.
  - `allows one open request per agent`: a second insert for `a1` with another id rejects with an `InstallStoreError` whose `code === 'request-exists'`; re-using `r1`'s id for another agent rejects with pg code `23505` and is NOT `request-exists`.
  - `removes by id and by agent, saying what went`: `removeBotRequest(r1)` → `true`, then `false`; `removeBotRequestForAgent('a2')` → `r2`'s id, then `null`.
  - `removeAll takes every request with the installs`: seed a shared install and two requests; after `removeAll()`, `listBotRequests()` is `[]`.
  - `a request never names anyone's token`: with only an open request by `usr_ada`, `personHasApps('usr_ada')` is `false`.
  - `the agent index is unique, by name, and the migration runs twice`: `pg_indexes` has `channel_slack_v1_bot_requests_agent` with `UNIQUE` on `(agent_id)`; a second `runMigrations` succeeds and keeps the rows.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/store.test.ts` (Docker env per Global Constraints): missing methods/table.
- [ ] **Step 3: Implement.** Append to `runMigrations`, after the `bot_agent` index:
  ```sql
  CREATE TABLE IF NOT EXISTS channel_slack_v1_bot_requests (
    request_id            TEXT PRIMARY KEY,
    agent_id              TEXT NOT NULL,
    requested_by_user_id  TEXT NOT NULL,
    bot_name              TEXT NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  -- separate statement:
  CREATE UNIQUE INDEX IF NOT EXISTS channel_slack_v1_bot_requests_agent ON channel_slack_v1_bot_requests (agent_id)
  ```
  Add `ChannelSlackBotRequestsTable` (`created_at: ColumnType<Date, Date | undefined, never>`) to `ChannelSlackDatabase`. In store.ts, `const BOT_REQUESTS = 'channel_slack_v1_bot_requests'` and `const BOT_REQUEST_AGENT_INDEX = 'channel_slack_v1_bot_requests_agent'`. Map a `23505` on that constraint to `InstallStoreError('request-exists')`, mirroring `isBotAgentConflict` (`:283-288`). The deletes use `db.deleteFrom(BOT_REQUESTS)`; `removeBotRequestForAgent` uses `RETURNING request_id`. `removeAll` gains a CTE `requests AS (DELETE FROM channel_slack_v1_bot_requests)` in its one statement. The literal also satisfies `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js`, which needs a delete of every `agent_id` table outside migrations.
  - Header prose for the table in migrations.ts: what a request is; one per agent (unique index); approving turns it into a pending bot row and deletes it; Decline, the team's Cancel, the agent's deletion (agents-deleted.ts) and a reset delete it; it names a requester and never an approver (no configuration token is involved until an AX admin approves, so `personHasApps` never reads it); no picture (the approving admin's browser draws the deployment's logo at Approve).
  - Stale lines to fix while here: `migrations.ts:20-23` and `store.ts:31-34` say "(in TASK-1167 always its requester)". They become "its requester on the self path, or the AX admin who approved its request (TASK-1169)". The `removeAll` doc (`:201-210`) adds "and every open bot request".
- [ ] **Step 4: Memory fake parity.** A third Map `requests` keyed by request id. Every new method goes through `enter()`, so `failures.set('removeBotRequest', err)` works. An agent that already has a request throws `InstallStoreError('request-exists')`; a duplicate id throws a plain `Error` (as `insertPendingBot` does). `listBotRequests` sorts by `createdAt`, then id. `removeAll` clears `requests`. `createdAt` comes from the fake's `clock`.
- [ ] **Step 5: Run, expect PASS** — the store tests, then `pnpm test:scripts` (the agent-keyed guard).
- [ ] **Step 6: Commit** — `[TASK-1169] channel-slack: a table for bot requests waiting for an AX admin`.

### Task 2: One create path, and bots an AX admin approved [tier: sensitive]

Sensitive: the approver's configuration token, the app lock, and who may finish a bot at the OAuth callback. **security-checklist: required** (credential path and OAuth-callback authority).

**Files:**
- Modify: `packages/channel-slack/src/slack-apps.ts:234-252` (`namesInUse`)
- Modify: `packages/channel-slack/src/bots.ts` (header `:29-82`, `AgentSlackBot` `:89-99`, `BotFinishRefusal` `:113-123`, `Bots` `:147-229`, `request` `:361-437`, `finish` `:499-526`, `status` `:562-595`, `removeForAgent` `:303-316`)
- Modify: `packages/channel-slack/src/bot-callback.ts` (header `:11-52`, `back` `:124-128`, the landing `:174-198`)
- Test: `bots.test.ts`, `bot-callback.test.ts`, `agents-deleted.test.ts` (its `clearTables` gains the new table)

**Interfaces:**
- Consumes: Task 1's store methods.
- Produces:
  ```ts
  // slack-apps.ts — `except` leaves out one install OR one open request, by its id
  export async function namesInUse(
    store: Pick<InstallStore, 'current' | 'listBots' | 'listBotRequests'>,
    o?: { except?: string },
  ): Promise<string[]>;
  // bots.ts
  export interface BotCreate {
    ctx: AgentContext;
    agentId: string;
    /** connected_by_user_id: whose configuration token makes and manages the app. */
    approverUserId: string;
    /** requested_by_user_id: whom its channels' outsiders run as. */
    requesterUserId: string;
    botName: string;              // passed checkBotName
    refreshToken: string | null;  // a pasted one that passed the route's shape check, or null for the stored one
    icon: ParsedIcon | null;
    /** The open request an AX admin is approving; null on the self path. */
    requestId: string | null;
  }
  // Bots gains: create(i: BotCreate): Promise<BotReply>   (runs under the CALLER's lock; never takes it)
  // AgentSlackBot gains: | { state: 'requested'; botName: string; requestedAt: string }   (ISO; managers only)
  // BotFinishRefusal gains: | 'not-admin' | 'requester-not-admin'
  // bot-callback: a bot whose approver isn't its requester lands on `<origin>/?slack-bot=<outcome>&from=admin`
  ```

**`create()` contract.** The caller holds the lock and has checked the rights for its own path. Refusals before any Slack call, in this order:
1. 409 `no-workspace` when there's no active shared install.
2. 409 `public-origin-not-https`.
3. 409 `bot-exists`.
4. 409 `bot-requested`: `botRequestForAgent` returns a request whose id isn't `i.requestId`.
5. 409 `bot-name-taken`: `isBotNameTaken(botName, await namesInUse(installs, { except: i.requestId ?? undefined }))`.
6. 500 when `configTokenRef(approverUserId)` throws, logged code-only at stage `request`.

Then today's body, unchanged except:
- the owner is `{ installId, connectedByUserId: approverUserId }`;
- `insertPendingBot({ …, connectedByUserId: approverUserId, requestedByUserId: requesterUserId })`;
- `mintInstallUrl(installId, clientId, approverUserId, botLink(installId))`;
- last inside the try: `if (i.requestId !== null) await d.installs.removeBotRequest(i.requestId)`. Its failure takes the catch path like any other: `undoConnect`, then 500.

The success line is `slack_bot_requested { installId }` when `requestId` is null, else `slack_bot_approved { installId, requestId }`. The answer is 200 `{ installUrl, iconSet }`. `request()` becomes `lock.run(rights re-check → create({ …, approverUserId: actor, requesterUserId: actor, requestId: null }))`.

**`finish()` rule after `not-approver`.** First, `bot.requestedByUserId === null` reads as `not-pending`, alongside the existing `agentId === null` check.
- **Self path** (`requestedByUserId === connectedByUserId`): unchanged, `checkRights(actor, 'manage')`.
- **Admin path:**
  1. `auth:get-user({ userId: actor })` must answer an object with `isAdmin === true`; anything else, a null answer included, refuses `not-admin`.
  2. `teamAdminAccess(bus, ctx, agentId, requestedByUserId)` must answer `'yes'`. `'agent-gone'` → `not-found`, `'not-team'` → `personal-agent`, `'no'` → `requester-not-admin`.

A fault in either step throws, as today's rights check does. Both run before `current()` and the code exchange.

**`status()`.** With no bot row and `manages`, an open request answers `{ state: 'requested', botName, requestedAt: createdAt.toISOString() }`. Otherwise the answer is today's `none`. A bot row always wins over a request.

**`removeForAgent()`.** Inside its lock and before the bot: `removeBotRequestForAgent(agentId)`. When an id comes back, log `slack_agent_bot_request_removed { requestId }` at info. Its fault is logged `steps.failed('agent-deleted-request', err, undefined, 'error')` and the bot's removal still runs (its own try, as today).

**bot-callback.** Right after `installs.get(spent.installId)`:

```ts
viaAdmin = install !== null && install.requestedByUserId !== null && install.requestedByUserId !== install.connectedByUserId
```

Every later `back(outcome, agentId)` becomes `back(outcome, viaAdmin ? null : agentId, viaAdmin)`. `back` sets `from=admin` (via `URLSearchParams.set`) when `viaAdmin` is true.

- [ ] **Step 1: Write failing tests.**
  - `bots.test.ts`. The world gains `GRACE` (AX admin, no role in the agent's team; `auth:get-user` answers `{ isAdmin: true, displayName: 'Grace' }`), a `create` wrapper that runs `bots.create` inside `lock.run`, and `finish` access as bot-callback.test.ts uses it.
    - `create › makes the bot with the approving admin's token, the admin as approver and the requester as requester`: seed request `R` (agent `a1`, by `ADA`, a team admin) and Grace's stored token. `create({ approverUserId: GRACE, requesterUserId: ADA, requestId: R, refreshToken: null })` → 200 `{ installUrl, iconSet }`. The row has `connectedByUserId === GRACE`, `requestedByUserId === ADA` and `status === 'pending'`. The rotate read `slack:person:<GRACE>:config-refresh-token`, the OAuth state's user is GRACE, `R` is gone, and the lines include `slack_bot_approved { installId, requestId }`.
    - `create › leaves the request open when its last step fails` (Review Focus 5): `memory.failures.set('removeBotRequest', err)` → 500. Slack's `deleteApp` ran with the minted access token, no bot row is left, `R` is still there, and Grace's token stays because her shared install names her.
    - `create › leaves out the request's own name, and no other`: approving `R` with its own name passes. With a second open request on `a2` whose name has the same key, approving `R` under that name answers 409 `bot-name-taken`, and nothing is rotated.
    - `request › refuses while the agent has an open request`: 409 `bot-requested`; no rotate, no Slack call.
    - `request › refuses a name an open request holds`: 409 `bot-name-taken`.
    - `status › a manager sees an open request`: `{ state: 'requested', botName, requestedAt }`. `status › anyone else sees none`: `{ state: 'none', configTokenStored: false }`. `status › a bot row wins over a request`.
    - `finish › goes live for an AX admin who is not on the agent's team` (Review Focus 3): a pending bot with approver GRACE and requester ADA; GRACE's finish answers `{ outcome: 'connected' }`. This fails on today's code with `not-found`.
    - `finish › refuses an approver who is no longer an AX admin`: `not-admin`, and no `oauth.v2.access` call. `finish › refuses when the requester is no longer a team admin`: `requester-not-admin`. `finish › refuses when the agent is gone`: `not-found`. The self-path finish tests stay unchanged.
    - `removeForAgent › removes the agent's open request` (with the log line). `removeForAgent › a request fault doesn't stop the bot's removal`.
    - `namesInUse › reads the shared bot, every bot and handle, and every open request; except leaves out one install or one request`.
  - `bot-callback.test.ts`: `sends an AX admin who approved back to Admin › Slack`. With a pending bot (approver GRACE, requester ADA) and a state minted for GRACE, the location is exactly `https://<origin>/?slack-bot=connected&from=admin`; a Slack `access_denied` gives `…cancelled&from=admin`. The existing self-path landing tests stay unchanged.
  - `agents-deleted.test.ts` (real Postgres): `deleting the agent deletes its open request`.
- [ ] **Step 2: Run, expect FAIL** — `T=(src/__tests__/bots.test.ts src/__tests__/bot-callback.test.ts src/__tests__/agents-deleted.test.ts); pnpm --filter @ax/channel-slack exec vitest run "${T[@]}"`.
- [ ] **Step 3: Implement** per the contracts above. Update bots.ts's header: the row's two people can now differ ("in TASK-1167 the two are the same person" at `:37-38`), and the method/lock list now includes `create`, which runs under its caller's lock. Update bot-callback.ts's header: the state may be minted by an approve in Admin › Slack, and the `from=admin` landing.
- [ ] **Step 4: Run, expect PASS**, then `pnpm --filter @ax/channel-slack test` (the whole package; admin-routes tests exercise `namesInUse` through Connect and Rename).
- [ ] **Step 5: Mutation check** (commit first; restore each with `git checkout HEAD -- <file>`; `git status --short` empty between mutants). Each mutant must fail a named test:
  1. Move `removeBotRequest` before `insertPendingBot` → `leaves the request open…`.
  2. Drop the `isAdmin` check → `refuses an approver who is no longer an AX admin`.
  3. Use `checkRights(actor, 'manage')` for both paths → `goes live for an AX admin…`.
  4. Drop `listBotRequests` from `namesInUse` → `refuses a name an open request holds`.
  5. Pass `except` as undefined on approve → `leaves out the request's own name`.

  Record the kills in the decisions shard.
- [ ] **Step 6: Commit** — `[TASK-1169] channel-slack: one create path for both approvals; an AX admin's Allow finishes the bot`.

### Task 3: The ask-an-admin domain (`bot-requests.ts`) [tier: sensitive]

Sensitive: the approving admin's credential, the lock, untrusted input (bot name), and a read of a team's agent on behalf of a non-member admin. **security-checklist: required** (credential use, untrusted input, cross-team disclosure).

**Files:**
- Create: `packages/channel-slack/src/bot-requests.ts`
- Test: `packages/channel-slack/src/__tests__/bot-requests.test.ts`

**Interfaces:**
- Consumes:
  - Task 1's store methods and `BOT_REQUESTS_MAX`;
  - Task 2's `Bots['create']`, `BotReply` and `namesInUse`;
  - `checkRights`, `teamAdminAccess` (channels.ts); `personName`; `cleanLabel` (label.ts); `isBotNameTaken`; `isHttps`; `INSTALL_ID_BYTES`;
  - `SecretStore.getConfigToken`; `logCode`; `PluginError` (`@ax/core`).
- Produces:
  ```ts
  export interface BotRequestsDeps {
    bus: HookBus; installs: InstallStore; secrets: SecretStore; bots: Pick<Bots, 'create'>;
    lock: Mutex; publicOrigin: string; logger: Logger; randomBytes: (n: number) => Buffer;
  }
  /** One open request as Admin › Slack lists it: display names only. */
  export interface AdminBotRequest {
    requestId: string; botName: string;
    agentName: string;        // as its requester sees it, else 'A team agent'
    teamName: string | null;  // null without the teams plugin, or when the requester can't see the agent
    requestedBy: string;      // display name, else email, else 'A team admin'
    requestedAt: string;      // ISO
  }
  export interface AdminBotRequestList { requests: AdminBotRequest[]; configTokenStored: boolean }
  export interface BotRequests {
    ask(i: { ctx: AgentContext; actorUserId: string; agentId: string; botName: string }): Promise<BotReply>;
    cancel(i: { agentId: string }): Promise<BotReply>;
    list(i: { ctx: AgentContext; viewerUserId: string }): Promise<AdminBotRequestList>;
    approve(i: { ctx: AgentContext; actorUserId: string; requestId: string; refreshToken: string | null; icon: ParsedIcon | null }): Promise<BotReply>;
    decline(i: { requestId: string }): Promise<BotReply>;
  }
  export function createBotRequests(d: BotRequestsDeps): BotRequests;
  ```

**Answers:**
- **`ask`** (takes the lock): rights again (`checkRights(…, 'manage')`, answered as bots.ts's `rightsRefused`: 404 `not-found` / 403 `forbidden` / 409 `personal-agent`) → 409 `no-workspace` → 409 `public-origin-not-https` → 409 `bot-exists` → 409 `bot-requested` → 409 `bot-name-taken` (`namesInUse(installs)`) → insert with `requestId = randomBytes(INSTALL_ID_BYTES).toString('base64url')` (`request-exists` → 409 `bot-requested`) → `slack_bot_request_opened { requestId }` → 200 `{}`.
- **`cancel`** (takes the lock): `removeBotRequestForAgent`. A null answer is 409 `not-requested`. Otherwise log `slack_bot_request_cancelled { requestId }` and answer 200 `{}`. No in-lock rights re-check (TASK-1167 row 39's rule for the pending bot's Cancel).
- **`list`** (no lock, no rotate, no Slack call): take `listBotRequests().slice(0, BOT_REQUESTS_MAX)`. For each row:
  - **The agent, as its requester sees it:** `agents:resolve({ agentId, userId: requester })`. Only a `team` answer about this id counts: `agentName = cleanLabel(displayName) || 'A team agent'`, and `teamId = ownerId` when it's a string. A `forbidden`/`not-found` PluginError gives the fallbacks. Any other fault also gives the fallbacks, logged `slack_bot_request_failed { requestId, stage: 'agent', code }` at warn.
  - **The team:** only when `bus.hasService('teams:list-for-user')` and a `teamId` exists. Call it once per distinct requester per list; take the team whose `id === teamId`, `cleanLabel(displayName)`, else null. A fault reads null, logged at stage `team`.
  - **The requester:** `requestedBy = personName(bus, ctx, requester, { allowEmail: true, fallback: 'A team admin', onFault })`, with faults logged at stage `requested-by`.
  - **`configTokenStored`:** false when there are no rows. Otherwise, whether `secrets.getConfigToken({ installId: '', connectedByUserId: viewer })` is non-null; a fault reads false, logged at stage `status-config-token`.
- **`approve`** (takes the lock): `getBotRequest`; null is 404 `not-found`. Then `teamAdminAccess(bus, ctx, agentId, requester)`: `'agent-gone'` → 409 `agent-gone`, `'no'`/`'not-team'` → 409 `requester-not-admin`; a fault throws (the route's 500). Then `return bots.create({ ctx, agentId, approverUserId: actor, requesterUserId: request.requestedByUserId, botName: request.botName, refreshToken, icon, requestId })`.
- **`decline`** (takes the lock): `removeBotRequest`; false is 404 `not-found`. Otherwise log `slack_bot_request_declined { requestId }` and answer 200 `{}`.

- [ ] **Step 1: Write the failing tests** in `bot-requests.test.ts`. The world is built like `bots.test.ts`'s `world()` (`:115-206`) from the shared fakes: `memoryStore`, `fakeSlack`, `busVault`, `fakeAgents` (`ADA` team admin and `BOB` member of `t1`; `GRACE` no role), real `createBots` and `createMutex`. Add inline `auth:get-user` users (GRACE `isAdmin: true`) and a `teams:list-for-user` fake answering `{ teams: [{ id: 't1', displayName: 'Support' }] }`. If `fakeAgents`' resolve answer lacks `ownerId`, add it there (additive).
  - `ask › opens a request` (row, 200 `{}`, the line). `ask › refusals` is a table: personal agent 409, member 403, unknown agent 404, `no-workspace`, http origin, a bot exists, a second ask (`bot-requested`), a name a bot, the shared bot or another request holds (`bot-name-taken`), and the index race (`failures.set('insertBotRequest', new InstallStoreError('request-exists'))` → 409 `bot-requested`). No refusal writes a row or calls Slack.
  - `cancel › removes the open request`; `cancel › with none open is not-requested`; `cancel › waits for an approve in flight` (Review Focus 2): hold `slack.on.createApp` on a deferred, start `approve`, then `cancel`. Release: approve answers 200, cancel answers 409 `not-requested`, and `botForAgent` is a pending bot.
  - `list › names the agent, team and requester as the requester sees them`; `list › a requester who left the team gets the fallbacks`; `list › no teams plugin leaves teamName null`; `list › oldest first, at most BOT_REQUESTS_MAX`; `list › configTokenStored is the viewer's own` (true / false / a vault fault reads false); `list › never takes the lock or calls Slack` (it resolves while `holdLock` holds the lock; no Slack calls).
  - `approve › with the admin's stored token, no paste` (the row as in Task 2's create test; `R` gone). `approve › a pasted token wins` (its successor stored under GRACE). `approve › none stored is config-token-needed, request kept`. `approve › a dead stored token makes nothing and keeps the request` (Review Focus 4): `rotate` fails `invalid_refresh_token` → 502 `slack-config-token`, no `createApp`, `R` listed.
  - `approve › a requester no longer a team admin` → 409 `requester-not-admin`, no rotate. `approve › an agent that is gone` → 409 `agent-gone`. `approve › an unknown request` → 404.
  - `approve › two at once make one app` (Review Focus 1): two concurrent approves of `R` → one 200, one 404 `not-found`; `createApp` called once.
  - `approve › the agent deleted meanwhile leaves no orphan`: hold `createApp`, start approve, then fire `bots.removeForAgent('a1')` (it waits for the lock). Release: no bot row and no request remain, and Slack's `deleteApp` was called.
  - `decline › removes it`; `decline › unknown is 404`; `decline › waits for an approve in flight, then 404`.
  - `logs are code-only`: every method runs with names, emails and tokens in the world, and no line's JSON contains any of them or any user or agent id.
- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement** `bot-requests.ts` per the answers above, with a header in the style of bots.ts: what it owns, who may call what, which methods take the lock and which never do, and the log lines.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Mutation check** (commit first). Each mutant must fail the named test:
  1. Drop `lock.run` from `cancel` → `waits for an approve in flight`.
  2. Approve looks the request up outside the lock → `two at once make one app`.
  3. Check the requester with `agentAccess` instead of `teamAdminAccess` → `requester no longer a team admin`.
  4. `list` reads `configTokenStored` for the requester → `configTokenStored is the viewer's own`.
- [ ] **Step 6: Commit** — `[TASK-1169] channel-slack: ask an AX admin for a bot; approve, decline and cancel requests`.

### Task 4: Routes and wiring [tier: sensitive]

Sensitive: new signed-in and admin routes (CSRF, body caps, gate order) carrying a pasted credential. **security-checklist: required** (new HTTP surface carrying a credential and untrusted input).

**Files:**
- Modify: `packages/channel-slack/src/agent-routes.ts` (header `:22-53`; `createAgentSlackRoutes` signature `:192-195`; two routes at `:423-433`)
- Create: `packages/channel-slack/src/bot-request-routes.ts`
- Modify: `packages/channel-slack/src/plugin.ts` (header `:71-92`; `createBotRequests` after `createBots` `:370-380`; the routes array `:382-472`)
- Test: `agent-routes.test.ts`, `bot-request-routes.test.ts` (new), `plugin.test.ts:674-729`, `presets/memory/src/__tests__/canary.test.ts` (`:740-790` admin block; `:851-866` bot loop)

**Interfaces:**
- Consumes: Task 3's `BotRequests`.
- Produces:
  ```ts
  // agent-routes.ts
  export function createAgentSlackRoutes(
    d: ChannelDeps,
    bots: Pick<Bots, 'request' | 'installUrl' | 'cancel' | 'status'>,
    requests: Pick<BotRequests, 'ask' | 'cancel'>,
  ): RouteSpec[];
  //   POST /settings/slack/:agentId/bot-request          { botName } → {}
  //   POST /settings/slack/:agentId/bot-request/cancel   → {}
  // bot-request-routes.ts
  export const ADMIN_BOT_REQUESTS_PATH = '/admin/slack/bot-requests';
  export const ADMIN_BOT_REQUEST_APPROVE_PATH = '/admin/slack/bot-requests/:requestId/approve';
  export const ADMIN_BOT_REQUEST_DECLINE_PATH = '/admin/slack/bot-requests/:requestId/decline';
  export function createBotRequestAdminRoutes(d: {
    bus: HookBus; requests: Pick<BotRequests, 'list' | 'approve' | 'decline'>; logger: Logger;
  }): RouteSpec[];
  //   GET  …/bot-requests                         → AdminBotRequestList
  //   POST …/bot-requests/:requestId/approve      { refreshToken?, iconPng? } → { installUrl, iconSet }
  //   POST …/bot-requests/:requestId/decline      → {}
  ```

**Agent routes.** Both keep the existing gate order: 401, the same 404, then rights (403 / 409 `personal-agent`). All of it runs before the body is read. Stages are `bot-request` and `bot-request-cancel`.

The ask body:
- Cap at `ADMIN_BODY_MAX_BYTES`, with a 413 backstop.
- `bodyObject` null, or any key but `botName` → 400 `invalid-body`.
- A missing `botName` reads as `''` → 400 `invalid-bot-name` `reason: 'empty'`.
- A non-string `botName` → 400 `invalid-bot-name` `reason: 'bad-characters'`.
- Otherwise `checkBotName`.

Cancel reads no body.

**Admin routes.**
- **Gate:** `checkAdmin` (admin-auth.ts) first: 401 / 403 / 500. Then `:requestId` must match `INSTALL_ID_RE` (exported by ingress.ts), else 404 `{ error: 'not-found' }` before the domain.
- **Approve body:**
  - `maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES`, with a 413 backstop.
  - `bodyObject` null, or any key but `refreshToken`/`iconPng` → 400 `invalid-body`.
  - A `refreshToken` that's present must pass `configToken(value, REFRESH_TOKEN_PREFIX)`, else 400 `invalid-refresh-token`, and nothing reaches the domain.
  - `iconPng` goes through `parseIconPng` and is never a 400.
- **Domain ctx:** `makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: actor.id, logger })`.
- **Faults:** a throw → 500 `{ error: 'internal' }`, logged `slack_admin_failed { stage, code: logCode(err) }` with stage `bot-requests`, `bot-request-approve` or `bot-request-decline`.
- **No route sets `bypassCsrf`.**

**plugin.ts.**

```ts
const botRequests = createBotRequests({ bus, installs: store, secrets, bots, lock: appLock, publicOrigin, logger, randomBytes })
```

Register `...createBotRequestAdminRoutes({ bus, requests: botRequests, logger })` right after `...createAdminRoutes(…)`, and pass `botRequests` as `createAgentSlackRoutes`' third argument. The header's route list gains the five routes.

- [ ] **Step 1: Write the failing tests.**
  - `agent-routes.test.ts`:
    - Add `'/bot-request'` (body `{ botName: 'Ada Bot' }`) and `'/bot-request/cancel'` (`{}`) to the `Suffix` union and `EVERY_ROUTE` (`:243-263`), so the 401 / 404 / 403 / 409 loops cover them.
    - Add both to the route-shape pin (`:449-489`): POST, `maxBodyBytes` `ADMIN_BODY_MAX_BYTES`, no `bypassCsrf`.
    - Add them to the hard-coded lists at `:594` (body not read before rights), `:963` (413) and `:1087` (domain fault), where each applies.
    - Add a `stubRequests()` modelled on `stubBots()` (`:279-312`) as the third argument.
    - New cases: `bot-request › an unknown key is invalid-body`, `› a missing name is invalid-bot-name empty`, `› answers what the domain answers`; `bot-request/cancel › reads no body`.
  - `bot-request-routes.test.ts` (new):
    - The gate stub: copy `admin-routes.test.ts`'s `auth:require-user` stub pattern (`:161-184`, `:231-239`; ADA admin, BOB not).
    - A loop over every returned route: 401 signed out, 403 non-admin, 500 auth fault, with the domain never called.
    - `a request id of the wrong shape is 404 before the domain`.
    - `approve › an access token in refreshToken is invalid-refresh-token, before the domain`; `› an unknown key is invalid-body`; `› an unusable picture still reaches the domain as a refusal, never a 400`; `› a body past the cap is 413`.
    - `routes keep CSRF and their caps` (shape pin).
    - `a domain throw is a 500 with a code-only line`.
  - `plugin.test.ts`: the exact route list (`:682-726`) gains the five; update the title's count.
  - Canary:
    - The bot loop (`:855`) gains `'/bot-request'` and `'/bot-request/cancel'`.
    - `GET /admin/slack/bot-requests` answers 401 signed out, 403 for `ALICE`, and `{ status: 200, json: { requests: [], configTokenStored: false } }` for `CANARY_ADMIN`.
    - `POST /admin/slack/bot-requests/AAAAAAAAAAAAAAAAAAAAAA/decline` without the CSRF header → 403; with it → `{ status: 404, json: { error: 'not-found' } }`.
- [ ] **Step 2: Run, expect FAIL** — `T=(src/__tests__/agent-routes.test.ts src/__tests__/bot-request-routes.test.ts src/__tests__/plugin.test.ts); pnpm --filter @ax/channel-slack exec vitest run "${T[@]}"`.
- [ ] **Step 3: Implement** the routes and the wiring. bot-request-routes.ts gets its own small `route()` helper with the same shape as admin-routes.ts's JSON branch (`:997-1029`). Don't import or edit admin-routes.ts.
- [ ] **Step 4: Run, expect PASS**, then `pnpm --filter @ax/channel-slack test`, `pnpm --filter @ax/preset-memory test` (Docker) and `pnpm --filter @ax/preset-k8s test`. The manifest pins must pass unchanged: if one fails, a hook slipped in, so remove it.
- [ ] **Step 5: Commit** — `[TASK-1169] channel-slack: routes for asking an AX admin, and Admin › Slack's request list`.

### Task 5: Agent settings — pick a way, then wait for an AX admin [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/agent-slack.ts` (header `:7-15`; `AgentSlackBot` `:39-45`; `parseBot` `:136-161`; two new calls after `:346`; `agentSlackBotStale` `:472-478`)
- Modify: `packages/channel-web/src/components/workspace/AgentSlackBot.tsx` (header `:1-25`; `AgentSlackBot` switch `:139-158`; `RequestForm` `:160-284`; new `Requested`)
- Modify: `packages/channel-web/src/components/workspace/AgentSlack.tsx:143-160` (no-workspace view)
- Test: `lib/__tests__/agent-slack.test.ts`, `components/workspace/__tests__/AgentSlackBot.test.tsx`, `components/workspace/__tests__/AgentSlack.test.tsx`

**Interfaces:**
- Consumes: Task 4's agent routes and the status's `bot.requested`.
- Produces:
  ```ts
  export type AgentSlackBot = /* … */ | { state: 'requested'; botName: string; requestedAt: string };
  export async function askSlackBotApproval(agentId: string, i: { botName: string }): Promise<void>; // POST …/bot-request
  export async function cancelSlackBotRequest(agentId: string): Promise<void>;                  // POST …/bot-request/cancel
  // agentSlackBotStale also answers true for 409 'bot-requested' and 409 'not-requested'
  ```

**UI.** Invoke the `shadcn` skill first.

**`RequestForm` gains `way: 'admin' | 'self'`,** defaulting to `configTokenStored ? 'self' : 'admin'`. The choice is a `FieldSet` + `FieldLegend variant="label"` + `RadioGroup` with two horizontal `Field`s (the `MemoryCorrection.tsx:282-310` pattern), placed above the name field:
- The token steps and `TokenField` render only when `way === 'self' && showToken`.
- With `'admin'`, submit reads no token, calls `askSlackBotApproval(agentId, { botName })`, then `onChanged()`.
- With `'self'`, submit works as today.
- Errors go through `agentSlackBotErrorCopy` as today.

**`Requested`** (managers only) holds the waiting line, the asked date (`toLocaleDateString(undefined, { dateStyle: 'medium' })`, falling back to the raw string as SlackTab's `shortDate` does) and **Cancel request**. A successful cancel calls `onChanged()`; there's no left-over note, because no app exists. A refusal is stale (re-read) or shows its message.

`AgentSlack.tsx`'s no-workspace view passes `canManage={state.bot.state === 'pending' || state.bot.state === 'requested'}`, and its comment says a request can be cancelled there too.

**Copy (exact):**
- Section description: `Give ${agentName} its own name in Slack. People mention it directly, and you add it to a channel with /invite. When someone outside the team mentions it, it answers them with your access.`
- Legend: `Who sets it up in Slack?`
- Option `admin`: label `Ask an AX admin`; description `We'll ask your AX admins. One of them approves it and finishes it in Slack, so you don't need a token.`
- Option `self`: label `I can install apps in Slack`; description `You set it up with your own Slack configuration token, then click Allow in Slack.`
- Under the choice: `Either way, Slack has the final say: only someone allowed to install apps in your Slack workspace can add it.`
- Submit: `Ask an AX admin` (busy `Asking…`) or `Create the Slack bot` (busy `Creating…`).
- Requested: `Waiting for an AX admin to approve ${botName}.` / muted `Asked on ${date}.` / button `Cancel request` (busy `Cancelling…`).

- [ ] **Step 1: Write the failing tests.**
  - agent-slack: `parses a requested bot`; `a requested bot without requestedAt is a bad response`; `askSlackBotApproval posts { botName } to /bot-request with the write headers`; `cancelSlackBotRequest posts {} to /bot-request/cancel`; `bot-requested and not-requested are stale`.
  - AgentSlackBot:
    - `defaults to Ask an AX admin when no token is stored, and to self when one is`.
    - `Ask an AX admin shows no token field and never sends one` (`askSlackBotApproval` called with exactly `{ botName }`; `requestSlackBot` not called; `onChanged` called).
    - `says Slack has the final say either way`.
    - `switching to self shows the token steps when none is stored`.
    - `a requested bot shows the waiting line and Cancel request to a manager`, `nothing to anyone else`.
    - `Cancel request cancels, then re-reads`.
    - `a stale cancel re-reads`.
    - The existing self-path tests keep passing.
  - AgentSlack: `the no-workspace view lets a manager cancel a request`.
- [ ] **Step 2: Run, expect FAIL** — `T=(src/lib/__tests__/agent-slack.test.ts src/components/workspace/__tests__/AgentSlackBot.test.tsx src/components/workspace/__tests__/AgentSlack.test.tsx); pnpm --filter @ax/channel-web exec vitest run "${T[@]}"`.
- [ ] **Step 3: Implement**, then update `AgentSlackBot.tsx`'s header for the choice and the `requested` view.
- [ ] **Step 4: Run, expect PASS**, then `pnpm --filter @ax/channel-web build` and `pnpm lint`.
- [ ] **Step 5: Commit** — `[TASK-1169] channel-web: ask an AX admin for an agent's own Slack bot`.

### Task 6: Admin › Slack — the request list, Approve and Decline [tier: integration]

Write-only token rule applies (Global Constraints). **security-checklist: in scope** of the PR's walk (a pasted credential in the admin's browser), though the tier stays integration: it copies `ReplaceTokenDialog`'s established pattern.

**Files:**
- Create: `packages/channel-web/src/lib/slack-bot-requests.ts`
- Create: `packages/channel-web/src/components/admin/SlackBotRequests.tsx`
- Modify: `packages/channel-web/src/components/admin/SlackTab.tsx`: import it, and render `<SlackBotRequests />` after `<ConnectedCard …/>` in `StatusView`'s `connected` case (`:914-920`). Nothing else changes in the file.
- Test: `lib/__tests__/slack-bot-requests.test.ts` (new), `components/admin/__tests__/SlackBotRequests.test.tsx` (new), `components/admin/__tests__/SlackTab.test.tsx`. In the last, mock `@/lib/slack-bot-requests` to an empty list for every existing test, and add one test that the connected view mounts the list.

**Interfaces:**
- Consumes: Task 4's admin routes; `SlackAdminError`, `goToSlack`, `SLACK_ERROR_COPY` (slack-admin.ts, import only); `SLACK_TOKEN_COPY` (slack-token-copy.ts); `AGENT_SLACK_BOT_COPY`, `AGENT_SLACK_COPY` (agent-slack.ts); `TokenField`, `SlackAppsLink`; `renderSlackAvatar`.
- Produces:
  ```ts
  export interface SlackBotRequest { requestId: string; botName: string; agentName: string; teamName: string | null; requestedBy: string; requestedAt: string }
  export interface SlackBotRequestList { requests: SlackBotRequest[]; configTokenStored: boolean }
  export async function fetchSlackBotRequests(): Promise<SlackBotRequestList>;
  export async function approveSlackBotRequest(requestId: string, i: { refreshToken?: string; iconPng?: string }): Promise<{ installUrl: string }>;
  export async function declineSlackBotRequest(requestId: string): Promise<void>;
  export function slackBotRequestErrorCopy(err: unknown): { field: 'refreshToken' | null; message: string; revealToken: boolean };
  export function slackBotRequestStale(err: unknown): boolean; // 404 'not-found' or 409 'bot-exists'
  export const SLACK_BOT_REQUEST_COPY: Readonly<Record<string, string>>;
  export function SlackBotRequests(): JSX.Element | null;
  ```

**Wire client.**
- Read every field by type; anything else is `SlackAdminError(status, 'bad-response')`.
- The GET throws `SlackAdminError(status, 'unknown')` when not ok.
- POSTs send `content-type: application/json` and `x-requested-with: ax-admin`, the request id through `encodeURIComponent`. A failure becomes `SlackAdminError(status, code, reason)` with codes kept only when they match `/^[a-z0-9-]{1,64}$/`. This is the same per-lib `post` pattern agent-slack.ts uses; don't export anything new from slack-admin.ts.
- Approve's `installUrl` must be a non-empty string. `goToSlack` refuses any link that isn't Slack's own Allow page.

**Component.**
- Fetches on mount. While loading, it renders nothing. On a load error it shows an `Alert` with `SLACK_BOT_REQUEST_COPY.loadFailed` and a `Try again` button. With no requests it renders nothing.
- Otherwise a `Card variant="settings"` with a `CardTitle role="heading" aria-level={2}` (the SlackTab outline rule), one `<ul>` row per request, and per row **Approve…** (opens the dialog) and **Decline** (outline; busy `Declining…`; a failure shows `declineFailed` on that row; success re-fetches).
- The dialog follows `ReplaceTokenDialog`'s shape (`SlackTab.tsx:634-767`): busy blocks closing, and every opening mounts the form empty.
- The token field shows when `!configTokenStored || revealed`. `revealed` is set by an answer whose copy has `revealToken`.
- Submit:
  1. Read the pasted token once and clear the input.
  2. `const iconPng = await renderSlackAvatar()`.
  3. `approveSlackBotRequest(requestId, { …(pasted !== '' ? { refreshToken: pasted } : {}), …(iconPng !== null ? { iconPng } : {}) })`.
  4. `goToSlack(installUrl)`, and stay busy.
- A stale answer closes the dialog, shows `changed` above the list and re-fetches.

**Copy (exact).** Three templated lines are written inline in the component:
- each row: `${botName} for ${agentName}` + (teamName ? ` · ${teamName}` : ''), then muted `Asked by ${requestedBy} on ${date}.`
- the dialog title: `Approve ${botName}`
- the dialog body: `We'll create the bot in Slack with your configuration token, then take you to Slack to click Allow. When someone outside the team mentions it, it answers with ${requestedBy}'s access.`

`SLACK_BOT_REQUEST_COPY` holds the fixed sentences:
- `title`: `Bot requests`
- `description`: `Team admins asked for their agent's own Slack bot. Approving creates it with your Slack configuration token, so you'll be the one who can change or delete it later.`
- `storedToken`: `We'll use the configuration token you gave us before.`
- token steps: the two `<li>`s from `AgentSlackBot.tsx:232-241` with "for your workspace". The field is `TokenField id="slack-approve-refresh-token" label="Refresh token" hint="Starts with xoxe-" required`.
- buttons: `Cancel` and `Approve and open Slack` (busy `Creating…`).
- `requester-not-admin`: `The person who asked is no longer an admin of that agent's team, so this can't be approved. Decline it instead.`
- `agent-gone`: `That agent was deleted, so there's nothing to approve. Decline the request.`
- `bot-name-taken`: `Another Slack bot here already uses that name. Decline this request, and the team can ask again with another name.`
- `slack-name`: `Slack didn't accept that bot name. Decline this request, and the team can ask again with another name.`
- `no-workspace`: `Slack isn't connected right now, so bots can't be approved.`
- `loadFailed`: `We couldn't load bot requests.`
- `declineFailed`: `We couldn't decline that just now. Try again in a minute.`
- `changed`: `This changed while you were here, so we've refreshed it.`
- Token codes map as `agentSlackBotErrorCopy` maps them:
  - `config-token-needed`, `slack-config-token` and `slack-token` use `AGENT_SLACK_BOT_COPY` with `revealToken: true`, field `refreshToken`;
  - `invalid-refresh-token` and `slack-refresh-token` use `SLACK_TOKEN_COPY`, field `refreshToken`;
  - `public-origin-not-https` uses `SLACK_ERROR_COPY['public-origin-not-https']`;
  - `slack-unconfirmed` uses `SLACK_TOKEN_COPY['slack-unconfirmed']`;
  - `slack-error` uses `SLACK_ERROR_COPY.generic`;
  - anything else uses `AGENT_SLACK_COPY.generic`.

- [ ] **Step 1: Write the failing tests.**
  - lib: `reads the list field by field`; `a malformed row is a bad response`; `approve posts only what it is given`; `decline posts to the request's own path`; `error copy and stale` (each code above).
  - component:
    - `shows each request with its names and date`.
    - `renders nothing with no requests`.
    - `a load error offers Try again`.
    - `Approve with a stored token shows no token field`.
    - `without one the field shows and is required`.
    - `submit sends the pasted token and the picture, empties the field, and goes to Slack`.
    - `reveals the token field after slack-config-token` (Review Focus 4).
    - `requester-not-admin says to decline`.
    - `a stale answer closes the dialog, says it changed and re-reads`.
    - `Decline declines and re-reads`.
    - `a failed decline says so on its row`.
  - SlackTab: `the connected view lists bot requests`.
- [ ] **Step 2: Run, expect FAIL** — `T=(src/lib/__tests__/slack-bot-requests.test.ts src/components/admin/__tests__/SlackBotRequests.test.tsx src/components/admin/__tests__/SlackTab.test.tsx); pnpm --filter @ax/channel-web exec vitest run "${T[@]}"`.
- [ ] **Step 3: Implement** (invoke `shadcn` first).
- [ ] **Step 4: Run, expect PASS**, then `pnpm --filter @ax/channel-web build` and `pnpm lint`.
- [ ] **Step 5: Commit** — `[TASK-1169] channel-web: Admin › Slack lists bot requests to approve or decline`.

### Task 7: Back from Slack — an approving AX admin lands in Admin › Slack [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/slack-bot-return.ts`
- Modify: `packages/channel-web/src/App.tsx` (`:158-175` comment; AppContent `:283-312`)
- Test: `lib/__tests__/slack-bot-return.test.ts`, `__tests__/slack-bot-return-app.test.tsx`

**Interfaces:**
- Consumes: Task 2's `…&from=admin`.
- Produces:
  ```ts
  export interface SlackBotReturn { outcome: SlackBotOutcome; returnPath: string | null; fromAdmin: boolean }
  export const SLACK_BOT_APPROVED_RETURN_MESSAGES: Readonly<Record<SlackBotOutcome, string>>;
  ```

**Rules.**
- `fromAdmin` is true only for the exact `from=admin`, and then `returnPath` is null (any `agentId` is ignored). `withoutSlackBotReturn` also strips `from`.
- In AppContent, for `user.role === 'admin'` with `fromAdmin`: admin settings open on the `slack` tab (the same initial state `slackOutcome` gives) and one toast from `SLACK_BOT_APPROVED_RETURN_MESSAGES` (an error toast for `failed`).
- For anyone else with `fromAdmin`: no toast and no settings.
- Without `fromAdmin`: unchanged.

**Copy (exact):**
- `connected`: `The Slack bot is live. Its team can add it to a channel with /invite.`
- `cancelled`: `Slack install was cancelled, so the bot isn't added yet. Its team can cancel the request in the agent's Slack settings and ask again.`
- `failed`: `We couldn't finish adding the Slack bot. Its team can cancel the request in the agent's Slack settings and ask again.`

- [ ] **Step 1: Write the failing tests.**
  - parser: `from=admin marks an admin's return and drops the agent path`; `any other from value is ignored`; `strips from with the rest`.
  - app: `an admin back from approving lands in Admin › Slack with one toast` (address ends `/`); `a non-admin with from=admin gets nothing`; the existing `agentId` landing is unchanged.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, then `pnpm --filter @ax/channel-web build` and `pnpm lint`.
- [ ] **Step 5: Commit** — `[TASK-1169] channel-web: an AX admin back from Slack lands in Admin › Slack`.

### Task 8: Stale lines, the design doc, and the changeset [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`
- Create: `.changeset/slack-bot-admin-approval.md`

- [ ] **Step 1: The design's stale lines.** These are what made the card's text look right.
  - §4 step 1, `:397-398`. "picks the name and avatar" becomes "picks the name. The picture is the deployment's logo, drawn by the browser of whoever creates the app; there's no per-bot picture yet."
  - §4 "As built (TASK-1167)", `:496-497`. "Asking an admin to approve is a later card. Here the approver is the requester." becomes "Asking an AX admin to approve came next (TASK-1169, below). On this path the approver is the requester."
  - §6, `:814-820`. Add TASK-1169's five routes: `POST …/bot-request` and `…/bot-request/cancel` from agent settings; `GET /admin/slack/bot-requests` and `POST /admin/slack/bot-requests/:requestId/{approve,decline}` for AX admins, all CSRF-checked, no hooks. Also `…&from=admin` on the bot callback's landing.
  - §9, `:1083-1086`. "Asking an admin to approve" leaves the "still to do" list; add a TASK-1169 progress line.
- [ ] **Step 2: Add "As built (TASK-1169)" after `:519`.** It covers:
  - the two ways on the form; a request holds a name and its requester, one per agent, no picture;
  - names unique across requests too;
  - Admin › Slack lists requests with the names the requester sees;
  - Approve uses the admin's stored token or a paste, through the same create path, with the admin as approver and the requester as run-as;
  - the request is deleted only once everything else worked;
  - an admin-approved bot goes live only while its approver is an AX admin and its requester a team admin;
  - the approver lands back in Admin › Slack;
  - Decline, Cancel, agent delete and a reset remove a request;
  - no Continue in Slack yet for an approver outside the team.
- [ ] **Step 3: Changeset** — `'@ax/channel-slack': patch` and `'@ax/channel-web': patch`: "A team admin who can't install Slack apps can now ask an AX admin for their agent's own Slack bot. The request shows up in Admin › Slack. An AX admin approves it with their own Slack configuration token (or the one we already keep for them, so most of the time there's nothing to paste) and clicks Allow in Slack. They become the bot's approver, and people outside the team are still answered with the requester's access. Decline, or the team's own Cancel, takes a request back, and deleting the agent deletes it."
- [ ] **Step 4: Commit** — `[TASK-1169] docs: the Slack design catches up with asking an AX admin`.

---

## Final gate

- [ ] `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, with the Docker env from Global Constraints, then `pnpm lint`.
  - `agent-keyed-tables-are-cleaned.test.js` passes with no allowlist edit (Task 1's delete; agents-deleted subscribes).
  - `channel-slack-boundaries.test.js` passes with no allowlist edit (no `slack:` string outside channel-slack).
  - `memory-quoted-blob-shas.test.js` passes: this plan touches no file a memory row pins by blob (checked at `3cf5673d0`; `router.ts` is untouched).
- [ ] `git grep -n "lock.run" packages/channel-slack/src/bots.ts packages/channel-slack/src/bot-requests.ts`. Each locked method has exactly one; `create` and `finish` have none.
- [ ] **security-checklist** once for the PR, covering Tasks 1–4 and Task 6's token field. The threats to answer:
  - **The approving admin's token:** every use under the app lock; the successor saved before use; the paste never stored; release only through `personHasApps`; `configTokenStored` the only token fact answered, about the viewer's own.
  - **Who can finish an admin-approved bot:** state-user binding, still an AX admin, requester still a team admin.
  - **Cross-agent and cross-team reach:** the admin list reads an agent as its requester. That's a disclosure to AX admins that the design sanctions. AX admins gain no rights over the agent, and outsiders still run as the requester.
  - **Untrusted input:** the bot name (`checkBotName` at the route, `cleanLabel`ed names out), the request id (shape-checked before the domain), the pasted token (shape-checked before Slack), the picture (icon.ts; never stored).
  - **CSRF and body caps** on the five routes.
  - **No new egress**, no new dependency.
- [ ] **Residuals to state in the PR:**
  - (a) An approver who isn't a team admin can't Continue in Slack: after a cancelled or abandoned Allow, the team cancels and asks again.
  - (b) The approver is the bot's only manager (design §4 Lifecycle); if they leave, the bot is rebuilt.
  - (c) A configuration token from another workspace still ends in `team-mismatch` (TASK-1167 deferred #4).
  - (d) A CLI reset racing an approve (no shared lock) can leave a bot row for a wiped agent (TASK-1167 residual c).
  - (e) Rolling back past this PR leaves the table unused, and an admin-approved pending bot can't be finished by the old code (its team cancels it).

## For the builder's handoff

- **`followups`:**
  1. Admin › Slack: Continue in Slack, and Cancel, for a pending bot the viewing admin approved (build on TASK-1172's bot list).
  2. Slack DMs to AX admins for a new request, and to the requester on approve or decline (the card's separate DM card).
  3. A `viewerIsApprover` field on the agent-side pending shape, so an approver reads "you" when Slack isn't connected (TASK-1167 round-3 nit).
- **`learnings`:**
  - A bot's approver may differ from its requester: approver ≠ requester means an AX admin approved it.
  - `finish` checks such an approver is still an AX admin (`auth:get-user`) and its requester still a team admin, and the callback lands them on `/?slack-bot=…&from=admin`.
  - `Bots.create` is the one create path and runs under the caller's lock.
  - Open requests live in `channel_slack_v1_bot_requests` (one per agent, no picture), and `namesInUse` reads them.
  - Admin › Slack's request routes are in `bot-request-routes.ts`, not `admin-routes.ts`.
