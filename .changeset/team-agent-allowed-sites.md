---
'@ax/host-grants': minor
'@ax/chat-orchestrator': minor
'@ax/credential-proxy': minor
'@ax/channel-web': minor
'@ax/channel-slack': patch
---

On a team agent, one website Allow now covers the whole team. The site belongs to the agent, so every member's later sessions, an outsider's turn in a connected channel, and the agent's routine runs can all reach it. On a personal agent nothing changes.

We did this on purpose, and it widens what a team agent can reach, so here are the facts without jokes. Sites are exact hostnames, private addresses stay blocked, and a site never gets the agent's credentials. There's a limit of 256 sites per agent, and when the list is full, Slack and the web say so instead of claiming it was kept. Owners and team admins can remove a site any time.

**Sites already allowed on a team agent become shared at deploy.** Until now each one was kept for the person who clicked. After this release the whole team's sessions get it. Everyone on the team can see the list in the agent's settings > Connectors. Owners and team admins can remove sites there.

Settings > Sites now shows personal agents only. Team agents are managed in their own settings.

Smaller fixes:

- The web app's "Always" now sticks after a conversation went quiet, and says when it couldn't keep the site.
- A site allowed while the agent wasn't running reaches its next reply, with the usual "now allowed" note.
