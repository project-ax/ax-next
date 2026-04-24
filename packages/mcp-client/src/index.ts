export { createMcpClientPlugin, type CreateMcpClientPluginOptions } from './plugin.js';
// Re-export config I/O so the CLI subcommand (Task 15) can use them without
// reaching into the package's private module paths.
export { loadConfigs, saveConfig, deleteConfig, type McpServerConfig } from './config.js';
