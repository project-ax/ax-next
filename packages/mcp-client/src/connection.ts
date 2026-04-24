// ---------------------------------------------------------------------------
// Per-server MCP connection lifecycle (Task 10).
//
// Thin wrapper around `@modelcontextprotocol/sdk`'s `Client` plus a transport
// from `createTransport` (Task 9). Owns the state machine — for this task:
//
//   disconnected  ──connect()──►  connecting  ──►  ready
//                                      │
//                                      └── fail ── ► unhealthy
//
//   unhealthy     ──connect()──►  connecting    (retry path for Task 11)
//   closed        ──connect()──►  (rejected: construct a new McpConnection)
//
//   any state     ──disconnect()──► closed      (idempotent)
//
// Reconnect-with-backoff (Task 11) will drive unhealthy→connecting from the
// SDK transport's `onclose`/`onerror` callbacks. We allow that transition
// from `connect()` already so the retry layer doesn't need to reach into
// private state to re-arm an attempt.
//
// We deliberately do NOT emit MCP_SERVER_UNAVAILABLE here — that's the job
// of the plugin layer that wraps callTool() once the bus is available
// (Task 13). Keeping this class bus-free keeps it unit-testable without
// booting a HookBus and its plugin graph.
// ---------------------------------------------------------------------------

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PluginError, type ChatContext } from '@ax/core';
import type { McpServerConfig } from './config.js';
import {
  createTransport,
  type BusLike,
  type CreateTransportOptions,
  type McpClientTransport,
} from './transports.js';

const PLUGIN_NAME = '@ax/mcp-client';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'unhealthy'
  | 'closed';

/**
 * Shape of the SDK tool descriptors we surface upward. A strict subset of the
 * SDK's `ListToolsResult['tools'][number]` — we keep only what downstream
 * plugins care about (name, description, inputSchema) so that future SDK
 * surface changes don't force churn here. Task 12 normalizes tool names.
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Minimal structural type of the SDK Client the connection manager uses.
 * Exposing an interface (rather than importing the concrete class shape)
 * lets tests swap in a stub without wrestling the SDK's private generics,
 * and makes the dependency explicit for anyone reading this file.
 */
export interface SdkClientLike {
  connect(transport: McpClientTransport): Promise<void>;
  listTools(): Promise<{
    tools: ReadonlyArray<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
  }>;
  callTool(req: { name: string; arguments?: unknown }): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpConnectionOptions {
  config: McpServerConfig;
  bus: BusLike;
  ctx: ChatContext;
  /** Test seam: build the transport. Defaults to `createTransport`. */
  transportFactory?: (opts: CreateTransportOptions) => Promise<McpClientTransport>;
  /** Test seam: construct the SDK Client. Defaults to the real one. */
  clientFactory?: () => SdkClientLike;
}

/**
 * Default SDK client constructor. We advertise an empty capabilities object —
 * we don't support roots / sampling / elicitation on the client side yet, so
 * claiming them would be a lie. MCP servers key behavior off capabilities,
 * so accidentally advertising something we can't back is a footgun.
 */
function defaultSdkClient(): SdkClientLike {
  const real = new Client({ name: '@ax/mcp-client', version: '0.0.0' }, { capabilities: {} });
  // The real Client's generic parameters make its methods slightly wider than
  // SdkClientLike (extra RequestOptions etc.), but every method we care about
  // is present with compatible runtime shapes. Cast once at this boundary.
  return real as unknown as SdkClientLike;
}

export class McpConnection {
  readonly serverId: string;
  private _state: ConnectionState = 'disconnected';
  private client: SdkClientLike | undefined;
  private transport: McpClientTransport | undefined;
  private readonly opts: McpConnectionOptions;

