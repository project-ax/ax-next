// ---------------------------------------------------------------------------
// Transport factory for MCP client transports.
//
// Job: given a validated `McpServerConfig` + access to the hook bus, produce
// the right `@modelcontextprotocol/sdk` transport object. Does NOT connect —
// `start()` is the connection manager's problem (Task 10). This keeps the
// credential-resolution logic pure and testable without opening a socket.
// There is no process-spawning transport here: stdio MCP servers were removed
// (2026-10-04), so nothing in this module can start a process on the host.
//
// Design notes:
// - We split the factory into pure `build*Options` helpers
//   + a thin `createTransport` wrapper. Tests assert on the pure output
//   rather than trying to read private fields of the SDK's transport
//   instances (e.g. `_requestInit` — not part of the SDK's supported
//   surface, so poking them would be brittle).
// ---------------------------------------------------------------------------

import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js';
import { PluginError, type AgentContext } from '@ax/core';
import type { McpServerConfig } from './config.js';

const PLUGIN_NAME = '@ax/mcp-client';

export interface BusLike {
  call: <I, O>(hookName: string, ctx: AgentContext, input: I) => Promise<O>;
}

export interface CreateTransportOptions {
  config: McpServerConfig;
  bus: BusLike;
  ctx: AgentContext;
}

export type McpClientTransport = StreamableHTTPClientTransport | SSEClientTransport;

export interface StreamableHttpBuildResult {
  url: URL;
  options: StreamableHTTPClientTransportOptions;
}

export interface SseBuildResult {
  url: URL;
  options: SSEClientTransportOptions;
}

/**
 * Resolve a map of `{ name -> credentialId }` into `{ name -> secretValue }`
 * by calling `credentials:get` once per id.
 *
 * On failure we wrap the underlying error in a `credential-resolution-failed`
 * PluginError that names the ref + id (useful for debugging "which ref is
 * missing?") but never the value (there is no value on failure, but also
 * never on success — the caller sees it via the returned map).
 */
async function resolveCredentials(
  bus: BusLike,
  ctx: AgentContext,
  refs: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (refs === undefined) return out;
  // Phase 3 shape: credentials:get takes ({ ref, userId }) and returns string.
  // userId comes from the agent context — MCP servers run on behalf of the
  // owning agent's user, never on behalf of "the system."
  for (const [name, ref] of Object.entries(refs)) {
    try {
      const value = await bus.call<{ ref: string; userId: string }, string>(
        'credentials:get',
        ctx,
        { ref, userId: ctx.userId },
      );
      out[name] = value;
    } catch (err) {
      throw new PluginError({
        code: 'credential-resolution-failed',
        plugin: PLUGIN_NAME,
        message: `failed to resolve credential ref '${name}' (ref '${ref}')`,
        cause: err instanceof Error ? err : undefined,
      });
    }
  }
  return out;
}

/**
 * Build URL + options for StreamableHTTPClientTransport. Header credentials
 * go into `requestInit.headers`; when there are no header creds we omit
 * `requestInit` entirely so the SDK keeps its default behavior.
 */
export async function buildStreamableHttpOptions(opts: {
  config: Extract<McpServerConfig, { transport: 'streamable-http' }>;
  bus: BusLike;
  ctx: AgentContext;
}): Promise<StreamableHttpBuildResult> {
  const { config, bus, ctx } = opts;
  const headers = await resolveCredentials(bus, ctx, config.headerCredentialRefs);
  const options: StreamableHTTPClientTransportOptions = {};
  if (Object.keys(headers).length > 0) {
    options.requestInit = { headers };
  }
  return { url: new URL(config.url), options };
}

/**
 * Build URL + options for SSEClientTransport. Header credentials are
 * attached via `requestInit.headers` — note that on SSE this only applies
 * to the outbound POST requests the client sends; the initial GET is
 * controlled by `eventSourceInit`, which we don't touch. For simple
 * bearer-token auth the POST headers are what matters.
 */
export async function buildSseOptions(opts: {
  config: Extract<McpServerConfig, { transport: 'sse' }>;
  bus: BusLike;
  ctx: AgentContext;
}): Promise<SseBuildResult> {
  const { config, bus, ctx } = opts;
  const headers = await resolveCredentials(bus, ctx, config.headerCredentialRefs);
  const options: SSEClientTransportOptions = {};
  if (Object.keys(headers).length > 0) {
    options.requestInit = { headers };
  }
  return { url: new URL(config.url), options };
}

/**
 * Construct (but do not connect) an MCP transport for the given config.
 * Caller owns `.start()` / lifecycle — that's the connection manager.
 */
export async function createTransport(
  opts: CreateTransportOptions,
): Promise<McpClientTransport> {
  const { config, bus, ctx } = opts;
  switch (config.transport) {
    case 'streamable-http': {
      const { url, options } = await buildStreamableHttpOptions({ config, bus, ctx });
      return new StreamableHTTPClientTransport(url, options);
    }
    case 'sse': {
      const { url, options } = await buildSseOptions({ config, bus, ctx });
      return new SSEClientTransport(url, options);
    }
    default: {
      // Fail closed. `parseConfig` already refuses anything but the two
      // transports above (a removed `stdio` included), so this is only
      // reachable by a value that skipped validation. Throw rather than
      // return undefined: there must be no path from a stored row to a
      // process spawn on the host.
      const unsupported: never = config;
      throw new PluginError({
        code: 'unsupported-transport',
        plugin: PLUGIN_NAME,
        message: `unsupported MCP transport '${String((unsupported as { transport?: unknown }).transport)}' — configure a streamable-http or sse server URL`,
      });
    }
  }
}
