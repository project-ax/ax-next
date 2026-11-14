# TASK-1094: Slack channel → team agent (attended vs external turns) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team admin connects a public Slack channel to a dedicated team agent (from the agent's settings or with `/ax connect <agent>`), and every @mention there becomes a turn: attended as the sender when they can use the agent, external as the person who connected the channel otherwise, always `audience: 'shared'`, with a per-channel memory switch and a "waiting for my owner" line when a call is held.

**Architecture:** `@ax/channel-slack` gains a bindings table (one agent per channel), three Slack methods (`conversations.info/list/join`), agent-scoped settings routes, a signed `/ax` route and a channel branch in its event router that reuses the DM turn machinery (one turn runner, one reply streamer, one queue type). Auth gains one host-internal hook, `auth:is-approved-email`, built on the same approved-domains helper as `auth:find-user-by-email`. Memory learns nothing new: channel-slack vetoes capture through the existing `memory:pre-capture`, and `memory_note` starts honouring that veto. channel-web gets an agent-settings "Slack" section.

**Tech Stack:** TypeScript (exactOptionalPropertyTypes), Kysely on Postgres, vitest + Testcontainers, React + shadcn in `packages/channel-web`. No new dependencies.

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` (§1, §2, §2a, §3, §5, §6, §9). Card: TASK-1094. Planner decisions (read them, they carry the why): `.claude/memory/decisions/2026-11-13-TASK-1094.md`. Stack contracts: `.claude/memory/decisions/2026-11-12-TASK-1091.md` (source/audience, outsider rules, `conversation:busy`, serialize per conversation), `.claude/memory/decisions/2026-11-13-TASK-1092.md` (`auth:find-user-by-email`, caller allowlist), `.claude/memory/decisions/2026-11-13-TASK-1093.md` (the DM path you are extending; its last rows are the walk learnings), `.claude/memory/mistakes/2026-11-13-TASK-1093.md` (token shapes, invisible characters, fake `agent:invoke` timeouts, zsh test lists).

## Delivery: one card, two stacked PRs

Both PRs stack on TASK-1093's PR B (#1178) and squash into main together with the rest of the epic (half-wired policy). Run a review gate (ax-code-reviewer) after Task 8 and after Task 16.

- **PR A, Tasks 1–8: connect a channel.** Reachable on its own: a team admin connects and disconnects from agent settings or `/ax`; a mention in a connected channel still gets the old DM-only refusal until PR B.
- **PR B, Tasks 9–16: channel turns.** Builds on PR A's bindings and connect core.

**Stacked PRs get NO CI** (`ci.yml` runs only for base `main`). The local gate below is the only gate, and it must cover dependents.

## What exists today (read from the code at `5cd1a8f72`, not run, unless noted)

- **DM path:** `router.ts` (screen → bot token → admission → `auth:find-user-by-email` → oldest personal agent → `conversations:find-or-create` → queue) → `dm-turn.ts` `runDmTurn` (ctx `source:'user'`, `audience:'private'`, label in content, 👀 via `stream.working()`, cap + interrupt) → `reply-stream.ts` (`finish()` closing lines at `:516-545`) → `turn-queue.ts` (`createKeyedQueue({maxPerKey})`, `enqueue(key, group, job)` → `'queued'|'full'|'closed'`). A held call is DROPPED today: `dm-turn.ts:226` returns on `c.held === true`.
- **Mentions:** `admission.ts` `screenEvent` turns `app_mention` into `{kind:'mention', sender, channel, threadTs?}` (no `ts`, no `text`) and `answerMention` posts the ephemeral `COPY.mentionRefusal`. The ingress already keeps `text`, `ts`, `thread_ts` for every event (`events.ts` `OPTIONAL_EVENT_FIELDS`) and the envelope's `is_ext_shared_channel` (screened → silence).
- **Conversations (Explore, file:line):** one owner column `user_id`; `find-or-create` is unique on `(user_id, agent_id, external_key)` (`conversations/src/migrations.ts:161-163`, `store.ts:1008-1015`) and runs `agents:resolve` for the INPUT `userId` (`plugin.ts:1398-1417`). A turn run as X in Y's conversation is not refused but breaks it: route lookup and bind fail, the runner resyncs and replaces Y's transcript (`plugin.ts:1037-1039`, `transcript-delta.ts:200-202`). Hence one conversation per (thread, identity) below.
- **Decisions / Today (Explore):** a hold writes a row with `ownerUserId: ctx.userId`, `conversationId`, `agentId` (`decisions/src/pre-call.ts:258-271`); Today is `GET /api/workspace/decisions` → `decisions:list({userId: signed-in})` (`channel-web/src/server/routes-workspace.ts:6937-6976`). `attendanceFor` returns unattended for outsider turns and for origin `'slack'` (`decisions/src/attendance.ts:95,119-128`). The runners mark the held result chunk `held: true` (`ipc-protocol/src/events.ts:58-72`) and END the turn right after (`complete`). `decisions:raised` is not fired for a reused open row; `chat:permission-request` is not fired for holds. Today's web route is `/workspace` (`channel-web/src/lib/workspace-route.ts:75`).
- **Memory (Explore):** `memory:pre-capture` `{conversationId}` is fired by memory's `observe()` before every pass (`memory/src/plugin.ts:1727-1745`), 10 s per subscriber, fails open on a timeout; a refusal leaves the cursor where it was. Routines' fail-closed subscriber is the pattern to copy: `routines/src/capture.ts` `taskCaptureVeto`. `memory_note` (`memory/src/note-tool.ts:196-262`) does NOT fire it (TASK-908 row 16).
- **Agents:** team agent = `visibility 'team'` (DB CHECK pairs `ownerType 'team'`). `agents:can-set-shared-credential({agentId, actor:{userId,isAdmin}}) → {allowed}` = team agent AND team role `admin`, workspace admin ignored, personal always false (`agents/src/plugin.ts:600-620,1227-1244`). `agents:list-for-user({userId, teamIds})` returns personal + those teams' agents. `teams:list-for-user({userId}) → {teams:[{id,…}]}`. `agents:deleted {agentId, ownerId, ownerType}` (`agents/src/types.ts:703-707`).
- **Auth:** `auth:find-user-by-email` (`auth-better/src/plugin.ts:591-670`); helpers `isPlainAscii`, `parseDomains`, `isDomainAllowed` in `identity-gate.ts:73-108`. **The coordinator is changing the approved-domains read on the TASK-1092 branch** (union of every non-blank Google or GitHub `allowed_domains`, enabled or not; none non-blank = any domain) into ONE helper `findUserByEmail` calls, and merges it up the stack into this branch before you start PR B.
- **Guards:** `scripts/__tests__/channel-slack-boundaries.test.js` (rule 1: `auth:find-user-by-email` literal only in auth-better, channel-slack and three listed preset tests; rule 2: `slack:` literals only in channel-slack and the composition test). `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js` (a table with `agent_id`/`conversation_id` needs a `deleteFrom` plus an `'agents:deleted'` or `'conversations:purged'` subscriber in the same package). ipc-core's `dependencies.test.ts` keeps every `auth:` hook off IPC.
- **Slack (docs.slack.dev, 2026-11-13):** an app receives `app_mention` only in conversations it is a member of. `conversations.list` (bot `channels:read`, Tier 2, form only; `types`, `exclude_archived`, `limit` < 1000, `cursor`, `response_metadata.next_cursor`). `conversations.info` (`channels:read`, Tier 3, form only; `channel.{id,name,is_channel,is_private,is_archived,is_ext_shared,is_pending_ext_shared,is_member}`; a private channel the bot can't see → `channel_not_found`). `conversations.join` (`channels:join`, Tier 3; public only, `method_not_supported_for_channel_type`, `is_archived`; ok with `warning: already_in_channel`). Slash commands: form-encoded POST with `team_id`, `api_app_id`, `channel_id`, `user_id`, `command`, `text`, `response_url`, `trigger_id`, optional `ssl_check=1`; answer within 3000 ms; a JSON body `{response_type:'ephemeral', text}` is shown only to the invoker; `text` is mrkdwn. `chat.postEphemeral` needs the bot to be a member (`no_permission` otherwise).
- **Composition test:** `presets/k8s/src/__tests__/channel-slack-composition.test.ts` boots the real preset (agents, teams, conversations, credentials, decisions, tool-policy, Postgres) with stubbed auth/`agent:invoke` and a fake Slack behind `fetchImpl`. The memory canary (`presets/memory/src/__tests__/canary.test.ts`) boots channel-slack for real with an `authStub()` at `:47-96`. The CLI reset kernel (`packages/cli/src/commands/admin/reset-bootstrap.ts:150-215`) loads channel-slack with auth-better, agents and credentials but NOT teams.

## Global Constraints

- **No new dependencies.** No Slack SDK. Only `https://slack.com/api/<method>` egress (no `response_url`, no `hooks.slack.com`).
- **Scopes:** bot scopes exactly `app_mentions:read, chat:write, im:history, reactions:write, users:read, users:read.email, channels:read, channels:join, commands`. Events stay exactly `app_mention, message.im`. No interactivity (TASK-1095).
- **Slash command:** `SLASH_COMMAND = '/ax'` (one constant), URL `<origin>/slack/commands/<installId>`, `should_escape: false`.
- **Routes (new):** `POST /slack/commands/:installId` (`bypassCsrf: true`, `maxBodyBytes: 16384`); `GET /settings/slack/:agentId`; `GET /settings/slack/:agentId/available`; `POST /settings/slack/:agentId/connect`; `POST /settings/slack/:agentId/disconnect`; `POST /settings/slack/:agentId/remember`. Settings POSTs keep http-server's CSRF check.
- **Tables (new, no foreign keys):** `channel_slack_v1_channels` (Task 3), `channel_slack_v1_threads` (Task 14). Additive, idempotent migrations.
- **Conversation keys:** attended `slack:<installId>:<channel>:<thread_ts>` (the sender's own conversation); external `slack:<installId>:<channel>:<thread_ts>:external` (the connector's). `thread_ts` = the mention's `thread_ts`, else its `ts`. Origin `'slack'`.
- **Turn context:** DM `{source:'user', audience:'private'}`; attended channel `{source:'user', audience:'shared'}`; external `{source:'external', audience:'shared'}`. Built only by host code from admission + AX answers, never from message text.
- **Manage rights:** `agents:resolve` passes AND `agents:can-set-shared-credential` answers `{allowed:true}`, always with `actor.isAdmin: false`. Only `visibility === 'team'` agents can be connected.
- **Queues:** attended turns per conversation (existing queue, `MAX_TURNS_PER_CONVERSATION` 3); external turns per channel (new queue, `MAX_EXTERNAL_TURNS_PER_CHANNEL` 5, lane key `<installId>:<channelId>`).
- **New limits (`limits.ts`):** `COMMANDS_MAX_BODY_BYTES = 16_384`, `SLASH_TEXT_MAX = 512`, `SLASH_REPLY_DEADLINE_MS = 2_500`, `CHANNEL_LIST_PAGE_LIMIT = 200`, `CHANNEL_LIST_MAX_PAGES = 5`, `CHANNEL_NAME_MAX = 80`, `AGENT_NAME_ARG_MAX = 128`, `MAX_EXTERNAL_TURNS_PER_CHANNEL = 5`.
- **Copy:** every Slack-facing word lives in `copy.ts` `COPY` (tests use `COPY.*`, never literals). No line names the product (the bot is white-labeled). In-thread replies are Markdown (`markdown_text`); ephemeral and slash replies are mrkdwn `text`: links are bare URLs built from `publicOrigin`, and any agent or channel name goes through `mrkdwnEscape` then `neutralizeSlackControls`. No COPY line holds `<!`, `<@`, `<#`, or a bare `@here/@channel/@everyone`. `copy.test.ts` pins the exact COPY key list ("has exactly the lines the plan names") and that no line says `AX`: add each new key in the task that adds it (Tasks 5, 10, 12) and drop `mentionRefusal` in Task 12.
- **Logs:** code-only (`installId`, `reason`, `stage`, `code`, counts, booleans). Never an email, a Slack user or channel id, a channel or agent name, message text, or a token.
- **Repo hygiene:** no Slack-token-shaped literal anywhere (fake tokens use short digit groups, e.g. `xoxb-1111-2222-…`; grep `xox[bpe]-[0-9]{10,13}-` before committing); no literal invisible or bidi character in any file (build U+200B with `String.fromCharCode(0x200b)` or reuse format.ts's constant; `source-hygiene.test.ts` catches `src/`); never bare `kubectl` (the default context is GKE prod).
- **Fakes:** a fake `agent:invoke` copies the real registration's `{ timeoutMs: Number.POSITIVE_INFINITY }`. `beforeEach` bodies are blocks, never an expression returning a mock.

## Local gate (run before each review gate and before saying "green")

```bash
export DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock
pnpm build
pnpm -r --no-bail --filter "...@ax/channel-slack" --filter "...@ax/auth-better" --filter "...@ax/memory" --filter "@ax/channel-web" run test
pnpm test:scripts
pnpm test:eslint-rules
pnpm lint
```

`--filter` goes before `run`. `...@ax/<pkg>` includes dependents (cli, preset-k8s, preset-memory). `@ax/auth-better`'s Docker teardown can time out with all assertions passing: re-run that package alone before suspecting the change. Under zsh, keep test file lists in arrays (`T=(a b); pnpm exec vitest run "${T[@]}"`).

## Invariants (how this plan meets each)

1. **Transport/storage-agnostic hooks:** the only new hook is `auth:is-approved-email` `{email} → {approved}`. Slack ids and channel names stay inside channel-slack; conversation keys are its opaque strings.
2. **No cross-plugin imports:** channel-slack copies routines' veto shape (no import); channel-web reaches channel-slack over HTTP; everything else is bus calls.
3. **No half-wired code:** every route, subscriber and table is registered in both presets through `createChannelSlackPlugin`, reached by the memory canary and the composition test; both PRs squash with the rest of the stack.
4. **One source of truth:** bindings live only in channel-slack; manage rights come from agents; approved domains from auth's one helper; the thread map is channel-slack's index of its own keys; names are read from auth when shown.
5. **Least capability:** three scopes, each justified (decisions shard); outsiders run with TASK-1091's external restrictions, held approvals and a per-channel lane; no new egress host.
6. **One UI language:** the settings section uses installed shadcn primitives only (Switch, Command, Popover, Dialog, Alert, Badge, Field) and semantic tokens.

## Boundary review (paste into the PR descriptions)

**`auth:is-approved-email` (new service hook, PR B).** `{ email: string } → { approved: boolean }`, registered by `@ax/auth-better` with a strict `returns` schema; host-internal (no route, no IPC action; ipc-core's `auth:` test pins that); caller allowlist = the boundaries guard's rule 1.
- Alternate impl: an OIDC or SCIM directory answering "is this address in our directory".
- Leaky names: none (`email`, `approved`).
- Subscriber risk: none (service hook). Caller risk: reading `approved` as "has an account"; the contract says it reads no account.
- Wire surface: none.

**`memory:pre-capture` gains a second producer site (PR B).** `memory_note` fires the same hook with the same `{conversationId}` payload before it writes. No payload or contract change ("fired before it learns anything from a conversation" already covers a note). Subscriber risk: routines' check-in veto now also refuses notes in task check-ins (tighter, consistent with TASK-908's reason; FLAGGED for Vinay).

No other hook signature changes. channel-slack's new subscriptions (`agents:deleted`, `memory:pre-capture`) and calls (`agents:resolve`, `agents:can-set-shared-credential`, `teams:list-for-user`, `auth:is-approved-email`) are existing surfaces.

## Sender tiers (the card's "each tier")

For a mention in a connected channel, after the Slack screen (bots, Slack Connect) and users.info admission:

| Tier | Who | Turn |
|---|---|---|
| A | AX user (verified email maps) who passes `agents:resolve` for the agent | attended, as themselves, their own conversation |
| B | AX user who does not pass `agents:resolve` | external, as the connector, the thread's external conversation |
| C | full member, no findable AX account, `auth:is-approved-email` → approved | external, as above |
| D | guest, bot, deactivated, invited, other workspace, unconfirmed email, off-domain (C with `approved:false`), Slack Connect | none; silence |
| E | A/B/C, but the binding is broken (connector fails `agents:resolve`, agent gone or not a team agent) | none; a private "a team admin needs to connect me here again" |

## Review Focus

1. **A connector who leaves the team.** Expect: no external turn, the sender gets `COPY.channelUnavailable` privately, attended members keep working, the settings row shows "needs reconnecting". Tests: Task 12 `tier E` cases; Task 4 `needsReconnect`; Task 15 end to end.
2. **A member and an outsider in one thread.** Expect: two conversations; the member's conversation never contains the outsider's text. Tests: Task 12 `mixed thread`; Task 15.
3. **The memory switch turned off, a turn, then on again.** Expect: that thread is never captured; a new thread is. Tests: Task 14 veto table; Task 15.
4. **An install made before this card** (no `channels:*`/`commands` scopes). Expect: settings say Slack must be reconnected by an admin (`needs-reconnect`), never a generic error. Tests: Task 4 (`missing_scope` on list/info/join).
5. **A reply that pings the room.** Expect: `@channel`/`@here`/`@everyone` and `<!…>` reach Slack inert, even split across a flush. Tests: Task 11.

---

## PR A — connect a channel

### Task 1: Manifest — three scopes and `/ax` [tier: mechanical]

**Files:**
- Modify: `packages/channel-slack/src/manifest.ts`
- Test: `packages/channel-slack/src/__tests__/manifest.test.ts`

**Interfaces:**
- Produces: `BOT_SCOPES` (9 entries, order: the six existing, then `channels:read`, `channels:join`, `commands`); `SLASH_COMMAND = '/ax'`; `slackUrls(origin, installId) → { eventsUrl, redirectUrl, commandsUrl }` with `commandsUrl = <origin>/slack/commands/<encodeURIComponent(installId)>`; `buildAppManifest` adds `features.slash_commands: [{ command: SLASH_COMMAND, url: commandsUrl, description: 'Connect this channel to a team agent', usage_hint: 'connect <agent name> | disconnect', should_escape: false }]`.

- [ ] **Step 1: Write failing tests** — `exact scopes`: `expect(BOT_SCOPES).toEqual([...6 existing, 'channels:read','channels:join','commands'])`; `no history or public-write scope`: none of `channels:history`, `chat:write.public`, `groups:read`, `mpim:read`; `slash command entry`: one entry, url ends `/slack/commands/<id>`, `should_escape === false`; `install url carries every scope`: `new URL(buildInstallUrl(…)).searchParams.get('scope')` splits to `BOT_SCOPES`; `events unchanged`: `['app_mention','message.im']`, no `settings.interactivity`.
- [ ] **Step 2:** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/manifest.test.ts` → FAIL.
- [ ] **Step 3: Implement** the constants and manifest entry; rewrite the header comment ("as small as DMs need … no slash commands") to name what each scope is for (decisions shard Q2).
- [ ] **Step 4:** re-run → PASS.
- [ ] **Step 5: Commit** `feat(channel-slack): channel scopes and the /ax command in the app manifest (TASK-1094)`.

YAGNI: all three scopes are used by Tasks 2/4/5. Existing dev installs reach the new manifest only by Disconnect + Connect (Task 4 maps `missing_scope` to `needs-reconnect`).

### Task 2: Slack client — `conversations.info`, `conversations.list`, `conversations.join` [tier: sensitive]

Security-checklist: untrusted Slack answers.

**Files:**
- Modify: `packages/channel-slack/src/slack-api.ts` (`SlackApi`, `SlackMethod` union, header "thirteen" → "sixteen")
- Modify: `packages/channel-slack/src/limits.ts` (`CHANNEL_LIST_PAGE_LIMIT`)
- Test: `packages/channel-slack/src/__tests__/slack-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SlackChannel {
    id: string; name: string;
    isChannel: boolean; isPrivate: boolean; isArchived: boolean;
    isExtShared: boolean; isPendingExtShared: boolean; isMember: boolean;
  }
  conversationsInfo(botToken: string, channel: string): Promise<SlackChannel>;
  conversationsList(botToken: string, a: { cursor?: string; limit: number }): Promise<{ channels: SlackChannel[]; nextCursor: string | null }>;
  conversationsJoin(botToken: string, channel: string): Promise<void>;
  ```
- All three: form bodies, `Authorization: Bearer`. List sends `types=public_channel`, `exclude_archived=true`, `limit`, `cursor` (only when given). Narrowing: `id` matches the client's Slack-id check; `name` a string (raw; cleaning is the caller's, Task 3); the refusing flags `is_private`, `is_archived`, `is_ext_shared`, `is_pending_ext_shared` are set unless absent, `null` or `false` (a non-boolean fails closed, like admission's `flagged`); `is_channel` and `is_member` count only when literally `true`. A list entry that fails narrowing is skipped; a `channels` that isn't an array, or an info answer without a valid `channel`, is `bad-response`. `next_cursor` `''`/absent → `null`.

- [ ] **Step 1: Write failing tests** — per method: URL, content type, body fields, bearer header; `already_in_channel` warning with `ok:true` resolves; `missing_scope`, `channel_not_found`, `is_archived`, `method_not_supported_for_channel_type` reject as `SlackApiError` with exactly `slack <method>: <code>`; narrowing table (string `"true"` for `is_private` → private; missing `is_member` → false; an entry with a bad id skipped while its neighbours survive); `nextCursor` null for `''`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** following the existing `usersInfo` pattern (redirect refusal, cap, deadline unchanged).
- [ ] **Step 4:** run → PASS. Mutation-check two rules (fail-closed flag → `=== true`; skip-bad-entry → throw) and confirm a test fails for each.
- [ ] **Step 5: Commit** `feat(channel-slack): conversations.info/list/join in the Slack client (TASK-1094)`.

YAGNI: three methods, each with a caller (picker, connect checks, join). No `conversations.leave`, no `users.conversations`, no channel cache.

### Task 3: Bindings store + `agents:deleted` cleanup [tier: sensitive]

Security-checklist: the binding decides whose identity external turns run as. Migration.

**Files:**
- Modify: `packages/channel-slack/src/migrations.ts` (table + types, header comment)
- Create: `packages/channel-slack/src/channel-store.ts`
- Modify: `packages/channel-slack/src/store.ts` (`remove`, `removeAll` also delete the install's bindings)
- Modify: `packages/channel-slack/src/label.ts` (`cleanChannelName`), `limits.ts` (`CHANNEL_NAME_MAX`)
- Create: `packages/channel-slack/src/agents-deleted.ts`
- Test: `src/__tests__/channel-store.test.ts`, `src/__tests__/agents-deleted.test.ts`, `src/__tests__/store.test.ts`

**Interfaces:**
- Produces:
  ```sql
  CREATE TABLE IF NOT EXISTS channel_slack_v1_channels (
    install_id TEXT NOT NULL, channel_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    connected_by_user_id TEXT NOT NULL, channel_name TEXT NOT NULL,
    remember BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (install_id, channel_id));
  CREATE INDEX IF NOT EXISTS channel_slack_v1_channels_agent ON channel_slack_v1_channels (agent_id);
  ```
  ```ts
  export interface ChannelBinding { installId: string; channelId: string; agentId: string; connectedByUserId: string; channelName: string; remember: boolean; createdAt: Date }
  export interface ChannelStore {
    get(installId: string, channelId: string): Promise<ChannelBinding | null>;
    listForAgent(installId: string, agentId: string): Promise<ChannelBinding[]>;          // oldest first
    listAll(installId: string): Promise<Array<{ channelId: string; agentId: string }>>;
    upsert(b: Pick<ChannelBinding, 'installId'|'channelId'|'agentId'|'connectedByUserId'|'channelName'>): Promise<'connected' | 'reconnected' | 'taken'>;
    remove(installId: string, channelId: string, agentId: string): Promise<boolean>;
    setRemember(installId: string, channelId: string, agentId: string, remember: boolean): Promise<boolean>;
    removeForAgent(agentId: string): Promise<number>;
  }
  export function createChannelStore(db: Kysely<ChannelSlackDatabase>): ChannelStore;
  export function cleanChannelName(raw: string): string;   // label.ts: no control/bidi/invisible chars, no [ ] ( ), single spaces, ≤ CHANNEL_NAME_MAX (80)
  export const AGENTS_DELETED_KEY = '@ax/channel-slack/agents-deleted';
  export function subscribeAgentsDeleted(bus: HookBus, channels: Pick<ChannelStore,'removeForAgent'>, logger: Logger): () => void;
  ```
- `upsert` is ONE statement: `INSERT … ON CONFLICT (install_id, channel_id) DO UPDATE SET connected_by_user_id = EXCLUDED.connected_by_user_id, channel_name = EXCLUDED.channel_name, updated_at = now() WHERE channel_slack_v1_channels.agent_id = EXCLUDED.agent_id RETURNING (xmax = 0) AS inserted` → no row = `taken`; `inserted` = `connected`; else `reconnected` (`remember` kept). It stores `cleanChannelName(channelName)`.
- `InstallStore.remove(installId)` / `removeAll()`: delete the matching bindings in the SAME statement (data-modifying CTEs), so a failed install delete deletes nothing; `removeAll` still returns exactly the installs it deleted. No foreign keys (existing tests TRUNCATE and DROP the installs table).
- The subscriber reads `payload.agentId` (non-empty string, else ignore), calls `removeForAgent`, logs `slack_agent_channels_removed {count}` (info, only when count > 0); a failure logs `slack_agent_cleanup_failed {code}` (warn) and never throws.

- [ ] **Step 1: Write failing tests** — `upsert` table: new → `connected`; same agent → `reconnected` with new `connectedByUserId` and name, `remember` unchanged after `setRemember(false)`; other agent → `taken`, row unchanged; `two agents race one channel`: `Promise.all` of two upserts → exactly one `connected`, one `taken`; `remove`/`setRemember` touch only the given agent's row (other agent → `false`); `listForAgent` oldest first; `removeForAgent` count; `cleanChannelName` table (bidi override, `[x](y)`, 200 chars); install `remove` and `removeAll` delete bindings; `a failing install delete keeps the bindings` (the existing BEFORE DELETE trigger pattern in `plugin.test.ts:350-370`); `agents-deleted.test.ts` fires the real `agents:deleted` on a `HookBus` and counts rows.
- [ ] **Step 2:** run (Docker) → FAIL.
- [ ] **Step 3: Implement.** Update `migrations.ts`'s header (the table list, "no foreign keys", "every query lives in store.ts or channel-store.ts").
- [ ] **Step 4:** run → PASS; `pnpm test:scripts` → the agent-keyed-tables guard passes.
- [ ] **Step 5: Commit** `feat(channel-slack): channel bindings, one agent per channel (TASK-1094)`.

YAGNI: the binding is the card's "one stored record"; the `agents:deleted` cleanup is required by the repo guard and keeps a deleted agent's channel from being stuck. No history table, no audit columns beyond the timestamps.

### Task 4: Connect core + agent-settings routes [tier: sensitive]

Security-checklist: authorization boundary; untrusted Slack data.

**Files:**
- Create: `packages/channel-slack/src/channels.ts`, `src/user-auth.ts`, `src/agent-routes.ts`
- Modify: `packages/channel-slack/src/limits.ts` (`CHANNEL_LIST_MAX_PAGES`)
- Test: `src/__tests__/channels.test.ts`, `src/__tests__/agent-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 client, Task 3 `ChannelStore`, existing `InstallStore.current()`, `SecretStore.get(install,'bot-token')`.
- Produces:
  ```ts
  // channels.ts
  export interface ChannelDeps { bus: HookBus; installs: Pick<InstallStore,'current'>; channels: ChannelStore; secrets: Pick<SecretStore,'get'>; api: SlackApi; logger: Logger }
  /** `agents:resolve` for one user: forbidden → 'no', not-found → 'agent-gone', resolved but not visibility 'team' → 'not-team'. Other errors propagate. */
  export function agentAccess(bus: HookBus, ctx: AgentContext, agentId: string, userId: string): Promise<'yes' | 'no' | 'agent-gone' | 'not-team'>;
  export type Rights = { ok: true; agentId: string; agentName: string } | { ok: false; reason: 'not-found' | 'personal-agent' | 'forbidden' };
  export function checkRights(bus: HookBus, ctx: AgentContext, agentId: string, userId: string, need: 'view' | 'manage'): Promise<Rights>;
  export type ConnectOutcome =
    | { ok: true; binding: ChannelBinding; reconnected: boolean }
    | { ok: false; reason: 'no-workspace' | 'needs-reconnect' | 'channel-taken' | 'not-public' | 'archived' | 'shared' | 'slack-error'; code?: string };
  export function connectChannel(d: ChannelDeps, i: { agentId: string; channelId: string; actorUserId: string }): Promise<ConnectOutcome>;
  export interface AvailableChannel { channelId: string; name: string; connected: 'this-agent' | 'other-agent' | null }
  export function listAvailableChannels(d: ChannelDeps, agentId: string): Promise<{ ok: true; channels: AvailableChannel[]; truncated: boolean } | { ok: false; reason: 'no-workspace' | 'needs-reconnect' | 'slack-error'; code?: string }>;
  // user-auth.ts — the signed-in person (any role), copied in shape from admin-auth.ts
  export function checkUser(bus: HookBus, ctx: AgentContext, req: RouteRequest): Promise<{ ok: true; userId: string } | { ok: false; status: 401 | 500; error: 'unauthenticated' | 'internal' }>;
  // agent-routes.ts
  export type AgentSlackStatus =
    | { state: 'no-workspace' }
    | { state: 'personal-agent'; botName: string }
    | { state: 'ready'; botName: string; workspaceName: string; canManage: boolean;
        channels: Array<{ channelId: string; name: string; remember: boolean; connectedBy: string; needsReconnect: boolean }> };
  export function createAgentSlackRoutes(d: ChannelDeps): RouteSpec[];
  ```
- `checkRights` (built on `agentAccess`): `'no'` or `'agent-gone'` → `not-found` (never tell a non-member the agent exists); `'not-team'` → `personal-agent`; `need === 'manage'` → `agents:can-set-shared-credential({agentId, actor:{userId, isAdmin:false}})`, `allowed !== true` → `forbidden`. Any other error propagates. Comment at the call: "workspace-admin status never connects a channel (TASK-813's rule); a team admin of the agent's team does".
- `connectChannel` order (each step's failure is the named reason; no step after a failure runs): active install (`current()?.status === 'active'`, else `no-workspace`) → bot token (missing → `no-workspace`) → `conversationsInfo` (`missing_scope` → `needs-reconnect`; `channel_not_found` → `not-public`; other → `slack-error` + code) → `!isChannel || isPrivate` → `not-public`; `isArchived` → `archived`; `isExtShared || isPendingExtShared` → `shared` → `conversationsJoin` unless `isMember` (`missing_scope` → `needs-reconnect`; `method_not_supported_for_channel_type` / `channel_not_found` → `not-public`; `is_archived` → `archived`; other → `slack-error`) → `channels.upsert(… channelName: info.name)` (`taken` → `channel-taken`).
- `listAvailableChannels`: at most `CHANNEL_LIST_MAX_PAGES` (5) pages of `CHANNEL_LIST_PAGE_LIMIT` (200); keep `isChannel && !isPrivate && !isArchived && !isExtShared && !isPendingExtShared`; `name` = `cleanChannelName`; sort by name; `connected` from `channels.listAll`; `truncated` when a cursor remained after page 5. `missing_scope` → `needs-reconnect`.
- Routes (JSON; writes cap bodies at `ADMIN_BODY_MAX_BYTES`; `channelId` must match the Slack-id pattern, which `events.ts` and `slack-api.ts` each keep privately today: export ONE `SLACK_ID_RE` from `limits.ts` and use it in all three; unknown body keys → 400):
  - `GET /settings/slack/:agentId` → `checkUser` (401/500) → `checkRights(view)` (`not-found` → 404 `{error:'not-found'}`) → no active install → `{state:'no-workspace'}`; personal → `{state:'personal-agent', botName}`; else `ready` with `canManage` (`can-set-shared-credential`), `connectedBy` = the `auth:get-user` display name, else `"A teammate"`, NEVER the email (team members who aren't admins read this page; admin-routes.ts's `connectedByName` at `:449-462` falls back to the email only because only admins see it). Share the cleaning: move its `label()`/`cleanLabel` read into one helper `personName(bus, ctx, userId, { allowEmail: boolean; fallback: string })` used by both route files (a throw logs `slack_channel_route_failed {stage:'connected-by', code}` here), `needsReconnect` = `agentAccess(agentId, connectedByUserId) !== 'yes'`.
  - `GET …/available` → `checkRights(manage)` (404/403/409 `personal-agent`) → `listAvailableChannels` → 200, or 409 `{error:'no-workspace'|'needs-reconnect'}`, 502 `{error:'slack-error'}`.
  - `POST …/connect {channelId}` → manage → `connectChannel` → 200 `{ channel: {channelId, name, remember, connectedBy, needsReconnect:false}, reconnected }`; 409 `{error:'no-workspace'|'needs-reconnect'|'channel-taken'}`; 422 `{error:'channel-not-allowed', reason:'not-public'|'archived'|'shared'}`; 502 `{error:'slack-error'}`.
  - `POST …/disconnect {channelId}` → manage → `channels.remove` → 200 `{removed: boolean}`.
  - `POST …/remember {channelId, remember: boolean}` → manage → `setRemember` → 200 `{}` or 404 `{error:'not-connected'}`.
  - Logs: `slack_channel_connected {installId, reconnected}`, `slack_channel_disconnected {installId}`, `slack_channel_refused {installId, reason}`, `slack_channel_route_failed {stage, code}`.

- [ ] **Step 1: Write failing tests** (`channels.test.ts` with a fake bus + fake api; `agent-routes.test.ts` through the route handlers): `rights` — signed out 401; non-member 404; team member (role member) → GET `canManage:false`, every write 403; workspace admin outside the team → 404; workspace admin who is a plain member → 403; team admin → 200; personal agent → GET `personal-agent`, connect 409 `personal-agent` and NO Slack call. `channel checks` — private, archived, shared, pending-shared, `channel_not_found` → 422 with the reason and `conversations.join` never called. `old install` — `missing_scope` from info, list or join → 409 `needs-reconnect`. `join` — `already_in_channel` succeeds; an `isMember` channel skips join. `taken` → 409, row unchanged. `reconnect` — a second team admin connecting the same agent's channel → 200 `reconnected:true`, `connectedBy` now theirs. `needsReconnect` — the connector removed from the team → GET shows `needsReconnect:true`. `available` — 5 pages then `truncated:true`; Slack Connect and archived entries dropped; this-agent/other-agent marks. `remember`/`disconnect` only act on this agent's binding. `connectedBy` — a connector with no display name shows `"A teammate"`, never their email. `logs` — no channel id, name or email in any log call.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run → PASS. Mutation-check: `isAdmin: true` passed through; join before the Slack Connect check; `not-found` vs `forbidden` distinguished to a non-member. Each must fail a test.
- [ ] **Step 5: Commit** `feat(channel-slack): connect a channel from agent settings (TASK-1094)`.

YAGNI: five routes, each behind one control in Task 7. `needsReconnect` is the only way a team admin learns the run-as person lost access (Review Focus 1). No pagination UI (5 pages, then a pointer to `/ax`), no lock (the upsert is atomic).

### Task 5: `/ax` — the signed slash-command route [tier: sensitive]

Security-checklist: a new public route; untrusted form input; identity.

**Files:**
- Create: `packages/channel-slack/src/ingress.ts` (steps 0–4 moved out of `events.ts`: body cap, id + `rawPath`, install, signing secret, signature)
- Modify: `packages/channel-slack/src/events.ts` (use `ingress.ts`; behaviour byte-identical)
- Create: `packages/channel-slack/src/commands.ts`
- Modify: `src/copy.ts`, `src/format.ts` (`mrkdwnEscape`), `src/limits.ts`
- Test: `src/__tests__/commands.test.ts`, `src/__tests__/copy.test.ts`; `events.test.ts` must pass UNCHANGED

**Interfaces:**
- Consumes: Task 4 `checkRights`, `connectChannel`, `ChannelDeps`; existing `admitSender`, `isTemporaryLookupFailure`, `findSenderUser`, `decodeSlackEntities`, `Lifetime`.
- Produces:
  ```ts
  export function verifySignedRequest(d: { store: Pick<InstallStore,'get'>; secrets: Pick<SecretStore,'get'>; logger: Logger; now: () => number }, req: RouteRequest, res: RouteResponse, o: { pathPrefix: string; maxBodyBytes: number; logPrefix: 'slack_event' | 'slack_command' }): Promise<InstallRow | null>;  // null = already answered
  export const COMMANDS_ROUTE_PATH = '/slack/commands/:installId';
  export function createCommandsHandler(d: ChannelDeps & { store: Pick<InstallStore,'get'>; lifetime: Lifetime; publicOrigin: string; now: () => number; sleep?: (ms: number) => Promise<void> }): RouteHandler;
  export function mrkdwnEscape(text: string): string;   // & → &amp;, < → &lt;, > → &gt;
  ```
- After `verifySignedRequest`: content type must start with `application/x-www-form-urlencoded` (else 400); parse with `URLSearchParams` over the UTF-8 body; `command`, `team_id`, `api_app_id`, `user_id`, `channel_id` required, ids valid, `text` ≤ `SLASH_TEXT_MAX` (else 400); `ssl_check === '1'` → 200 empty; app/team mismatch, install not `active`, or `command !== SLASH_COMMAND` → 200 empty (logged `slack_command_ignored {installId, reason}`).
- Invoker: `admitSender(api, botToken, user_id, teamId)`. Refused → 200 EMPTY (silence) unless `isTemporaryLookupFailure` → `COPY.slashFailed`. Identity never comes from `text`.
- Subcommand = first word of `decodeSlackEntities(text).trim()`, case-insensitive: `connect` (rest = agent name), `disconnect`, anything else → `COPY.slashUsage`.
- **connect:** `findSenderUser` (null → `COPY.slashNotMapped(publicOrigin)`) → `teams:list-for-user({userId})` (optional hook: absent → `[]`) → `agents:list-for-user({userId, teamIds})` → candidates = `visibility === 'team'` agents whose `normalizeName(displayName) === normalizeName(arg)` (`normalizeName = s.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase()`, surrounding straight quotes dropped; an argument longer than `AGENT_NAME_ARG_MAX` after normalizing matches nothing) → keep those `checkRights(manage)` allows. 0 candidates → `slashNoSuchAgent`; candidates but none manageable → `slashNotManager`; > 1 manageable → `slashAmbiguous`; 1 → `connectChannel({agentId, channelId: channel_id, actorUserId})` → `slashConnected(agentName, channelName)` / `slashReconnected(agentName)` / reason copy.
- **disconnect:** binding for `(installId, channel_id)`; none → `slashNothingConnected`; `checkRights(manage)` on its agent: `not-found` (agent gone) → remove it and say `slashDisconnected`; `forbidden`/`personal-agent` → `slashNotManager`; ok → `channels.remove` → `slashDisconnected`.
- **Reply timing:** run the work under `lifetime.track`; answer `{response_type:'ephemeral', text}` with its result if it settles within `SLASH_REPLY_DEADLINE_MS` (2.5 s); otherwise answer `COPY.slashWorking` and, when the work settles, `api.postEphemeral(botToken, {channel: channel_id, user: user_id, text})` (failure → `slack_reply_failed {stage:'ephemeral', code}`).
- New COPY (mrkdwn, wording via the ux-design pass in Task 16; intent): `slashUsage`, `slashNotMapped(origin)`, `slashNoSuchAgent`, `slashNotManager` ("only a team admin of that agent's team can connect it"), `slashAmbiguous` (connect it from the agent's settings in the web app), `slashConnected(agent, channel)` (MUST say: mention the bot here to talk to it; its instructions and files are visible to everyone in this channel; when someone without access talks to it, it works with your access and approvals wait for you in Today), `slashReconnected(agent)`, `slashDisconnected`, `slashNothingConnected`, `slashChannelTaken`, `slashChannelNotAllowed(reason)`, `slashNeedsReconnect`, `slashWorking`, `slashFailed`. Names go through `mrkdwnEscape` then `neutralizeSlackControls` inside the COPY function. No literal `<` or `>` in a mrkdwn line (mrkdwn reads `<…>` as a link): write "`/ax connect` followed by the agent's name", not `<agent name>`.

- [ ] **Step 1: Write failing tests** — ingress: bad signature 401, stale timestamp 401, unknown/malformed install 404 (same answer as the events route), 17 KiB body 413; `ssl_check` → 200 empty; wrong app/team/pending → 200 empty; `refused invoker` (guest, bot, other workspace) → 200 empty and no `auth:*`/`agents:*` call; `temporary users.info failure` → `slashFailed`; usage for `''`, `help`, `frobnicate`; connect: unmapped → `slashNotMapped`; no match → `slashNoSuchAgent`; personal agent with that name → `slashNoSuchAgent` (never a candidate); member-only → `slashNotManager`; two manageable "Support" agents → `slashAmbiguous`; one → `connectChannel` called with `channel_id` and the mapped user, reply is `slashConnected` with `<b>&` escaped; `text` holding `<@U999>` or an email changes nothing about who connects; disconnect: none / manager / non-manager / agent gone; `copy.test.ts` — `everyLine()` (`:8-13`) calls every new name-taking line with hostile names (`<!channel> & <@U1> @here`) and the existing "no `<!`/`<@`/`<#`" and "no AX" checks still pass, plus an explicit `&lt;!channel&gt; &amp;` expectation; `slow Slack` (fake `sleep` + a join that settles after the deadline) → HTTP body `slashWorking`, then exactly one `chat.postEphemeral` with the result; `events.test.ts` unchanged and green.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** (extract `ingress.ts` first and re-run `events.test.ts` before writing `commands.ts`).
- [ ] **Step 4:** run → PASS. Mutation-check: identity from `user_name`/`text`; refused invoker answered; the deadline branch never posting the late result.
- [ ] **Step 5: Commit** `feat(channel-slack): /ax connect and /ax disconnect (TASK-1094)`.

YAGNI: `connect` is the card's Slack side; `disconnect` is the in-Slack kill switch for a misbehaving channel agent (same rights, a few lines); everything else is the usage line. No `status`, no list, no `response_url`.

### Task 6: Wire PR A — plugin, presets, canary, composition [tier: integration]

**Files:**
- Modify: `packages/channel-slack/src/plugin.ts` (routes, `subscribeAgentsDeleted`, manifest, header comment), `src/__tests__/plugin.test.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (`:1287-1325` pins), `presets/memory/src/__tests__/canary.test.ts`, `presets/k8s/src/__tests__/channel-slack-composition.test.ts`
- Check (change only if it fails): `packages/cli/src/commands/admin/reset-bootstrap.ts` + `packages/cli/src/__tests__/admin-reset-bootstrap.test.ts`
- Modify: `.changeset/channel-slack.md`

**Interfaces:**
- Manifest after this task — `calls`: existing + `'agents:resolve'`, `'agents:can-set-shared-credential'`; `optionalCalls`: existing + `{ hook: 'teams:list-for-user', degradation: '/ax connect finds no team agents, so channels connect from agent settings only' }`; `subscribes`: existing + `'agents:deleted'`. The CLI reset kernel loads agents (both new hard calls satisfied) and not teams (optional).

- [ ] **Step 1: Write failing tests** — `plugin.test.ts`: the six new routes are registered (method + path), the commands route with `bypassCsrf: true` and `maxBodyBytes: 16384`, the settings POSTs without `bypassCsrf`; shutdown unregisters them and the `agents:deleted` subscriber. `preset.test.ts`: exact new `calls`/`optionalCalls`/`subscribes`. Memory canary: a POST to `/slack/commands/<22 A's>` gets the same answer the events route gets there (405 behind static-files; see TASK-1093 review fix H; copy the events assertion at `canary.test.ts:771`). Composition (real agents, teams, conversations, Postgres; fake Slack answering `conversations.info/list/join`, `users.info`, `chat.postEphemeral`): a team (`teams:create({actor, displayName})`, the creator becomes team admin) with a member (`teams:add-member({actor, teamId, userId, role:'member'})`), one team agent (`agents:create` with `visibility:'team', teamId`, following the `personalAgent` helper at `:416-432`), one personal agent; team admin connects `#support` from the settings route → binding row + `conversations.info` then `conversations.join`; the member → 403; personal agent → 409; `/ax connect Support` signed as the team admin → `slashConnected`; as the member → `slashNotManager`; `/ax disconnect` → row gone; `agents:delete` of the team agent → its bindings gone.
- [ ] **Step 2:** run the four files → FAIL.
- [ ] **Step 3: Implement** the wiring; extend `.changeset/channel-slack.md` (connecting a channel, the three scopes and why, "an existing Slack connection must be disconnected and connected again").
- [ ] **Step 4:** run the local gate's `channel-slack` dependents → PASS.
- [ ] **Step 5: Commit** `feat(channel-slack): wire channel connect into both presets (TASK-1094)`.

YAGNI: wiring and pins only (invariant 3). `teams:list-for-user` is optional so the CLI reset kernel needs no new stub.

### Task 7: Agent settings → "Slack" section (channel-web) [tier: integration]

Invoke the `shadcn` skill (installed primitives only, `-c packages/channel-web`) and the `ux-design` skill on every string. Claude-simple: no ids, scopes or install words; a problem appears only when there is one.

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-route.ts` (`AGENT_SETTINGS_SECTIONS` + `'slack'` after `'connectors'`)
- Modify: `packages/channel-web/src/components/workspace/AgentSettings.tsx` (`SETTINGS_SECTIONS` entry, `SectionBody` case)
- Create: `packages/channel-web/src/lib/agent-slack.ts`, `packages/channel-web/src/components/workspace/AgentSlack.tsx`
- Test: `components/workspace/__tests__/AgentSlack.test.tsx`, `lib/__tests__/agent-slack.test.ts`, `lib/__tests__/workspace-route.test.ts`, `components/workspace/__tests__/AgentSettings.test.tsx`
- Modify: `components/admin/SlackTab.tsx` + `components/admin/__tests__/SlackTab.test.tsx`: the Disconnect dialog gains one sentence that every channel's connection to an agent goes too (Task 3 deletes bindings with the install).
- Modify: `.changeset/channel-slack-ui.md`

**Interfaces:**
- Consumes: Task 4's routes and `AgentSlackStatus` (re-declare the wire type in the lib; no import from channel-slack).
- Produces (`lib/agent-slack.ts`, via `httpFetch`, writes send `x-requested-with: ax-admin` like `lib/slack-admin.ts:47-50`): `fetchAgentSlack(agentId): Promise<AgentSlackStatus | { state: 'unavailable' }>` (404 or non-JSON → `unavailable`); `fetchAvailableChannels(agentId)`; `connectSlackChannel(agentId, channelId)`; `disconnectSlackChannel(agentId, channelId)`; `setSlackChannelRemember(agentId, channelId, remember)`; each failing call throws an error carrying the route's `error`/`reason` code.
- `AgentSlack` states: `unavailable` (an older host) → one muted line that Slack isn't available here; `no-workspace` → one plain line for everyone (an admin connects Slack in Admin settings; no button, no threading of `onOpenAdminSettings`); `personal-agent` → one line (personal agents answer in a DM with the bot); `ready` → a list of connected channels (`#name`, "Connected by {name}", a `Switch` "Let the agent remember this channel" that flips only after the server confirms, a `Dialog`-confirmed Disconnect, and when `needsReconnect` a `Badge`/`Alert` "needs reconnecting" with a Reconnect button that calls connect again), then for managers a "Connect a channel" combobox (Command + Popover, the `components/admin/ModelCombobox.tsx` pattern) listing available channels (other-agent ones disabled, "connected to another agent"; a `truncated` note pointing to `/ax connect` in Slack) with a `FieldDescription` stating that everyone in the channel can talk to the agent, its instructions and files are visible to them, and when someone without access talks to it, it works with the connector's access and approvals wait in their Today. Non-managers see the list read-only. `needs-reconnect` from `available`/`connect` → an `Alert` that an admin must reconnect Slack.

- [ ] **Step 1: Write failing tests** — route grammar accepts `/workspace/agents/a1/settings/slack`; the settings nav lists "Slack"; each state renders as above; the visibility note text mentions "instructions and files"; a manager connects (combobox select → POST → row appears); a member sees no switch, no Disconnect, no combobox; the switch is never optimistic: disabled at its old position while the POST is in flight, and a failed POST leaves it there with a sentence that nothing changed (`lib/agent-abilities.ts` pattern); Disconnect asks first; `needsReconnect` row shows Reconnect; 409 `needs-reconnect` shows the admin Alert; `channel-taken` and `channel-not-allowed` show their own sentences; no raw channel id rendered.
- [ ] **Step 2:** `pnpm --filter @ax/channel-web exec vitest run <files>` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run → PASS; `pnpm --filter @ax/channel-web exec tsc --noEmit` (channel-web type-checks its tests).
- [ ] **Step 5: Commit** `feat(channel-web): connect a Slack channel from an agent's settings (TASK-1094)`.

YAGNI: one section, no new primitives, no team/personal badge elsewhere, no Admin › Slack changes, no admin deep link.

### Task 8: PR A docs and stale lines [tier: mechanical]

**Files:** `docs/plans/2026-11-09-channel-slack-design.md`; channel-slack header comments.

- [ ] **Step 1:** §3 "Scopes" (`:179-190`): the phase-1 list is now the nine scopes in Global Constraints, each with its reason; `channels:history` is NOT used (mention-only; a follow-up in a thread needs an @mention); `chat:write.customize` is not used (a streamed reply can't carry a custom name; phase-2 bots carry their own); TASK-1094 adds `channels:read`, `channels:join`, `commands`; an existing install reconnects (Disconnect, Connect).
- [ ] **Step 2:** §3 "Connecting a channel" (`:192-201`): manage rights = a team admin of the agent's team (`agents:can-set-shared-credential`), workspace admins don't count; the bot joins the channel itself; one agent per channel, one agent may serve several; reconnecting takes over as the run-as person; the `/ax` subcommands; refusals (private, archived, Slack Connect); Admin › Slack › Disconnect (and a reset) removes every channel connection with the install, so channels are connected again after Slack is.
- [ ] **Step 3:** `grep -rn "no slash commands\|six bot scopes\|DMs only\|direct messages for now" packages/channel-slack/src` and fix each line that this PR made false (leave `COPY.mentionRefusal` itself to Task 12).
- [ ] **Step 4: Commit** `docs: channel connect in the Slack design (TASK-1094)`. Run the review gate (local gate + ax-code-reviewer on PR A).

YAGNI: only lines this PR made false (rule 5); the next planner reads the design first.

---

## PR B — channel turns

### Task 9: `auth:is-approved-email` [tier: sensitive]

Security-checklist: identity boundary; a new hook.

**Files:**
- Modify: `packages/auth-better/src/types.ts`, `packages/auth-better/src/plugin.ts` (registration + `registers` list)
- Create: `packages/auth-better/src/__tests__/is-approved-email.test.ts`
- Modify: `scripts/__tests__/channel-slack-boundaries.test.js`
- Modify: `.changeset/sign-up-gate.md` or a new `.changeset/auth-approved-email.md` (`'@ax/auth-better': minor`)

**Interfaces:**
- Consumes: the coordinator's approved-domains helper (the ONE function `findUserByEmail` uses to read approved domains), `isPlainAscii`, `isDomainAllowed`.
- Produces: `auth:is-approved-email`, `IsApprovedEmailInput { email: string }`, `IsApprovedEmailOutput { approved: boolean }`, `IsApprovedEmailOutputSchema = z.object({ approved: z.boolean() }).strict()`. Contract (in `types.ts`, plus the boundary review above): `approved` iff the email is 1–320 chars (else `invalid-payload` with fixed text, value never echoed), printable ASCII, exactly one `@` with a non-empty local part and domain, and its domain is approved. Reads no user row. No log line. Callers pass only an address they fetched from the identity provider (users.info), never message text.

- [ ] **Step 0: Precondition.** `git log --oneline -5` and `grep -n` in `packages/auth-better/src/plugin.ts` for the approved-domains helper `findUserByEmail` now calls (it reads every non-blank Google or GitHub list). If the coordinator's merge isn't on this branch, STOP and report back; do not write a second list read.
- [ ] **Step 1: Write failing tests** (Postgres, like `find-user-by-email.test.ts`): no providers / blank lists → a well-formed ASCII address approved; Google list only; GitHub list only; both (union); a disabled row's list still counts; `A@CanopyWorks.COM` approved for `canopyworks.com`; subdomain `a@eng.canopyworks.com` refused; `alİce@canopyworks.com` and a Kelvin-sign domain (`canopywor` + `String.fromCharCode(0x212a)` + `s.com`) refused; no `@`, two `@`, empty local part, empty domain refused; non-string / `''` / 321 chars → `invalid-payload` whose message never contains the input; registration spy (`find-user-by-email.test.ts:464-483` pattern) proves the strict schema (an extra key → `invalid-return`); `reads no users`: approved with an empty users table.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Guard: rule 1's hook literal becomes a set `{ 'auth:find-user-by-email', 'auth:is-approved-email' }` with the same allowlist; update its header, describe title, failure message, positive control, `CASES` (one row per name, inside and outside the allowlist) and the case count.
- [ ] **Step 4:** run auth-better + `pnpm test:scripts` → PASS; prove the guard bites: add a `bus.call('auth:is-approved-email', …)` to `packages/agents/src/plugin.ts`, watch the guard fail naming file:line, `git checkout HEAD -- packages/agents/src/plugin.ts`.
- [ ] **Step 5: Commit** `feat(auth-better): auth:is-approved-email for members without an account (TASK-1094)`.

YAGNI: tier C (members with no account) can't be admitted without it, and channel-slack may not hold the list. No caching, no log lines, no route.

### Task 10: One turn runner for DMs and channels, and the held-approval line [tier: sensitive]

Security-checklist: untrusted model output to Slack; the turn's identity context.

**Files:**
- Rename: `git mv packages/channel-slack/src/dm-turn.ts packages/channel-slack/src/turn.ts`
- Modify: `src/turn.ts`, `src/router.ts` (imports, DM call site), `src/reply-stream.ts`, `src/copy.ts`
- Test: `src/__tests__/turn.test.ts` (new), `src/__tests__/reply-stream.test.ts`, `src/__tests__/router.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TurnMode = 'dm' | 'attended' | 'external';
  export function turnContextFields(mode: TurnMode): { source: 'user' | 'external'; audience: 'private' | 'shared' };
  export interface TurnDeps { /* = old DmTurnDeps, unchanged */ }
  export interface TurnRequest {
    mode: TurnMode;
    /** The whole sender label, built by the caller (`dmSenderLabel` / `channelSenderLabel`). Replaces `senderName`. */
    label: string;
    install: InstallRow; botToken: string; channel: string;
    messageTs: string; threadTs: string;
    senderSlackId: string;   // the stream's recipient
    userId: string; agentId: string; conversationId: string; text: string;
  }
  export function runTurn(d: TurnDeps, r: TurnRequest): Promise<void>;   // old runDmTurn
  export function pickPersonalAgent(...): string | null;                 // unchanged, still exported here
  // reply-stream.ts
  ReplyStreamDeps.todayLink: string;            // host-built `${publicOrigin}/workspace`
  ReplyStream.held(who: 'owner' | 'sender'): void;
  ```
- `turnContextFields`: dm → `{source:'user', audience:'private'}`; attended → `{source:'user', audience:'shared'}`; external → `{source:'external', audience:'shared'}`. Content = `${r.label}: ${decodeSlackEntities(r.text)}`; the caller builds the label (DM: `dmSenderLabel`).
- `onChunk`: a `tool-result` with `held === true` → `stream.held(r.mode === 'external' ? 'owner' : 'sender')` (still no artifact link for it). `finish` closing lines, in order: artifact link, the held line (once, however many holds), the failure/busy line; a held line counts as something to say (no `emptyReply`). COPY: `heldForOwner` (external: the agent needs its owner's OK, it has asked them, nothing happens until they approve), `heldForSender(todayLink)` (Markdown link to Today: approve it there; nothing happens until you do). Neither names a tool, a connector or the owner.

- [ ] **Step 1: Write failing tests** — `turnContextFields` table; DM turn unchanged otherwise (existing router tests green after the rename); `DM held` → reply ends `COPY.heldForSender(<origin>/workspace)`; `external held` → `COPY.heldForOwner`; `attended held` → `heldForSender`; two holds → one line; artifact + held → both, artifact first; held with no text → the held line alone, no `emptyReply`; held then `turn-error` → held line then `turnFailed`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** (rename first, run the suite green, then add the behaviour).
- [ ] **Step 4:** run → PASS. Mutation-check: held dropped (old behaviour); owner/sender swapped; line repeated per hold.
- [ ] **Step 5: Commit** `feat(channel-slack): a held call ends the reply with a line saying who must approve (TASK-1094)`.

YAGNI: one runner instead of a fork (the brief's rule); the held line is the card's acceptance item. The DM variant is the same branch plus one COPY key. No buttons (TASK-1095), no Today deep link to the specific decision.

### Task 11: Neutralize bare `@here`, `@channel`, `@everyone` [tier: sensitive]

Security-checklist: untrusted model output reaching a whole channel.

**Files:** Modify `packages/channel-slack/src/format.ts`, `src/reply-stream.ts`. Test `src/__tests__/format.test.ts`, `src/__tests__/reply-stream.test.ts`.

**Interfaces:**
- `neutralizeSlackControls(text)` additionally puts a zero-width space right after the `@` of `@here`, `@channel`, `@everyone` (case-insensitive) when the `@` is at the start or follows a non-word character and the word ends at a non-word character or the end. `a@channel.com` and `x@here.org` are untouched (preceded by a word character). Use one regex with lookarounds, never a padded `includes(' @channel ')` (punctuation evades it: `.claude/memory/mistakes.md:290`).
- `reply-stream.ts`: while the reply is unfinished, unsent text ending in `@` + a proper prefix of one of the three words (preceded as above) is held back until more text arrives or `finish` (the same holdback idea as the trailing high surrogate), so a split across deltas or flushes can't assemble a live word.

- [ ] **Step 1: Write failing tests** — table: `@channel`, `@Here!`, `(@everyone)`, `hi @channel.`, `@channels` (untouched: word continues), `me@channel.com` (untouched); every split point of `ping @channel now` across two `text()` calls with a flush between → the bytes Slack receives never contain `@channel` without the ZWSP; `cleanStatusTitle('@here')` neutralized; COPY lines contain none of the three bare words (copy.test.ts).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement (build the ZWSP with the existing constant, never a literal). **Step 4:** run → PASS; mutation-check the holdback and the left-boundary rule.
- [ ] **Step 5: Commit** `fix(channel-slack): replies can't broadcast with a bare @channel/@here/@everyone (TASK-1094)`.

YAGNI: only the three broadcast words (a bare `@name` pings one person at most and is not converted without `link_names`). Load-bearing because a channel is the first place a model reply reaches a room.

### Task 12: Channel turns — the router's mention branch [tier: sensitive]

Security-checklist: untrusted channel input into an agent with its owner's connectors; identity decisions.

**Files:**
- Modify: `packages/channel-slack/src/admission.ts` (`Mention` gains `ts` and `text`; `threadTs?` keeps its meaning, the event's `thread_ts`, present only inside a thread, because an ephemeral sent with a `thread_ts` that has no thread yet is never shown; the reply's thread root is `threadTs ?? ts`; `answerMention(api, botToken, teamId, mention, text)` takes its line)
- Create: `packages/channel-slack/src/channel-route.ts`
- Modify: `src/router.ts`, `src/format.ts` (`channelSenderLabel`), `src/copy.ts`, `src/limits.ts`, `src/plugin.ts` (second queue, calls, shutdown drops), header comments in `plugin.ts`/`router.ts`/`admission.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (calls), `presets/memory/src/__tests__/canary.test.ts` (`authStub` registers `auth:is-approved-email` → `{approved:false}`), `presets/k8s/src/__tests__/channel-slack-composition.test.ts` (stub registers it with a domain table)
- Test: `src/__tests__/admission.test.ts`, `src/__tests__/channel-route.test.ts` (new: `decideTier` table), `src/__tests__/router.test.ts` (extend the `world()` fixture at `:219` with a channel store, bindings and the external queue; channel cases in their own `describe`)

**Interfaces:**
- Consumes: Task 3 store, Task 4 `agentAccess`, Task 9 hook, Task 10 `runTurn`.
- Produces:
  ```ts
  export type SenderTier =
    | { tier: 'attended'; userId: string }
    | { tier: 'external'; userId: string /* the connector */ }
    | { tier: 'refused'; reason: 'off-domain' }
    | { tier: 'unavailable'; reason: 'connector-no-access' | 'agent-gone' | 'not-team-agent' };
  export function decideTier(i: {
    sender: { mappedUserId: string | null; access: 'yes' | 'no' | 'agent-gone' | 'not-team' | null; approved: boolean | null };
    connector: { userId: string; access: 'yes' | 'no' | 'agent-gone' | 'not-team' };
  }): SenderTier;   // pure
  export function channelSenderLabel(channel: string, senderName: string, slackUserId: string): string;  // `[Slack · #<channel> · <who>]`; the caller passes `binding.channelName || channelId`; `<who>` as dmSenderLabel builds it
  // RouterDeps gains: channels: ChannelStore; externalQueue: KeyedQueue; (agentAccess comes from channels.ts, Task 4)
  ```
- Router mention branch: `screenEvent` → bot token → binding `channels.get(installId, channel)`; none → `answerMention(…, COPY.channelNotConnected)` (admitted senders only; refusal silent). Bound → `admitSender`, per event and uncached as for DMs (refused → silence, logged `slack_sender_refused`; temporary → private `turnFailed`) → empty text → ignore → `findSenderUser` → mapped: `agentAccess(agentId, mapped)`; unmapped: `auth:is-approved-email({email})` → approved → `agentAccess(agentId, binding.connectedByUserId)` when the tier needs it → `decideTier`. A thrown hook call → private `turnFailed`, `slack_event_failed {stage}`. `refused` → silence + `slack_sender_refused {reason:'off-domain'}`; `unavailable` → private `COPY.channelUnavailable` + `slack_channel_unavailable {installId, reason}`.
- Attended: `find-or-create({userId: sender, agentId, externalKey: slack:<installId>:<channel>:<threadTs>, fallback:{origin:'slack'}})`, queue lane = conversation (existing queue). External: `find-or-create({userId: connector, …, externalKey: …:<threadTs>:external})`, lane `<installId>:<channel>` on a second `createKeyedQueue({maxPerKey: MAX_EXTERNAL_TURNS_PER_CHANNEL})` (full → private `COPY.channelBusy`; closed → private `turnFailed`). At job start re-read the install (active) AND the binding (same agent) → else drop with `slack_turns_dropped {reason:'disconnected'}`.
- `runTurn` with `mode` `attended`/`external`, `label = channelSenderLabel(binding.channelName || '#'+channel …)`, `messageTs = mention.ts` (👀 on the mention), `threadTs`, recipient = the sender's Slack id. Pre-turn lines in a channel are ephemeral to the sender (with `threadTs` when threaded); in-turn lines go in the thread.
- New COPY: `channelNotConnected` (replaces `mentionRefusal`: no agent here yet; a team admin can connect one with `/ax connect <agent name>`; DM the bot to reach your own agent), `channelUnavailable`, `channelBusy`.
- Manifest: `calls` + `'auth:is-approved-email'`; `plugin.ts` shutdown closes both queues and logs `slack_turns_dropped` per install for each.

- [ ] **Step 1: Write failing tests** — `decideTier` table covering tiers A–E (including mapped-without-access → external; connector `no`/`agent-gone`/`not-team` → unavailable for B and C but NOT for A; a sender whose own lookup says `agent-gone` or `not-team` → unavailable, never attended); router (fake bus + fake api): `tier A` → one invoke, ctx `{userId: sender, source:'user', audience:'shared'}`, key without suffix, content starts `[Slack · #support · Alice (U1)]: `; `tier B` and `tier C` → ctx `{userId: connector, source:'external', audience:'shared'}`, key ends `:external`; `tier D off-domain` → no invoke, no post; `tier D guest` → no `auth:*` call; `tier E` → `postEphemeral` `channelUnavailable`, no invoke, and a tier-A sender in the same channel still gets a turn; `mixed thread` → a member's turn and an outsider's turn in one thread use two conversations, and the member's invoke content never contains the outsider's text; `unbound channel` → `channelNotConnected` to an admitted sender only; `lanes` → 6 outsider mentions in one channel while the first runs → 5 queued, the 6th gets `channelBusy`; attended turns in other threads aren't blocked by the outsider lane; `disconnect while queued` → dropped; `Slack Connect envelope` → silence; DM routing unchanged; 👀 on the mention's own `ts`; logs carry no ids, names or text.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run → PASS; boot the memory canary and the composition test (stubs added). Mutation-check: external turn keyed without `:external`; external ctx with the sender's userId; unmapped sender admitted without the domain check; connector access unchecked.
- [ ] **Step 5: Commit** `feat(channel-slack): a mention in a connected channel becomes an attended or external turn (TASK-1094)`.

YAGNI: the per-channel outsider lane is the one bound on untrusted callers spending one person's identity (decisions shard); everything else is the card's turn-mode rule. No thread history fetch, no follow-ups without a mention, no per-agent bot name.

### Task 13: `memory_note` honours `memory:pre-capture` [tier: sensitive]

Security-checklist: memory persistence boundary; behaviour change for routines' task check-ins.

**Files:** Modify `packages/memory/src/note-tool.ts`. Test `packages/memory/src/__tests__/note-tool.test.ts`. Changeset `'@ax/memory': patch`.

**Interfaces:**
- After input validation and the shared-turn person check, before `resolveMemoryAccess`: when `ctx.conversationId` is a non-empty string, `bus.fire(MEMORY_PRE_CAPTURE_HOOK, ctx, { conversationId }, { subscriberTimeoutMs: MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS })`; rejected → log `CAPTURE_REFUSED_EVENT` (`memory_capture_refused`) with `{agentId, refusedBy, reason, tool:'memory_note'}` (not a `PassTrigger` value; that union stays as is) and throw `NoteInputError(NOT_SAVED_HERE_MESSAGE, 'forbidden')` with a fixed model-readable sentence (nothing saved; memory is turned off for this conversation) that names no subscriber.

- [ ] **Step 1: Write failing tests** — a subscriber that rejects → the tool answers forbidden with `NOT_SAVED_HERE_MESSAGE`, `memory:facts:record` never called; no subscriber → saved as today; no `conversationId` → no fire; a subscriber that throws → saved (the bus skips it; same fail-open as `observe`).
- [ ] **Step 2:** FAIL. **Step 3:** implement; update the TASK-908 comment block where `observe()` explains the veto ("notes too, since TASK-1094"). **Step 4:** PASS (`pnpm --filter ...@ax/memory run test` incl. routines).
- [ ] **Step 5: Commit** `feat(memory): memory_note asks memory:pre-capture before it saves (TASK-1094)`.

YAGNI: without it the "remember" switch is a false promise (the agent's own notes would still save). No new hook, no payload change.

### Task 14: The memory switch — thread map, taint, capture veto [tier: sensitive]

Security-checklist: memory capture boundary; fail-closed subscriber.

**Files:**
- Modify: `packages/channel-slack/src/migrations.ts`, `src/channel-store.ts`, `src/agents-deleted.ts` (NOT `store.ts`: an install's removal deletes its bindings but KEEPS its thread rows, so a thread tainted while the switch was off stays refused after Slack is disconnected; deleting them would turn the veto's answer into "no opinion" and let a later pass capture what was said while off. Thread rows go with `agents:deleted`.) (also threads), `src/router.ts` (taint write in the job), `src/plugin.ts` (subscribe, manifest `subscribes` + `'memory:pre-capture'`)
- Create: `packages/channel-slack/src/capture-veto.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (subscribes)
- Test: `src/__tests__/capture-veto.test.ts`, `src/__tests__/channel-store.test.ts`, `src/__tests__/router.test.ts`, `src/__tests__/agents-deleted.test.ts`

**Interfaces:**
- Table:
  ```sql
  CREATE TABLE IF NOT EXISTS channel_slack_v1_threads (
    conversation_id TEXT PRIMARY KEY, install_id TEXT NOT NULL, channel_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    not_remembered BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS channel_slack_v1_threads_agent ON channel_slack_v1_threads (agent_id);
  ```
- `ChannelStore` += `recordThread(t: { conversationId; installId; channelId; agentId; notRemembered: boolean }): Promise<void>` (upsert; `not_remembered = threads.not_remembered OR EXCLUDED.not_remembered`, sticky) and `getThread(conversationId): Promise<{ installId; channelId; agentId; notRemembered } | null>`; `removeForAgent` also deletes threads.
- `capture-veto.ts`: `CAPTURE_VETO_KEY = '@ax/channel-slack/capture-veto'`, `CAPTURE_CHECK_DEADLINE_MS = MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS / 2`, `channelCaptureVeto(channels, ctx, payload, deadlineMs?) → Promise<Rejection | undefined>`, shaped like `routines/src/capture.ts` `taskCaptureVeto` (copied, not imported): ids = `ctx.conversationId` and the parsed payload id; for each known thread row, refuse (`reject({ reason: 'channel-not-remembered' })`) when `notRemembered`, or the binding is missing, bound to another agent, or `remember === false`; unknown ids → no opinion; a throw or the deadline → refuse and log `slack_capture_check_failed {code}`.
- Router job (after the install + binding re-read, BEFORE `runTurn`): `recordThread({…, notRemembered: !binding.remember})`; a failure → no turn, private `turnFailed`, `slack_event_failed {stage:'thread'}`. DMs record nothing.

- [ ] **Step 1: Write failing tests** — veto table: unknown → undefined; tainted → reject; switch off → reject; binding gone → reject; rebound to another agent → reject; on and clean → undefined; lookup throws → reject; slow lookup → reject at the deadline (fake timers); payload id differs from ctx id → both checked. Store: taint is sticky (`false` after `true` stays `true`). Router: switch off → thread recorded tainted before `agent:invoke` (call order); switch on → clean row; `recordThread` failure → no invoke; DM → no row. Cleanup: `agents:deleted` deletes the agent's threads; install `remove`/`removeAll` keep them (`a tainted thread stays refused after Slack is disconnected`: taint, remove the install, the veto still rejects); agent-keyed guard passes.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + `pnpm test:scripts`.
- [ ] **Step 5: Commit** `feat(channel-slack): "remember this channel" switch through memory:pre-capture (TASK-1094)`.

YAGNI: the thread map exists only because the veto's payload is a bare conversation id; the sticky taint is what makes "off" mean off after it is turned back on. No per-message granularity, no "forget this channel" action.

### Task 15: End to end — tiers, held approval → note + Today, the switch [tier: integration]

**Files:** `presets/k8s/src/__tests__/channel-slack-composition.test.ts` (extend; it is already on both guard allowlists — a new sibling file would need its own allowlist entries and a reason), `presets/memory/src/__tests__/canary.test.ts` (boots with every new hook), CLI reset test (still boots).

- [ ] **Step 1: Write failing tests** through the real events route (signed `app_mention` envelopes) with the real agents, teams, conversations, decisions, tool-policy and Postgres:
  - `tiers`: A (team member) → invoke ctx `{userId: member, source:'user', audience:'shared'}`; B (AX user outside the team) and C (unmapped, approved domain) → `{userId: connector, source:'external'}`, and the conversation row (query `conversations_v1_conversations`) is owned by the connector with an `external_key` ending `:external`, while A's row is owned by the member with no suffix; D (unmapped, `evil.example`) → no invoke, no Slack post; E (`teams:remove-member` the connector; the team needs a second admin first, because teams refuses to remove its last admin, `teams/src/plugin.ts:254-279`) → `chat.postEphemeral` `channelUnavailable`, no invoke, while A still runs.
  - `held approval → note and Today`: for one external turn the stub `agent:invoke` fires `tool:pre-call` on the bus with the turn's ctx and a ToolCall the preset's real `tool-policy:evaluate` answers `hold` for (use `request_capability`, rule `skills.request-capability` at `packages/tool-policy/src/rules.ts:141-152`, the canary's own hold, since skill-broker is always in the k8s preset; assert the fire came back as a Hold), then emits `chat:stream-chunk {kind:'tool-result', held:true, toolCallId, output}` and `chat:turn-end`. Assert the thread's stream carried `COPY.heldForOwner`, and `decisions:list({userId: connector})` returns a pending row for that agent and the external conversation. Repeat for an attended turn → `COPY.heldForSender(…)` and the row is in the MEMBER's list.
  - `memory switch`: after an external turn, `bus.fire('memory:pre-capture', ctx, {conversationId})` is not rejected; switch off via the settings route → rejected (`channel-not-remembered`); a turn while off, switch back on → that conversation still rejected; a new thread's conversation → not rejected.
- [ ] **Step 2:** FAIL until all of PR B is in; **Step 3:** fix only wiring gaps (none expected); **Step 4:** run the full local gate → PASS. Prove non-vacuity: break one wiring at a time (the router treating every unmapped sender as approved; the external key losing `:external`; the veto not subscribed) and watch a case fail for each.
- [ ] **Step 5: Commit** `test(preset-k8s): Slack channel turns end to end (TASK-1094)`.

YAGNI: these are the card's four acceptance tests through the real plugins (invariant 3); nothing else is added here.

### Task 16: PR B docs, copy and stale lines [tier: mechanical]

**Files:** `docs/plans/2026-11-09-channel-slack-design.md`; `packages/channel-slack/src/copy.ts` (wording only); `.changeset/channel-slack.md`, `.changeset/channel-slack-ui.md`.

- [ ] **Step 1: The line that made this card's conversation model look settled** — §5.3 (`:255-258`): "One Slack thread is one conversation, owned by the agent's owner" → one conversation per AX identity per thread: an attended sender's own, and one owned by the person who connected the channel for external turns (key suffix `:external`); why (single-owner conversations; outsiders' text never enters a member's attended transcript; `(source, audience)` constant per conversation).
- [ ] **Step 2:** §2: the channel label `[Slack · #support · Alice (U123)]`, the tier table, mention-only. §2a (`:112-114`): "learned in #support" is NOT done by TASK-1094 (memory never sees channel names; a later card); the switch works through `memory:pre-capture` and also stops `memory_note`; turning it back on doesn't capture a thread that had a turn while it was off. §5.6 (`:299-305`): the attended "approve it in Today" line until TASK-1095. §6 (`:376-381`): replace "Open for TASK-1094" with `auth:is-approved-email` and its boundary review; "No other new hooks" names it. §1.2 (`:24-29`) and §6 (`:357-363`): if the coordinator's merge didn't already, the approved domains are the union of the Google and GitHub lists.
- [ ] **Step 3:** run the `ux-design` skill over every new COPY line (Tasks 5, 10, 12) and the settings section strings; keep each line's tested intent; re-run `copy.test.ts`.
- [ ] **Step 4:** changesets: channel turns, the `/ax` command, the switch, `'@ax/auth-better': minor`, `'@ax/memory': patch`, `'@ax/channel-web': minor`.
- [ ] **Step 5: Commit** `docs: channel turns in the Slack design (TASK-1094)`. Run the review gate (local gate + ax-code-reviewer on the whole branch), then write the PR security notes from the security-checklist walks and the residuals in the decisions shard.

YAGNI: stale lines and copy only; no new design sections.

---

## Security-checklist walks required

Tasks 2, 3, 4, 5, 9, 10, 11, 12, 13, 14. Paste each walk into the decisions shard as you finish the task (TASK-1093 pattern) and into the PR's `## Security review`. Residuals to state, not discover (decisions shard, "Residuals" row): split thread context; approvals keyed by agent + call; shared memory from outsiders recalled in later shared turns; forged sender lines; the connector's usage budget; stale channel names; unmeasured markdown broadcast; permission cards not shown in Slack; one outsider lane per channel; outsiders can fill the connector's Today with distinct held requests (bounded by the lane and the usage budget); an external reply's artifact link points at a page outsiders can't open.

## Not in this card

Thread follow-ups without a mention; private channels and group DMs; "learned in #support"; a Slack label for held calls in Today; announcing a connection in the channel; leaving a channel on disconnect; refreshing names on rename; per-agent bot names; a usage-limit reply; `response_url`. Approval buttons are TASK-1095, the rename TASK-1096, the walk TASK-1097 (it must check whether Slack's markdown broadcasts a bare `@channel`, and that Revoke on Slack's page kills the stored refresh token).

**Unmeasured, high impact, check on real Slack before the stack merges:** `chat.startStream` in a channel requires `recipient_user_id` ("the user to receive the streaming text"), and the docs don't say whether the rest of the thread sees the streamed message. TASK-1090 marked channel streaming "Docs", not "Tested". If only the recipient sees it, channel turns must reply in posting mode (`reply-stream.ts` already has one; forcing it per turn is a small change). Don't build that switch speculatively; flag the result in the PR.
