import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';

import { createMemoryPlugin } from '../plugin.js';
import type { MemoryRecallOutput, MemoryRememberOutput } from '../types.js';
import { registerMemoryAgents } from './harness.js';

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
  bus.registerService('tool:register', 'stub-catalog', async () => ({}));
  registerMemoryAgents(bus);
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

  it('sends NO slot for a relation the normalizer does not map — no slot is the safe direction', async () => {
    const { bus, seen } = await busWithEngine({ record: { records: [{ id: 'x' }] } });
    // `r` is not in the synonym table, and the normalizer is the table alone
    // (TASK-489) — there is no nearest-neighbour behind it to guess with.
    await bus.call('memory:remember', ctx(), { about: 'a', relation: 'r', value: 'v' });
    const record = seen[0]!.input as { statements: Array<Record<string, unknown>> };
    // A no-slot row is stored, retrievable and INERT: it closes nothing and
    // nothing closes it. That is under-closing, the measured baseline and the
    // safe direction — a false positive closes a true fact. It is NOT
    // `PENDING_SLOT` either: pending means "the normalizer could not derive
    // one yet", which cannot happen when derivation is a synchronous table
    // lookup, and it would raise `degraded: ['pending']` — a flag about a
    // component that does not exist to drain it.
    //
    // The mapped case, and the `slot` this same payload carries when the
    // relation IS in the table, are in `slot-wiring.test.ts`.
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

describe('@ax/memory — degraded passes through untouched, once readable', () => {
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

  // Absent and malformed are NOT the same thing. Absent honestly means
  // "nothing was degraded"; a value we cannot read means we do not know
  // whether anything was, and answering `[]` would state the opposite.
  it.each([['a string', 'semantic'], ['an object', { semantic: true }], ['null', null]])(
    'throws rather than reporting no degradation when degraded is %s',
    async (_label, degraded) => {
      const { bus } = await busWithEngine({ recall: { statements: [], degraded } });
      await expect(
        bus.call<Record<string, never>, MemoryRecallOutput>('memory:recall', ctx(), {}),
      ).rejects.toThrow(/non-array degraded/);
    },
  );

  // The ELEMENTS, not just the array they arrived in — the same step
  // `toMemoryStatement` takes for `statements` rows. A flag we cannot read is
  // not a flag we may hand a caller: `MemoryRecallOutput.degraded` promises
  // `string[]`, and passing `42` or `null` through would put a wrong-typed
  // value on the caller-facing payload. Throwing (not dropping) because a
  // dropped element is a silently discarded degradation signal, and throwing
  // (not coercing) because `String(null)` is a flag name the engine never
  // raised.
  it.each([
    ['a number', [42]],
    ['null', [null]],
    ['an object beside a real flag', ['semantic', { flag: 'ranking' }]],
    ['undefined', [undefined]],
  ])('throws when a degraded element is %s', async (_label, degraded) => {
    const { bus } = await busWithEngine({ recall: { statements: [], degraded } });
    const err = await bus
      .call<Record<string, never>, MemoryRecallOutput>('memory:recall', ctx(), {})
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(PluginError);
    expect(err).toMatchObject({
      code: 'invalid-return',
      plugin: '@ax/memory',
      hookName: 'memory:recall',
    });
    expect((err as Error).message).toMatch(/non-string degraded flag/);
    // Message hygiene, as the row guard keeps it: the engine-supplied value
    // never reaches the message.
    expect((err as Error).message).not.toMatch(/42|ranking|\[object/);
  });
});

// A malformed answer is an ERROR, not an empty memory. "No facts" and "could
// not read the facts" render identically to a person and to a model, and one
// of them is a lie — the same call `requireEngineResult` makes for a null
// response, applied to a response that is non-null but nonsense. Before this,
// every case below silently answered "you have no memories".
/** A row shaped exactly as the engine's `FactRecord` promises. */
const GOOD_ROW = {
  id: 'a',
  about: 'user:user-alice',
  relation: 'lives_in',
  value: 'Berlin',
  when: '2026-01-01T00:00:00.000Z',
};

describe('@ax/memory — a malformed statements is an error, not an empty memory', () => {
  it.each([
    ['omitted', {}],
    ['null', { statements: null }],
    ['a string', { statements: 'nope' }],
    ['an object', { statements: { 0: { id: 'a' } } }],
  ])('memory:recall throws when statements is %s', async (_label, recall) => {
    const { bus } = await busWithEngine({ recall });
    await expect(
      bus.call<Record<string, never>, MemoryRecallOutput>('memory:recall', ctx(), {}),
    ).rejects.toThrow(/non-array statements/);
  });

  // Proving the ARRAY is an array is not proving its ELEMENTS are rows. Before
  // these cases, the shape guard above passed and `toMemoryStatement` — a bare
  // field-copy — then produced a statement-shaped object full of `undefined`s,
  // which is the very defect this block exists to kill, one level down. That
  // is worse than the `[]` it replaced: a UI renders it as a real-but-blank
  // memory rather than obviously failing. A `null` element was worse still — a
  // bare `TypeError` with no `plugin`, no `hookName` and no `code`, exactly the
  // error shape this plugin documents at length that it does not emit.
  it.each([
    ['null', [null]],
    ['a string', ['nope']],
    ['a number', [42]],
    ['a partial row (schema drift)', [{ id: 'a' }]],
    ['a row whose field is the wrong type', [{ id: 'a', about: 'b', relation: 'c', value: 4, when: 'd' }]],
    ['a good row followed by a bad one', [GOOD_ROW, { id: 'b' }]],
  ])('memory:recall throws when a statements element is %s', async (_label, statements) => {
    const { bus } = await busWithEngine({ recall: { statements, degraded: [] } });
    await expect(
      bus.call<Record<string, never>, MemoryRecallOutput>('memory:recall', ctx(), {}),
    ).rejects.toThrow(/malformed statement/);
  });

  it('still accepts a well-formed row, with and without `until`', async () => {
    const { bus } = await busWithEngine({
      recall: { statements: [GOOD_ROW, { ...GOOD_ROW, id: 'b', until: '2026-02-01T00:00:00Z' }] },
    });
    const out = await bus.call<Record<string, never>, MemoryRecallOutput>(
      'memory:recall',
      ctx(),
      {},
    );
    expect(out.statements.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out.statements[0]).not.toHaveProperty('until');
    expect(out.statements[1]!.until).toBe('2026-02-01T00:00:00Z');
  });

  it('rejects a non-string `until` rather than passing it through', async () => {
    const { bus } = await busWithEngine({
      recall: { statements: [{ ...GOOD_ROW, until: 7 }] },
    });
    await expect(
      bus.call<Record<string, never>, MemoryRecallOutput>('memory:recall', ctx(), {}),
    ).rejects.toThrow(/malformed statement/);
  });

  it.each([42, null, 'bogus'])('rejects a malformed engine `kind` (%s)', async (kind) => {
    const { bus } = await busWithEngine({
      recall: { statements: [{ ...GOOD_ROW, kind }], degraded: [] },
    });
    let caught: unknown;
    await bus
      .call<Record<string, never>, MemoryRecallOutput>('memory:recall', ctx(), {})
      .catch((err: unknown) => {
        caught = err;
      });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('invalid-return');
    expect((caught as Error).message).toContain('malformed statement');
    expect((caught as Error).message).not.toContain(String(kind));
  });
});

describe('@ax/memory — boot', () => {
  it('cannot boot without an engine (calls are hard dependencies)', async () => {
    const bus = new HookBus();
    bus.registerService('tool:register', 'stub-catalog', async () => ({}));
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
