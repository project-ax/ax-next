---
'@ax/channel-slack': minor
'@ax/channel-web': minor
---

A team agent's Slack bot now remembers private channels, like any other channel. We used to promise "answer, but don't remember" there, and it turned out we couldn't keep that promise: the agent could still write what it heard to a file. So we stopped promising, and now we just tell people.

What changes:

- **Private channels are remembered from their next thread.** Threads from before this change that were marked "not remembered" stay that way. Memory already skipped them, and we'd rather not let it go back and read them now.
- **The bot says so, once, in each channel.** The first time it answers in a channel, it posts this before its reply: "Heads up: what I hear in this channel is shared with anyone who talks to me, and I may bring it up elsewhere." The message that started it all (the first new thread's opening message, addressed to the bot) is remembered too. The notice lands just before the bot answers it, which is the first moment the bot can speak up, since Slack doesn't tell a bot when it's invited. Channels the bot was already in get the post at their next turn. In an announcement-only channel, where only admins can post to the channel itself, the bot puts the notice in the thread it's answering instead, once. Only that thread's readers see it there, and later threads in that channel aren't told again. We'd rather tell one thread than retry forever and tell nobody. If Slack refuses the post for any other reason (busy, down), the next turn tries again. The turn runs either way.
- **The same goes everywhere else people meet the agent:** the bot's Slack profile, the agent's Slack card in settings, and one muted line under the chat box with a team agent ("Fern's memory is shared with anyone who talks to Fern."). Personal agents show no such line.
- **The "Private channels aren't remembered" note is gone** from the Slack card.

What stays: Words from people outside the agent's team are never remembered. Slack Connect and archived channels are still refused.

For whoever deploys: channel-slack's boot migration drops `channel_slack_v1_channels.is_private` and adds a nullable `notice_posted_at`. Rolling back needs nothing. Older code re-adds `is_private` with a default at its own boot, and it ignores the new column. Existing bots pick up the new profile text at their next manifest send (Set up again, a rename, or a token Replace).

This removes a privacy boundary on purpose. The notices replace it.
