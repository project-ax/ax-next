import { HookBus, makeAgentContext, type AgentContext, type ToolDescriptor } from '@ax/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentActivityPlugin } from '../plugin.js';
import type { AgentActivityGetOutput } from '../types.js';

const T0 = Date.parse('2026-08-21T09:00:00.000Z');

let clock = T0;
function now(): number {
  return clock;
}

function ctx(over: { agentId?: string; triggerLabel?: string } = {}): AgentContext {
  return makeAgentContext({
    sessionId: 's1',
    userId: 'u1',
    agentId: over.agentId ?? 'a1',
    ...(over.triggerLabel !== undefined ? { triggerLabel: over.triggerLabel } : {}),
  });
}

function descriptor(over: Partial<ToolDescriptor> & { name: string }): ToolDescriptor {
  return { inputSchema: {}, executesIn: 'host', ...over };
}

/** A stand-in for @ax/tool-dispatcher's `tool:list`. */
function registerCatalog(bus: HookBus, tools: ToolDescriptor[]): { calls: number } {
  const counter = { calls: 0 };
  bus.registerService<Record<string, never>, { tools: ToolDescriptor[] }>(
    'tool:list',
    '@ax/test-catalog',
    async () => {
      counter.calls += 1;
      return { tools };
    },
  );
  return counter;
}

async function boot(
  bus: HookBus,
): Promise<ReturnType<typeof createAgentActivityPlugin>> {
  const plugin = createAgentActivityPlugin({ now });
  await plugin.init({ bus, config: undefined });
  return plugin;
}

async function get(bus: HookBus, agentId = 'a1'): Promise<AgentActivityGetOutput> {
  return bus.call<{ agentId: string }, AgentActivityGetOutput>('agent-activity:get', ctx(), {
    agentId,
  });
}

beforeEach(() => {
  clock = T0;
});

describe('the tool:pre-call subscriber can never affect the call', () => {
  it('returns undefined and leaves the call unmodified', async () => {
    const bus = new HookBus();
    registerCatalog(bus, [descriptor({ name: 'web_search', activityPhrase: 'Searching the web' })]);
    await boot(bus);

    const call = { id: 'c1', name: 'web_search', input: { query: 'cats' } };
    const result = await bus.fire('tool:pre-call', ctx(), call);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.payload).toBe(call);
  });

  it('still returns undefined when its own bookkeeping throws — a status line must never veto a tool call', async () => {
    const bus = new HookBus();
    // A `tool:list` that blows up is the most realistic internal failure: it is
    // the one thing the subscriber awaits.
    bus.registerService('tool:list', '@ax/test-catalog', async () => {
      throw new Error('catalog exploded');
    });
    await boot(bus);

    const call = { id: 'c1', name: 'web_search', input: {} };
    const logger = { ...ctx().logger, error: vi.fn() };
    const noisyCtx = { ...ctx(), logger } as unknown as AgentContext;

    const result = await bus.fire('tool:pre-call', noisyCtx, call);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.payload).toBe(call);
    // Swallowed, but loudly — HookBus.fire would have eaten a throw silently.
    expect(logger.error).toHaveBeenCalledWith(
      'agent_activity_record_failed',
      expect.objectContaining({ tool: 'web_search' }),
    );
  });

  it('still records the STEP when the catalog read fails — a failed lookup must not read as silence', async () => {
    const bus = new HookBus();
    bus.registerService('tool:list', '@ax/test-catalog', async () => {
      throw new Error('catalog exploded');
    });
    await boot(bus);

    await bus.fire('chat:start', ctx(), {});
    clock = T0 + 80_000;
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });

    // 80s after the turn started, but only 10s after the step: not stale.
    clock = T0 + 89_000;
    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Working on your request',
      stale: false,
    });
  });

  it('does not reject when there is no tool catalog at all', async () => {
    const bus = new HookBus();
    await boot(bus);
    const result = await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });
    expect(result.rejected).toBe(false);
  });
});

