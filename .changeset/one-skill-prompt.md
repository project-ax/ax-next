---
'@ax/tool-policy': patch
'@ax/decisions': patch
'@ax/skill-broker': patch
'@ax/channel-slack': patch
---

Asking for a skill used to mean answering twice. The agent tried to use a skill, AX held that first try with one question, you said yes, and then a second card asked basically the same thing. Now, when someone is there to answer, the agent's request runs and its card is the one question. When nobody is there (a routine run, or someone who isn't the owner), the hold stays, same as before. Routine writes are still held either way, because we have trust issues. The log line for the new skip is `decision_hold_skipped_attended`.

The agent is also told the truth now: until you say yes, the skill isn't connected, so it should say it asked and wait, instead of acting like it already works (or trying the same thing some other way).

In Slack, the skill prompt now names the hosts the skill will reach, and adds one sentence when it downloads extra software. If AX can't name the reach whole (a host that looks odd, or too many to fit), it leaves the reach out rather than show part of it, and sends you to the web app, which shows everything. A skill that needs a key still goes through the web app.

One known wrinkle: if someone who isn't the owner asks for a skill, the owner is still asked twice in Today (the held call, then the card).
