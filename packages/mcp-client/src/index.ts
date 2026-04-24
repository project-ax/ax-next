export { createMcpClientPlugin, type CreateMcpClientPluginOptions } from './plugin.js';
// Re-export config I/O so the CLI subcommand (Task 15) can use them without
// reaching into the package's private module paths.
export { loadConfigs, saveConfig, deleteConfig, type McpServerConfig } from './config.js';
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
