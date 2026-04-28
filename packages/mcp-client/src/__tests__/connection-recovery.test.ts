// ---------------------------------------------------------------------------
// Dead-server + reconnect-backoff tests (Task 11).
//
// Two failure surfaces to cover:
//
//   1. An underlying `client.callTool()` / `client.listTools()` throws
//      (transport closed, socket died, server crashed). We must NOT let
//      that throw escape: surface it as a discriminated MCP_SERVER_UNAVAILABLE
//      so the chat keeps going and the model sees a tool error.
//
//   2. Once unhealthy, we reconnect in the background with exponential
//      backoff: 1s, 2s, 4s, 8s, 16s cap. Successful connect resets the
//      attempt counter. `disconnect()` cancels the loop so operators can
//      tear a connection down cleanly.
//
// Fake timers let us watch the backoff without real waits. Each reconnect
// attempt goes through the transportFactory seam, which we reuse as a
// per-attempt hook to fail or succeed on demand.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentContext, type AgentContext } from '@ax/core';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpConnection, type SdkClientLike } from '../connection.js';
import type { BusLike, McpClientTransport } from '../transports.js';
import type { McpServerConfig } from '../config.js';

function ctx(): AgentContext {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

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
 * Stand up a linked pair (client + server) so we can exercise the happy
 * path through the real SDK and then kill the server mid-flight.
 */
async function makeLinkedServer(): Promise<{
  clientTransport: McpClientTransport;
  dispose: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: 'fake-mcp', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'echoes',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [
      {
        type: 'text' as const,
        text: String((req.params.arguments as { text?: unknown })?.text ?? ''),
      },
    ],
  }));
  await server.connect(serverTransport);
  return {
    clientTransport: clientTransport as unknown as McpClientTransport,
    dispose: async () => {
      await server.close();
    },
  };
}

describe('McpConnection — MCP_SERVER_UNAVAILABLE on in-flight failure', () => {
  it('callTool() returns MCP_SERVER_UNAVAILABLE when the underlying client throws', async () => {
    // Stub client whose callTool throws — simulates a transport error
    // without having to race server close against the call.
    const stubClient: SdkClientLike = {
      async connect() {},
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        throw new Error('boom: transport closed');
      },
      async close() {},
    };
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => ({ close: async () => {} }) as unknown as McpClientTransport,
      clientFactory: () => stubClient,
    });
    await conn.connect();
    expect(conn.state).toBe('ready');

    const res = await conn.callTool('echo', { text: 'x' });
    expect(res).toEqual({
      ok: false,
      code: 'MCP_SERVER_UNAVAILABLE',
      reason: expect.stringContaining('boom: transport closed'),
    });
    expect(conn.state).toBe('unhealthy');

    await conn.disconnect();
  });

  it('listTools() returns MCP_SERVER_UNAVAILABLE when the underlying client throws', async () => {
    let listCount = 0;
    const stubClient: SdkClientLike = {
      async connect() {},
      async listTools() {
        listCount += 1;
        throw new Error('list failed');
      },
      async callTool() {
        return {};
      },
      async close() {},
    };
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => ({ close: async () => {} }) as unknown as McpClientTransport,
      clientFactory: () => stubClient,
    });
    await conn.connect();

    const res = await conn.listTools();
    expect(res).toEqual({
      ok: false,
      code: 'MCP_SERVER_UNAVAILABLE',
      reason: expect.stringContaining('list failed'),
    });
    expect(conn.state).toBe('unhealthy');
    expect(listCount).toBe(1);

    await conn.disconnect();
  });

  it('callTool() on an already-unhealthy connection returns UNAVAILABLE without calling the client', async () => {
    // After the first failure marks us unhealthy, subsequent calls should
    // short-circuit with the structured error — callers only need one
    // happy-path for "server is down," not two (thrown + returned).
    let callCount = 0;
    const stubClient: SdkClientLike = {
      async connect() {},
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        callCount += 1;
        throw new Error('first call died');
      },
      async close() {},
    };
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => ({ close: async () => {} }) as unknown as McpClientTransport,
      clientFactory: () => stubClient,
    });
    await conn.connect();
    const first = await conn.callTool('echo', {});
    expect(first.ok).toBe(false);
    expect(callCount).toBe(1);
    expect(conn.state).toBe('unhealthy');

    const second = await conn.callTool('echo', {});
    expect(second).toEqual({
      ok: false,
      code: 'MCP_SERVER_UNAVAILABLE',
      reason: expect.stringContaining('unhealthy'),
    });
    // Did NOT reach the underlying client — short-circuited on state.
    expect(callCount).toBe(1);

    await conn.disconnect();
  });

  it('callTool() passes through an SDK-returned isError result without marking unhealthy', async () => {
    // Server-side tool error: the mechanical RPC succeeded, the tool just
    // reported a semantic failure. This is NOT a connection problem.
    const stubClient: SdkClientLike = {
      async connect() {},
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return {
          isError: true,
          content: [{ type: 'text', text: 'tool says no' }],
        };
      },
      async close() {},
    };
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => ({ close: async () => {} }) as unknown as McpClientTransport,
      clientFactory: () => stubClient,
    });
    await conn.connect();

    const res = await conn.callTool('echo', {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.result).toMatchObject({ isError: true });
    expect(conn.state).toBe('ready');

    await conn.disconnect();
  });
});

