---
'@ax/channel-slack': patch
---

In Slack, the agent is now told who's asking and what they can do. When someone who can't use the agent asks for something that needs approval, the agent is told there's no card for them and to say it needs its owner's OK instead of "approve the card". And it's told that a teammate's words in Slack are their own request, not a suspicious message it stumbled on, so a plain ask shouldn't get called a prompt injection. Text people paste or quote is still treated as data, which is exactly how we like it.
