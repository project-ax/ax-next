#!/usr/bin/env node
/**
 * Minimal stdio MCP server stub.
 *
 * This module is built to `dist/mcp-server-stub.js` and spawned as a
 * subprocess (via `node <path>`) by acceptance tests that need to drive
 * the real `StdioClientTransport` codepath — e.g. Task 18's MCP tool e2e
 * test. The MCP SDK's in-memory transports are fine for unit tests but
 * do not exercise subprocess spawn / stdio framing / process-death, which
 * is exactly what the acceptance tests care about.
 *
 * Tools exposed:
 *   - `echo`  — returns the `text` argument verbatim.
 *   - `crash` — calls `process.exit(1)` to simulate a server dying mid-call.
 *
 * Keep this stub tiny. If a test needs a more elaborate server, write a
 * second stub rather than piling features into this one.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [
  {
    name: 'echo',
    description: 'echo the input text verbatim',
    inputSchema: {
      type: 'object' as const,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'crash',
    description: 'exit the server process with code 1 (dead-server test)',
    inputSchema: { type: 'object' as const },
  },
];

async function main(): Promise<void> {
  const server = new Server(
    { name: 'ax-test-mcp-server-stub', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (name === 'echo') {
      const text = typeof args['text'] === 'string' ? args['text'] : String(args['text'] ?? '');
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'crash') {
      // Hard-exit to simulate the server dying mid-test. Flush stderr
      // first so anything the SDK logged isn't lost in CI output.
      process.stderr.write('mcp-server-stub: crash tool invoked, exiting with code 1\n');
      process.exit(1);
    }

    return {
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `mcp-server-stub fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(2);
});
