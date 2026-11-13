---
'@ax/channel-slack': minor
'@ax/conversations': minor
'@ax/credentials': minor
'@ax/preset-k8s': patch
---

Add `@ax/channel-slack`, so people can talk to their own AX agent from Slack. A Slack admin connects the workspace once from AX's admin settings by pasting a Slack configuration token; AX creates the Slack app itself, with only the permissions direct messages need. After that, anyone with an AX account can DM the bot and reach their own personal agent, and the reply streams into the Slack thread. The bot's name defaults to a Slack-safe form of your branding name, and AX checks a name against Slack's rules before asking Slack for it. AX talks to Slack with its own small client, not Slack's SDK: one address (`slack.com`), no redirects followed, a size cap and a time limit on every answer, and no token ever written to a log or an error.

`credentials:get` can now be asked for the workspace-wide value only (`scope: 'global'`). The Slack install's secrets are read that way, so a key someone stored for themselves under the same name can never stand in for the install's own.

Conversations can now come from Slack (origin `'slack'`). A Slack DM thread shows up in the web app but stays read-only there, so the conversation never forks. Until Slack can show approval buttons, a tool call that needs your OK from a Slack DM waits in Today, the same as a routine's.
