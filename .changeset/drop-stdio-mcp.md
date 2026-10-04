---
'@ax/agent-aisdk-runner': patch
'@ax/agent-claude-sdk-runner': patch
'@ax/agent-runner-core': patch
'@ax/channel-web': patch
'@ax/chat-orchestrator': patch
'@ax/cli': patch
'@ax/connectors': patch
'@ax/credentials': patch
'@ax/credentials-admin-routes': patch
'@ax/ipc-protocol': patch
'@ax/mcp-client': patch
'@ax/preset-k8s': patch
'@ax/sandbox-k8s': patch
'@ax/sandbox-protocol': patch
'@ax/sandbox-subprocess': patch
'@ax/skills-parser': patch
'@ax/test-harness': patch
'@ax/tool-connector-propose': patch
---

Remove stdio MCP servers everywhere; stored stdio connectors, drafts and mcp-client configs are deleted at boot.

The `mcp-env` credential destination kind goes with them: it only ever held a stdio server's env secret. `mcp-header` stays.
