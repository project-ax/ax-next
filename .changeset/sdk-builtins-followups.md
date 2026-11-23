---
'@ax/agent-claude-sdk-runner': patch
'@ax/tool-policy': patch
---

An agent's list of what it can and can't do now says it plainly: it can't set itself to run again later outside routines. Claude Code's own built-in skills, like `loop`, are switched off, so when we ask an agent to do something every weekday, it sets up a routine we can approve instead of a schedule that never runs.

An agent can now open only the skills we gave it. Asking for any other skill, such as `update-config` or `init`, gets a plain "not one of this agent's skills" answer.
