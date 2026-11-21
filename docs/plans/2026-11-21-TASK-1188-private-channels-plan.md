# TASK-1188 — Slack private channels: answer, never remember (design §4b.3)

Decisions: `.claude/memory/decisions/2026-11-21-TASK-1188.md`.

1. **Manifest** [mechanical] — add `groups:read` to `DEDICATED_BOT_SCOPES`; manifest test: the bot asks for it, the shared app still bans it.
2. **Channel rule** [sensitive] — `connectable()` allows private (`is_channel` still required). `channel-check.ts`: `allowed` carries `isPrivate` (kept in the cache); refusal codes `not-a-channel | archived | shared`. Tests: private is allowed with `isPrivate: true`; archived / Slack Connect / `is_channel` false still refused.
3. **Store + migration** [sensitive] — `is_private BOOLEAN NOT NULL DEFAULT false` on `channel_slack_v1_channels`; `ChannelBinding.isPrivate`; `bindBot`/`upsert` take it; `setPrivate(installId, channelId, agentId, isPrivate)`; `markNotRemembered(conversationId)`; `recordThread` takes `isPrivate` and ORs it and `b.is_private` into `not_remembered`. The memory fake mirrors it.
4. **Capture veto** [sensitive] — refuse `channel-not-remembered` when the binding is private now.
5. **Router** [sensitive] — bind writes `isPrivate`; at turn start an allowed answer updates the binding when it changed, and recordThread gets `isPrivate`; the private branch runs the turn, archived / Slack Connect still refused.
6. **Allow continuation** [sensitive] — answers.ts step 8 runs the channel check; plugin.ts shares one `ChannelCheck`.
7. **Settings** [integration] — `AgentSlackBotChannel.isPrivate`; the channel-web row shows "Private channels aren't remembered" instead of the switch.
8. **Design doc** [mechanical] — §2a/§3 "public only" lines, §4b.3 as-built, known gaps (1-minute cache window; captured-while-public stays; legacy private groups).
