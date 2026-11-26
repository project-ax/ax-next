---
'@ax/core': minor
'@ax/channel-slack': minor
'@ax/channel-web': patch
---

Slack now says why a turn failed, in the same words as the web app: "A dev service failed to start." with which one and why underneath, "The agent timed out.", a usage limit, and so on, instead of "Something went wrong" for everything. Where the web app would point at a button or Settings, Slack links the page instead. The detail line can't ping anyone or sneak in a link, and someone outside the agent's team only hears the reasons that are true for them.
