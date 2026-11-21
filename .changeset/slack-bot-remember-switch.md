---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

Each channel a team agent's own Slack bot answers in has its own "remember this channel" switch in the agent's settings, and only a team admin of the agent's team can flip it. When the team switched memory off for a channel, it stays off when the bot first answers there, even after a Disconnect in between. One exception: a channel switched off and disconnected before this release, with no conversation there while it was off, left no record, so the bot starts with memory on there. Check those channels' switches in the agent's settings.
