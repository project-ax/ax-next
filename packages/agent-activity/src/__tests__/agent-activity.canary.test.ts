import { HookBus, makeAgentContext, type ToolDescriptor } from '@ax/core';
import { createToolDispatcherPlugin } from '@ax/mcp-client';
import { describe, expect, it } from 'vitest';
import { createAgentActivityPlugin } from '../plugin.js';
import type { AgentActivityGetOutput } from '../types.js';

const T0 = Date.parse('2026-08-21T09:00:00.000Z');

function ctx(over: { triggerLabel?: string } = {}) {
  return makeAgentContext({
    sessionId: 's1',
    agentId: 'a1',
    userId: 'u1',
    ...(over.triggerLabel !== undefined ? { triggerLabel: over.triggerLabel } : {}),
  });
}

/**
 * The canary. Real HookBus, real tool dispatcher, real `tool:list` zod — which
 * is the point: a `z.object` strips keys it does not declare, so this is the
 * test that fails if `activityPhrase` is added to three of the four descriptor
 * gates instead of all four.
 */
describe('agent-activity canary (real tool-dispatcher)', () => {
  it('drives a whole stretch of work end to end through the bus', async () => {
    let clock = T0;
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: undefined });
    await createAgentActivityPlugin({ now: () => clock }).init({ bus, config: undefined });

    const descriptor: ToolDescriptor = {
      name: 'web_search',
      description: 'Search the live web.',
      activityPhrase: 'Searching the web',
      executesIn: 'host',
      inputSchema: { type: 'object', properties: {} },
    };
    await bus.call('tool:register', ctx(), descriptor);

    const activity = async (): Promise<AgentActivityGetOutput['activity']> =>
      (
        await bus.call<{ agentId: string }, AgentActivityGetOutput>(
          'agent-activity:get',
          ctx(),
          { agentId: 'a1' },
        )
      ).activity;

    // Nothing running yet.
    expect(await activity()).toBeNull();

    // T0 — the trigger label a person wrote when they made the routine.
    await bus.fire('chat:start', ctx({ triggerLabel: 'Morning email pass' }), {
      message: { role: 'user', content: 'go' },
    });
    expect(await activity()).toMatchObject({
      phrase: 'Morning email pass',
      source: 'trigger',
      counter: null,
      stale: false,
    });

    // T1 — the tool's own in-repo phrase, having survived tool:list's zod.
    const call = { id: 'c1', name: 'web_search', input: { query: 'cats' } };
    const fired = await bus.fire('tool:pre-call', ctx(), call);
    expect(fired.rejected).toBe(false);
    if (!fired.rejected) expect(fired.payload).toBe(call);
    expect(await activity()).toMatchObject({ phrase: 'Searching the web', source: 'tool' });

    // Silence replaces the phrase rather than decorating it.
    clock = T0 + 5 * 60_000;
    expect(await activity()).toMatchObject({
      phrase: 'No activity for 5 minutes',
      stale: true,
      counter: null,
    });

    // And the work ending means there is no "right now" left to describe.
    await bus.fire('chat:end', ctx(), { outcome: { kind: 'complete', messages: [] } });
    expect(await activity()).toBeNull();
  });

  it('never renders a percentage, a remaining, an eta, or a time left', async () => {
    let clock = T0;
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: undefined });
    await createAgentActivityPlugin({ now: () => clock }).init({ bus, config: undefined });
    await bus.call('tool:register', ctx(), {
      name: 'web_search',
      activityPhrase: 'Searching the web',
      countable: 'results',
      executesIn: 'host',
      inputSchema: {},
    });

    const rendered: string[] = [];
    const snap = async (): Promise<void> => {
      const out = await bus.call<{ agentId: string }, AgentActivityGetOutput>(
        'agent-activity:get',
        ctx(),
        { agentId: 'a1' },
      );
      rendered.push(JSON.stringify(out.activity));
    };

    await bus.fire('chat:start', ctx({ triggerLabel: 'Morning email pass' }), {});
    await snap();
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });
    await snap();
    clock = T0 + 40 * 60_000;
    await snap();

    expect(rendered).toHaveLength(3);
    for (const one of rendered) {
      expect(one).not.toMatch(/%|remaining|left|eta/i);
    }
  });
});
