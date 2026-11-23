---
'@ax/memory': patch
---

Memory stops saving more of a conversation talking about itself.

- **"I don't have that on file."** When the agent looks something up and comes back empty ("no record of your favorite color", "no standup time on record"), that's one lookup, wrong the moment you answer. It used to be saved, sometimes under your name, right next to the real answer.
- **The agent's offers and admin requests.** "Offered to set up a reminder" and "asked its admin for Slack access" are lines of a reply. The request itself already lives where requests live.
- **Your Slack ID, and "reply with exactly…".** The channel shows who you are every time, and a request to echo some words back isn't something about you.

What you ask for otherwise stays: "wanted a reservation at Roscioli", "use markdown from now on". We checked these rules against 500 benchmark memory banks (about 167,000 saved facts). They drop one fact we'd have kept before, and it was the agent narrating too. Honest caveat: the benchmark has almost no facts shaped like these, so each rule is also narrowed by hand against lookalikes ("the IRS has no record of your payment", "no reservation was on file for us at the Hilton", "always reply with exactly three bullets" all stay).

For whoever runs the deployment: `packages/memory/scripts/clean-assistant-narration.mjs` now also catches the agent's own memory misses, offers and admin requests already saved. It only touches facts about the agent, so your Slack ID and echo requests saved before this change stay until you remove them.
