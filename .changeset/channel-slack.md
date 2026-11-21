---
'@ax/channel-slack': minor
'@ax/conversations': minor
'@ax/credentials': minor
'@ax/preset-k8s': patch
---

Add `@ax/channel-slack`, so people can talk to their own AX agent from Slack. A Slack admin connects the workspace once from AX's admin settings by pasting a Slack configuration token; AX creates the Slack app itself, with only the permissions it needs. After that, anyone with an AX account can DM the bot and reach their own personal agent, and the reply streams into the Slack thread. The bot's name defaults to a Slack-safe form of your branding name, and AX checks a name against Slack's rules before asking Slack for it. AX talks to Slack with its own small client, not Slack's SDK: one address (`slack.com`), no redirects followed, a size cap and a time limit on every answer, and no token ever written to a log or an error.

`credentials:get` can now be asked for the workspace-wide value only (`scope: 'global'`). The Slack install's secrets are read that way, so a key someone stored for themselves under the same name can never stand in for the install's own.

Conversations can now come from Slack (origin `'slack'`). A Slack DM thread shows up in the web app but stays read-only there, so the conversation never forks: where the message box would be, it says "This conversation is in Slack. Reply there." A tool call that needs your OK from a Slack DM shows Allow and Deny buttons in the thread; the call is still in Today too.

A team agent answers in a channel through its own bot (see that note). Mentioning that bot there talks to its agent. Someone who can use the agent is answered as themselves. Any other member of your Slack workspace is answered as the team admin who set up the agent's bot, with the limits every outsider's turn has, if they have an AX account or their email is on one of your approved sign-in domains; anything that needs approval then waits in that person's Today, and the reply says so. Guests, bots and people from other workspaces or other domains get no answer at all. Each thread keeps one conversation per person the agent works as, so an outsider's words never end up in a member's conversation. If the team admin who set up the bot is no longer a team admin of the agent's team, outsiders are told privately to check the agent's settings (another team admin can take the bot over there), while members keep going.

Mention-only, on purpose: the bot answers a message that mentions it and nothing else, so a follow-up in the same thread needs a new mention. A bare `@bot` with nothing else runs no turn. A reply can't broadcast: a bare `@channel`, `@here` or `@everyone` in the agent's text gets a zero-width space after the `@`, and so does the `&` of an HTML character reference that could spell one (`&#64;channel`, `&commat;here`, `<&excl;channel>`), even when the word is split across chunks. Plain text such as `R&D`, `&amp;` and a link's `&page=2` is left as written.

Each channel a team bot answers in has a memory setting, for what people who can use the agent say there: "Don't remember this channel" (or "Remember this channel") in that channel's ⋯ menu in the agent's Slack settings. What anyone else says is never remembered, whatever the setting: it would otherwise come back as fact in the agent's later turns, members' private chats included. The setting works through `memory:pre-capture`, so it also stops the agent's own `memory_note`. Once a thread has had a turn while the channel was not remembered, it stays unremembered, even if remembering is turned back on or Slack is disconnected. It stops learning, not recall: the agent still recalls what it learned elsewhere.

When a call needs approval, an outsider's turn says the agent is waiting for its owner and the call waits in the Today of the team admin who set up the bot. A member's turn, or a DM, shows Allow and Deny buttons in the thread, and the asker can also approve it in Today (see the approval buttons note).
