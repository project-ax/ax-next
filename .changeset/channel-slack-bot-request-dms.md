---
'@ax/channel-slack': minor
---

When a team admin asks an AX admin for their agent's own Slack bot, the shared bot now DMs the admins who can answer. Approve is a link to Admin › Slack, so no token ever passes through Slack. Decline is a button, and it only works for someone who is an AX admin right now while the request is still open. Each DM is redrawn to show who approved or declined it, and the person who asked hears from the shared bot when the bot goes live or is declined (only when someone else answered). The DMs name nobody in the notification, and the names inside them reach Slack as plain text.

We kept the bounds tight. At most 20 admins are DMed per ask, and one person can start 3 rounds of DMs every 10 minutes. Nothing here can fail an ask, an approval or a decline, and the request always still waits in Admin › Slack. If Slack refuses a DM, nobody is told and we log a code. There are no new scopes, routes or tables. After a restart, old DMs aren't redrawn, and a click on one says it was already handled.
