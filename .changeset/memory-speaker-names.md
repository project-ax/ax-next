---
'@ax/core': minor
'@ax/memory': patch
'@ax/channel-slack': patch
---

In a Slack channel, nothing is saved under the speaker's name anymore, by any path. Before this, our background note-taker read the sender label ("vinay (UHTE83XE1)") and filed "Team standup moved to 10:15" under `vinay`, as a shared fact. Now the note-taker, the agent's own `memory_note` and the write door all ask one rule. Facts about the work are still kept, and so is who owns what: `team_standup | owner | vinay` stays.

How it works: channel-slack tells memory each member's label names (their display name and Slack ID) when memory asks whether it may learn from a conversation. `memory:pre-capture`'s answer gains an optional `speakerNames` list, up to 32 names. A subscriber adds to it and never removes. Memory only compares words with the names, and it reads no subject longer than 1024 characters (the stores refuse those anyway). Outsiders' names are never stored, since memory never learns from their threads.

The limits, plainly. We only know the names the label shows, so a nickname or an initial (`vp`) gets through. So does someone named only in passing ("Ada is out next week"): telling a person from a thing would need us to change the extraction prompt, and we haven't. A work subject that happens to be made of a display name's words gets dropped. If memory can't read channel-slack's answer, it learns nothing from that turn. And channel-slack keeps each member's label names on the thread's row until the agent is deleted: we don't clear them when a channel is disconnected or a conversation is deleted. And this only stops new rows: anything already saved under a member's name before this change stays until someone deletes it.
