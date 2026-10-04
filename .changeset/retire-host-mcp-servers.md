---
'@ax/mcp-client': minor
'@ax/cli': minor
'@ax/credentials': patch
'@ax/credentials-admin-routes': patch
'@ax/channel-web': patch
'@ax/preset-k8s': patch
'@ax/test-harness': patch
'@ax/tool-policy': patch
'@ax/core': patch
'@ax/agents': patch
'@ax/teams': patch
'@ax/agent-aisdk-runner': patch
---

Retire host MCP servers (TASK-792). MCP now reaches agents only through
connectors, which come with per-agent attach, per-user credentials, OAuth and
tool ceilings.

- `@ax/mcp-client` no longer loads `mcp-server:<id>` rows at boot, no longer
  registers `mcp.<serverId>.<tool>` host tools, and no longer mounts
  `/admin/mcp-servers` (TASK-848's admin gate goes with the routes). At init it
  hard-deletes every stored `mcp-server:*` row and `mcp-server-index`, after
  purging each row's `mcp:<id>:` credentials. The tool catalog
  (`createToolDispatcherPlugin`) and the connector tool inventory are unchanged.
- `ax-next mcp` (add / list / remove / test) is removed from the CLI.
- The `mcp-header` credential destination kind is removed; the admin
  destination route answers 400 to it.
- The channel-web mock `/api/admin/mcp-servers` and `@ax/test-harness`'s
  orphaned `startMcpHttpServerStub` are removed.
