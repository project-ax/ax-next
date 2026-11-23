---
'@ax/agent-runner-core': patch
'@ax/agent-claude-sdk-runner': patch
---

We stopped trusting the agent's config folder to stay put. A session won't start on a config folder an earlier session could have written, and the CLI's settings and skills can't be changed mid-session. Instruction files the agent writes are never loaded. Long commands no longer wake the agent later (they stop at their timeout). A message that starts with `/` is read as words, not as a CLI command. A skill named like a built-in command gets a polite "please rename" answer instead of quietly running the built-in one.
