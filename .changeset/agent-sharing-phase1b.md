---
'@ax/channel-web': minor
'@ax/auth-better': minor
'@ax/agents': patch
---

Agents can now be shared from the UI (phase 1B). Settings has a "Who can use
<agent>?" row: Just me, Everyone, or people picked by name, plus "Same people
as" another agent. Widening asks first and names the connections that travel with the agent (the ones attached to it, not your own
connectors).
Owners can be added and removed. Agents shared with you show up in your list and
say who shared them. People who only use an agent just chat: no settings, no
activity line, and errors tell them to ask the owner. People search is
`GET /admin/people` in @ax/auth-better. It returns names only, never email, and
is rate-limited.

Not done yet: memory for non-creators (card C), co-owners still see routine
switches and Delete in Settings (the server refuses them), "Shared by" on the
home composer menu and agent header, and new people with only shared agents still
create their own first.
