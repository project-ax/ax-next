---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

Admins can now rename the Slack bot from Admin > Slack: click **Rename** next to its name. We check the name against Slack's rules first, then tell Slack, and people see the new name straight away. Nothing needs reinstalling, and connected channels keep working. (The bot's @handle stays the one it got when Slack was first connected; Slack shows the new name in mentions anyway.) If we can't use the configuration token we have for the Slack app, or the Slack app was deleted, the tab says so and what to do about it.
