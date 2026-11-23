---
'@ax/agents': minor
'@ax/channel-web': patch
---

Choosing an agent's tools is now a list you tick, not a box you type into. In Settings › Agents, tools come grouped — Files and commands, Routines, Memory, Web, Sharing what it makes — and ticking a group's name picks everything in it. You can only pick tools this deployment really has, so a word like "routines" can't sneak in and quietly match nothing (which, yes, is how we found this).

If an agent's saved list has a name we don't have, the form says so and offers to remove it. The list comes from a new read, `GET /admin/agents/tools`, open to anyone signed in, like the model list.
