---
'@ax/memory': patch
---

In a shared conversation (a Slack channel, say), the agent's own notes and our background note-taker already followed the same rule about people; now they call one function for it, and a test keeps them in step. Both keep facts about the work. Neither keeps a note about "the person I'm talking to". One gap we know about: the rule only catches "the person I'm talking to", so a fact filed under the speaker's name still gets through. The note-taker does that on its own, because channel messages carry the name; the agent is now told not to.

When a note gets turned down for being about a person, the agent now hears what to do instead: save it with the work as the subject. So "standup moved to 10:15" can be remembered, instead of the agent telling the channel it couldn't save it. (That depends on the model taking the hint; we'll check on the next walk.)

Memory also stops keeping the agent's commentary on its own memory ("couldn't save that to memory", "saved it to memory") and on common tool failures ("couldn't connect to the calendar", "couldn't fetch the page"). Those describe one conversation's hiccups, and they're stale the moment they're written. Failures that answer what someone asked, like not finding a flight or not being able to book a table, are kept. The filter is a list of patterns, so some hiccups still slip through; we'd rather keep a junk note than lose a real answer.
