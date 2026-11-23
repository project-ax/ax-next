---
'@ax/agent-claude-sdk-runner': patch
'@ax/tool-policy': patch
---

An agent's list of what it can and can't do now says it plainly: it can't schedule things with its built-in timer instead of a routine. Claude Code's own built-in skills, like `loop`, are switched off, so when we ask an agent to do something every weekday, it sets up a routine we can approve instead of a schedule that never runs.

A file in the agent's home can no longer make Claude Code run prompts on a timer.

An agent can now open only the skills we gave it. Asking for any other skill, such as `update-config` or `init`, gets a plain "not one of this agent's skills" answer.
