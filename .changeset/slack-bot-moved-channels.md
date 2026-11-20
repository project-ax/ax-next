---
'@ax/channel-slack': patch
'@ax/channel-web': patch
---

When a team agent gets its own Slack bot, its settings now list the channels it
was already connected to through the shared bot that still need the new one:
run `/invite @handle` in each, and a channel leaves the list once the bot has
answered there. While its own bot is live, connecting that agent through the
shared bot (from its settings or with `/ax connect`) is refused, and the reply
names the bot to invite instead. One agent, one bot per channel. We like things
tidy.
