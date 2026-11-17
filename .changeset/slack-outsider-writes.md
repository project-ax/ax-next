---
'@ax/routines': patch
'@ax/ipc-core': patch
'@ax/sandbox-k8s': patch
'@ax/agent-runner-core': patch
'@ax/chat-orchestrator': patch
'@ax/skill-broker': patch
'@ax/core': patch
---

Someone in a Slack channel who has no access to the agent can no longer change
what the agent later reads as its own. Their turns can't create, change, delete
or fire routines, publish artifacts or charts, or file catalog requests, and the
agent's files are read-only for them (the agent is told so). Their first turn in
a thread starts a fresh sandbox instead of a warm one, because a warm one would
mount the files writable. A runner can now bind its session id only to its own
conversation. Members' turns, in channels or anywhere else, are unchanged. We
checked every other place such a turn can write; the audit is in
`docs/plans/2026-11-17-task-1122-outsider-persist-audit-plan.md`.
