import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, type AgentContext } from '@ax/core';

import { createMemoryPlugin } from '../plugin.js';
import type { MemoryRecallOutput, MemoryRememberOutput } from '../types.js';

// ---------------------------------------------------------------------------
// What `@ax/memory` does with what the engine hands back.
//
// A stub engine, on purpose — unlike the integration harness. These are the
// responses a REAL engine is not supposed to produce, and the whole point is
// how the product layer behaves when it does anyway.
//
// The trap being pinned: `HookBus.call` returns a handler's RAW value when the
// hook declares no `returns` schema, and none of the `memory:facts:*` hooks
// declares one. So a handler resolving to `null` arrives intact and a
// `=== undefined` guard is FALSE for it — the check has to be `== null`.
// ---------------------------------------------------------------------------

function ctx(): AgentContext {
  return makeAgentContext({
    sessionId: 's',
    agentId: 'agent-1',
    userId: 'user-alice',
    workspace: { rootPath: '/tmp' },
  });
}

async function busWithEngine(responses: {
  recall?: unknown;
  record?: unknown;
  supersede?: unknown;
}): Promise<{ bus: HookBus; seen: Array<{ hook: string; input: unknown }> }> {
  const bus = new HookBus();
  const seen: Array<{ hook: string; input: unknown }> = [];
  const stub =
    (hook: string, value: unknown) =>
    async (_c: AgentContext, input: unknown): Promise<unknown> => {
      seen.push({ hook, input });
      return value;
    };
  bus.registerService('memory:facts:recall', 'stub', stub('recall', responses.recall));
  bus.registerService('memory:facts:record', 'stub', stub('record', responses.record));
  bus.registerService('memory:facts:supersede', 'stub', stub('supersede', responses.supersede));
  await createMemoryPlugin().init({ bus, config: {} });
  return { bus, seen };
}

describe('@ax/memory — a null engine response is an error, not an empty memory', () => {
  it.each([null, undefined])('memory:recall throws when the engine returns %s', async (value) => {
    // "No facts" and "could not read the facts" render identically to a model
    // and to a person, and one of them is a lie. An empty table is a valid
    // answer; a failed store is not (design §4.4).
    const { bus } = await busWithEngine({ recall: value });
    await expect(bus.call('memory:recall', ctx(), {})).rejects.toThrow(
      /memory:facts:recall returned no result/,
    );
  });

  it.each([null, undefined])('memory:remember throws when the engine returns %s', async (value) => {
    const { bus } = await busWithEngine({ record: value });
    await expect(
      bus.call('memory:remember', ctx(), { about: 'a', relation: 'r', value: 'v' }),
    ).rejects.toThrow(/memory:facts:record returned no result/);
  });

  it('memory:remember throws when the engine records nothing for a one-statement batch', async () => {
    const { bus } = await busWithEngine({ record: { records: [] } });
    await expect(
      bus.call('memory:remember', ctx(), { about: 'a', relation: 'r', value: 'v' }),
    ).rejects.toThrow(/recorded no statement/);
  });

  it('memory:forget tolerates a void supersede response', async () => {
    // `supersede`'s return is not read — the refusal is enforcement, not a
    // signal — so an engine that returns nothing must not break forget.
    const { bus } = await busWithEngine({ supersede: undefined });
    await expect(bus.call('memory:forget', ctx(), { ids: ['x'] })).resolves.toEqual({});
  });
});

