---
'@ax/auth-better': minor
---

Add `auth:list-admins`, a host-internal hook that answers one question: who are the admins we can tell? It's how `@ax/channel-slack` finds the people to DM when a team admin asks for their agent's own Slack bot. It lists every account that is an admin right now and whose email a sign-in provider verified, oldest first, as `{ userId, email }` and nothing more. If the accounts can't be read, it throws, because an empty answer would read as "nobody to tell". One honest wrinkle: the admin made by the setup wizard has an unverified email until they sign in with Google or GitHub, so until then this hook lists no one.

We're careful with this one, on purpose. It writes no log line, it isn't an HTTP route or an IPC action, and only `@ax/auth-better` and `@ax/channel-slack` may name it (a repo scan enforces that).
