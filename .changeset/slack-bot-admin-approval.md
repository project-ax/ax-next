---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

A team admin who can't install Slack apps can now ask an AX admin for their agent's own Slack bot. The request shows up in Admin > Slack. An AX admin approves it with their own Slack configuration token (or the one we already keep for them, so most of the time there's nothing to paste) and clicks Allow in Slack, then lands back in Admin > Slack. They become the bot's approver, and people outside the team are still answered with the requester's access. Decline, or the team's own Cancel, takes a request back, and deleting the agent deletes it.
