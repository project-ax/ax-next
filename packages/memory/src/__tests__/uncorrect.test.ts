import { describe, it, expect, afterEach, vi } from 'vitest';

import { FACTS_RECORD_HOOK, FACTS_REVERT_HOOK, MEMORY_UNCORRECT_HOOK } from '../plugin.js';
import type { MemoryStatement } from '../types.js';
import { ALICE, BOB, engineRecall, engineRecord, makeMemoryHarness, type MemoryHarness } from './harness.js';

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

// ---------------------------------------------------------------------------
// memory:uncorrect (TASK-634) — Undo for a Fix.
//
// A Fix writes a NEW human row and closes the old one: "it changed" as a
// replacement (by the slot rule, or TASK-632's close-by for a slot-less row),
// "it was never right" as a never-true retraction. Neither closure can be
// undone with `memory:unforget` (a replaced row is not a retraction), and
// forgetting the new row re-opens a slotted old row but NOT a slot-less one.
// Undo must put the memory back exactly where it was before the Fix, in all
// four combinations — over the REAL sqlite engine, because the property is
// the two plugins together.
// ---------------------------------------------------------------------------

type Reason = 'changed' | 'never-right';

const agentRow = (relation: string, value: string, when: string, slot?: string) => ({
  about: `user:${ALICE}`,
  relation,
  value,
  when,
  ...(slot !== undefined ? { slot } : {}),
  provenance: 'agent' as const,
  ownerUserId: ALICE,
});

async function history(h: MemoryHarness): Promise<Map<string, MemoryStatement>> {
  const { statements } = await h.recall({ about: 'user', activeOnly: false, limit: 50 });
  return new Map(statements.map((s) => [s.id, s]));
}

/** Everything a person could see: History, the active list, the profile pick. */
async function snapshot(h: MemoryHarness) {
  const rows = await history(h);
  const active = (await h.recall({ about: 'user', limit: 50 })).statements.map((s) => s.id).sort();
  const profile = (await h.recall({ profile: true, limit: 100 })).statements.map((s) => s.id);
  return { rows, active, profile };
}

/**
 * Two rows in one batch (chain replay is path-dependent under same-ms ties, so
 * one `record` call keeps the order total): slotted `lives_in` Boston -> Seattle
 * (Seattle closes Boston), or slot-less `likes` tea + coffee. Returns the id of
 * the row a person will Fix.
 */
async function seed(h: MemoryHarness, slotted: boolean): Promise<{ target: string; relation: string }> {
  const rows = slotted
    ? [
        agentRow('lives_in', 'Boston', '2025-01-01T00:00:00.000Z', 'lives_in'),
        agentRow('lives_in', 'Seattle', '2025-06-01T00:00:00.000Z', 'lives_in'),
      ]
    : [
        agentRow('likes', 'coffee', '2025-01-01T00:00:00.000Z'),
        agentRow('likes', 'tea', '2025-06-01T00:00:00.000Z'),
      ];
  const { records } = await engineRecord(h.bus, h.ctx(), rows);
  return { target: records[1]!.id, relation: slotted ? 'lives_in' : 'likes' };
}

const combos: Array<[Reason, boolean]> = [
  ['changed', true],
  ['changed', false],
  ['never-right', true],
  ['never-right', false],
];

describe('@ax/memory — memory:uncorrect', () => {
  it.each(combos)(
    "reason '%s', slotted=%s: Undo returns memory to exactly its pre-Fix state",
    async (reason, slotted) => {
      harness = await makeMemoryHarness();
      const { target, relation } = await seed(harness, slotted);
      const before = await snapshot(harness);

      const { id: fixed } = await harness.correct({
        id: target,
        about: 'user',
        relation,
        value: 'Denver',
        reason,
      });
      // The Fix did something visible, or this test proves nothing.
      const during = await snapshot(harness);
      expect(during.active).toContain(fixed);
      expect(during.active).not.toContain(target);

      expect(await harness.uncorrect({ id: fixed, restore: target })).toEqual({ undone: true });

      const after = await snapshot(harness);
      expect(after.active).toEqual(before.active);
      expect(after.profile).toEqual(before.profile);
      // Every row that existed before the Fix reads back EXACTLY as it did —
      // provenance ("saved by"), closure, successor, never-right label.
      for (const [id, row] of before.rows) expect(after.rows.get(id)).toEqual(row);
      // The Fix's own row stays in History as a plain Forget: it was said,
      // and taken back — never "replaced", never "never right".
      expect(after.rows.size).toBe(before.rows.size + 1);
      expect(after.rows.get(fixed)).toMatchObject({ closure: 'forgotten' });
      expect(after.rows.get(fixed)).not.toHaveProperty('closedBy');
    },
  );

  it.each(combos)("reason '%s', slotted=%s: a second Undo is a no-op", async (reason, slotted) => {
    harness = await makeMemoryHarness();
    const { target, relation } = await seed(harness, slotted);
    const { id: fixed } = await harness.correct({
      id: target,
      about: 'user',
      relation,
      value: 'Denver',
      reason,
    });
    await harness.uncorrect({ id: fixed, restore: target });
    const once = await snapshot(harness);

    expect(await harness.uncorrect({ id: fixed, restore: target })).toEqual({ undone: false });
    expect(await snapshot(harness)).toEqual(once);
  });

  it('writes nothing new — no record call reaches the engine', async () => {
    harness = await makeMemoryHarness();
    const { target, relation } = await seed(harness, true);
    const { id: fixed } = await harness.correct({
      id: target,
      about: 'user',
      relation,
      value: 'Denver',
      reason: 'changed',
    });
    const spy = vi.spyOn(harness.bus, 'call');
    await harness.uncorrect({ id: fixed, restore: target });
    const hooks = spy.mock.calls.map(([hook]) => hook);
    expect(hooks).toContain(FACTS_REVERT_HOOK);
    expect(hooks).not.toContain(FACTS_RECORD_HOOK);
  });

  it("on a personal agent, cannot undo somebody else's Fix", async () => {
    harness = await makeMemoryHarness();
    const { records } = await engineRecord(harness.bus, harness.ctx(), [
      { ...agentRow('likes', 'tea', '2025-01-01T00:00:00.000Z'), about: `user:${BOB}`, ownerUserId: BOB },
      {
        ...agentRow('likes', 'green tea', '2025-06-01T00:00:00.000Z'),
        about: `user:${BOB}`,
        ownerUserId: BOB,
        provenance: 'human' as const,
      },
    ]);
    const [old, fixed] = [records[0]!.id, records[1]!.id];
    await harness.bus.call('memory:facts:supersede', harness.ctx(), { ids: [old], by: fixed });

    expect(await harness.uncorrect({ id: fixed, restore: old })).toEqual({ undone: false });
    const all = await engineRecall(harness.bus, harness.ctx(), { limit: 10, activeOnly: false });
    expect(all.statements.find((s) => s.id === fixed)?.until).toBeUndefined();
    expect(all.statements.find((s) => s.id === old)?.closedBy).toBe(fixed);
  });

  it.each([
    ['id missing', { restore: 'x' }],
    ['restore missing', { id: 'x' }],
    ['id blank', { id: ' ', restore: 'x' }],
    ['restore blank', { id: 'x', restore: '' }],
    ['a privilege field', { id: 'x', restore: 'y', ownerUserId: ALICE }],
  ])('refuses %s as invalid-payload', async (_label, payload) => {
    harness = await makeMemoryHarness();
    await expect(harness.bus.call(MEMORY_UNCORRECT_HOOK, harness.ctx(), payload)).rejects.toMatchObject({
      code: 'invalid-payload',
    });
  });
});
