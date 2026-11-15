---
'@ax/channel-slack': patch
'@ax/decisions': patch
---

Slack now shows Allow and Deny buttons when your agent needs an OK. In a DM, or in a channel thread where you are talking to the agent as yourself, the bot posts a short prompt under its reply: what the agent wants to do, the two buttons, and a link to the same request in Today. Only the person who asked can answer, and AX checks that again on every click (it does not trust the message text or the button label). Anyone else gets one private note saying so. Allow lets the agent carry on, and when it picks the work back up the bot keeps writing into the same thread. Deny tells it no. If the answer takes longer than usual, the prompt says it is still working, so there is no need to click twice.

Some things stay the way they were. When someone who can't use the agent talks to it in a channel, there are no buttons: the agent says it is waiting for its owner, and the call waits in the connector's Today. A call that is identical to one already waiting links to Today instead of showing buttons. And because the bot keeps its open prompts in memory, a restart turns an old click into "this isn't waiting here anymore, answer it in Today".

An existing Slack connection has to be disconnected and connected again from AX's admin settings, so Slack learns where to send button clicks. Until then its prompts still carry the Today link.

Decisions now treats a Slack thread like a web chat: someone is there to answer, so an approval is handed back to the agent to carry out instead of being run quietly by the host. If the agent's session has already ended by the time you approve a connector call, it waits for the agent's next identical request, as it does in a web chat.

One safety tightening that also reaches web chats with a team agent: a saved approval ("yes, once") can now be spent only by the turn of the person who gave it. Before, any turn on the same agent making the exact same call could use it, and an outsider's turn in a Slack channel could use someone else's. A team-mate making the same call is now asked for their own approval, and each person's yes is kept separately: two team-mates can approve the same request at the same time, and neither one blocks the other.