  constructor(opts: McpConnectionOptions) {
    this.opts = opts;
    this.serverId = opts.config.id;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Build the transport, construct the SDK client, and run the MCP
   * initialize handshake. On failure the connection lands in `unhealthy`
   * rather than `closed` so Task 11's backoff layer can distinguish
   * "never came up" from "explicitly torn down".
   *
   * Allowed from `'disconnected'` (fresh connection) and `'unhealthy'`
   * (retry after a failed attempt — Task 11's reconnect path). Rejected
   * from `'connecting'` / `'ready'` (double-connect is a programming error)
   * and from `'closed'` (once explicitly torn down, construct a new
   * McpConnection — we don't resurrect a closed one).
   */
  async connect(): Promise<void> {
    if (this._state === 'closed') {
      throw new PluginError({
        code: 'mcp-closed',
        plugin: PLUGIN_NAME,
        message: `connection for '${this.serverId}' is closed; construct a new McpConnection to reconnect`,
      });
    }
    if (this._state !== 'disconnected' && this._state !== 'unhealthy') {
      throw new PluginError({
        code: 'mcp-already-connected',
        plugin: PLUGIN_NAME,
        message: `connection for '${this.serverId}' is in state '${this._state}'`,
      });
    }
    // Clear any residue from a prior failed attempt so the retry path
    // doesn't accidentally reuse a half-built client or transport.
    this.client = undefined;
    this.transport = undefined;
    this._state = 'connecting';
    try {
      const buildTransport = this.opts.transportFactory ?? createTransport;
      this.transport = await buildTransport({
        config: this.opts.config,
        bus: this.opts.bus,
        ctx: this.opts.ctx,
      });
      this.client = (this.opts.clientFactory ?? defaultSdkClient)();
      await this.client.connect(this.transport);
      this._state = 'ready';
    } catch (err) {
      this._state = 'unhealthy';
      // Best-effort cleanup: if we built a transport before failing, try
      // to close it so we don't leak an open socket / subprocess. Ignore
      // errors — we're already on the failure path.
      if (this.transport !== undefined) {
        try {
          await this.transport.close();
        } catch {
          /* ignore */
        }
      }
      throw new PluginError({
        code: 'mcp-connect-failed',
        plugin: PLUGIN_NAME,
        message: `failed to connect to MCP server '${this.serverId}': ${
          err instanceof Error ? err.message : String(err)
        }`,
        cause: err,
      });
    }
  }

  /**
   * List tools advertised by the server. Requires `state === 'ready'`.
   * Returns the SDK's tool array, narrowed to the fields downstream cares
   * about — we drop SDK-only bookkeeping (cursors, _meta, icons, etc.)
   * so subscribers don't accidentally key on them.
   */
  async listTools(): Promise<McpToolDescriptor[]> {
    this.assertReady('listTools');
    const res = await this.client!.listTools();
    return res.tools.map((t) => {
      const out: McpToolDescriptor = {
        name: t.name,
        inputSchema: t.inputSchema,
      };
      if (t.description !== undefined) out.description = t.description;
      return out;
    });
  }

  /**
   * Invoke a tool on the server. Returns the raw SDK result — Task 13 will
   * normalize this into the @ax/core tool-result shape. We don't unwrap
   * `isError` here because "MCP tool returned isError=true" is a
   * server-reported tool failure, not a connection failure, and the two
   * should not be conflated at this layer.
   */
  async callTool(name: string, args: unknown): Promise<unknown> {
    this.assertReady('callTool');
    return this.client!.callTool({ name, arguments: args });
  }

  /**
   * Tear down the connection. Idempotent: calling again after `closed` is
   * a no-op. We mark state BEFORE calling `client.close()` so a caller in
   * a `finally` block can't race with another caller's connect() — once
   * we say "closed", we mean it.
   */
  async disconnect(): Promise<void> {
    if (this._state === 'closed') return;
    this._state = 'closed';
    try {
      await this.client?.close();
    } catch (err) {
      // Disconnect is best-effort — the server might already be dead or
      // the transport might have errored out. We've already committed to
      // the 'closed' state and we don't rethrow (callers in `finally`
      // blocks shouldn't have to guard against it), but a failed close
      // can mean a wedged transport or stuck subprocess. Log a warning
      // so operators can see it rather than silently swallowing.
      this.opts.ctx.logger.warn('mcp_disconnect_close_failed', {
        serverId: this.serverId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private assertReady(op: string): void {
    if (this._state !== 'ready') {
      throw new PluginError({
        code: 'mcp-not-ready',
        plugin: PLUGIN_NAME,
        message: `cannot ${op}() on connection '${this.serverId}': state is '${this._state}'`,
      });
    }
  }
}
