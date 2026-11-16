---
'@ax/channel-slack': patch
---

Renaming the Slack bot now works more than once. Every time we use the configuration token, Slack hands us a fresh one and retires the old one some time later (minutes to hours, as far as we can tell). We used to keep the old one, so the second rename, and Disconnect after a rename, found it dead. Now we keep the fresh one each time. If we ever can't save it, we stop and ask you to try again. Sooner is better: the old one may still work for a little while.
