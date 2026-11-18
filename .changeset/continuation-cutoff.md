---
'@ax/chat-orchestrator': patch
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

A reply the agent is still writing no longer gets cut off by an approval that lands in the middle of it.

- In the web app, clicking Connect while the agent is still answering now lets that answer finish first. Then your message goes again, with the new connection in place. If the agent is still busy a minute later, we leave it be and tell you to send it a message once it's done.
- In Slack, the reply the agent writes after you Allow one of its requests is now tracked like any other reply. Allowing a skill while it runs lets it finish (your next message gets the skill), and the 15-minute limit can actually stop it now.
- A sandbox that's been quiet for five minutes is no longer shut down while the agent is still working on something you approved. That work gets up to 15 more minutes: we can't always tell it apart from a leftover, so we don't wait forever.
- Deleting a connector still takes its key away right away, even from work like that. Same reason: we'd rather that work's next calls fail than keep a key you deleted. A normal reply that's mid-answer keeps it until it's done, as before.
- If AX can't read the conversation for a moment while you allow a skill, your next message still gets it.
