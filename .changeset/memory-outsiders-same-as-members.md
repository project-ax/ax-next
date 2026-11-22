---
'@ax/memory': minor
'@ax/core': patch
'@ax/memory-facts-contract': patch
---

Outsiders recall a team agent's memory like members do. We tried keeping two classes of reader, and it was more rules than anyone could hold in their head, so we stopped. Now, on a team agent, anyone who talks to it can be told what it remembers, and its sessions keep the `/memory` view.

What changes:

- **An outsider's turn recalls what a member's turn does.** Someone in a Slack channel the agent is in, or an AX user who isn't on the team, gets the team's memory back, including what members said in private web chats. We removed this boundary on purpose, and the notices that tell people ("shared with anyone who talks to [the agent]") are what replace it.
- **Every session on a team agent keeps its `/memory` view**, outsiders' included. Personal agents don't: a personal agent's shared turn still recalls only what was learned in shared places, and its outsiders' sessions still get no view.
- **A new kind of turn still fails closed.** Add a new place turns can come from, and memory won't compile until someone decides who may read it. Until then a team agent would show it shared memory only and no view. One honest gap: a session saved by a newer build, with a source this build doesn't recognize, reads as an outsider's (that happens before memory ever sees it), so on a team agent it reads everything. That only happens while two versions share one database, and it's exactly what an outsider reads now anyway.
- **Teammates read by name.** In the memory view, the `memory_recall` tool, recall receipts and the memory block the agent sees, a teammate's memories read by their display name instead of a raw id. We only look up a name for someone we've confirmed is a current member of the agent's team. Anyone else reads "a teammate", and so does a name we can't find or one that reads like "you" or the agent. Display names only: no emails, no admin flags.
- **The "Shared" badge is back** on what a member said about themself. Those rows carry the stamp of where they were learned again, with no special case.

What didn't change: an outsider's words are still never remembered, an outsider's turn still files no fact about them, Slack Connect channels are still refused, and personal agents behave exactly as before (and make no name lookups).

Not done yet (follow-ups, and we'd rather list them than have you find them):

- **The `/memory` export still shows raw ids.** Its headings and lines still say `user:<id>` for a teammate, and on a team agent that file is now visible in outsiders' sessions too. No name, no email, but an internal id we'd rather not hand out.
- **A member named like the agent isn't refused.** We refuse names that read as "you" or as the word "agent", but not one that matches the agent's own name (a member who calls themself "Fern" on Fern's team reads as "Fern").
- **A stalled name lookup has no deadline of its own.** If the team or account lookup hangs, recall waits on it, until whatever limit the turn itself has.

The plain version: anyone who talks to a team agent can now hear back what its members told it. We think that's what people expect from a shared agent, and we'd rather say it out loud than pretend otherwise. This ships alongside the notice copy, never before it.

`@ax/core` and `@ax/memory-facts-contract` only get doc comments (the `audience` contract and the stamp a statement carries).
