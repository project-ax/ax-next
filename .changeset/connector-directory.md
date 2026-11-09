---
'@ax/connector-directory': minor
'@ax/connectors': patch
'@ax/tool-connector-propose': patch
'@ax/preset-k8s': patch
---

Admins can now search a directory of MCP servers from Admin > Connectors. The host keeps its own copy of the public MCP Registry, refreshes it about hourly, and cleans up every listing before storing it. The sync is off unless the chart (or the preset config) turns it on, and only ever talks to the one registry address it is configured with.
