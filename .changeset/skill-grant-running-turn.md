---
'@ax/chat-orchestrator': patch
---

Allowing a skill while the agent is still replying no longer cuts the reply off. Before, the Allow ended the conversation's sandbox on the spot, so a reply that was halfway through was lost. Now the reply finishes, and the next message starts with the skill. That holds when the reply's sandbox was still starting up too. A message sent while that reply is still running gets the skill as well, though it replaces the reply. If nothing is running, the sandbox restarts right away, as before.
