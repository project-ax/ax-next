---
'@ax/channel-slack': patch
---

When a team agent's own Slack bot first answers in a channel, it keeps the "remember this channel" setting the team chose for that agent on the shared bot. Before, a channel the team had told us not to remember got remembered again.
