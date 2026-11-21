---
'@ax/channel-slack': patch
---

If someone turned a channel's "remember this channel" switch off at the same moment the agent's own Slack bot first answered there, the bot could go on remembering that channel. The switch and the bot's first answer now take turns, so the channel always ends up with the team's last choice.
