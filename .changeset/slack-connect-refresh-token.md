---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

Connecting Slack now checks the refresh token you paste. Right after we create the Slack app, we use that token once and keep the fresh one Slack hands back. If Slack won't take it, we delete the app we just made and ask you for a new token pair, instead of finishing a connection whose first rename or disconnect would fail. If Slack won't let us delete that app either, Admin > Slack names it until the next Connect deletes it. One side effect: the refresh token you pasted stops working a while after you connect, because Slack retires a token once it's been used. If you need one somewhere else, generate another pair.
