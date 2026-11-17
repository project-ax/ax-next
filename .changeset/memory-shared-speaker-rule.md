---
'@ax/memory': patch
---

In a shared conversation (a Slack channel, say), the agent's own notes and our background note-taker already followed the same rule about people; now they call one function for it, and a test keeps them in step. Both keep facts about the work. Neither keeps a note about "the person I'm talking to". One gap we know about: the note-taker can still file a fact under the speaker's name, because channel messages carry it, and the rule only catches "the person I'm talking to".

When a note gets turned down for being about a person, the agent now hears what to do instead: save it with the work as the subject. So "standup moved to 10:15" can be remembered, instead of the agent telling the channel it couldn't save it. (That depends on the model taking the hint; we'll check on the next walk.)

Memory also stops keeping the agent's commentary on itself, like "I couldn't save that" or "saved it to memory", and failures of its own tools. Those describe one conversation's hiccups, and they're stale the moment they're written. Any other failure, like not finding a flight or not being able to book a table, is kept: it's the answer to what someone asked.
