# TASK-1202: drop the per-channel remember switch (design §4c, card A)

**Goal.** Nothing can switch a channel to "not remembered" any more. The switch goes end to end: the ⋯ item and its copy in channel-web, the `POST …/bot/remember` route, `channel_slack_v1_memory_switches`, `channel_slack_v1_channels.remember`, the bind-time carry-over (TASK-1180, `bindBot`), the switch lock (TASK-1182), and the switch's share of the `channel-not-remembered` capture refusal.

**What stays (card B, TASK-1203, removes it later).** The private-channel half: `is_private`, `channel_slack_v1_threads.not_remembered` (now set only by a private channel), `markNotRemembered`, the `channel-not-remembered` refusal for a private or disconnected channel, "Private channels aren't remembered." in settings, and the TASK-1191 turn note (`TurnRequest.remembered`), which still fires for private channels and outsiders' threads. Kept also: bindings, the private-wins channel check (TASK-1184/1188), `groups:read`, everything about outsiders.

## Tasks

### 1. channel-slack: store, migration, router, veto, routes `[tier: sensitive]`

- `channel-store.ts`: drop `ChannelBinding.remember`, `upsert`'s `remember`, `setRemember`, `keptRemember`, `bindBot`, `lockSwitch`, `SWITCHES`, the switch delete in `removeForAgent`. `recordThread` taints on `b.is_private OR privateTurn` only. Rewrite the doc comments so they describe no switch.
- `router.ts` `bindBotChannel`: call `d.channels.upsert(wrote)` (a bot's binding no longer needs a lock: nothing it reads can race). Comments.
- `migrations.ts`: `channel_slack_v1_channels` CREATE loses `remember`; the memory-switches CREATE and both backfills go; append (before the shared-binding delete or after — order irrelevant) `ALTER TABLE channel_slack_v1_channels DROP COLUMN IF EXISTS remember` and `DROP TABLE IF EXISTS channel_slack_v1_memory_switches`. Drop `ChannelSlackMemorySwitchesTable` and the DB key. The header's "additive-only" line now names the two drops. Safe: host deploys are `Recreate` (one replica, no old replica writing `remember` beside a new one); prod has no real users (Vinay, 2026-11-21).
- Thread rows whose `not_remembered` an old switch set stay set (sticky, fail closed). Card B owns the column.
- `capture-veto.ts`: drop `binding.remember !== true`; comments describe private/disconnected only.
- `agent-routes.ts`: drop the `/bot/remember` route, `rememberBotChannel`, `readSwitchBody` (and `readBody` if then unused), `setRemember` from deps, `remember` from `AgentSlackBotChannel`; header doc.
- `plugin.ts`, `channel-check.ts`, `agents-deleted.ts`, `answers.ts`, `turn.ts`, `turn-note.ts` comments that name the switch.
- Tests: `memory-channel-store.ts` fake; `channel-store.test.ts` (delete the TASK-1180/1182/bindBot describes; TRUNCATE list; recordThread switch cases); `agent-routes.test.ts` (route gone → 404); `capture-veto.test.ts`; `router.test.ts`; `plugin.test.ts`; `agents-deleted.test.ts`; `channel-check.test.ts`; `store.test.ts`.
- **New migration test**: build the old schema (channels with `remember`, some false; `channel_slack_v1_memory_switches` with rows), run `runMigrations` twice; the table and column are gone, every binding survives with its other fields, thread rows untouched.
- **Absence test**: the agent route answers 404 for `POST …/bot/remember`; `botChannels` rows carry no `remember` key (`'remember' in row === false`).

### 2. channel-web: the ⋯ item and copy `[tier: integration]`

- `lib/agent-slack.ts`: drop `setSlackBotChannelRemember`, `BotChannelRow.remember` (parser stops requiring it), copy `rememberFailed`, `notRemembered`, `dontRemember`, `rememberAgain`; header route list.
- `AgentSlackBotChannels.tsx`: no ⋯ on a channel row (it held only the switch), no "Not remembered" badge, no pending/error state for it. Private row keeps "Private channels aren't remembered." (card B).
- `AgentSlackMenu.tsx` doc comment.
- Tests: `AgentSlack.test.tsx`, `AgentSlackBot.test.tsx`, `agent-slack.test.ts`, `slack-card-words.test.ts` (add the switch words to the forbidden list rather than just deleting them).

### 3. Docs, changeset, memory `[tier: mechanical]`

- Design §4b.3 and §4c "What goes": as-built note (TASK-1202).
- `.changeset/` for `@ax/channel-slack` + `@ax/channel-web`.
- Decisions shard.
