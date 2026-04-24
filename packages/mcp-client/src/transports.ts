// ---------------------------------------------------------------------------
// Transport factory for MCP client transports.
//
// Job: given a validated `McpServerConfig` + access to the hook bus, produce
// the right `@modelcontextprotocol/sdk` transport object. Does NOT connect —
// `start()` is the connection manager's problem (Task 10). This keeps the
// env-allowlist + credential-resolution logic pure and testable without
// actually spawning a subprocess or opening a socket.
//
// Design notes:
// - For stdio, we explicitly pass `env` to StdioClientTransport so the SDK
//   does NOT fall back to `getDefaultEnvironment()`. That function inherits
//   PATH/HOME/LOGNAME/SHELL/TERM/USER from the host by default — more than
//   we want leaking into a third-party subprocess. Our allowlist (PATH +
//   HOME + LANG + LC_ALL) is deliberately shorter.
// - We split the factory into pure `build*Params` / `build*Options` helpers
//   + a thin `createTransport` wrapper. Tests assert on the pure output
//   rather than trying to read private fields of the SDK's transport
//   instances (those are `_serverParams`, `_requestInit`, etc. — not part
//   of the SDK's supported surface, so poking them would be brittle).
// ---------------------------------------------------------------------------

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js';
import { PluginError, type ChatContext } from '@ax/core';
import type { McpServerConfig } from './config.js';

const PLUGIN_NAME = '@ax/mcp-client';

/**
 * Minimal env allowlist for stdio MCP subprocesses.
 *
 * We do NOT inherit the full `process.env` — too easy to leak secrets the
 * user didn't intend the MCP server to see (think `AWS_ACCESS_KEY_ID`,
 * `AX_CREDENTIALS_KEY`, arbitrary CI-injected vars). Concrete env vars
 * reach the subprocess only via `config.env` or resolved `credentialRefs`.
 *
 * The list is intentionally conservative: PATH so the process can find
 * binaries, HOME because some CLIs sulk without it, LANG/LC_ALL so text
 * output encodings aren't garbage. Add more only with a concrete reason.
 */
export const BASE_STDIO_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL'] as const;

export interface BusLike {
  call: <I, O>(hookName: string, ctx: ChatContext, input: I) => Promise<O>;
}

export interface CreateTransportOptions {
  config: McpServerConfig;
  bus: BusLike;
  ctx: ChatContext;
}

export type McpClientTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;

// Shape the SDK's StdioClientTransport constructor accepts.
export interface StdioParams {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

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
  ctx: ChatContext,
  refs: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (refs === undefined) return out;
  for (const [name, id] of Object.entries(refs)) {
    try {
      const res = await bus.call<{ id: string }, { value: string }>(
        'credentials:get',
        ctx,
        { id },
      );
      out[name] = res.value;
    } catch (err) {
      throw new PluginError({
        code: 'credential-resolution-failed',
        plugin: PLUGIN_NAME,
        message: `failed to resolve credential ref '${name}' (id '${id}')`,
        cause: err instanceof Error ? err : undefined,
      });
    }
  }
  return out;
}

function baseStdioEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_STDIO_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * Build the `StdioServerParameters` object we'll pass to `new
 * StdioClientTransport(...)`. Exposed (and tested) separately from
 * `createTransport` so we can assert on the exact env/args without
 * having to introspect the SDK transport's private fields.
 *
 * Merge order for env is allowlist → config.env → resolved credential refs.
 * Credentials win last on purpose: if a user accidentally hardcoded a value
 * in `env` with the same key as a credentialRef, the real secret still
 * reaches the subprocess instead of the plaintext.
 */
export async function buildStdioParams(opts: {
  config: Extract<McpServerConfig, { transport: 'stdio' }>;
  bus: BusLike;
  ctx: ChatContext;
}): Promise<StdioParams> {
  const { config, bus, ctx } = opts;
  const credEnv = await resolveCredentials(bus, ctx, config.credentialRefs);
  const env: Record<string, string> = {
    ...baseStdioEnv(),
    ...(config.env ?? {}),
    ...credEnv,
  };
  return {
    command: config.command,
    args: config.args,
    env,
  };
}

/**
 * Build URL + options for StreamableHTTPClientTransport. Header credentials
 * go into `requestInit.headers`; when there are no header creds we omit
 * `requestInit` entirely so the SDK keeps its default behavior.
 */
export async function buildStreamableHttpOptions(opts: {
  config: Extract<McpServerConfig, { transport: 'streamable-http' }>;
  bus: BusLike;
  ctx: ChatContext;
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
  ctx: ChatContext;
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
    case 'stdio': {
      const params = await buildStdioParams({ config, bus, ctx });
      return new StdioClientTransport(params);
    }
    case 'streamable-http': {
      const { url, options } = await buildStreamableHttpOptions({ config, bus, ctx });
      return new StreamableHTTPClientTransport(url, options);
    }
    case 'sse': {
      const { url, options } = await buildSseOptions({ config, bus, ctx });
      return new SSEClientTransport(url, options);
    }
  }
}