describe('agent-activity:get', () => {
  it('is null before any work starts and after it ends', async () => {
    const bus = new HookBus();
    await boot(bus);
    expect((await get(bus)).activity).toBeNull();

    await bus.fire('chat:start', ctx(), { message: { role: 'user', content: 'hi' } });
    expect((await get(bus)).activity).not.toBeNull();

    await bus.fire('chat:end', ctx(), { outcome: { kind: 'complete', messages: [] } });
    expect((await get(bus)).activity).toBeNull();
  });

  it('says nothing at all once the turn errors — the error state is not this line to tell', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx(), {});
    await bus.fire('chat:turn-error', ctx(), { reqId: 'r1', reason: 'sandbox-died' });
    expect((await get(bus)).activity).toBeNull();
  });

  it('resolves to the T0 floor for a user turn with no routine behind it', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx(), {});
    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Working on your request',
      source: 'trigger',
      counter: null,
      stale: false,
      startedAt: '2026-08-21T09:00:00.000Z',
    });
  });

  it("resolves to the routine's own name when the context carries one", async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ triggerLabel: 'Morning email pass' }), {});
    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Morning email pass',
      source: 'trigger',
    });
  });

  it("promotes to the running tool's in-repo phrase, and back down when the turn ends", async () => {
    const bus = new HookBus();
    registerCatalog(bus, [descriptor({ name: 'web_search', activityPhrase: 'Searching the web' })]);
    await boot(bus);

    await bus.fire('chat:start', ctx({ triggerLabel: 'Morning email pass' }), {});
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });

    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Searching the web',
      source: 'tool',
    });

    await bus.fire('chat:end', ctx(), { outcome: { kind: 'complete', messages: [] } });
    expect((await get(bus)).activity).toBeNull();
  });

  it('never borrows a description: a tool with no activityPhrase falls to T0', async () => {
    const bus = new HookBus();
    registerCatalog(bus, [
      descriptor({ name: 'mcp.acme.list_things', description: 'List all the things, fast!' }),
    ]);
    await boot(bus);

    await bus.fire('chat:start', ctx({ triggerLabel: 'Morning email pass' }), {});
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'mcp.acme.list_things', input: {} });

    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Morning email pass',
      source: 'trigger',
    });
  });

  it('starts a record for a pre-call that arrived with no chat:start behind it', async () => {
    const bus = new HookBus();
    registerCatalog(bus, [descriptor({ name: 'web_search', activityPhrase: 'Searching the web' })]);
    await boot(bus);

    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });
    expect((await get(bus)).activity).toMatchObject({ phrase: 'Searching the web' });
  });

  it('reads the catalog once per stretch of work, not once per tool call', async () => {
    const bus = new HookBus();
    const counter = registerCatalog(bus, [
      descriptor({ name: 'web_search', activityPhrase: 'Searching the web' }),
    ]);
    await boot(bus);

    await bus.fire('chat:start', ctx(), {});
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });
    await bus.fire('tool:pre-call', ctx(), { id: 'c2', name: 'web_search', input: {} });
    expect(counter.calls).toBe(1);

    await bus.fire('chat:end', ctx(), { outcome: { kind: 'complete', messages: [] } });
    await bus.fire('chat:start', ctx(), {});
    await bus.fire('tool:pre-call', ctx(), { id: 'c3', name: 'web_search', input: {} });
    expect(counter.calls).toBe(2);
  });

  it('keeps one line per agent', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ agentId: 'a1', triggerLabel: 'Morning email pass' }), {});
    await bus.fire('chat:start', ctx({ agentId: 'a2', triggerLabel: 'Weekly digest' }), {});

    expect((await get(bus, 'a1')).activity).toMatchObject({ phrase: 'Morning email pass' });
    expect((await get(bus, 'a2')).activity).toMatchObject({ phrase: 'Weekly digest' });
    expect((await get(bus, 'a3')).activity).toBeNull();
  });
});

describe('two tool calls in flight at once', () => {
  it('shows the tool that was CALLED last, not the lookup that RESOLVED last', async () => {
    const bus = new HookBus();
    const gates: Array<() => void> = [];
    bus.registerService<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      '@ax/test-catalog',
      async () =>
        new Promise((resolve) => {
          gates.push(() =>
            resolve({
              tools: [
                descriptor({ name: 'slow_tool', activityPhrase: 'Reading a web page' }),
                descriptor({ name: 'fast_tool', activityPhrase: 'Searching the web' }),
              ],
            }),
          );
        }),
    );
    await boot(bus);
    await bus.fire('chat:start', ctx(), {});

    // Two calls start, in order; their catalog lookups finish in the opposite
    // order. The line must follow call order.
    const first = bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'slow_tool', input: {} });
    clock = T0 + 1;
    const second = bus.fire('tool:pre-call', ctx(), { id: 'c2', name: 'fast_tool', input: {} });

    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!();
    gates[0]!();
    await Promise.all([first, second]);

    expect((await get(bus)).activity).toMatchObject({ phrase: 'Searching the web' });
  });
});

describe('staleness, through the injected clock', () => {
  it('replaces the phrase after 90 seconds of silence and drops the counter', async () => {
    const bus = new HookBus();
    registerCatalog(bus, [
      descriptor({ name: 'web_search', activityPhrase: 'Searching the web', countable: 'results' }),
    ]);
    await boot(bus);

    await bus.fire('chat:start', ctx(), {});
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });
    expect((await get(bus)).activity).toMatchObject({ phrase: 'Searching the web', stale: false });

    clock = T0 + 4 * 60_000;
    expect((await get(bus)).activity).toMatchObject({
      phrase: 'No activity for 4 minutes',
      stale: true,
      counter: null,
    });

    // A fresh step un-stales it — the line follows the stream, it does not latch.
    clock = T0 + 4 * 60_000 + 1_000;
    await bus.fire('tool:pre-call', ctx(), { id: 'c2', name: 'web_search', input: {} });
    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Searching the web',
      stale: false,
      // startedAt still marks when the WORK started, not when the step landed.
      startedAt: '2026-08-21T09:00:00.000Z',
    });
  });
});

describe('lifecycle', () => {
  it('unsubscribes and forgets everything on shutdown', async () => {
    const bus = new HookBus();
    const plugin = await boot(bus);
    await bus.fire('chat:start', ctx(), {});

    await plugin.shutdown?.();

    expect(bus.unsubscribe('chat:start', '@ax/agent-activity')).toBe(0);
    expect(bus.unsubscribe('tool:pre-call', '@ax/agent-activity')).toBe(0);
    // Idempotent — a second shutdown is a no-op, not a throw.
    await plugin.shutdown?.();
  });
});

describe('the manifest', () => {
  it('registers one read hook, subscribes to four, and requires nothing', () => {
    const { manifest } = createAgentActivityPlugin();
    expect(manifest.registers).toEqual(['agent-activity:get']);
    expect(manifest.calls).toEqual([]);
    expect(manifest.optionalCalls?.map((o) => o.hook)).toEqual(['tool:list']);
    expect(manifest.subscribes).toEqual([
      'chat:start',
      'chat:end',
      'chat:turn-error',
      'tool:pre-call',
    ]);
  });
});
