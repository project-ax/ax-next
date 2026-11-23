---
'@ax/agent-claude-sdk-runner': patch
'@ax/tool-policy': patch
---

Agents now say plainly that they can't set themselves to run again later outside routines. Claude Code's own built-in skills, like `loop`, are switched off, so an agent asked to do something every weekday sets up a routine you can approve instead of a schedule that never runs.

An agent can now open only the skills you gave it. Asking for any other skill, such as `update-config` or `init`, gets a plain "not one of this agent's skills" answer.
