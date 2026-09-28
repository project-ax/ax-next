import { describe, it, expect, afterEach, vi } from 'vitest';

import { FACTS_RECORD_HOOK, FACTS_SUPERSEDE_HOOK, MEMORY_CORRECT_HOOK } from '../plugin.js';
import type { MemoryCorrectInput, MemoryStatement } from '../types.js';
import {
  ALICE,
  BOB,
  engineRecall,
  engineRecord,
  makeMemoryHarness,
  type MemoryHarness,
} from './harness.js';

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

// ---------------------------------------------------------------------------
// memory:correct (TASK-624) — a person's Fix, with WHY the old value was wrong.
//
// 'changed'     → the plain human write; the slot rule closes a slotted old
//                 row, and a slot-less one is closed BY the new row (TASK-632).
// 'never-right' → retract the old row as never-true FIRST, then the same write,
//                 so the (about, slot) chain re-settles around the mistake.
//
// Over the REAL sqlite engine: the property is the two plugins together.
// ---------------------------------------------------------------------------

/** Boston (Jan) → Seattle (Jun), both person-saved into the `lives_in` slot. */
async function bostonThenSeattle(h: MemoryHarness): Promise<{ boston: string; seattle: string }> {
  const { id: boston } = await h.remember({
    about: 'user',
    relation: 'lives_in',
    value: 'Boston',
    when: '2025-01-01T00:00:00Z',
  });
  const { id: seattle } = await h.remember({
    about: 'user',
    relation: 'lives_in',
    value: 'Seattle',
    when: '2025-06-01T00:00:00Z',
  });
  return { boston, seattle };
}

async function history(h: MemoryHarness): Promise<Map<string, MemoryStatement>> {
  const { statements } = await h.recall({ about: 'user', activeOnly: false, limit: 50 });
  return new Map(statements.map((s) => [s.id, s]));
}

function correction(id: string, reason: MemoryCorrectInput['reason']): MemoryCorrectInput {
  return { id, about: 'user', relation: 'lives_in', value: 'Denver', reason };
}

