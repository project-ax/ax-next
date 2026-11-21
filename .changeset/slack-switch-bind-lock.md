---
'@ax/channel-slack': patch
---

If someone picked "Don't remember this channel" (in a channel's ⋯ menu in the agent's Slack settings) at the same moment the agent's own Slack bot first answered there, the bot could go on remembering that channel. That choice and the bot's first answer now take turns, so the channel always ends up with the team's last choice.
