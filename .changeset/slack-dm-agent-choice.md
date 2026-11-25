---
'@ax/channel-slack': minor
'@ax/channel-web': minor
---

A personal agent's Slack settings now say which of your personal agents answers your Slack DMs. "Use {agent} instead" moves them. We apply it to new messages: anything already in progress finishes with the old agent, and a reply in an older thread goes to the new agent, which doesn't see what another agent was told there. If the chosen agent is deleted, your DMs go back to your oldest personal agent, so nothing gets stuck talking to a ghost.
