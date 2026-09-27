import { describe, it, expect, afterEach, vi } from 'vitest';
import { HookBus, makeAgentContext, type AgentContext } from '@ax/core';

import { createMemoryPlugin } from '../plugin.js';
import { formatEvidenceWhen } from '../evidence.js';
import { MEMORY_NOTE_TOOL_HOOK } from '../note-tool.js';
import {
  makeMemoryHarness,
  engineRecord,
  registerMemoryAgents,
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
  registerMemoryAgents(bus);
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

  it('omits a closedBy that is in the engine page but outside the returned page', async () => {
    const { bus } = await busWithEngine({
      statements: [
        { ...GOOD_ROW, id: 'z', slot: 'lives_in', until: GOOD_ROW.when, closedBy: 'a' },
        { ...GOOD_ROW, id: 'a', slot: 'lives_in' },
      ],
      degraded: [],
    });
    const { statements } = await bus.call('memory:recall', STUB_CTX, {
      profile: true,
      activeOnly: false,
      limit: 1,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.id).toBe('z');
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

  it('a raw-engine foreign-owner row closes the slot without leaking the foreign id (personal)', async () => {
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

// ---------------------------------------------------------------------------
// TASK-526: display legibility. `savedBy` coarsens provenance for display,
// `aboutText` never names another person's raw id, `whenText` leaves closure
// to the `closure` field, and history marks the row the active read hides.
// ---------------------------------------------------------------------------
describe('@ax/memory — recall display fields', () => {
  const extracted = (value: string, when: string, extra: Record<string, unknown> = {}) => ({
    about: `user:${ALICE}`,
    relation: 'lives_in',
    value,
    when,
    slot: 'lives_in',
    provenance: 'extracted' as 'extracted' | 'human',
    ownerUserId: ALICE,
    ...extra,
  });

  it('says who saved a row: person for memory:remember, agent for memory_note, absent for extracted', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({ about: 'acme_corp', relation: 'stage', value: 'series B' });
    await harness.bus.call(MEMORY_NOTE_TOOL_HOOK, harness.ctx(), {
      input: { about: 'acme_corp', relation: 'ceo', value: 'Dana' },
    });
    await engineRecord(harness.bus, harness.ctx(), [
      {
        about: 'acme_corp',
        relation: 'founded_in',
        value: '2019',
        when: '2023-01-01T00:00:00Z',
        provenance: 'extracted',
        ownerUserId: ALICE,
      },
    ]);
    const { statements } = await harness.recall({ about: 'acme_corp' });
    const by = (value: string) => statements.find((s) => s.value === value);
    expect(by('series B')?.savedBy).toBe('person');
    expect(by('Dana')?.savedBy).toBe('agent');
    expect(by('2019')).toBeDefined();
    expect(by('2019')).not.toHaveProperty('savedBy');
    expect(by('2019')).not.toHaveProperty('provenance');
  });

  it("labels another person's speaker subject 'a teammate', never the raw id", async () => {
    harness = await makeMemoryHarness();
    await engineRecord(harness.bus, harness.ctx(), [
      {
        about: `user:${BOB}`,
        relation: 'likes',
        value: 'tea',
        when: '2023-01-01T00:00:00Z',
        provenance: 'extracted',
        ownerUserId: ALICE,
      },
    ]);
    const { statements } = await harness.recall({ activeOnly: false, limit: 100 });
    const tea = statements.find((s) => s.value === 'tea');
    expect(tea?.aboutText).toBe('a teammate');
    expect(tea?.aboutText).not.toContain(BOB);
  });

  it('leaves closure out of whenText — the closure field owns it', async () => {
    harness = await makeMemoryHarness();
    const { id } = await harness.remember({
      about: 'acme_corp',
      relation: 'stage',
      value: 'series B',
      when: '2023-01-01T00:00:00Z',
    });
    await harness.forget({ ids: [id] });
    const { statements } = await harness.recall({ about: 'acme_corp', activeOnly: false });
    expect(statements[0]?.closure).toBe('forgotten');
    expect(statements[0]?.whenText).not.toContain('→');
    expect(statements[0]?.whenText).not.toContain('superseded');
  });

  it('history profile marks the outranked active row overridden, not the one the profile shows', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Boston',
      when: '2023-01-01T00:00:00Z',
    });
    await engineRecord(harness.bus, harness.ctx(), [extracted('Denver', '2023-03-01T00:00:00Z')]);

    const history = await harness.recall({ profile: true, activeOnly: false, limit: 100 });
    const by = (value: string) => history.statements.find((s) => s.value === value);
    expect(by('Denver')?.closure).toBe('overridden');
    expect(by('Denver')).not.toHaveProperty('until');
    expect(by('Boston')).toBeDefined();
    expect(by('Boston')).not.toHaveProperty('closure');

    const active = await harness.recall({ profile: true, limit: 100 });
    expect(active.statements.map((s) => s.value)).toEqual(['Boston']);
    expect(active.statements.some((s) => s.closure === 'overridden')).toBe(false);
  });

  it('history profile still marks the outranked row when the winner fell off the page', async () => {
    // Review finding (TASK-526): the history page is recency-ordered and
    // capped, and an old human correction is never closed, so enough newer
    // extracted rows push it off the page. Deciding the mark from the page
    // alone then picked the newest extracted row as the "winner" and showed
    // it as current, while the active profile shows Boston.
    harness = await makeMemoryHarness();
    await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Boston',
      when: '2023-01-01T00:00:00Z',
    });
    for (let i = 0; i < 34; i += 1) {
      const when = new Date(Date.UTC(2023, 2, 1 + i)).toISOString();
      await engineRecord(harness.bus, harness.ctx(), [extracted(`City ${i}`, when)]);
    }

    const history = await harness.recall({ profile: true, activeOnly: false, limit: 32 });
    expect(history.statements.some((s) => s.value === 'Boston')).toBe(false);
    const latest = history.statements.find((s) => s.value === 'City 33');
    expect(latest).toBeDefined();
    expect(latest).not.toHaveProperty('until');
    expect(latest?.closure).toBe('overridden');

    const active = await harness.recall({ profile: true, limit: 100 });
    expect(active.statements.map((s) => s.value)).toEqual(['Boston']);
  });

  it('history search marks exactly the re-mention the active read hides', async () => {
    harness = await makeMemoryHarness();
    // One call per row: each arrival settles its slot against what is there.
    for (const r of [
      extracted('Portland, Oregon', '2026-01-10T12:00:00.000Z'),
      extracted('Seattle, Washington', '2026-02-10T12:00:00.000Z', { provenance: 'human' }),
      extracted('Portland, Oregon', '2026-06-10T12:00:00.000Z', { conversationId: 'conv-restated' }),
    ]) {
      await engineRecord(harness.bus, harness.ctx(), [r]);
    }

    const history = await harness.recall({ activeOnly: false, limit: 100 });
    const portlands = history.statements.filter((s) => s.value === 'Portland, Oregon');
    expect(portlands.map((s) => s.closure).sort()).toEqual(['overridden', 'replaced']);
    expect(portlands.find((s) => s.closure === 'overridden')).not.toHaveProperty('until');
    const seattle = history.statements.find((s) => s.value === 'Seattle, Washington');
    expect(seattle).toBeDefined();
    expect(seattle).not.toHaveProperty('closure');

    for (const input of [{}, { query: 'where does the user live' }, { profile: true }]) {
      const active = await harness.recall(input);
      expect(active.statements.some((s) => s.closure === 'overridden')).toBe(false);
    }
  });

  it('does not mark a genuinely new value under an old human row in history search', async () => {
    harness = await makeMemoryHarness();
    await engineRecord(harness.bus, harness.ctx(), [
      extracted('Paris', '2026-01-10T12:00:00.000Z', { provenance: 'human' }),
    ]);
    await engineRecord(harness.bus, harness.ctx(), [
      extracted('Coimbra', '2026-06-10T12:00:00.000Z', { conversationId: 'conv-moved' }),
    ]);
    const history = await harness.recall({ activeOnly: false, limit: 100 });
    expect(history.statements.map((s) => s.value).sort()).toEqual(['Coimbra', 'Paris']);
    expect(history.statements.some((s) => s.closure === 'overridden')).toBe(false);
  });
});