describe('@ax/memory — memory:correct', () => {
  it("'never-right' leaves Boston replaced BY Denver and Seattle retracted", async () => {
    harness = await makeMemoryHarness();
    const { boston, seattle } = await bostonThenSeattle(harness);

    const { id: denver } = await harness.correct(correction(seattle, 'never-right'));

    const rows = await history(harness);
    expect(rows.size).toBe(3);
    // Boston's validity runs straight to Denver: Seattle is not in the chain.
    expect(rows.get(boston)).toMatchObject({ closure: 'replaced', closedBy: denver });
    expect(rows.get(seattle)!.closure).toBe('retracted');
    expect(rows.get(seattle)!.until).toBeDefined();
    expect('closedBy' in rows.get(seattle)!).toBe(false);
    const d = rows.get(denver)!;
    expect(d).toMatchObject({ value: 'Denver', savedBy: 'person' });
    expect(d.until).toBeUndefined();
    expect('closure' in d).toBe(false);

    // The active read shows only Denver.
    const active = await harness.recall({ about: 'user' });
    expect(active.statements.map((s) => s.id)).toEqual([denver]);
  });

  it("'changed' is the plain write: Seattle is replaced, not retracted", async () => {
    harness = await makeMemoryHarness();
    const { boston, seattle } = await bostonThenSeattle(harness);

    const { id: denver } = await harness.correct(correction(seattle, 'changed'));

    const rows = await history(harness);
    expect(rows.get(seattle)).toMatchObject({ closure: 'replaced', closedBy: denver });
    expect(rows.get(boston)).toMatchObject({ closure: 'replaced', closedBy: seattle });
    expect([...rows.values()].some((r) => r.closure === 'retracted')).toBe(false);
    expect(rows.get(denver)!.until).toBeUndefined();
  });

  it('a Forget still reads as forgotten, not retracted', async () => {
    harness = await makeMemoryHarness();
    const { seattle } = await bostonThenSeattle(harness);
    await harness.forget({ ids: [seattle] });
    expect((await history(harness)).get(seattle)!.closure).toBe('forgotten');
  });

  it('records the correction with provenance human', async () => {
    harness = await makeMemoryHarness();
    const { seattle } = await bostonThenSeattle(harness);
    const { id } = await harness.correct(correction(seattle, 'never-right'));
    const engine = await harness.bus.call<
      { limit: number; activeOnly: boolean },
      { statements: Array<{ id: string; provenance: string }> }
    >('memory:facts:recall', harness.ctx(), { limit: 10, activeOnly: false });
    expect(engine.statements.find((s) => s.id === id)?.provenance).toBe('human');
  });

  it('never-right calls supersede (neverTrue, owner-scoped) BEFORE record; changed closes BY the new row AFTER it', async () => {
    harness = await makeMemoryHarness();
    const { seattle } = await bostonThenSeattle(harness);
    const spy = vi.spyOn(harness.bus, 'call');

    await harness.correct(correction(seattle, 'never-right'));
    const engineWrites = (): Array<[string, unknown]> =>
      spy.mock.calls
        .filter(([hook]) => hook === FACTS_SUPERSEDE_HOOK || hook === FACTS_RECORD_HOOK)
        .map(([hook, , payload]) => [hook as string, payload]);
    expect(engineWrites().map(([h]) => h)).toEqual([FACTS_SUPERSEDE_HOOK, FACTS_RECORD_HOOK]);
    expect(engineWrites()[0]![1]).toEqual({ ids: [seattle], neverTrue: true, ownerUserId: ALICE });

    spy.mockClear();
    const again = await harness.remember({ about: 'user', relation: 'lives_in', value: 'Austin' });
    spy.mockClear();
    const { id: fixed } = await harness.correct(correction(again.id, 'changed'));
    expect(engineWrites().map(([h]) => h)).toEqual([FACTS_RECORD_HOOK, FACTS_SUPERSEDE_HOOK]);
    // `by`, never `neverTrue`: a changed value is replaced, not retracted.
    expect(engineWrites()[1]![1]).toEqual({ ids: [again.id], by: fixed, ownerUserId: ALICE });
  });

  // -------------------------------------------------------------------------
  // TASK-632 — 'changed' on a SLOT-LESS row. Nothing in the slot rule can close
  // a row that is in no chain, so before this the old value stayed active
  // beside the new one. `drives` has no slot (see `slots.ts`).
  // -------------------------------------------------------------------------

  it("'changed' on a slot-less row closes it as replaced BY the new row", async () => {
    harness = await makeMemoryHarness();
    const { id: civic } = await harness.remember({
      about: 'user',
      relation: 'drives',
      value: 'a Civic',
      when: '2025-01-01T00:00:00Z',
    });

    const { id: tesla } = await harness.correct({
      id: civic,
      about: 'user',
      relation: 'drives',
      value: 'a Tesla',
      reason: 'changed',
    });

    const rows = await history(harness);
    expect(rows.get(civic)).toMatchObject({ closure: 'replaced', closedBy: tesla });
    expect(rows.get(civic)!.until).toBeDefined();
    expect(rows.get(tesla)!.until).toBeUndefined();
    expect('closure' in rows.get(tesla)!).toBe(false);

    const active = await harness.recall({ about: 'user' });
    expect(active.statements.map((s) => s.id)).toEqual([tesla]);
  });

  it("'changed' leaves a slotted row in a DIFFERENT chain active, exactly as before", async () => {
    harness = await makeMemoryHarness();
    const { id: boston } = await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Boston',
      when: '2025-01-01T00:00:00Z',
    });

    // The person rewrote the relation too: the new row is not in `lives_in`,
    // so the slot rule does not close Boston, and the explicit close refuses a
    // slotted row (its closure belongs to its chain).
    const { id: fixed } = await harness.correct({
      id: boston,
      about: 'user',
      relation: 'drives',
      value: 'a Tesla',
      reason: 'changed',
    });

    const rows = await history(harness);
    expect(rows.get(boston)!.until).toBeUndefined();
    expect('closure' in rows.get(boston)!).toBe(false);
    expect(rows.get(fixed)!.until).toBeUndefined();
  });

  it("personal agent: 'changed' on another owner's slot-less id does not close it", async () => {
    harness = await makeMemoryHarness();
    const foreign = await engineRecord(harness.bus, harness.ctx(), [
      {
        about: `user:${BOB}`,
        relation: 'drives',
        value: 'a Civic',
        when: '2025-01-01T00:00:00Z',
        provenance: 'human',
        ownerUserId: BOB,
      },
    ]);
    const foreignId = foreign.records[0]!.id;

    const { id } = await harness.correct(
      { id: foreignId, about: 'user', relation: 'drives', value: 'a Tesla', reason: 'changed' },
      harness.ctx({ userId: ALICE }),
    );

    const bobs = await engineRecall(harness.bus, harness.ctx(), {
      limit: 10,
      activeOnly: false,
      ownerUserId: BOB,
    });
    expect(bobs.statements.map((s) => s.id)).toEqual([foreignId]);
    expect(bobs.statements[0]!.until).toBeUndefined();
    expect('closedBy' in bobs.statements[0]!).toBe(false);

    const mine = await harness.recall({ about: 'user' }, harness.ctx({ userId: ALICE }));
    expect(mine.statements.map((s) => [s.id, s.value])).toEqual([[id, 'a Tesla']]);
  });

  it("team agent: a member's 'changed' replaces a teammate-saved slot-less row", async () => {
    harness = await makeMemoryHarness({}, { agent: { visibility: 'team' } });
    const { id: seed } = await harness.remember(
      { about: 'acme_corp', relation: 'stage', value: 'seed' },
      harness.ctx({ userId: BOB }),
    );
    const { id: seriesB } = await harness.correct(
      { id: seed, about: 'acme_corp', relation: 'stage', value: 'series B', reason: 'changed' },
      harness.ctx({ userId: ALICE }),
    );
    const { statements } = await harness.recall(
      { about: 'acme_corp', activeOnly: false },
      harness.ctx({ userId: ALICE }),
    );
    expect(statements.find((s) => s.id === seed)).toMatchObject({
      closure: 'replaced',
      closedBy: seriesB,
    });
    expect(statements.find((s) => s.id === seriesB)!.until).toBeUndefined();
  });

  it.each([
    ['reason missing', { id: 'x', about: 'user', relation: 'lives_in', value: 'Denver' }],
    ['reason unknown', { id: 'x', about: 'user', relation: 'lives_in', value: 'Denver', reason: 'oops' }],
    ['reason wrong type', { id: 'x', about: 'user', relation: 'lives_in', value: 'Denver', reason: true }],
    ['id missing', { about: 'user', relation: 'lives_in', value: 'Denver', reason: 'changed' }],
    ['id blank', { id: ' ', about: 'user', relation: 'lives_in', value: 'Denver', reason: 'never-right' }],
    ['value blank', { id: 'x', about: 'user', relation: 'lives_in', value: '', reason: 'changed' }],
    ['about missing', { id: 'x', relation: 'lives_in', value: 'Denver', reason: 'changed' }],
    ['relation missing', { id: 'x', about: 'user', value: 'Denver', reason: 'changed' }],
  ])('refuses %s as invalid-payload and writes nothing', async (_label, payload) => {
    harness = await makeMemoryHarness();
    const { boston, seattle } = await bostonThenSeattle(harness);
    const hostile = { ...payload, ...('id' in payload && payload.id === 'x' ? { id: seattle } : {}) };
    const spy = vi.spyOn(harness.bus, 'call');
    await expect(harness.bus.call(MEMORY_CORRECT_HOOK, harness.ctx(), hostile)).rejects.toMatchObject({
      code: 'invalid-payload',
    });
    expect(
      spy.mock.calls.some(([hook]) => hook === FACTS_SUPERSEDE_HOOK || hook === FACTS_RECORD_HOOK),
    ).toBe(false);
    const rows = await history(harness);
    expect([...rows.keys()].sort()).toEqual([boston, seattle].sort());
    expect(rows.get(seattle)!.until).toBeUndefined();
  });

  it.each([
    ['provenance', 'human'],
    ['savedBy', 'person'],
    ['ownerUserId', BOB],
    ['agentId', 'agent-other'],
    ['visibility', 'team'],
  ])('refuses a payload carrying %s', async (field, value) => {
    harness = await makeMemoryHarness();
    const { seattle } = await bostonThenSeattle(harness);
    await expect(
      harness.bus.call(MEMORY_CORRECT_HOOK, harness.ctx(), {
        ...correction(seattle, 'never-right'),
        [field]: value,
      }),
    ).rejects.toThrow(new RegExp(`${field} is not a caller-settable field`));
    const rows = await history(harness);
    expect(rows.size).toBe(2);
    expect(rows.get(seattle)!.until).toBeUndefined();
  });

  it("personal agent: never-right on another owner's id does not retract it, and the write still lands", async () => {
    harness = await makeMemoryHarness();
    const foreign = await engineRecord(harness.bus, harness.ctx(), [
      {
        about: `user:${BOB}`,
        relation: 'lives_in',
        value: 'Lisbon',
        slot: 'lives_in',
        when: '2025-01-01T00:00:00Z',
        provenance: 'human',
        ownerUserId: BOB,
      },
    ]);
    const foreignId = foreign.records[0]!.id;

    const { id } = await harness.correct(
      { id: foreignId, about: 'user', relation: 'lives_in', value: 'Denver', reason: 'never-right' },
      harness.ctx({ userId: ALICE }),
    );

    const bobs = await engineRecall(harness.bus, harness.ctx(), {
      limit: 10,
      activeOnly: false,
      ownerUserId: BOB,
    });
    expect(bobs.statements.map((s) => s.id)).toEqual([foreignId]);
    expect(bobs.statements[0]!.until).toBeUndefined();
    expect('neverTrue' in bobs.statements[0]!).toBe(false);

    const mine = await harness.recall({ about: 'user' }, harness.ctx({ userId: ALICE }));
    expect(mine.statements.map((s) => [s.id, s.value])).toEqual([[id, 'Denver']]);
  });

  it('team agent: a member may retract a teammate-saved row as never-right', async () => {
    harness = await makeMemoryHarness({}, { agent: { visibility: 'team' } });
    const { id: wrong } = await harness.remember(
      { about: 'acme_corp', relation: 'stage', value: 'seed' },
      harness.ctx({ userId: BOB }),
    );
    const spy = vi.spyOn(harness.bus, 'call');
    await harness.correct(
      { id: wrong, about: 'acme_corp', relation: 'stage', value: 'series B', reason: 'never-right' },
      harness.ctx({ userId: ALICE }),
    );
    const supersede = spy.mock.calls.find(([hook]) => hook === FACTS_SUPERSEDE_HOOK)!;
    // Team scope: no owner filter, exactly as memory:forget sends it.
    expect(supersede[2]).toEqual({ ids: [wrong], neverTrue: true });
    const { statements } = await harness.recall(
      { about: 'acme_corp', activeOnly: false },
      harness.ctx({ userId: ALICE }),
    );
    expect(statements.find((s) => s.id === wrong)!.closure).toBe('retracted');
  });
});
