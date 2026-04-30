# Meta — self-observations about how I work on this project

Behaviors (not project facts). Name a behavior, name the better alternative. Tag `active` if load-bearing for next session.

- `2026-04-23` `active` — **I've been skipping the claude-memory write phase on task completion.** Week 3 shipped as PR #2 without any memory write; this bootstrap is retroactive. Better: treat "PR opened" and "tests pass on a significant change" as hard write-phase triggers, not soft hints. At minimum, ask the meta-question ("what did I learn about how I work?") before declaring a task done.
- `2026-04-29` — **I offered the user an option that depended on local fs state without checking that state first.** Asked "ANTHROPIC_API_KEY vs ~/.claude/.credentials.json", user picked the credentials path — and then I discovered macOS keeps creds in Keychain, not on disk. Better: when listing options that hinge on a local file/binary/env-var existing, do the existence check inline before the AskUserQuestion. One extra Bash call upfront beats a wasted question round-trip.