// TASK-602 (walk TASK-596): "I moved to Tacoma" in chat never displaced an
// older agent note saying Seattle. Storage rule 3 stays as it is — the
// extracted row cannot CLOSE the agent row — so the fix is which active row
// the profile SHOWS: newest non-human value, unless it is a re-mention.
describe('@ax/memory — profile pick among non-human rows (TASK-602)', () => {
  const row = (
    value: string,
    when: string,
    provenance: 'extracted' | 'agent' | 'human',
    extra: Record<string, unknown> = {},
  ) => ({
    about: `user:${ALICE}`,
    relation: 'lives_in',
    value,
    when,
    slot: 'lives_in',
    provenance,
    ownerUserId: ALICE,
    ...extra,
  });

  it('a newer extracted value beats an older agent note; the note stays open and still recalls', async () => {
    harness = await makeMemoryHarness();
    await engineRecord(harness.bus, harness.ctx(), [
      row('Seattle, Washington', '2026-09-25T21:31:51.890Z', 'agent'),
    ]);
    await engineRecord(harness.bus, harness.ctx(), [
      row('Tacoma, Washington', '2026-09-26T00:30:22.000Z', 'extracted', { conversationId: 'conv-moved' }),
    ]);

    const active = await harness.recall({ profile: true, limit: 100 });
    expect(active.statements.map((s) => s.value)).toEqual(['Tacoma, Washington']);

    const history = await harness.recall({ profile: true, activeOnly: false, limit: 100 });
    const by = (value: string) => history.statements.find((s) => s.value === value);
    expect(by('Seattle, Washington')?.closure).toBe('overridden');
    expect(by('Seattle, Washington')).not.toHaveProperty('until');
    expect(by('Tacoma, Washington')).not.toHaveProperty('closure');

    // Not closed in storage: an ordinary recall still returns the note.
    const recall = await harness.recall({ limit: 100 });
    expect(recall.statements.map((s) => s.value).sort()).toEqual([
      'Seattle, Washington',
      'Tacoma, Washington',
    ]);
  });

  it("a person's own edit still beats a newer extracted value", async () => {
    harness = await makeMemoryHarness();
    await engineRecord(harness.bus, harness.ctx(), [row('Boston', '2026-01-01T00:00:00.000Z', 'human')]);
    await engineRecord(harness.bus, harness.ctx(), [row('Denver', '2026-02-01T00:00:00.000Z', 'agent')]);
    await engineRecord(harness.bus, harness.ctx(), [row('Austin', '2026-03-01T00:00:00.000Z', 'extracted')]);
    const active = await harness.recall({ profile: true, limit: 100 });
    expect(active.statements.map((s) => s.value)).toEqual(['Boston']);
  });

  it('a re-mention of a replaced value does not count as newer', async () => {
    harness = await makeMemoryHarness();
    // Portland (extracted) is replaced by the agent's Seattle; chat later says
    // Portland again. The agent row outranks it, so it is not closed — and it
    // must not win the profile either.
    await engineRecord(harness.bus, harness.ctx(), [row('Portland, Oregon', '2026-01-10T12:00:00.000Z', 'extracted')]);
    await engineRecord(harness.bus, harness.ctx(), [row('Seattle, Washington', '2026-02-10T12:00:00.000Z', 'agent')]);
    await engineRecord(harness.bus, harness.ctx(), [
      row('Portland, Oregon', '2026-06-10T12:00:00.000Z', 'extracted', { conversationId: 'conv-restated' }),
    ]);

    const active = await harness.recall({ profile: true, limit: 100 });
    expect(active.statements.map((s) => s.value)).toEqual(['Seattle, Washington']);

    const history = await harness.recall({ profile: true, activeOnly: false, limit: 100 });
    const portlands = history.statements.filter((s) => s.value === 'Portland, Oregon');
    expect(portlands.map((s) => s.closure).sort()).toEqual(['overridden', 'replaced']);
    const seattle = history.statements.find((s) => s.value === 'Seattle, Washington');
    expect(seattle).not.toHaveProperty('closure');
  });
});
