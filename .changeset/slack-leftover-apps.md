---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

When Disconnect, or cancelling a Slack connection that didn't finish, can't delete the Slack app we made, we now remember that app instead of forgetting it. That usually happens because the configuration token we hold has stopped working, for example after it was revoked on Slack's page. Admin > Slack keeps naming the app, with a link straight to its settings page, until we know it's gone. The next Connect deletes it if Slack lets it (we haven't yet checked on real Slack that a new token can always delete an app an older one made). If you delete it yourself, click **I deleted it** and the note goes away.
