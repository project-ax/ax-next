// ---------------------------------------------------------------------------
// Per-server MCP connection lifecycle (Task 10 + 11).
//
// Thin wrapper around `@modelcontextprotocol/sdk`'s `Client` plus a transport
// from `createTransport` (Task 9). Owns the state machine:
//
//   disconnected  ──connect()──►  connecting  ──►  ready
//                                      │
//                                      └── fail ── ► unhealthy
//                                                      │
//                                                      ├── timer fires ──► connecting
//                                                      │                     │
//                                                      │                     └── fail ──► unhealthy
//                                                      │                         (reschedule)
//                                                      │
//                                                      └── connect() ──► connecting  (manual retry)
//
//   closed        ──connect()──►  (rejected: construct a new McpConnection)
//   any state     ──disconnect()──► closed  (idempotent, clears reconnect timer)
//
// Task 11 semantics (this file):
//
//  - `callTool()` / `listTools()` return a discriminated union. On success:
//    `{ ok: true, result | tools }`. If the underlying SDK call THROWS (a
//    transport failure, dropped socket, timeout), we trap it, mark the
//    connection unhealthy, schedule a background reconnect, and return
//    `{ ok: false, code: 'MCP_SERVER_UNAVAILABLE', reason }`. The chat keeps
//    going; the caller (Task 13 plugin) translates this into a tool-error
//    result the model can see.
//
//  - An SDK response where the tool itself reported `{ isError: true }` is
//    NOT a connection failure — the RPC succeeded mechanically, the tool
//    chose to fail. We return it as `{ ok: true, result: <that object> }`
//    and let the caller inspect `isError`. Conflating the two would brick
//    a connection every time the model passed bad args to a tool.
//
//  - Background reconnect uses exponential backoff capped at 16s:
//    1s, 2s, 4s, 8s, 16s, 16s, ... Successful `connect()` resets the
//    counter. `disconnect()` clears the pending timer so the loop stops.
//
// We deliberately do NOT emit a hook from here — the class stays bus-free
// so it's unit-testable without booting a HookBus. The Task 13 plugin layer
// is where failures become observable to the rest of the system.
// ---------------------------------------------------------------------------

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PluginError, type AgentContext } from '@ax/core';
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
  ctx: AgentContext;
  /** Test seam: build the transport. Defaults to `createTransport`. */
  transportFactory?: (opts: CreateTransportOptions) => Promise<McpClientTransport>;
  /** Test seam: construct the SDK Client. Defaults to the real one. */
  clientFactory?: () => SdkClientLike;
}

/**
 * Discriminated return shape for `callTool` / `listTools`. The `ok: false`
 * branch is returned (not thrown) when the underlying SDK call throws, so
 * a crashed MCP server manifests as a recoverable tool error rather than a
 * chat-terminating exception. Task 13's plugin layer translates `ok: false`
 * into the model-visible tool-result shape.
 */
export type ToolCallResult =
  | { ok: true; result: unknown }
  | { ok: false; code: 'MCP_SERVER_UNAVAILABLE'; reason: string };

export type ListToolsResult =
  | { ok: true; tools: McpToolDescriptor[] }
  | { ok: false; code: 'MCP_SERVER_UNAVAILABLE'; reason: string };

/**
 * Backoff schedule: 1s, 2s, 4s, 8s, 16s, 16s, ...
 * Cap at 16s so we don't drift into minute-scale delays after a long outage.
 */
