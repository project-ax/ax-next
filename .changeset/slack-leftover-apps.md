---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

Trying Slack again no longer leaves an extra Slack app behind. When Disconnect, or cancelling a connection that didn't finish, can't delete the Slack app we made (usually because the configuration token we hold has stopped working, for example after it was revoked on Slack's page), we now remember that app instead of forgetting it. Admin > Slack names it, with a link straight to its settings page, and the next Connect deletes it with the token you paste.
