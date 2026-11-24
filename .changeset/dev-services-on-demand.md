---
'@ax/agent-runner-core': minor
'@ax/agents': minor
'@ax/channel-web': minor
'@ax/chat-orchestrator': minor
'@ax/connectors': minor
'@ax/conversations': minor
'@ax/ipc-core': minor
'@ax/ipc-protocol': minor
'@ax/preset-k8s': minor
'@ax/sandbox-k8s': minor
'@ax/sandbox-protocol': minor
'@ax/sandbox-subprocess': minor
'@ax/session-inmemory': minor
'@ax/session-postgres': minor
'@ax/skills-parser': minor
'@ax/agent-aisdk-runner': patch
'@ax/agent-claude-sdk-runner': patch
'@ax/channel-slack': patch
'@ax/cli': patch
'@ax/core': patch
'@ax/preset-memory': patch
'@ax/skill-broker': patch
'@ax/test-harness': patch
'@ax/tool-policy': patch
'@ax/validator-service': patch
---

A coding agent can now start an admin-approved compose stack inside its own sandbox, on demand, and turns of up to two hours survive.

Admins import a compose file, pick a group of services, pin the images, and mark the stack on-demand. The agent sees it as an offer, calls `restart_with_services` when it needs the stack and `stop_services` when it's done. The host swaps the sandbox mid-turn and tells the agent with a host-note. The model only picks when to restart and which offered set. Images, commands, env and ports always come from the admin's descriptor. Inside the pod, loopback forwards (127.0.0.1 only) make each service reachable on its published port.

Each agent also gets its own turn limit, idle time and runner size, clamped to chart ceilings (`chat.maxTurnMinutes`, `chat.maxIdleMinutes`, `sandbox.runnerMax`). Long turns now hold across the Slack reply cap, the reap hold, API timeouts and mid-turn sign-in rotation (every 5 minutes).

We're a bit paranoid about the importer, so it refuses dangerous compose fields, unsafe writable paths and alias bombs. The image-pin route resolves DNS once and refuses private addresses. Every `$` is escaped and docker gets a minimal env in the local renderer. Operators: the chart's `ingress.backendConfig.timeoutSec` default is now 7500 and the render fails if it isn't above `maxTurnMinutes * 60`. Ship the runner image together with the host.
