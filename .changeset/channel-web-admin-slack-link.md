---
'@ax/channel-web': patch
---

Add a link that opens Admin › Slack: `/?admin=slack`. It's where the Approve button in a Slack DM about a bot request goes. For an admin it opens that tab with no toast. For anyone else it does nothing, and the link is tidied out of the address bar either way.