function delayForAttempt(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 16_000);
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
  // Reconnect bookkeeping (Task 11). `reconnectAttempt` is the count of
  // consecutive failed attempts since the last success — it drives the
  // backoff schedule and resets to 0 on a successful `connect()`.
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;

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
      // Successful connect clears any lingering backoff counter so a later
      // failure starts its reconnect schedule from 1s, not wherever a
      // previous unhealthy window left off.
      this.reconnectAttempt = 0;
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
   *
   * If the SDK call throws, we return `MCP_SERVER_UNAVAILABLE` and mark the
   * connection unhealthy rather than propagating — Task 13's plugin layer
   * surfaces this as a tool error, not a chat-crashing exception.
   */
  async listTools(): Promise<ListToolsResult> {
    // An already-unhealthy connection returns UNAVAILABLE immediately
    // rather than throwing `mcp-not-ready` — that keeps callers on a
    // single happy-path for handling server outages (check `ok`, move on)
    // instead of forcing them to catch a second error type. `disconnected`
    // / `connecting` / `closed` are still programming errors and throw.
    if (this._state === 'unhealthy') {
      return {
        ok: false,
        code: 'MCP_SERVER_UNAVAILABLE',
        reason: `connection for '${this.serverId}' is unhealthy`,
      };
    }
    this.assertReady('listTools');
    let res;
    try {
      res = await this.client!.listTools();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.markUnhealthy(reason);
      return { ok: false, code: 'MCP_SERVER_UNAVAILABLE', reason };
    }
    const tools: McpToolDescriptor[] = res.tools.map((t) => {
      const out: McpToolDescriptor = {
        name: t.name,
        inputSchema: t.inputSchema,
      };
      if (t.description !== undefined) out.description = t.description;
      return out;
    });
    return { ok: true, tools };
  }

  /**
   * Invoke a tool on the server. Returns the raw SDK result wrapped in a
   * discriminated union — Task 13 normalizes the `ok: true` branch into the
   * @ax/core tool-result shape.
   *
   * We distinguish thrown errors (transport failure → mark unhealthy,
   * return `ok: false`) from SDK-returned `{ isError: true }` (server-side
   * tool failure → pass through as `ok: true`). Conflating them would
   * brick the connection every time the model called a tool with bad
   * arguments.
   */
  async callTool(name: string, args: unknown): Promise<ToolCallResult> {
    // Short-circuit on an already-unhealthy connection — see listTools()
    // for the rationale. Still throws `mcp-not-ready` on disconnected /
    // connecting / closed (those are programming errors).
    if (this._state === 'unhealthy') {
      return {
        ok: false,
        code: 'MCP_SERVER_UNAVAILABLE',
        reason: `connection for '${this.serverId}' is unhealthy`,
      };
    }
    this.assertReady('callTool');
    try {
      const result = await this.client!.callTool({ name, arguments: args });
      return { ok: true, result };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.markUnhealthy(reason);
      return { ok: false, code: 'MCP_SERVER_UNAVAILABLE', reason };
    }
  }

  /**
   * Tear down the connection. Idempotent: calling again after `closed` is
   * a no-op. We mark state BEFORE calling `client.close()` so a caller in
   * a `finally` block can't race with another caller's connect() — once
   * we say "closed", we mean it.
   *
   * Also clears any pending reconnect timer so the background loop stops —
   * otherwise a timer fired after disconnect would try to `connect()` a
   * connection that's been explicitly torn down (which now rejects with
   * `mcp-closed`, but is still noise we don't need).
   */
  async disconnect(): Promise<void> {
    if (this._state === 'closed') return;
    this._state = 'closed';
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
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

  /**
   * Flip to `unhealthy` and schedule the next reconnect. Idempotent: if
   * we're already unhealthy (a previous call in the same batch already
   * tripped us), leave the existing timer alone — we don't want to reset
   * the backoff clock on every failed request, just the first one in a
   * failure window.
   */
  private markUnhealthy(reason: string): void {
    if (this._state === 'closed') return;
    this.opts.ctx.logger.warn('mcp_connection_unhealthy', {
      serverId: this.serverId,
      reason,
    });
    this._state = 'unhealthy';
    if (this.reconnectTimer !== undefined) return;
    const delay = delayForAttempt(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      void this.attemptReconnect();
    }, delay);
  }

  /**
   * Background reconnect: fire and forget. If `connect()` succeeds, state
   * lands on `ready` and the counter resets (handled inside `connect()`).
   * If it throws, `connect()` has already marked us `unhealthy` again,
   * and we increment the counter and schedule the next attempt using the
   * doubled delay.
   *
   * No-op if `disconnect()` happened while we were waiting — the caller
   * explicitly tore down, and scheduling another attempt would fight them.
   */
  private async attemptReconnect(): Promise<void> {
    this.reconnectTimer = undefined;
    if (this.isClosed()) return;
    try {
      await this.connect();
      // connect() already reset reconnectAttempt to 0.
    } catch {
      // connect() left us in 'unhealthy'. Bump the counter and schedule
      // the next attempt — unless disconnect() ran during the await.
      if (this.isClosed()) return;
      this.reconnectAttempt += 1;
      const delay = delayForAttempt(this.reconnectAttempt);
      this.reconnectTimer = setTimeout(() => {
        void this.attemptReconnect();
      }, delay);
    }
  }

  /**
   * Runtime check used to re-read `_state` across an `await` boundary.
   * TypeScript narrows local `this._state` reads based on control flow
   * and assumes the value can't change — which isn't true when we yield
   * to the event loop and a concurrent `disconnect()` can flip us to
   * 'closed'. This helper returns a fresh read without the narrowing.
   */
  private isClosed(): boolean {
    return this._state === 'closed';
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
