// In-process streamable-HTTP MCP server for the connector tests. Stateless
// by default (fresh Server + transport per request); `sessionful` keeps real
// MCP sessions so a test can make the server forget them. Configurable so a
// test can capture request headers, page `tools/list`, force an HTTP status,
// or hand back `isError` results.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

export interface TestTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler?: (
    args: Record<string, unknown>,
    /** The SDK's per-request context: `_meta.progressToken`, `sendNotification`, `signal`. */
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => Promise<CallToolResult> | CallToolResult;
}

export interface McpTestServer {
  url: string;
  /** Headers of every HTTP request the server received, in order. */
  seenHeaders: IncomingHttpHeaders[];
  /** JSON-RPC methods of every POST the server received, in order. */
  seenMethods: string[];
  /**
   * `sessionful` only: drop every live MCP session, as a server restart
   * would. Later requests carrying an old `mcp-session-id` get the SDK's
   * own answer for an unknown session: HTTP 404, JSON-RPC -32001.
   */
  forgetSessions(): Promise<void>;
  close(): Promise<void>;
}

export async function startMcpTestServer(opts: {
  tools: TestTool[];
  /** Page `tools/list` this many tools at a time (cursor = start index). */
  pageSize?: number;
  /** Answer EVERY request with this bare status instead of speaking MCP. */
  status?: number;
  /**
   * Answer requests for ONE JSON-RPC method (e.g. `tools/call`, `tools/list`)
   * with this HTTP status + raw body instead of speaking MCP — every other
   * method is answered normally. Models a server whose error page is huge
   * and attacker-authored.
   */
  methodError?: { method: string; status: number; body: string };
  /** Delay every `tools/list` answer by this long — a slow-to-list server. */
  listDelayMs?: number;
  /**
   * Called for every POST before it is answered. Return a status + body to
   * answer with that instead; await inside it to delay (or hang) the answer.
   */
  intercept?: (method: string | undefined) => Promise<{ status: number; body: string } | void> | { status: number; body: string } | void;
  /** Keep real MCP sessions (server-minted `mcp-session-id`) instead of answering statelessly. */
  sessionful?: boolean;
}): Promise<McpTestServer> {
  const seenHeaders: IncomingHttpHeaders[] = [];
  const seenMethods: string[] = [];
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  const listed = opts.tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: t.inputSchema ?? { type: 'object' },
  }));

  const makeServer = (): Server => {
    const server = new Server({ name: 'ax-aisdk-test-mcp', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      if (opts.listDelayMs !== undefined) await new Promise((r) => setTimeout(r, opts.listDelayMs));
      if (opts.pageSize === undefined) return { tools: listed as never };
      const start = Number(req.params?.cursor ?? '0');
      const end = start + opts.pageSize;
      return {
        tools: listed.slice(start, end) as never,
        ...(end < listed.length ? { nextCursor: String(end) } : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const t = opts.tools.find((x) => x.name === req.params.name);
      if (t?.handler === undefined) {
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
      }
      return t.handler((req.params.arguments ?? {}) as Record<string, unknown>, extra);
    });
    return server;
  };

  const http = createServer((req, res) => {
    seenHeaders.push(req.headers);
    if (opts.status !== undefined) {
      res.writeHead(opts.status).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : undefined;
        const method = (body as { method?: unknown } | undefined)?.method;
        if (typeof method === 'string') seenMethods.push(method);
        if (req.method === 'POST' && opts.intercept !== undefined) {
          const over = await opts.intercept(typeof method === 'string' ? method : undefined);
          if (over !== undefined) {
            res.writeHead(over.status, { 'content-type': 'text/plain' }).end(over.body);
            return;
          }
        }
        const me = opts.methodError;
        if (me !== undefined && (body as { method?: unknown } | undefined)?.method === me.method) {
          res.writeHead(me.status, { 'content-type': 'text/plain' }).end(me.body);
          return;
        }
        if (opts.sessionful === true) {
          const sid = req.headers['mcp-session-id'];
          const live = typeof sid === 'string' ? sessions.get(sid) : undefined;
          if (live !== undefined) {
            await live.transport.handleRequest(req, res, body);
            return;
          }
          if (sid !== undefined) {
            // Exactly what the SDK's own server answers for a session it does not know.
            res
              .writeHead(404, { 'content-type': 'application/json' })
              .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
            return;
          }
          const server = makeServer();
          const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { transport, server });
            },
          });
          await server.connect(transport as Transport);
          await transport.handleRequest(req, res, body);
          return;
        }
        const transport = new StreamableHTTPServerTransport({});
        const server = makeServer();
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, body);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenHeaders,
    seenMethods,
    forgetSessions: async () => {
      const live = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(live.flatMap((l) => [l.transport.close(), l.server.close()]));
    },
    close: () =>
      new Promise<void>((resolve) => {
        sessions.clear();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/** Accepts TCP connections and never answers — a wedged server. */
export async function startHangingServer(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const srv = createNetServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        srv.close(() => resolve());
      }),
  };
}
