---
'@ax/memory': patch
---

`memory_note` now asks `memory:pre-capture` before it saves anything, the same question every extraction pass already asks. So when a plugin keeps a conversation out of memory, the agent's own notes stay out too. Before this, an agent could write down exactly what memory had been told not to learn, which made "don't remember this" more of a suggestion than a rule.

A refused note saves nothing and reads nothing, and the agent hears one plain sentence: memory is turned off for this conversation. It never says which plugin refused or why; that goes to the log. The rules are the ones extraction already follows. A subscriber that throws, or takes longer than 10 seconds, is skipped and the note is saved. If the question can't be asked at all, nothing is saved.

One knock-on effect, on purpose: memory already didn't learn from a task check-in's conversation, and now the agent can't write notes there either. Same reason (an instruction slipped into a ticket shouldn't outlive the ticket), same conversation, and it closes the side door.
