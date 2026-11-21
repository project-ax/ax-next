---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

A team agent can now have its own Slack bot. A team admin picks its name and clicks Allow in Slack. If we already hold their Slack configuration token they paste nothing; otherwise they paste one once. People then mention the bot by name in any public channel it's invited to. Deleting the agent deletes its bot. Disconnecting the shared bot leaves team bots alone, and no longer tells you to revoke a token they still use.
