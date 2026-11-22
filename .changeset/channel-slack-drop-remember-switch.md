---
'@ax/channel-slack': minor
'@ax/channel-web': minor
---

The "Don't remember this channel" switch is gone. A team agent's memory is shared with its team (design §4c), and the switch promised a secrecy the agent couldn't keep: a fact memory refused could still end up in a file, a task or a post somewhere else. So we stopped promising it.

What went: the ⋯ menu on each Slack channel row in the agent's settings (the switch was its only item), the "Not remembered" label, the route behind it, the table that kept each channel's switch and the `remember` column on the channel bindings. Both are dropped at boot. A thread that had a turn while its channel was switched off stays out of memory for good. Every other thread in that channel is open to memory again. That includes new threads, and older threads whose turns were all said while the switch was on, even if memory hadn't read them yet when the switch went off. Nothing said while the switch was off is ever learned.

If you have the app open in a browser tab during the deploy, reload it. Until you do, that tab can't show the Slack section for an agent whose bot is in a channel.

Rolling back past this change needs the column back first: `ALTER TABLE channel_slack_v1_channels ADD COLUMN IF NOT EXISTS remember BOOLEAN NOT NULL DEFAULT true`. Without it, an image that has the TASK-1180 boot fill won't start at all, and an older image starts but every Slack channel turn fails.

What stays, for now: private channels still aren't remembered, and the agent is still told so in its turn. A follow-up changes that. Words from people outside AX are never remembered, as before.
