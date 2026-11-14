---
'@ax/channel-web': minor
---

Admins can now connect Slack from Admin > Slack. Paste the two configuration tokens Slack gives you, pick the bot's name, and click Allow in Slack. The tab shows whose token is in use and when it was added. Disconnect then tells you the one step only you can do: revoking that token on Slack's own page. The pasted tokens are never shown again, not even to you.

A conversation that takes no new messages here (a Slack DM thread, a routine's run) no longer claims it "may have been deleted" when someone tries to send into it. The send route now answers `409 conversation-read-only` for it (it used to be a 404 `conversation-not-found`), and the page says the conversation can't take new messages here and to start a new chat.

Agent settings gain a Slack section. A team admin can connect a public channel to a team agent from a list, choose whether the agent remembers that channel, and disconnect it. The page says plainly that everyone in the channel can talk to the agent, and that its instructions and files can show up in its answers to anyone in the channel. A personal agent's Slack section says whether a direct message to the bot reaches it or another of your personal agents. A change the server no longer accepts (someone else already removed the channel, say) now refreshes the section instead of asking you to try again. Everyone who can see the agent can read which channels it answers in, and a channel whose connector lost access says it needs reconnecting. Admin > Slack's Disconnect now also says that every channel connection goes with it.
