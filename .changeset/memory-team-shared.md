---
'@ax/memory': minor
'@ax/core': patch
'@ax/memory-facts-contract': patch
---

A team agent's memory is now the team's. When a member talks to it, in a web chat or in a Slack channel, it remembers what they say about themselves under their own name in AX, and it brings that up for any member, anywhere the agent works. A member's channel turn also recalls everything the team agent knows and keeps its `/memory` view. (Who else can read it changed again in a later release: see the TASK-1209 entry, "Outsiders recall a team agent's memory like members".)

We removed a privacy boundary here, on purpose. Before, a team agent's shared turns could only recall what was learned in shared places. Now a member's question in a channel can surface something a member said in a private web chat. The notices that tell the room replace the old filter.

People outside AX are not members, and their words still aren't remembered. They are never treated as the requester. (What they can read back is covered by the TASK-1209 entry.) Personal agents are unchanged, except that an outsider's turn now reads shared-only even when it carries no audience stamp (a fail-closed fix).

`@ax/core` and `@ax/memory-facts-contract` only get doc comments (the `audience` and `memory:pre-capture` contracts, and the stamp a statement carries, now say this).
