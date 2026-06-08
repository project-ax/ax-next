export const MCP_OAUTH_PLUGIN_NAME = '@ax/mcp-oauth';

export { createMcpOAuthPlugin } from './plugin.js';
export type { McpOAuthPluginConfig } from './plugin.js';

export { assertSafeUrl, safeFetch, isPrivateIp, BlockedUrlError } from './ssrf.js';
export type { HostResolver } from './ssrf.js';
