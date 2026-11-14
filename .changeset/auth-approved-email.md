---
'@ax/auth-better': minor
---

Add `auth:is-approved-email`, a host-internal hook that answers one question: is this email address on one of the install's approved domains? It's how `@ax/channel-slack` can let a company member who has no AX account talk to an agent in a connected Slack channel. The answer follows the same rule as `auth:find-user-by-email`: on at least one Google or GitHub sign-in list, whether or not that provider is switched on; a blank list adds nothing; with no list anywhere, any domain counts. Only plain, well-formed ASCII addresses can pass, so a look-alike letter can't sneak a domain through.

We're a little paranoid about this one, on purpose. It never looks at accounts, so its answer can't tell anyone who has one. It isn't an HTTP route or an IPC action, it writes no log line, and only `@ax/auth-better` and `@ax/channel-slack` may name it (a repo scan enforces that).
