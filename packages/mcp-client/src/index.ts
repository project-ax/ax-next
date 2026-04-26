export { createMcpClientPlugin, type CreateMcpClientPluginOptions } from './plugin.js';
// Re-export config I/O so the CLI subcommand (Task 15) can use them without
// reaching into the package's private module paths.
export {
  loadConfigs,
  loadConfigById,
  saveConfig,
  deleteConfig,
  type McpServerConfig,
} from './config.js';
// Admin route public surface — exposed so the multi-tenant preset can mount
// the routes directly without going through the plugin's mountAdminRoutes
// flag (e.g. for tests that build a custom plugin order).
export {
  ADMIN_BODY_MAX_BYTES,
  MCP_TEST_TIMEOUT_MS,
  registerAdminMcpRoutes,
  testMcpConnection,
  type TestOutcome,
} from './admin-routes.js';
// Re-export McpConnection so `ax-next mcp test <id>` can open a one-shot
// connection without reaching into private module paths.
export {
  McpConnection,
  type McpConnectionOptions,
  type McpToolDescriptor,
  type ConnectionState,
  type ToolCallResult,
  type ListToolsResult,
} from './connection.js';
