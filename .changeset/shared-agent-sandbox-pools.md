---
'@ax/sandbox-k8s': minor
'@ax/preset-k8s': minor
'@ax/sandbox-protocol': minor
'@ax/agent-runner-core': minor
'@ax/agent-claude-sdk-runner': patch
'@ax/agent-aisdk-runner': patch
'@ax/chat-orchestrator': patch
'@ax/memory': patch
---

Add opt-in shared Agent Sandbox standby pools per runner configuration, with
one-use bootstrap and protected late attachment of agent files and read-only
memory. Keep service-sidecar sessions on the cold path. Recover durable
conversations after host restart and safely retire storage after a confirmed
new kernel boot on the same GKE VM identity. Permanently lost nodes require
independent cloud fencing before cleanup.

Fix Claude Stop to terminate Linux tool descendants and preserve new stream
bindings while retiring an old session. Shared pools remain disabled by default;
activation requires the new image, helper, dedicated TLS certificates, and
matching Filestore configuration.
