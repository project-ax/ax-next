---
'@ax/channel-slack': minor
'@ax/channel-web': patch
---

Allowing a website from Slack now sticks. We add it to the agent's allowed sites, so its later conversations can reach it too, not just the one that asked. On a personal agent you'll find the list in Settings › Sites, and you can remove a site any time. The prompt says so before you click ("Once allowed, it stays allowed."), and the reply says "Allowed from now on."

On a team agent, we keep it for everyone who uses the agent, and its owners and team admins remove it in the agent's settings.

The web app got a small nudge too: it now tells you when a site is allowed, or that nothing changed because the conversation had already moved on.
