---
'@ax/channel-slack': patch
---

Slack replies no longer open with lines like "Loading the routine creation tool schema." That was the agent quietly fetching a tool's instructions before using it: housekeeping, not news. The web app already kept it out of sight, and now Slack does too. What the agent is actually doing still shows on the reply's status line.
