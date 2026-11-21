---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

Team Slack bots can now be looked after when people move on. The person who set a bot up can replace their Slack token from the agent's settings or from Admin › Slack, and we check the new token with Slack before we keep it, because pasting the wrong one into a vault is nobody's idea of fun. Only that person may do it; everyone else is refused before any secret is read. A bot whose setter has left says it needs rebuilding, and Rebuild starts it again under your own token. A team admin can also claim a bot whose requester is no longer an admin, which moves who its outsiders run as and nothing else. Cancel now names the exact request it is cancelling, so a stale tab can't take back a newer one.
