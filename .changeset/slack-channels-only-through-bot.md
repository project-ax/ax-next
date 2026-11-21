---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

Team agents now reach Slack channels only through their own bot. The shared bot is for DMs: if someone mentions it in a channel, it sends them one private line saying so and how to bring in a team agent (invite that agent's own bot).

The `/ax` command is gone, and so is the channel picker in agent settings. The shared app now asks Slack for three fewer permissions (`channels:read`, `channels:join` and `commands`). An existing connection sheds them with Disconnect, then Connect, in Admin › Slack. Channel connections made through the shared app are deleted at the first boot, and the "remember this channel" settings are kept.
