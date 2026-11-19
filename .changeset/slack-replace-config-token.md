---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

Admins can now replace Slack's configuration token from Admin > Slack: click **Replace** next to who added it, and paste a refresh token from someone who can manage the Slack app. Before we switch over, we check with Slack that the new token can manage the app. A token that can't is turned away, and the old one keeps working. Connected channels, conversations and the bot carry on as they were, so a token that stopped working (or whose owner is leaving) no longer means disconnecting and connecting again. Also: the note about Slack apps we couldn't delete now says we couldn't *confirm* they were deleted, since sometimes they're already gone. And the note after Disconnect now says the Revoke step belongs to whoever generated the token.
