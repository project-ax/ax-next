import { describe, it, expect, afterEach, vi } from 'vitest';
import { HookBus, makeAgentContext, type AgentContext } from '@ax/core';

import { createMemoryPlugin } from '../plugin.js';
import { formatEvidenceWhen } from '../evidence.js';
import {
  makeMemoryHarness,
  engineRecord,
  ALICE,
  BOB,
  type MemoryHarness,
} from './harness.js';

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

const STUB_CTX = makeAgentContext({
  sessionId: 's',
  agentId: 'agent-1',
  userId: ALICE,
  workspace: { rootPath: '/tmp' },
});

async function busWithEngine(recall: unknown): Promise<{
  bus: HookBus;
  seen: Array<{ hook: string; input: unknown }>;
}> {
  const bus = new HookBus();
  const seen: Array<{ hook: string; input: unknown }> = [];
  bus.registerService('memory:facts:recall', 'stub', async (_c: AgentContext, input: unknown) => {
    seen.push({ hook: 'recall', input });
    return recall;
  });
  bus.registerService('memory:facts:record', 'stub', async () => ({ records: [] }));
  bus.registerService('memory:facts:supersede', 'stub', async () => ({ closed: [], resettled: [] }));
  bus.registerService('tool:register', 'stub-catalog', async () => ({}));
  await createMemoryPlugin().init({ bus, config: {} });
  return { bus, seen };
}

const GOOD_ROW = {
  id: 'r1',
  about: 'user:user-alice',
  relation: 'likes_artist',
  value: 'Khalid',
  when: '2023-01-01T00:00:00.000Z',
};

