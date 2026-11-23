---
'@ax/core': minor
'@ax/memory': patch
'@ax/ipc-core': patch
'@ax/session-postgres': patch
---

Team memory follow-ups. These close most of the gaps we listed when outsiders started reading team memory like members do.

- **A session from a source we don't recognize fails closed.** If a newer build saved a session with a source this build can't place, it's treated as `unrecognized`. On a team agent its recall reads shared memory only and names nobody. (Whether it gets a `/memory` view was decided when the session opened, by the build that opened it.) Everywhere else it's treated like an outsider. Nothing creates one today.
- **The `/memory` export names teammates.** Current members only. Anyone else reads "a teammate".
- **More names are refused.** A member whose name reads as the agent's own name, or as "a teammate", reads "a teammate" instead.
- **Your own name counts.** In your turn, a teammate who takes your display name reads "a teammate".
- **Name lookups give up after 2 seconds.** When that happens, the answer names nobody.

Still not done: a team-wide duplicate-name check (it needs a member list memory doesn't have), and finding a teammate's facts by name.
