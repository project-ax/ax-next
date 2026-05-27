---
'@ax/host-grants': minor
'@ax/credential-proxy': patch
'@ax/chat-orchestrator': patch
'@ax/channel-web': patch
'@ax/preset-k8s': patch
---

JIT: persistent per-(user, agent) host-grant store ("always allow"). New `@ax/host-grants` plugin (`host-grants:grant`/`list`/`revoke`) persists the reactive egress wall's "Always for this agent" choice; the orchestrator loads grants into the allowlist at session open; `proxy:add-host` now returns the session agentId so the grant key stays server-authoritative. Closes TASK-37's half-wired persistence window. (TASK-44)