describe('@ax/memory — profile recall', () => {
  it('rejects a non-boolean profile flag', async () => {
    const { bus } = await busWithEngine({ statements: [], degraded: [] });
    await expect(
      bus.call('memory:recall', STUB_CTX, { profile: 'yes' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it.each([{ query: 'x' }, { about: 'user' }])(
    'rejects profile combined with %j — the profile scopes itself',
    async (extra) => {
      const { bus } = await busWithEngine({ statements: [], degraded: [] });
      await expect(
        bus.call('memory:recall', STUB_CTX, { profile: true, ...extra }),
      ).rejects.toMatchObject({ code: 'invalid-payload' });
    },
  );

  it('pushes the slot filter and a widened page down to the engine', async () => {
    const { bus, seen } = await busWithEngine({ statements: [], degraded: [] });
    await bus.call('memory:recall', STUB_CTX, { profile: true, limit: 100 });
    const input = seen[0]?.input as Record<string, unknown>;
    expect(input.ownerUserId).toBe(ALICE);
    expect(input.about).toBe('user:user-alice');
    expect(Array.isArray(input.slots)).toBe(true);
    expect(input.limit).toBe(100);
    expect(input).not.toHaveProperty('query');
  });

  it('forwards a same-page closedBy, drops a foreign one, keeps the closure', async () => {
    const { bus } = await busWithEngine({
      statements: [
        { ...GOOD_ROW, id: 'old', until: '2023-02-01T00:00:00.000Z', closedBy: 'new' },
        { ...GOOD_ROW, id: 'new', value: 'Frank Ocean' },
      ],
      degraded: [],
    });
    const { statements } = await bus.call('memory:recall', STUB_CTX, { limit: 10 });
    const old = statements.find((s) => s.id === 'old');
    expect(old?.closure).toBe('replaced');
    expect(old?.closedBy).toBe('new');
  });

  it('omits a closedBy that names a row outside the page, but still says replaced', async () => {
    const { bus } = await busWithEngine({
      statements: [
        { ...GOOD_ROW, id: 'old', until: '2023-02-01T00:00:00.000Z', closedBy: 'not-here' },
      ],
      degraded: [],
    });
    const { statements } = await bus.call('memory:recall', STUB_CTX, { limit: 10 });
    expect(statements[0]?.closure).toBe('replaced');
    expect(statements[0]).not.toHaveProperty('closedBy');
  });

  it('marks a closed row with no closedBy as forgotten', async () => {
    const { bus } = await busWithEngine({
      statements: [{ ...GOOD_ROW, until: '2023-02-01T00:00:00.000Z' }],
      degraded: [],
    });
    const { statements } = await bus.call('memory:recall', STUB_CTX, { limit: 10 });
    expect(statements[0]?.closure).toBe('forgotten');
    expect(statements[0]).not.toHaveProperty('closedBy');
  });

  it('rejects a malformed slot or closedBy on an engine row', async () => {
    for (const extra of [{ slot: 42 }, { closedBy: 7 }]) {
      const { bus } = await busWithEngine({
        statements: [{ ...GOOD_ROW, ...extra }],
        degraded: [],
      });
      await expect(bus.call('memory:recall', STUB_CTX, {})).rejects.toMatchObject({
        code: 'invalid-return',
      });
    }
  });
});

describe('@ax/memory — profile recall against a real store', () => {
  it('finds the slot row even with far more non-slot rows than the page', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Boston',
      when: '2023-01-01T00:00:00Z',
    });
    for (let i = 0; i < 110; i++) {
      await harness.remember({
        about: 'user',
        relation: 'likes',
        value: `thing-${i}`,
        when: '2023-02-01T00:00:00Z',
      });
    }
    const { statements } = await harness.recall({ profile: true, limit: 100 });
    const home = statements.find((s) => s.value === 'Boston');
    expect(home).toBeDefined();
    expect(home?.slot).toBe('lives_in');
  });

  it('picks the older human correction over a newer extracted row in the same slot', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Boston',
      when: '2023-01-01T00:00:00Z',
    });
    await engineRecord(harness.bus, harness.ctx(), [
      {
        about: 'user:user-alice',
        relation: 'lives_in',
        value: 'Denver',
        when: '2023-03-01T00:00:00Z',
        slot: 'lives_in',
        provenance: 'extracted',
        ownerUserId: ALICE,
      },
    ]);
    const { statements } = await harness.recall({ profile: true, limit: 100 });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.value).toBe('Boston');
    expect(statements[0]?.slot).toBe('lives_in');

    const history = await harness.recall({ profile: true, activeOnly: false, limit: 100 });
    expect(history.statements.length).toBeGreaterThanOrEqual(2);
  });

  it('stamps whenText from the same formatEvidenceWhen the tool renders', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2023-06-15T12:00:00Z'));
      harness = await makeMemoryHarness();
      const { id } = await harness.remember({
        about: 'user',
        relation: 'lives_in',
        value: 'Boston',
        when: '2023-06-01T00:00:00Z',
      });
      vi.setSystemTime(new Date('2023-06-16T12:00:00Z'));
      const { statements } = await harness.recall({ about: 'user' });
      const row = statements.find((s) => s.id === id);
      expect(row?.whenText).toBe(
        formatEvidenceWhen(
          { when: '2023-06-01T00:00:00Z' },
          '2023-06-16T12:00:00.000Z',
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels the caller\'s own speaker "you" and leaves other subjects literal', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Boston',
      when: '2023-01-01T00:00:00Z',
    });
    await harness.remember({
      about: 'priya_sharma',
      relation: 'likes',
      value: 'tea',
      when: '2023-01-02T00:00:00Z',
    });
    const { statements } = await harness.recall({ activeOnly: false, limit: 100 });
    const own = statements.find((s) => s.value === 'Boston');
    const other = statements.find((s) => s.value === 'tea');
    expect(own?.aboutText).toBe('you');
    expect(other?.aboutText).toBe('priya sharma');
    expect(other?.aboutText).not.toContain('user-alice');
  });

  it('a cross-owner replacement closes the row without leaking the foreign id', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Boston',
      when: '2023-01-01T00:00:00Z',
    });
    const foreign = await engineRecord(harness.bus, harness.ctx({ userId: BOB }), [
      {
        about: 'user:user-alice',
        relation: 'lives_in',
        value: 'Denver',
        when: '2023-03-01T00:00:00Z',
        slot: 'lives_in',
        provenance: 'human',
        ownerUserId: BOB,
      },
    ]);
    const foreignId = foreign.records[0]?.id;
    expect(foreignId).toBeDefined();

    const history = await harness.recall({ activeOnly: false, limit: 100 });
    const closed = history.statements.find((s) => s.value === 'Boston');
    expect(closed?.closure).toBe('replaced');
    expect(closed).not.toHaveProperty('closedBy');
    expect(history.statements.find((s) => s.value === 'Denver')).toBeUndefined();
  });

  it('a human re-statement closes the prior row and the closure is visible in history', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Boston',
      when: '2023-01-01T00:00:00Z',
    });
    const second = await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Cambridge',
      when: '2023-02-01T00:00:00Z',
    });
    const history = await harness.recall({ activeOnly: false, limit: 100 });
    const closed = history.statements.find((s) => s.value === 'Boston');
    expect(closed?.closure).toBe('replaced');
    expect(closed?.closedBy).toBe(second.id);

    await harness.forget({ ids: [second.id] });
    const after = await harness.recall({ activeOnly: false, limit: 100 });
    const forgotten = after.statements.find((s) => s.id === second.id);
    expect(forgotten?.closure).toBe('forgotten');
  });
});
