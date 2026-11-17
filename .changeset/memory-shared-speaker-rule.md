---
'@ax/memory': patch
---

In a shared conversation (a Slack channel, say), the agent's own notes and our background note-taker now share one rule about people, and a test keeps them in step. Both keep facts about the work. Neither keeps a note about "the person I'm talking to". One gap we know about: the note-taker can still file a work fact under the speaker's name, because channel messages carry it.

When a note gets turned down for being about a person, the agent now hears what to do instead: save it with the work as the subject. So "standup moved to 10:15" gets remembered, instead of the agent telling the channel it couldn't save it.

Memory also stops keeping the agent's commentary on itself, like "I couldn't save that" or "saved it to memory", and failures of its own tools. Those describe one conversation's hiccups, and they're stale the moment they're written. A failure to find, locate, confirm or recommend something is kept: it's the answer to what someone asked.
