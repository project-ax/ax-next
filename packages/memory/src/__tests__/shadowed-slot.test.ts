import { describe, it, expect, afterEach } from 'vitest';

import { ALICE, engineRecord, makeMemoryHarness, type MemoryHarness } from './harness.js';

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

const JAN = '2026-01-10T12:00:00.000Z';
const FEB = '2026-02-10T12:00:00.000Z';
const JUN = '2026-06-10T12:00:00.000Z';
const USER = `user:${ALICE}`;

// ---------------------------------------------------------------------------
// A person's correction must survive the next chat mention on the READ path
// too (design §3.4) — found live on kind in the TASK-519 rung-5 walk.
//
// Portland (extracted) is corrected to Seattle (human), which closes it. The
// person then says "Portland" in chat again. Rule 3 keeps the new extracted
// row from closing the human one, so both are active, and `memory:recall`
// handed the agent the stale value as current — `[FACT]`, beside the person's
// own correction.
//
// Only a RE-MENTION of a replaced value is hidden. A genuinely new value under
// an old human row ("I moved to Coimbra") stays visible: that is news, and the
// model reads the dated evidence.
// ---------------------------------------------------------------------------

type Row = Parameters<typeof engineRecord>[2][number];
const row = (value: string, when: string, provenance: Row['provenance'], extra: Partial<Row> = {}): Row => ({
  about: USER,
  relation: 'lives_in',
  value,
  when,
  slot: 'lives_in',
  provenance,
  ownerUserId: ALICE,
  ...extra,
});

async function record(h: MemoryHarness, ...rows: Row[]): Promise<string[]> {
  const ids: string[] = [];
  // One call per row: each arrival settles its slot against what is already
  // there, which is how the observer and the UI write in production.
  for (const r of rows) ids.push(...(await engineRecord(h.bus, h.ctx(), [r])).records.map((x) => x.id));
  return ids;
}

/** Portland → corrected to Seattle by the person → "Portland" said again in chat. */
async function correctedThenRestated(h: MemoryHarness, restated = 'Portland, Oregon'): Promise<void> {
  await record(
    h,
    row('Portland, Oregon', JAN, 'extracted'),
    row('Seattle, Washington', FEB, 'human'),
    row(restated, JUN, 'extracted', { conversationId: 'conv-restated' }),
  );
}

const values = (out: { statements: Array<{ value: string }> }): string[] => out.statements.map((s) => s.value);

describe('@ax/memory — memory:recall hides a re-mention of a value the person corrected', () => {
  it('returns the correction, not the restated old value', async () => {
    harness = await makeMemoryHarness();
    await correctedThenRestated(harness);

    const out = values(await harness.recall({ query: 'where does the user live' }));
    expect(out).toContain('Seattle, Washington');
    expect(out).not.toContain('Portland, Oregon');
  });

  it('still hides it when the correction and the replaced row are outside the retrieved pool', async () => {
    harness = await makeMemoryHarness();
    await correctedThenRestated(harness);

    // limit 1 on a query naming the stale value: the pool is the stale row
    // alone, so a check that only looked inside the pool would let it through.
    expect(values(await harness.recall({ query: 'Portland, Oregon', limit: 1 }))).not.toContain(
      'Portland, Oregon',
    );
  });

  it('the listing (no query) hides it too', async () => {
    harness = await makeMemoryHarness();
    await correctedThenRestated(harness);

    const out = values(await harness.recall({}));
    expect(out).toContain('Seattle, Washington');
    expect(out).not.toContain('Portland, Oregon');
  });

  it('matches through case, spacing and trailing punctuation', async () => {
    harness = await makeMemoryHarness();
    await correctedThenRestated(harness, '  portland,   OREGON. ');

    expect(values(await harness.recall({}))).toEqual(['Seattle, Washington']);
  });

  it('history (activeOnly: false) still shows every row — it is hidden, not deleted', async () => {
    harness = await makeMemoryHarness();
    await correctedThenRestated(harness);

    const out = values(await harness.recall({ activeOnly: false }));
    expect(out.filter((v) => v === 'Portland, Oregon')).toHaveLength(2);
    expect(out).toContain('Seattle, Washington');
  });

  it('keeps a genuinely new value visible under an old human row', async () => {
    harness = await makeMemoryHarness();
    await record(
      harness,
      row('Paris', JAN, 'human'),
      row('Coimbra', JUN, 'extracted', { conversationId: 'conv-moved' }),
    );

    const out = values(await harness.recall({ query: 'where does the user live' }));
    expect(out).toContain('Coimbra');
    expect(out).toContain('Paris');
  });

  it('does not treat a FORGOTTEN value as corrected', async () => {
    harness = await makeMemoryHarness();
    const [portland] = await record(harness, row('Portland, Oregon', JAN, 'extracted'));
    await harness.forget({ ids: [portland!] });
    await record(
      harness,
      row('Seattle, Washington', FEB, 'human', { slot: 'lives_in', relation: 'lives in' }),
      row('Portland, Oregon', JUN, 'extracted', { conversationId: 'conv-again' }),
    );

    // Portland was forgotten, not replaced by anything — saying it again is
    // not the stale value of a correction, so recall shows it.
    expect(values(await harness.recall({}))).toContain('Portland, Oregon');
  });

  it('never hides a slot-less row, whatever else shares its subject', async () => {
    harness = await makeMemoryHarness();
    await correctedThenRestated(harness);
    await record(harness, row('Portland, Oregon', JUN, 'extracted', { relation: 'grew_up_in', slot: undefined }));

    const out = await harness.recall({});
    expect(out.statements.filter((s) => s.value === 'Portland, Oregon').map((s) => s.relation)).toEqual([
      'grew_up_in',
    ]);
  });
});
