---
'@ax/channel-slack': minor
'@ax/conversations': minor
'@ax/credentials': minor
'@ax/preset-k8s': patch
---

Add `@ax/channel-slack`, so people can talk to their own AX agent from Slack. A Slack admin connects the workspace once from AX's admin settings by pasting a Slack configuration token; AX creates the Slack app itself, with only the permissions direct messages need. After that, anyone with an AX account can DM the bot and reach their own personal agent, and the reply streams into the Slack thread. The bot's name defaults to a Slack-safe form of your branding name, and AX checks a name against Slack's rules before asking Slack for it. AX talks to Slack with its own small client, not Slack's SDK: one address (`slack.com`), no redirects followed, a size cap and a time limit on every answer, and no token ever written to a log or an error.

`credentials:get` can now be asked for the workspace-wide value only (`scope: 'global'`). The Slack install's secrets are read that way, so a key someone stored for themselves under the same name can never stand in for the install's own.

Conversations can now come from Slack (origin `'slack'`). A Slack DM thread shows up in the web app but stays read-only there, so the conversation never forks: where the message box would be, it says "This conversation is in Slack. Reply there." Until Slack can show approval buttons, a tool call that needs your OK from a Slack DM waits in Today, the same as a routine's.

A team admin can now connect a public Slack channel to a team agent, from the agent's settings or by typing `/ax connect` followed by the agent's name in the channel. `/ax disconnect` undoes it. Only a team admin of the agent's team can do either; being a workspace admin does not count, and a personal agent can't be connected at all. AX checks the channel first (public, not archived, not shared with another workspace) and only then has the bot join it. A person who can't see an agent is told nothing about it, and deleting an agent frees its channels. This step only records the connection and joins the bot: nothing answers in the channel yet.

The Slack app asks for three more permissions, each for one job. `channels:read` lets AX look up a channel and list the public ones to pick from. `channels:join` lets the bot join the channel you pick, so nobody has to invite it. `commands` adds the `/ax` slash command, which Slack sends to AX at a signed address of its own (`/slack/commands/<install>`); AX checks the signature and who is asking before it does anything.

An existing Slack connection has none of these, so it must be disconnected and connected again from AX's admin settings before channels can be connected.
