---
'@ax/channel-slack': patch
---

Slack can now answer two more kinds of "may I?" from the thread itself. When the agent tries to open a website it has not been allowed to reach, the bot posts a short prompt under its reply with Allow and Deny buttons. Allow lets that website through, and the agent keeps it from then on, like the web app's "Always for this agent" (you can remove it in Settings). When the agent asks to start using a skill that needs nothing but your yes, the same kind of prompt shows up, naming the skill, and Allow connects the skill so your next message can use it. A skill that needs a key or password still goes through the web app, because Slack never asks for one: the thread gets a link there instead.

The rules are the same as for the other buttons. Only the person whose turn it was can answer, AX checks that again on every click, and anyone else gets one private note saying so. When someone who can't use the agent talks to it in a channel, no prompt is posted. A prompt that Slack can't deliver, or that the bot has forgotten after a restart, just means doing it in the web app as before.

Two things worth knowing. In a channel, the website is named in a prompt everyone there can see (the web app shows it to the person alone). And a skill you allow here still shows up as waiting in Today until you clear it there. An existing Slack connection that was set up before the Allow and Deny buttons has to be disconnected and connected again, so Slack knows where to send clicks.
