---
'@ax/memory': minor
'@ax/core': patch
---

A team agent's memory is now the team's. When a member talks to it, in a web chat or in a Slack channel, it remembers what they say about themselves under their own name in AX, and it brings that up anywhere the agent works. A member's channel turn also recalls everything the team agent knows and keeps its `/memory` view.

We removed a privacy boundary here, on purpose. Before, a team agent's shared turns could only recall what was learned in shared places. Now a member's question in a channel can surface something a member said in a private web chat. The notices that tell the room replace the old filter.

People outside AX are not members, so nothing changes for them. Their words still aren't remembered, their turns keep shared-only recall, they get no `/memory` view, and they are never treated as the requester. Personal agents are unchanged.

`@ax/core` only gets doc comments (the `audience` and `memory:pre-capture` contracts now say this).
