---
'@ax/apps-bridge': minor
'@ax/apps-bridge-contract': minor
'@ax/mcp-client': minor
'@ax/preset-k8s': patch
'@ax/test-harness': patch
'@ax/channel-web': minor
'@ax/cli': patch
---

Add the apps connector bridge: `@ax/apps-bridge` lets an outside app call an agent's connectors through a link the agent's owner approves, on its own listener (default port 9092, bound on `AX_HTTP_HOST`). `@ax/apps-bridge-contract` holds the wire contract the platform vendors. `@ax/mcp-client` gains `connectors:call-tool-result` and `inputSchema` in `connectors:describe-tools`. `@ax/preset-k8s` loads the bridge, and `AX_APPS_BRIDGE_PLATFORM_ID` (with the other `AX_APPS_BRIDGE_*` variables, listed in `ax-next serve --help`) turns it on. `@ax/channel-web` gains the agent settings' Apps section and the app approve page.
