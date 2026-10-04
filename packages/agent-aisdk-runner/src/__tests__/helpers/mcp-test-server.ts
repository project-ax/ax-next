// In-process streamable-HTTP MCP server for the connector tests. Stateless
// mode (fresh Server + transport per request), same shape as
// @ax/test-harness's mcp-http-server-stub — but in-process and configurable,
// so a test can capture request headers, page `tools/list`, force an HTTP
// status, or hand back `isError` results.
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
  close(): Promise<void>;
}

export async function startMcpTestServer(opts: {
  tools: TestTool[];
  /** Page `tools/list` this many tools at a time (cursor = start index). */
  pageSize?: number;
  /** Answer EVERY request with this bare status instead of speaking MCP. */
  status?: number;
}): Promise<McpTestServer> {
  const seenHeaders: IncomingHttpHeaders[] = [];
  const listed = opts.tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: t.inputSchema ?? { type: 'object' },
  }));

  const makeServer = (): Server => {
    const server = new Server({ name: 'ax-aisdk-test-mcp', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
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
    close: () =>
      new Promise<void>((resolve) => {
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
