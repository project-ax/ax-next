---
'@ax/channel-slack': patch
---

In Slack, the agent is now told who's asking and what they can do. When someone who can't use the agent asks for something that needs approval, the agent is told there's no card for them and to say it needs its owner's OK instead of "approve the card". And it's told that the words after a person's Slack label are that person's own request, not a suspicious message it stumbled on, so a plain ask shouldn't get called a prompt injection. It's also told to keep treating pasted or quoted text as data, which is exactly how we like it.
