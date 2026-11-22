---
'@ax/channel-slack': minor
'@ax/channel-web': minor
---

The "Don't remember this channel" switch is gone. A team agent's memory is shared with its team (design §4c), and the switch promised a secrecy the agent couldn't keep: a fact memory refused could still end up in a file, a task or a post somewhere else. So we stopped promising it.

What went: the ⋯ menu on each Slack channel row in the agent's settings (the switch was its only item), the "Not remembered" label, the route behind it, the table that kept each channel's switch and the `remember` column on the channel bindings. Both are dropped at boot. A channel turned off before this keeps the threads it already marked as not remembered; new turns there are remembered like anywhere else.

What stays, for now: private channels still aren't remembered, and the agent is still told so in its turn. A follow-up changes that. Words from people outside AX are never remembered, as before.
