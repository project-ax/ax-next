import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  makeAgentContext,
  createLogger,
  type AgentContext,
  type ToolDescriptor,
} from '@ax/core';
import { createToolDispatcherPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// list-with-agent-scope.test — integration coverage for Task 7.
//
// We boot the tool-dispatcher into a HookBus, register a fake
// `session:get-config` service that returns a per-agent scope, and assert
// that `tool:list` filters its output accordingly. The cross-tenant test
// (two agents, two MCP servers) is the headline case: it pins the
// invariant that agent A cannot see agent B's MCP tools by virtue of
// shared catalog state.
// ---------------------------------------------------------------------------

const ctxFor = (
  overrides: Partial<{ sessionId: string; agentId: string; userId: string }> = {},
): AgentContext =>
  makeAgentContext({
    sessionId: overrides.sessionId ?? 's',
    agentId: overrides.agentId ?? 'a',
    userId: overrides.userId ?? 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
  });

interface SessionConfig {
  userId: string;
  agentId: string;
  agentConfig: {
    systemPrompt: string;
    allowedTools: string[];
    mcpConfigIds: string[];
    model: string;
  };
}

/** Register a fake session:get-config that hands back configs keyed by sessionId. */
function registerFakeSessionGetConfig(
  bus: HookBus,
  configs: Map<string, SessionConfig>,
): void {
  bus.registerService<Record<string, never>, SessionConfig>(
    'session:get-config',
    '@ax/test-fixture',
    async (ctx) => {
      const cfg = configs.get(ctx.sessionId);
      if (cfg === undefined) {
        throw new PluginError({
          code: 'unknown-session',
          plugin: '@ax/test-fixture',
          hookName: 'session:get-config',
          message: `no fake config for session '${ctx.sessionId}'`,
        });
      }
      return cfg;
    },
  );
}

const native = (name: string): ToolDescriptor => ({
  name,
  inputSchema: { type: 'object' },
  executesIn: 'sandbox',
});

const mcp = (name: string): ToolDescriptor => ({
  name,
  inputSchema: { type: 'object' },
  executesIn: 'host',
});

async function registerAll(bus: HookBus, descriptors: ToolDescriptor[]): Promise<void> {
  for (const d of descriptors) {
    await bus.call('tool:register', ctxFor(), d);
  }
}

describe('tool:list with per-agent scope', () => {
  it('passes everything through when session:get-config is not registered', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    await registerAll(bus, [
      native('bash'),
      native('read_file'),
      mcp('mcp.alpha.echo'),
    ]);
    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctxFor(),
      {},
    );
    expect(list.tools.map((t) => t.name)).toEqual([
      'bash',
      'read_file',
      'mcp.alpha.echo',
    ]);
  });

  it('filters by the calling session agent config when session:get-config is registered', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    const configs = new Map<string, SessionConfig>([
      [
        'sess-a',
        {
          userId: 'user-a',
          agentId: 'agent-a',
          agentConfig: {
            systemPrompt: 'a',
            model: 'claude-opus-4-7',
            allowedTools: ['bash'],
            mcpConfigIds: ['alpha'],
          },
        },
      ],
    ]);
    registerFakeSessionGetConfig(bus, configs);

    await registerAll(bus, [
      native('bash'),
      native('read_file'),
      mcp('mcp.alpha.echo'),
      mcp('mcp.beta.echo'),
    ]);

    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctxFor({ sessionId: 'sess-a', agentId: 'agent-a', userId: 'user-a' }),
      {},
    );
    expect(list.tools.map((t) => t.name)).toEqual(['bash', 'mcp.alpha.echo']);
  });

  it('passes everything through on unknown-session reject (pre-9.5 / system ctx)', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    // The fake registers session:get-config but knows zero sessions —
    // every call rejects with unknown-session, the same code the real
    // plugin uses for missing rows. tool:list should fall back to the
    // unfiltered catalog rather than fail the call.
    registerFakeSessionGetConfig(bus, new Map());

    await registerAll(bus, [native('bash'), mcp('mcp.alpha.echo')]);

    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctxFor(),
      {},
    );
    expect(list.tools.map((t) => t.name)).toEqual(['bash', 'mcp.alpha.echo']);
  });

  it('passes everything through on owner-missing reject (legacy session)', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    // session:get-config rejects with owner-missing — that's the real
    // plugin's code for "session exists but has no v2 owner row" (a
    // pre-9.5 session resurfacing in a multi-tenant kernel).
    bus.registerService(
      'session:get-config',
      '@ax/test-fixture',
      async () => {
        throw new PluginError({
          code: 'owner-missing',
          plugin: '@ax/test-fixture',
          hookName: 'session:get-config',
          message: 'legacy session, no owner row',
        });
      },
    );

    await registerAll(bus, [native('bash'), mcp('mcp.alpha.echo')]);

    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctxFor(),
      {},
    );
    expect(list.tools.map((t) => t.name)).toEqual(['bash', 'mcp.alpha.echo']);
  });

  it('surfaces unexpected session:get-config failures (no silent pass-through)', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    // Anything other than unknown-session / owner-missing is a real bug
    // and must not be quietly translated into "show everything", which
    // would defeat the filter under partial outages.
    bus.registerService(
      'session:get-config',
      '@ax/test-fixture',
      async () => {
        throw new PluginError({
          code: 'database-down',
          plugin: '@ax/test-fixture',
          hookName: 'session:get-config',
          message: 'fake postgres outage',
        });
      },
    );

    await registerAll(bus, [native('bash')]);

    const err = await bus
      .call<Record<string, never>, { tools: ToolDescriptor[] }>('tool:list', ctxFor(), {})
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('database-down');
  });

  it('cross-tenant: agent A and agent B see only their own MCP tools', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    const configs = new Map<string, SessionConfig>([
      [
        'sess-a',
        {
          userId: 'user-a',
          agentId: 'agent-a',
          agentConfig: {
            systemPrompt: 'a',
            model: 'claude-opus-4-7',
            allowedTools: ['read_file'],
            mcpConfigIds: ['alpha'],
          },
        },
      ],
      [
        'sess-b',
        {
          userId: 'user-b',
          agentId: 'agent-b',
          agentConfig: {
            systemPrompt: 'b',
            model: 'claude-opus-4-7',
            allowedTools: ['read_file'],
            mcpConfigIds: ['beta'],
          },
        },
      ],
    ]);
    registerFakeSessionGetConfig(bus, configs);

    // BOTH MCP servers' tools land in the global catalog — that's the
    // exact condition this test pins. Without scoping, agent A would
    // see B's tools by virtue of the shared catalog.
    await registerAll(bus, [
      native('read_file'),
      native('write_file'),
      mcp('mcp.alpha.read_file'),
      mcp('mcp.alpha.write_file'),
      mcp('mcp.beta.read_file'),
      mcp('mcp.beta.write_file'),
    ]);

    const aCtx = ctxFor({ sessionId: 'sess-a', agentId: 'agent-a', userId: 'user-a' });
    const bCtx = ctxFor({ sessionId: 'sess-b', agentId: 'agent-b', userId: 'user-b' });

    const aList = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      aCtx,
      {},
    );
    const bList = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      bCtx,
      {},
    );

    expect(aList.tools.map((t) => t.name)).toEqual([
      'read_file',
      'mcp.alpha.read_file',
      'mcp.alpha.write_file',
    ]);
    expect(bList.tools.map((t) => t.name)).toEqual([
      'read_file',
      'mcp.beta.read_file',
      'mcp.beta.write_file',
    ]);
    // Negative assertion — explicit, because the headline of this slice
    // is "cross-tenant leak is the threat model".
    expect(aList.tools.some((t) => t.name.startsWith('mcp.beta.'))).toBe(false);
    expect(bList.tools.some((t) => t.name.startsWith('mcp.alpha.'))).toBe(false);
  });
});
