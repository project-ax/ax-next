---
'@ax/channel-slack': patch
---

Renaming the Slack bot now works more than once. Every time we use the configuration token, Slack hands us a fresh one and retires the old one a few minutes later. We used to keep the old one, so the second rename, and Disconnect after a rename, found it dead. Now we keep the fresh one each time. If we ever can't save it, we stop and ask you to try again in a minute, while the old one still works.