describe('McpConnection — reconnect backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules reconnect attempts with 1s, 2s, 4s, 8s, 16s (capped) backoff', async () => {
    // Track each RECONNECT transportFactory call so we can assert when the
    // backoff timer fires. We ignore the initial `connect()` call by
    // clearing the array just before we induce failure.
    let attemptTimes: number[] = [];
    let t0 = 0;
    const stubClient: SdkClientLike = {
      async connect() {},
      async listTools() {
        throw new Error('always fails');
      },
      async callTool() {
        throw new Error('always fails');
      },
      async close() {},
    };
    let isInitialConnect = true;
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => {
        if (isInitialConnect) {
          return { close: async () => {} } as unknown as McpClientTransport;
        }
        attemptTimes.push(Date.now() - t0);
        throw new Error('transport unreachable');
      },
      clientFactory: () => stubClient,
    });

    // Fresh connect succeeds (transportFactory returns a stub, stubClient
    // .connect resolves).
    await conn.connect();
    expect(conn.state).toBe('ready');

    // Subsequent transportFactory calls now fail. Reset the clock so every
    // subsequent assertion is relative to the moment we induced failure.
    isInitialConnect = false;
    t0 = Date.now();
    attemptTimes = [];

    // Now induce failure via callTool — state flips to unhealthy, reconnect
    // scheduled for t+1s.
    const first = await conn.callTool('echo', {});
    expect(first.ok).toBe(false);
    expect(conn.state).toBe('unhealthy');

    // Advance through the backoff schedule. Each tick fires the timer,
    // transportFactory rejects, connect() re-marks unhealthy, next timer
    // is scheduled with doubled delay capped at 16s.
    //
    // attempt 1 fires at t+1s
    await vi.advanceTimersByTimeAsync(1000);
    expect(attemptTimes).toEqual([1000]);
    expect(conn.state).toBe('unhealthy');

    // attempt 2 at t+3s (1+2)
    await vi.advanceTimersByTimeAsync(2000);
    expect(attemptTimes).toEqual([1000, 3000]);

    // attempt 3 at t+7s (1+2+4)
    await vi.advanceTimersByTimeAsync(4000);
    expect(attemptTimes).toEqual([1000, 3000, 7000]);

    // attempt 4 at t+15s (1+2+4+8)
    await vi.advanceTimersByTimeAsync(8000);
    expect(attemptTimes).toEqual([1000, 3000, 7000, 15000]);

    // attempt 5 at t+31s (+16s)
    await vi.advanceTimersByTimeAsync(16000);
    expect(attemptTimes).toEqual([1000, 3000, 7000, 15000, 31000]);

    // attempt 6 at t+47s — cap stays at 16s
    await vi.advanceTimersByTimeAsync(16000);
    expect(attemptTimes).toEqual([1000, 3000, 7000, 15000, 31000, 47000]);

    await conn.disconnect();
  });

  it('successful reconnect returns state to ready and resets the attempt counter', async () => {
    // The 3rd reconnect attempt (after initial failure) succeeds. After
    // recovery, another failure should schedule the NEXT reconnect 1s out,
    // not 8s — the counter resets.
    let attempt = 0;
    let workingTransport: McpClientTransport | null = null;

    const stubClient: SdkClientLike = {
      async connect() {},
      async listTools() {
        return { tools: [{ name: 'echo', inputSchema: {} }] };
      },
      async callTool() {
        // Fail on first call to flip us to unhealthy; succeed afterward.
        if (!callShouldSucceed) throw new Error('dead');
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      async close() {},
    };
    let callShouldSucceed = false;

    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => {
        attempt += 1;
        // Initial connect: attempt 1. Then 2 and 3 are reconnect attempts
        // that fail. Attempt 4 succeeds.
        if (attempt === 1) {
          workingTransport = { close: async () => {} } as unknown as McpClientTransport;
          return workingTransport;
        }
        if (attempt <= 3) {
          throw new Error('still dead');
        }
        workingTransport = { close: async () => {} } as unknown as McpClientTransport;
        return workingTransport;
      },
      clientFactory: () => stubClient,
    });

    await conn.connect();
    expect(conn.state).toBe('ready');

    // Induce failure (call throws).
    const bad = await conn.callTool('echo', {});
    expect(bad.ok).toBe(false);
    expect(conn.state).toBe('unhealthy');

    // Attempt 2 @ +1s (fails), attempt 3 @ +3s (fails), attempt 4 @ +7s (ok).
    await vi.advanceTimersByTimeAsync(1000);
    expect(conn.state).toBe('unhealthy');
    expect(attempt).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(conn.state).toBe('unhealthy');
    expect(attempt).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(conn.state).toBe('ready');
    expect(attempt).toBe(4);

    // Recovery verified — a call should now succeed.
    callShouldSucceed = true;
    const recovered = await conn.callTool('echo', {});
    expect(recovered.ok).toBe(true);

    // Now induce another failure and verify the next reconnect fires at
    // +1s (counter was reset), not +16s (where it would have been if the
    // counter kept climbing).
    callShouldSucceed = false;
    const bad2 = await conn.callTool('echo', {});
    expect(bad2.ok).toBe(false);
    expect(conn.state).toBe('unhealthy');
    const attemptsBefore = attempt;
    await vi.advanceTimersByTimeAsync(999);
    expect(attempt).toBe(attemptsBefore); // hasn't fired yet
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toBe(attemptsBefore + 1); // fired at exactly +1s

    await conn.disconnect();
  });

  it('disconnect() clears the pending reconnect timer', async () => {
    let attempt = 0;
    const stubClient: SdkClientLike = {
      async connect() {},
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        throw new Error('dead');
      },
      async close() {},
    };
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => {
        attempt += 1;
        if (attempt === 1) {
          return { close: async () => {} } as unknown as McpClientTransport;
        }
        throw new Error('still dead');
      },
      clientFactory: () => stubClient,
    });

    await conn.connect();
    const res = await conn.callTool('echo', {});
    expect(res.ok).toBe(false);
    expect(conn.state).toBe('unhealthy');
    expect(attempt).toBe(1);

    // Tear down BEFORE the reconnect timer fires.
    await conn.disconnect();
    expect(conn.state).toBe('closed');

    // Advance way past any scheduled reconnect window. No new attempts
    // should fire — the timer was cleared.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toBe(1);
  });

  it('recovering client reports ready tools on listTools() after reconnect', async () => {
    // Sanity: after a recovery, listTools works and state is ready.
    let attempt = 0;
    let listShouldThrow = true;
    const stubClient: SdkClientLike = {
      async connect() {},
      async listTools() {
        if (listShouldThrow) throw new Error('list dead');
        return {
          tools: [
            { name: 'echo', description: 'echoes', inputSchema: { type: 'object' } },
          ],
        };
      },
      async callTool() {
        return {};
      },
      async close() {},
    };
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => {
        attempt += 1;
        return { close: async () => {} } as unknown as McpClientTransport;
      },
      clientFactory: () => stubClient,
    });

    await conn.connect();
    const bad = await conn.listTools();
    expect(bad.ok).toBe(false);
    expect(conn.state).toBe('unhealthy');

    // First reconnect attempt @ +1s. transportFactory + clientFactory
    // succeed, so connect() returns ready.
    listShouldThrow = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(conn.state).toBe('ready');
    expect(attempt).toBeGreaterThanOrEqual(2);

    const good = await conn.listTools();
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error('expected ok');
    expect(good.tools).toHaveLength(1);

    await conn.disconnect();
  });
});

describe('McpConnection — real SDK on closed transport', () => {
  // End-to-end integration: use the real SDK Client against a real Server
  // via InMemoryTransport. Close the server mid-flight and assert the client
  // manifests the failure as MCP_SERVER_UNAVAILABLE (not a thrown crash).
  //
  // This is the smoke test that the stub-based tests above model correctly.
  it('callTool() after server close returns MCP_SERVER_UNAVAILABLE', async () => {
    vi.useRealTimers();
    const { clientTransport, dispose } = await makeLinkedServer();
    const conn = new McpConnection({
      config: stdioConfig(),
      bus: unusedBus,
      ctx: ctx(),
      transportFactory: async () => clientTransport,
    });
    try {
      await conn.connect();
      // Close the server — this closes the linked pair, so the client's
      // transport goes down and any subsequent request errors out.
      await dispose();

      const res = await conn.callTool('echo', { text: 'hi' });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected not ok');
      expect(res.code).toBe('MCP_SERVER_UNAVAILABLE');
      expect(conn.state).toBe('unhealthy');
    } finally {
      await conn.disconnect();
    }
  });
});
