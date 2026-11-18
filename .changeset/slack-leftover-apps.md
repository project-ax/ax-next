---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

When Disconnect, or cancelling a Slack connection that didn't finish, can't delete the Slack app we made, we now remember that app instead of forgetting it. That usually happens because the configuration token we hold has stopped working, for example after it was revoked on Slack's page. Admin > Slack names the app, with a link straight to its settings page, and the next Connect tries to delete it with the token you paste. We haven't yet checked on real Slack that a new token can always delete an app an older one made, so if the note is still there after you connect, deleting it by hand is the sure fix.
