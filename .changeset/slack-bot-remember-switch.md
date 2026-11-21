---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

Each channel a team agent's own Slack bot answers in now has its own "remember this channel" switch in the agent's settings, just like the shared bot's channels, and only a team admin of the agent's team can flip it. When the team switched memory off for a channel, it stays off when the agent's own bot first answers there, even if the shared connection was disconnected in between, unless the channel was connected again since. One exception: a channel switched off and disconnected before this release, with no conversation there while it was off, left no record, so the bot starts with memory on there. Check those channels' switches in the agent's settings.
