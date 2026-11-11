// ---------------------------------------------------------------------------
// The `clientInfo` we send in the MCP `initialize` handshake.
//
// Operators can rename it per deployment with AX_MCP_CLIENT_NAME (the chart's
// `host.mcpClientName`). The same variable is forwarded into runner sandboxes,
// where the aisdk runner applies the same rule to its own connector client.
// The value goes to third-party servers, so it is held to a short run of
// printable ASCII: no whitespace, no control characters, nothing to smuggle.
// ---------------------------------------------------------------------------

/** What `initialize` carries as `clientInfo`. */
export interface McpClientInfo {
  name: string;
  version: string;
}

export const MCP_CLIENT_NAME_ENV = 'AX_MCP_CLIENT_NAME';

/** What we call ourselves unless the deployment says otherwise. */
export const DEFAULT_CLIENT_INFO: McpClientInfo = { name: '@ax/mcp-client', version: '0.0.0' };

/** 1-64 printable ASCII characters, no spaces. */
export const MCP_CLIENT_NAME_RE = /^[\x21-\x7e]{1,64}$/;

/**
 * The deployment's `clientInfo`: DEFAULT_CLIENT_INFO with its name replaced
 * when AX_MCP_CLIENT_NAME is set. Unset or empty means the default. Throws on
 * a malformed name, so a typo fails boot instead of quietly sending the default.
 */
export function readMcpClientInfo(env: NodeJS.ProcessEnv = process.env): McpClientInfo {
  const raw = env[MCP_CLIENT_NAME_ENV];
  if (raw === undefined || raw === '') return DEFAULT_CLIENT_INFO;
  if (!MCP_CLIENT_NAME_RE.test(raw)) {
    throw new Error(
      `${MCP_CLIENT_NAME_ENV} must be 1-64 printable ASCII characters with no spaces (got ${JSON.stringify(raw.slice(0, 80))})`,
    );
  }
  return { ...DEFAULT_CLIENT_INFO, name: raw };
}
