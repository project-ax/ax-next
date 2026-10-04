#!/usr/bin/env node
/**
 * Minimal streamable-HTTP MCP server stub, run as a CHILD PROCESS so tests
 * exercise a real socket + a real process death. Listens on 127.0.0.1:0 and
 * prints `LISTENING <port>` on stdout once ready.
 *
 * Tools: `echo` (returns `text`), `crash` (process.exit(1) mid-request — the
 * listener dies with it, which is the dead-server case).
 *
 * Stateless: a fresh Server + transport per POST, so no session bookkeeping.
 * Keep it tiny; write a second stub rather than growing this one.
 */
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [
  {
    name: 'echo',
    description: 'echo the input text verbatim',
    inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'crash',
    description: 'exit the server process with code 1 (dead-server test)',
    inputSchema: { type: 'object' as const },
  },
];

function makeServer(): Server {
  const server = new Server({ name: 'ax-test-mcp-http-stub', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (req.params.name === 'echo') {
      const text = typeof args['text'] === 'string' ? args['text'] : String(args['text'] ?? '');
      return { content: [{ type: 'text', text }] };
    }
    if (req.params.name === 'crash') {
      process.stderr.write('mcp-http-server-stub: crash tool invoked, exiting with code 1\n');
      process.exit(1);
    }
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
  });
  return server;
}

const http = createServer((req, res) => {
  if (req.url !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    void (async () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : undefined;
      // No `sessionIdGenerator` = stateless mode. (Spelling it out as
      // `sessionIdGenerator: undefined` does not type-check under this repo's
      // `exactOptionalPropertyTypes`.)
      const transport = new StreamableHTTPServerTransport({});
      const server = makeServer();
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      // The SDK types this transport's `onclose` accessor as `(() => void) |
      // undefined`, which `exactOptionalPropertyTypes` rejects against the
      // `Transport` interface's `onclose?: () => void`. Same object, so cast.
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, body);
    })().catch((err: unknown) => {
      process.stderr.write(`mcp-http-server-stub: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
});

http.listen(0, '127.0.0.1', () => {
  const addr = http.address();
  if (addr === null || typeof addr === 'string') process.exit(2);
  process.stdout.write(`LISTENING ${addr.port}\n`);
});
