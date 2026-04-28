// ---------------------------------------------------------------------------
// Plugin init wiring tests (Task 13).
//
// These exercise the centerpiece of `@ax/mcp-client`: on init, the plugin
// reads MCP server configs from storage, spawns an `McpConnection` per
// enabled config, lists tools, namespaces them, and registers both
// `tool:register` (declarative) and `tool:execute:${namespacedName}`
// (dynamic service hooks) so the dispatcher + IPC layer can route tool
// calls to the right MCP server.
//
// Boot shape mirrors `@ax/credentials`'s plugin test: an in-memory storage
// plugin + credentials plugin + tool-dispatcher + the plugin under test,
// run through `bootstrap()` so manifest / graph validation happens for real.
// The transport layer is replaced via the `transportFactory` test seam —
// each enabled config maps to a pre-linked InMemoryTransport paired with
// a real `Server` on the other side.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
  type ToolCall,
  type ToolDescriptor,
} from '@ax/core';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createCredentialsPlugin } from '@ax/credentials';
import { createToolDispatcherPlugin } from '@ax/tool-dispatcher';
import { createMcpClientPlugin } from '../plugin.js';
import { saveConfig } from '../config.js';
import type { McpClientTransport } from '../transports.js';

const TEST_KEY_HEX = '42'.repeat(32);

function ctx(): AgentContext {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

// Minimal in-memory storage plugin — mirrors the credentials test shape.
function memStoragePlugin(): Plugin {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: ['storage:get', 'storage:set'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService(
        'storage:get',
        'mem-storage',
        async (_ctx, input) => {
          const { key } = input as { key: string };
          return { value: store.get(key) };
        },
      );
      bus.registerService(
        'storage:set',
        'mem-storage',
        async (_ctx, input) => {
          const { key, value } = input as { key: string; value: Uint8Array };
          store.set(key, value);
        },
      );
    },
  };
}

interface FakeServerHandle {
  clientTransport: McpClientTransport;
  /** Close the underlying server — flips the client into unhealthy on next call. */
  dispose: () => Promise<void>;
}

async function makeFakeMcpServer(opts: {
  tools: Array<{ name: string; description?: string; inputSchema: object }>;
  callResult?: (name: string, args: unknown) => unknown;
}): Promise<FakeServerHandle> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: 'fake-mcp', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: opts.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const fn =
      opts.callResult ??
      ((_name: string, args: unknown) => ({
        content: [
          { type: 'text' as const, text: String((args as { text?: unknown })?.text ?? '') },
        ],
      }));
    return fn(req.params.name, req.params.arguments) as {
      content: Array<{ type: 'text'; text: string }>;
    };
  });
  await server.connect(serverTransport);
  return {
    clientTransport: clientTransport as unknown as McpClientTransport,
    dispose: async () => {
      await server.close();
    },
  };
}