describe('@ax/memory — what actually goes down the wire', () => {
  it('sends the owner as a scope on every engine call, and never an agentId', async () => {
    const { bus, seen } = await busWithEngine({
      recall: { statements: [], degraded: [] },
      record: { records: [{ id: 'x' }] },
      supersede: {},
    });
    await bus.call('memory:recall', ctx(), {});
    await bus.call('memory:remember', ctx(), { about: 'a', relation: 'r', value: 'v' });
    await bus.call('memory:forget', ctx(), { ids: ['x'] });

    const recall = seen[0]!.input as Record<string, unknown>;
    expect(recall.ownerUserId).toBe('user-alice');
    const record = seen[1]!.input as { statements: Array<Record<string, unknown>> };
    expect(record.statements[0]!.ownerUserId).toBe('user-alice');
    expect(record.statements[0]!.provenance).toBe('human');
    const supersede = seen[2]!.input as Record<string, unknown>;
    expect(supersede.ownerUserId).toBe('user-alice');

    // The tenant is ambient — it rides on ctx and must never appear as a
    // payload field, or a caller could name one.
    for (const { input } of seen) {
      expect(JSON.stringify(input)).not.toMatch(/agentId/);
    }
  });

  it('sends NO batchKey — a person pressing "remember" twice means it twice', async () => {
    const { bus, seen } = await busWithEngine({ record: { records: [{ id: 'x' }] } });
    await bus.call('memory:remember', ctx(), { about: 'a', relation: 'r', value: 'v' });
    expect(seen[0]!.input).not.toHaveProperty('batchKey');
  });

  it('sends NO slot — slot derivation is a later card, and no slot is the safe direction', async () => {
    const { bus, seen } = await busWithEngine({ record: { records: [{ id: 'x' }] } });
    await bus.call('memory:remember', ctx(), { about: 'a', relation: 'r', value: 'v' });
    const record = seen[0]!.input as { statements: Array<Record<string, unknown>> };
    // A no-slot row is stored, retrievable and INERT: it closes nothing and
    // nothing closes it. That is under-closing, the measured baseline and the
    // safe direction — a false positive closes a true fact. It is NOT
    // `PENDING_SLOT` either: pending means "the normalizer could not derive
    // one yet" and raises `degraded: ['pending']`, which would be a flag
    // about a component that does not exist to drain it. Both decisions
    // belong to the normalizer card.
    expect(record.statements[0]).not.toHaveProperty('slot');
  });

  it('carries conversationId when the turn has one, and omits it when it does not', async () => {
    const withConv = await busWithEngine({ record: { records: [{ id: 'x' }] } });
    const c = makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: 'user-alice',
      conversationId: 'conv-7',
      workspace: { rootPath: '/tmp' },
    });
    await withConv.bus.call('memory:remember', c, { about: 'a', relation: 'r', value: 'v' });
    const a = withConv.seen[0]!.input as { statements: Array<Record<string, unknown>> };
    expect(a.statements[0]!.conversationId).toBe('conv-7');

    const withoutConv = await busWithEngine({ record: { records: [{ id: 'x' }] } });
    await withoutConv.bus.call('memory:remember', ctx(), { about: 'a', relation: 'r', value: 'v' });
    const b = withoutConv.seen[0]!.input as { statements: Array<Record<string, unknown>> };
    // Absent rather than faked — a canary or an admin probe has no
    // conversation and inventing one would be a provenance lie.
    expect(b.statements[0]).not.toHaveProperty('conversationId');
  });
});

describe('@ax/memory — degraded passes through untouched', () => {
  it('forwards an unknown flag a newer engine raises', async () => {
    // Typed as `string[]` and copied, not mapped through a local union: a
    // second copy of the vocabulary here would silently drop any flag the
    // engine learned to raise, which is the opposite of a signal.
    const { bus } = await busWithEngine({
      recall: { statements: [], degraded: ['semantic', 'a-flag-from-the-future'] },
    });
    const out = await bus.call<Record<string, never>, MemoryRecallOutput>(
      'memory:recall',
      ctx(),
      {},
    );
    expect(out.degraded).toEqual(['semantic', 'a-flag-from-the-future']);
  });

  it('does not alias the engine\'s own array', async () => {
    const degraded = ['semantic'];
    const { bus } = await busWithEngine({ recall: { statements: [], degraded } });
    const out = await bus.call<Record<string, never>, MemoryRecallOutput>(
      'memory:recall',
      ctx(),
      {},
    );
    out.degraded.push('mutated');
    expect(degraded).toEqual(['semantic']);
  });

  it('survives an engine that omits degraded entirely', async () => {
    const { bus } = await busWithEngine({ recall: { statements: [] } });
    const out = await bus.call<Record<string, never>, MemoryRecallOutput>(
      'memory:recall',
      ctx(),
      {},
    );
    expect(out.degraded).toEqual([]);
  });
});

describe('@ax/memory — boot', () => {
  it('cannot boot without an engine (calls are hard dependencies)', async () => {
    const bus = new HookBus();
    await createMemoryPlugin().init({ bus, config: {} });
    // The kernel's `verifyCalls()` is what actually refuses; at the bus level
    // the consequence is a `no-service` on first use rather than a silent
    // empty answer.
    await expect(bus.call('memory:recall', ctx(), {})).rejects.toThrow(/no plugin registered/);
  });

  it('rejects a nonsense maxRecallLimit at construction, not at call time', () => {
    expect(() => createMemoryPlugin({ maxRecallLimit: 0 })).toThrow(/positive number/);
  });

  it('returns a well-formed id from remember', async () => {
    const { bus } = await busWithEngine({ record: { records: [{ id: 'fact-1' }] } });
    const out = await bus.call<unknown, MemoryRememberOutput>('memory:remember', ctx(), {
      about: 'a',
      relation: 'r',
      value: 'v',
    });
    expect(out).toEqual({ id: 'fact-1' });
  });
});
