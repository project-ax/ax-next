---
'@ax/agents': minor
'@ax/channel-web': patch
'@ax/mcp-oauth': patch
'@ax/routines-admin-routes': patch
---

Agents can now be shared (phase 1A, no UI yet). A personal agent has an
audience (`just-me`, `everyone` or a list of people) and owners. `agents:resolve`
admits owners and the audience, and its answer carries `shared` and `isOwner`.
Owners-only routes set who can use an agent and who owns it. Settings writes,
connection sign-in and Slack setup on a personal agent need an owner. The sharing
view carries no email, and an unknown person is refused without naming the id.

Not done yet: card B (the sharing UI), card C (re-keying memory), and memory for
non-creators.
