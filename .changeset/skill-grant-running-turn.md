---
'@ax/chat-orchestrator': patch
---

Allowing a skill while the agent is still replying no longer cuts the reply off. Before, the Allow ended the conversation's sandbox on the spot, so a reply that was halfway through was lost. Now the reply finishes, and the next message starts with the skill. That holds when the reply's sandbox was still starting up too, including for a message sent while that reply is running. If nothing is running, the sandbox restarts right away, as before.

Two things we haven't fixed yet. In Slack, a reply the agent writes after you approve one of its requests can still be cut off by a skill Allow, because AX can't tell yet that this kind of reply is running. And in the web app, Connect still sends your last message again straight away, which replaces a reply that was still running.
