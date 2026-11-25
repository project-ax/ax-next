---
'@ax/memory': minor
'@ax/channel-slack': minor
'@ax/channel-web': patch
'@ax/agents': patch
'@ax/chat-orchestrator': patch
---

A shared personal agent now follows the team-agent rules (phase 1C).

- Memory is shared with everyone who can use the agent. Names show only for owners, listed people and people who spoke to it. Anyone else reads "a teammate".
- A shared agent gets its own Slack bot, and its owners manage it. It never answers DMs.
- Outsiders' approvals go to the owner who set the bot up.
- A sharee's "Always for this agent" website choice is kept.
- Only owners change who a personal agent is, even through chat.
- Slack wording no longer names a team.

Not done yet: co-owners of a Just-me agent still can't chat with it. Going back to
Just me leaves the bot inert instead of removing it. Card B's client wording still
says "team" in places.
