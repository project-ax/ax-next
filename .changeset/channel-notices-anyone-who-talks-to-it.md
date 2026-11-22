---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

The "this agent's memory is shared" notices now say who can hear it back: anyone who talks to the agent. They used to say "everyone on {team}", and that stopped being true once outsiders could read a team agent's memory the way members do. So we changed the words, and since no team is named any more, we stopped looking the team up for them.

What reads differently: the bot's first post in a channel ("Heads up: what I hear in this channel is shared with anyone who talks to me, and I may bring it up elsewhere."), its Slack profile, the agent's Slack card in settings, the line under a team agent's chat box, and the note above its memory view.

What goes with it: the status the Slack card reads no longer carries `agentTeamName`, and an agent's memory read no longer carries `teamName`. Nothing showed either one any more.
