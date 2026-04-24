// ---------------------------------------------------------------------------
// Connection manager tests (Task 10).
//
// We exercise the real SDK Client end-to-end by pairing it with the SDK's
// InMemoryTransport and a real `Server` instance on the other side. This is
// the cleanest way to check that state transitions line up with what the SDK
// actually does during connect/initialize — a raw mock of the Client would
// silently pass even if we confused `.connect()` semantics.
//
// For the failure path (`connect()` against an unreachable transport) we use
// a stub transport whose `start()` throws — no subprocess or socket required.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { makeChatContext, PluginError, type ChatContext } from '@ax/core';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpConnection } from '../connection.js';
import type { BusLike, McpClientTransport } from '../transports.js';
import type { McpServerConfig } from '../config.js';

function ctx(): ChatContext {
  return makeChatContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

// A bus stub — the connection manager itself never calls credentials:get
// (the transport factory does), but the transportFactory seam needs *some*
// bus to pass through. Fail loudly if anything unexpected arrives.
const unusedBus: BusLike = {
  async call() {
    throw new Error('bus.call should not be invoked in these tests');
  },
};

function stdioConfig(id = 'fake'): McpServerConfig {
  return {
    id,
    enabled: true,
    transport: 'stdio',
    command: 'not-a-real-command',
    args: [],
  };
}

/**
 * Stand up a fake MCP server with one tool, paired via InMemoryTransport to
 * a client transport we hand back for the connection manager to use.
 *
 * Returns a `dispose` that closes the server so tests don't leak a listener.
 */
async function makeLinkedServer(opts?: {
  tools?: Array<{ name: string; description?: string; inputSchema: object }>;
  callResult?: (args: unknown) => unknown;
}): Promise<{
  clientTransport: McpClientTransport;
  dispose: () => Promise<void>;
}> {
  const tools = opts?.tools ?? [
    {
      name: 'echo',
      description: 'echoes its input',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ];

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = new Server(
    { name: 'fake-mcp', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const callResult =
      opts?.callResult ??
      ((args: unknown) => ({
        content: [
          { type: 'text' as const, text: String((args as { text?: unknown })?.text ?? '') },
        ],
      }));
    return callResult(req.params.arguments) as {
      content: Array<{ type: 'text'; text: string }>;
    };
  });

  await server.connect(serverTransport);

  return {
    // The SDK's pairing transport satisfies the Transport interface the
    // client uses, and nothing in McpConnection reaches into stdio/http
    // specific fields, so casting through the union is safe.
    clientTransport: clientTransport as unknown as McpClientTransport,
    dispose: async () => {
      await server.close();
    },
  };
}

describe('McpConnection', () => {
  it('initial state is disconnected', () => {
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => {
        throw new Error('not used');
      },
    });
    expect(conn.state).toBe('disconnected');
  });

  it('connect() transitions to ready and listTools() returns advertised tools', async () => {
    const { clientTransport, dispose } = await makeLinkedServer();
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => clientTransport,
    });
    try {
      await conn.connect();
      expect(conn.state).toBe('ready');

      const tools = await conn.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('echo');
      expect(tools[0]?.description).toBe('echoes its input');
    } finally {
      await conn.disconnect();
      await dispose();
    }
  });

  it('callTool() round-trips a call + response', async () => {
    const { clientTransport, dispose } = await makeLinkedServer();
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => clientTransport,
    });
    try {
      await conn.connect();
      const result = (await conn.callTool('echo', { text: 'hello' })) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    } finally {
      await conn.disconnect();
      await dispose();
    }
  });

  it('disconnect() transitions to closed and is idempotent', async () => {
    const { clientTransport, dispose } = await makeLinkedServer();
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => clientTransport,
    });
    await conn.connect();
    await conn.disconnect();
    expect(conn.state).toBe('closed');
    // Second call is a no-op — must not throw.
    await expect(conn.disconnect()).resolves.toBeUndefined();
    expect(conn.state).toBe('closed');
    await dispose();
  });

  it('listTools() before connect() throws mcp-not-ready', async () => {
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => {
        throw new Error('not used');
      },
    });
    await expect(conn.listTools()).rejects.toMatchObject({
      name: 'PluginError',
      code: 'mcp-not-ready',
      plugin: '@ax/mcp-client',
    });
  });

  it('callTool() before connect() throws mcp-not-ready', async () => {
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => {
        throw new Error('not used');
      },
    });
    await expect(conn.callTool('echo', { text: 'x' })).rejects.toMatchObject({
      name: 'PluginError',
      code: 'mcp-not-ready',
    });
  });

  it('connect() against an unreachable transport throws mcp-connect-failed and marks unhealthy', async () => {
    // Transport whose start() fails — the Client's `connect()` invokes
    // start() before sending `initialize`, so this rejects during connect.
    const brokenTransport: Transport = {
      async start() {
        throw new Error('simulated transport start failure');
      },
      async send() {
        /* never reached */
      },
      async close() {
        /* no-op */
      },
    };

    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => brokenTransport as unknown as McpClientTransport,
    });

    await expect(conn.connect()).rejects.toMatchObject({
      name: 'PluginError',
      code: 'mcp-connect-failed',
      plugin: '@ax/mcp-client',
    });
    expect(conn.state).toBe('unhealthy');
  });

  it('connect() when already connecting or ready throws mcp-already-connected', async () => {
    const { clientTransport, dispose } = await makeLinkedServer();
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => clientTransport,
    });
    try {
      await conn.connect();
      expect(conn.state).toBe('ready');
      await expect(conn.connect()).rejects.toBeInstanceOf(PluginError);
      await expect(conn.connect()).rejects.toMatchObject({
        code: 'mcp-already-connected',
      });
    } finally {
      await conn.disconnect();
      await dispose();
    }
  });

  it('connect() failure preserves structured cause chain', async () => {
    const inner = new Error('dns nxdomain');
    const brokenTransport: Transport = {
      async start() {
        throw inner;
      },
      async send() {},
      async close() {},
    };
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => brokenTransport as unknown as McpClientTransport,
    });
    try {
      await conn.connect();
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as Error).message).toContain('dns nxdomain');
      expect((err as Error).cause).toBe(inner);
    }
  });
});
