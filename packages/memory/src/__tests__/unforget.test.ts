import { describe, it, expect, afterEach, vi } from 'vitest';

import { FACTS_RECORD_HOOK, FACTS_REINSTATE_HOOK, MEMORY_UNFORGET_HOOK } from '../plugin.js';
import type { MemoryStatement } from '../types.js';
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
// memory:unforget (TASK-630) — Undo for a Forget.
//
// Before this hook, Undo re-saved the forgotten memory AS THE PERSON. An
// agent-saved fact then came back person-saved, and a person-saved row wins
// the profile over newer non-human values (#761) — so one Undo silently
// changed which fact the profile shows. Over the REAL sqlite engine: the
// property is the two plugins together.
// ---------------------------------------------------------------------------

const row = (
  value: string,
  when: string,
  provenance: 'extracted' | 'agent' | 'human',
) => ({
  about: `user:${ALICE}`,
  relation: 'lives_in',
  value,
  when,
  slot: 'lives_in',
  provenance,
  ownerUserId: ALICE,
});

async function history(h: MemoryHarness): Promise<Map<string, MemoryStatement>> {
  const { statements } = await h.recall({ about: 'user', activeOnly: false, limit: 50 });
  return new Map(statements.map((s) => [s.id, s]));
}

async function profileValues(h: MemoryHarness): Promise<string[]> {
  const { statements } = await h.recall({ profile: true, limit: 100 });
  return statements.map((s) => s.value);
}

/** An agent note (Seattle), then a newer extracted value (Tacoma) in the same slot. */
async function agentNoteThenExtracted(h: MemoryHarness): Promise<{ seattle: string; tacoma: string }> {
  const [a] = (
    await engineRecord(h.bus, h.ctx(), [row('Seattle', '2026-09-25T00:00:00.000Z', 'agent')])
  ).records;
  const [b] = (
    await engineRecord(h.bus, h.ctx(), [row('Tacoma', '2026-09-26T00:00:00.000Z', 'extracted')])
  ).records;
  return { seattle: a!.id, tacoma: b!.id };
}

describe('@ax/memory — memory:unforget', () => {
  it('restores an agent-saved memory as agent-saved, as the same row', async () => {
    harness = await makeMemoryHarness();
    const { seattle } = await agentNoteThenExtracted(harness);
    const before = (await history(harness)).get(seattle)!;
    expect(before.savedBy).toBe('agent');

    await harness.forget({ ids: [seattle] });
    expect((await history(harness)).get(seattle)!.closure).toBe('forgotten');

    const out = await harness.unforget({ ids: [seattle] });
    expect(out).toEqual({ restored: [seattle] });

    const rows = await history(harness);
    // Nothing new was written: still two rows, and Seattle is the same row.
    expect(rows.size).toBe(2);
    const after = rows.get(seattle)!;
    expect(after).toEqual(before);
    expect(after.savedBy).toBe('agent');
    expect('closure' in after).toBe(false);
    expect('until' in after).toBe(false);

    const engine = await harness.bus.call<
      { limit: number; activeOnly: boolean },
      { statements: Array<{ id: string; provenance: string }> }
    >('memory:facts:recall', harness.ctx(), { limit: 10, activeOnly: false });
    expect(engine.statements.find((s) => s.id === seattle)?.provenance).toBe('agent');
  });

  it('does not change which fact the profile shows', async () => {
    harness = await makeMemoryHarness();
    const { seattle } = await agentNoteThenExtracted(harness);
    // #761: the newer extracted value beats the older agent note.
    expect(await profileValues(harness)).toEqual(['Tacoma']);

    await harness.forget({ ids: [seattle] });
    await harness.unforget({ ids: [seattle] });
    expect(await profileValues(harness)).toEqual(['Tacoma']);
  });

  it('(contrast) the old re-save-as-person Undo DID change the profile', async () => {
    // Pins why the hook exists: the same Undo done the pre-TASK-630 way — a
    // plain `memory:remember` of the forgotten value — makes Seattle win.
    // If this ever stops holding, the test above is no longer telling us
    // anything and should be revisited.
    harness = await makeMemoryHarness();
    const { seattle } = await agentNoteThenExtracted(harness);
    await harness.forget({ ids: [seattle] });
    await harness.remember({ about: 'user', relation: 'lives_in', value: 'Seattle' });
    expect(await profileValues(harness)).toEqual(['Seattle']);
  });

  it('writes nothing new — no record call reaches the engine', async () => {
    harness = await makeMemoryHarness();
    const { seattle } = await agentNoteThenExtracted(harness);
    await harness.forget({ ids: [seattle] });
    const spy = vi.spyOn(harness.bus, 'call');
    await harness.unforget({ ids: [seattle] });
    const hooks = spy.mock.calls.map(([hook]) => hook);
    expect(hooks).toContain(FACTS_REINSTATE_HOOK);
    expect(hooks).not.toContain(FACTS_RECORD_HOOK);
  });

  it("undoing a 'never right' retraction clears the label: a later replacement reads 'replaced'", async () => {
    harness = await makeMemoryHarness();
    const { id: boston } = await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Boston',
      when: '2025-01-01T00:00:00Z',
    });
    const { id: seattle } = await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Seattle',
      when: '2025-06-01T00:00:00Z',
    });
    const { id: denver } = await harness.correct({
      id: seattle,
      about: 'user',
      relation: 'lives_in',
      value: 'Denver',
      reason: 'never-right',
    });
    expect((await history(harness)).get(seattle)!.closure).toBe('retracted');

    expect(await harness.unforget({ ids: [seattle] })).toEqual({ restored: [seattle] });

    // Seattle is back in the chain: it closes Boston again, and Denver (the
    // later correction) closes it — as a replacement, not a retraction.
    const rows = await history(harness);
    expect(rows.get(seattle)).toMatchObject({ closure: 'replaced', closedBy: denver });
    expect(rows.get(boston)).toMatchObject({ closure: 'replaced', closedBy: seattle });
    const active = await harness.recall({ about: 'user' });
    expect(active.statements.map((s) => s.id)).toEqual([denver]);
  });

  it('restores nothing for an id that is not forgotten, and says so', async () => {
    harness = await makeMemoryHarness();
    const { id } = await harness.remember({ about: 'user', relation: 'likes', value: 'tea' });
    expect(await harness.unforget({ ids: [id, 'no-such-id'] })).toEqual({ restored: [] });
  });

  it("on a personal agent, cannot bring back somebody else's forgotten row", async () => {
    harness = await makeMemoryHarness();
    const [theirs] = (
      await engineRecord(harness.bus, harness.ctx(), [
        { ...row('Paris', '2026-01-01T00:00:00.000Z', 'agent'), about: `user:${BOB}`, ownerUserId: BOB },
      ])
    ).records;
    await harness.bus.call('memory:facts:supersede', harness.ctx(), { ids: [theirs!.id] });

    expect(await harness.unforget({ ids: [theirs!.id] })).toEqual({ restored: [] });
    const all = await engineRecall(harness.bus, harness.ctx(), { limit: 10, activeOnly: false });
    expect(all.statements.find((s) => s.id === theirs!.id)?.until).toBeDefined();
  });

  it.each([
    ['ids missing', {}],
    ['ids not an array', { ids: 'x' }],
    ['ids empty', { ids: [] }],
    ['an id blank', { ids: [' '] }],
    ['a privilege field', { ids: ['x'], ownerUserId: ALICE }],
  ])('refuses %s as invalid-payload', async (_label, payload) => {
    harness = await makeMemoryHarness();
    await expect(
      harness.bus.call(MEMORY_UNFORGET_HOOK, harness.ctx(), payload),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});
