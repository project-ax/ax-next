---
'@ax/channel-slack': patch
---

In Slack, the agent now knows who's asking and what they can do. Someone who can't use the agent is no longer told to "approve the card". There's no card for them, so the agent says it needs its owner's OK instead. And a teammate's plain request no longer gets called a prompt injection just because it arrived through Slack. Text people paste or quote is still treated as data, which is exactly how we like it.
