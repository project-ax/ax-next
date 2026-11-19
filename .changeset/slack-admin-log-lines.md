---
'@ax/channel-slack': patch
---

The Slack host log now says when things went right, not just when they went wrong. A Disconnect logs `slack_disconnected` with whether Slack deleted the app (`appDeleted`), a finished connection logs `slack_connected`, and each leftover app a new Connect deletes logs `slack_leftover_app_deleted`. Like every Slack log line, they carry ids and outcomes, never tokens.