describe('@ax/mcp-client plugin', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });
  afterEach(() => {
    delete process.env.AX_CREDENTIALS_KEY;
  });

  it('registers namespaced tools for each enabled MCP server on init', async () => {
    const bus = new HookBus();
    const storage = memStoragePlugin();

    // Stand up two fake servers BEFORE bootstrapping so the transportFactory
    // has linked pairs ready to hand out.
    const serverA = await makeFakeMcpServer({
      tools: [
        {
          name: 'echo',
          description: 'echoes',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
        {
          name: 'reverse',
          description: 'reverses',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ],
    });
    const serverB = await makeFakeMcpServer({
      tools: [
        {
          name: 'ping',
          description: 'pings',
          inputSchema: { type: 'object' },
        },
      ],
    });

    // Bootstrap storage + credentials first so saveConfig can write.
    await bootstrap({
      bus,
      plugins: [storage, createCredentialsPlugin()],
      config: {},
    });

    // Seed two enabled configs pointing at serverA + serverB respectively.
    await saveConfig(bus, ctx(), {
      id: 'a',
      enabled: true,
      transport: 'stdio',
      command: 'ignored',
      args: [],
    });
    await saveConfig(bus, ctx(), {
      id: 'b',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    });

    // Now init the dispatcher + MCP client — the plugin will call loadConfigs
    // and, for each config, ask the transportFactory for a transport.
    const dispatcher = createToolDispatcherPlugin();
    await dispatcher.init({ bus, config: undefined });
    const byId = new Map<string, McpClientTransport>([
      ['a', serverA.clientTransport],
      ['b', serverB.clientTransport],
    ]);
    const mcp = createMcpClientPlugin({
      transportFactory: async ({ config }) => {
        const t = byId.get(config.id);
        if (t === undefined) throw new Error(`no fake transport for ${config.id}`);
        return t;
      },
    });
    await mcp.init({ bus, config: undefined });

    const listed = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual(['mcp.a.echo', 'mcp.a.reverse', 'mcp.b.ping']);

    // executesIn + schema + description preserved verbatim.
    for (const d of listed.tools) {
      expect(d.executesIn).toBe('host');
    }
    const echo = listed.tools.find((t) => t.name === 'mcp.a.echo')!;
    expect(echo.description).toBe('echoes');
    expect(echo.inputSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
    });

    await serverA.dispose();
    await serverB.dispose();
  });

  it('tool:execute:${namespacedName} routes to the right MCP server and returns { output }', async () => {
    const bus = new HookBus();
    const serverA = await makeFakeMcpServer({
      tools: [
        {
          name: 'echo',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ],
      callResult: (_name, args) => ({
        content: [
          { type: 'text' as const, text: `A:${String((args as { text?: unknown })?.text ?? '')}` },
        ],
      }),
    });
    const serverB = await makeFakeMcpServer({
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      callResult: (_name, args) => ({
        content: [
          { type: 'text' as const, text: `B:${String((args as { text?: unknown })?.text ?? '')}` },
        ],
      }),
    });

    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsPlugin()],
      config: {},
    });
    await saveConfig(bus, ctx(), {
      id: 'a',
      enabled: true,
      transport: 'stdio',
      command: 'x',
      args: [],
    });
    await saveConfig(bus, ctx(), {
      id: 'b',
      enabled: true,
      transport: 'stdio',
      command: 'x',
      args: [],
    });

    await createToolDispatcherPlugin().init({ bus, config: undefined });

    const byId = new Map([
      ['a', serverA.clientTransport],
      ['b', serverB.clientTransport],
    ]);
    await createMcpClientPlugin({
      transportFactory: async ({ config }) => byId.get(config.id)!,
    }).init({ bus, config: undefined });

    // Same remote tool name on both servers — namespacing keeps them distinct.
    const call: ToolCall = { id: 'c1', name: 'mcp.a.echo', input: { text: 'hello' } };
    const resA = await bus.call<ToolCall, { output: unknown }>(
      'tool:execute:mcp.a.echo',
      ctx(),
      call,
    );
    expect(resA.output).toMatchObject({
      content: [{ type: 'text', text: 'A:hello' }],
    });

    const callB: ToolCall = { id: 'c2', name: 'mcp.b.echo', input: { text: 'hello' } };
    const resB = await bus.call<ToolCall, { output: unknown }>(
      'tool:execute:mcp.b.echo',
      ctx(),
      callB,
    );
    expect(resB.output).toMatchObject({
      content: [{ type: 'text', text: 'B:hello' }],
    });

    await serverA.dispose();
    await serverB.dispose();
  });

  it('disabled configs contribute zero tools', async () => {
    const bus = new HookBus();
    const serverA = await makeFakeMcpServer({
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    });
    // serverB configured-disabled: plugin should not connect to it, so we
    // don't even hand it a linked transport — if the plugin tries to pull
    // one, transportFactory throws and the assertion catches that.
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsPlugin()],
      config: {},
    });
    await saveConfig(bus, ctx(), {
      id: 'a',
      enabled: true,
      transport: 'stdio',
      command: 'x',
      args: [],
    });
    await saveConfig(bus, ctx(), {
      id: 'disabled-one',
      enabled: false,
      transport: 'stdio',
      command: 'x',
      args: [],
    });

    await createToolDispatcherPlugin().init({ bus, config: undefined });
    await createMcpClientPlugin({
      transportFactory: async ({ config }) => {
        if (config.id !== 'a') {
          throw new Error(`transportFactory should not be called for '${config.id}'`);
        }
        return serverA.clientTransport;
      },
    }).init({ bus, config: undefined });

    const listed = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(listed.tools.map((t) => t.name)).toEqual(['mcp.a.echo']);

    await serverA.dispose();
  });

  it('tool:execute returns a MCP_SERVER_UNAVAILABLE tool-error result when the server dies', async () => {
    const bus = new HookBus();
    const serverA = await makeFakeMcpServer({
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    });

    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsPlugin()],
      config: {},
    });
    await saveConfig(bus, ctx(), {
      id: 'a',
      enabled: true,
      transport: 'stdio',
      command: 'x',
      args: [],
    });

    await createToolDispatcherPlugin().init({ bus, config: undefined });
    await createMcpClientPlugin({
      transportFactory: async () => serverA.clientTransport,
    }).init({ bus, config: undefined });

    // Kill the server so the underlying callTool errors out.
    await serverA.dispose();

    const call: ToolCall = { id: 'c', name: 'mcp.a.echo', input: { text: 'hi' } };
    const res = await bus.call<ToolCall, { output: unknown }>(
      'tool:execute:mcp.a.echo',
      ctx(),
      call,
    );
    // Shape the model sees: isError:true + a text content describing the
    // outage. Matches the pattern tool-error results use elsewhere (so
    // providers that already render isError get this for free).
    expect(res.output).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringMatching(/unavailable/i),
        },
      ],
    });
    const text = (res.output as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("'a'");
  });

  it('one server failing to connect does not prevent other servers from coming up', async () => {
    const bus = new HookBus();
    const serverGood = await makeFakeMcpServer({
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    });

    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsPlugin()],
      config: {},
    });
    await saveConfig(bus, ctx(), {
      id: 'broken',
      enabled: true,
      transport: 'stdio',
      command: 'x',
      args: [],
    });
    await saveConfig(bus, ctx(), {
      id: 'good',
      enabled: true,
      transport: 'stdio',
      command: 'x',
      args: [],
    });

    await createToolDispatcherPlugin().init({ bus, config: undefined });

    // Swallow stdout warnings emitted by the default logger during init so
    // the test output isn't polluted with the expected `mcp_init_connect_failed`
    // record.
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await createMcpClientPlugin({
        transportFactory: async ({ config }) => {
          if (config.id === 'broken') {
            return {
              async start() {
                throw new Error('boom');
              },
              async send() {},
              async close() {},
            } as unknown as McpClientTransport;
          }
          return serverGood.clientTransport;
        },
      }).init({ bus, config: undefined });
    } finally {
      process.stdout.write = origWrite;
    }

    const listed = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(listed.tools.map((t) => t.name)).toEqual(['mcp.good.echo']);

    // And the healthy server's tool actually works.
    const call: ToolCall = { id: 'c', name: 'mcp.good.echo', input: { text: 'ok' } };
    const res = await bus.call<ToolCall, { output: unknown }>(
      'tool:execute:mcp.good.echo',
      ctx(),
      call,
    );
    expect(res.output).toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });

    await serverGood.dispose();
  });

  it('warns at init when a streamable-http config uses plain http://', async () => {
    const bus = new HookBus();

    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsPlugin()],
      config: {},
    });
    await saveConfig(bus, ctx(), {
      id: 'plain',
      enabled: true,
      transport: 'streamable-http',
      url: 'http://example.invalid/mcp',
    });

    await createToolDispatcherPlugin().init({ bus, config: undefined });

    // Capture stdout so we can assert the warn log was emitted. The connect
    // itself is expected to fail (we reject in transportFactory) — that's
    // fine; the warn fires BEFORE connect(), so it's still on the tape.
    const captured: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      captured.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await createMcpClientPlugin({
        transportFactory: async () => {
          throw new Error('unreachable — warn should still fire');
        },
      }).init({ bus, config: undefined });
    } finally {
      process.stdout.write = origWrite;
    }

    const matched = captured.filter((line) => /plain HTTP|cleartext/i.test(line));
    expect(matched.length).toBeGreaterThan(0);
  });

  it('does NOT warn when a streamable-http config uses https://', async () => {
    const bus = new HookBus();
    const serverA = await makeFakeMcpServer({
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    });

    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsPlugin()],
      config: {},
    });
    await saveConfig(bus, ctx(), {
      id: 'secure',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    });

    await createToolDispatcherPlugin().init({ bus, config: undefined });

    const captured: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      captured.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await createMcpClientPlugin({
        transportFactory: async () => serverA.clientTransport,
      }).init({ bus, config: undefined });
    } finally {
      process.stdout.write = origWrite;
    }

    const matched = captured.filter((line) => /plain HTTP|cleartext/i.test(line));
    expect(matched).toEqual([]);

    await serverA.dispose();
  });

  it('manifest declares the expected calls and no static registers', async () => {
    const plugin = createMcpClientPlugin();
    expect(plugin.manifest).toMatchObject({
      name: '@ax/mcp-client',
      version: '0.0.0',
      registers: [],
      calls: expect.arrayContaining([
        'tool:register',
        'storage:get',
        'storage:set',
        'credentials:get',
      ]),
      subscribes: [],
    });
  });
});
