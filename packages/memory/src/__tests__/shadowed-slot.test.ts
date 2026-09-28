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

// ---------------------------------------------------------------------------
// TASK-633 — a value the person said was NEVER right must not come back on the
// next chat mention either. "Never right" (memory:correct, TASK-624) retracts
// the old row as never-true — closed with NO successor — then writes the
// person's value. Before this, only a row closed WITH a successor counted as
// replaced, so the retracted value, said again in chat, read as news.
//
// Built from the engine calls memory:correct makes (supersede neverTrue, then
// a human record), so each row can carry an explicit date.
// ---------------------------------------------------------------------------

const MAR = '2026-03-10T12:00:00.000Z';
const JUL = '2026-07-10T12:00:00.000Z';

async function retract(h: MemoryHarness, id: string): Promise<void> {
  await h.bus.call('memory:facts:supersede', h.ctx(), { ids: [id], neverTrue: true, ownerUserId: ALICE });
}

describe('@ax/memory — a retracted (never-right) value re-mentioned later', () => {
  it('recall hides the re-mention under the person’s correction', async () => {
    harness = await makeMemoryHarness();
    const [portland] = await record(harness, row('Portland, Oregon', JAN, 'extracted'));
    await retract(harness, portland!);
    await record(
      harness,
      row('Seattle, Washington', FEB, 'human'),
      row('portland, oregon.', JUN, 'extracted', { conversationId: 'conv-again' }),
    );

    expect(values(await harness.recall({}))).toEqual(['Seattle, Washington']);
    expect(values(await harness.recall({ query: 'Portland, Oregon', limit: 1 }))).not.toContain(
      'portland, oregon.',
    );
  });

  it('history marks the re-mention overridden rather than current', async () => {
    harness = await makeMemoryHarness();
    const [portland] = await record(harness, row('Portland, Oregon', JAN, 'extracted'));
    await retract(harness, portland!);
    await record(
      harness,
      row('Seattle, Washington', FEB, 'human'),
      row('Portland, Oregon', JUN, 'extracted', { conversationId: 'conv-again' }),
    );

    const out = await harness.recall({ activeOnly: false });
    const closures = out.statements.map((s) => [s.value, s.closure ?? 'current']);
    expect(closures).toEqual(
      expect.arrayContaining([
        ['Portland, Oregon', 'retracted'],
        ['Portland, Oregon', 'overridden'],
        ['Seattle, Washington', 'current'],
      ]),
    );
  });

  it('the profile does not pick the re-mention over a fresh value', async () => {
    harness = await makeMemoryHarness();
    const [portland] = await record(harness, row('Portland, Oregon', JAN, 'extracted'));
    await retract(harness, portland!);
    await record(
      harness,
      row('Tacoma, Washington', MAR, 'agent'),
      row('Portland, Oregon', JUN, 'extracted', { conversationId: 'conv-again' }),
    );

    expect(values(await harness.recall({ profile: true }))).toEqual(['Tacoma, Washington']);
  });

  it('the person restating the retracted value themselves is authoritative', async () => {
    harness = await makeMemoryHarness();
    const [portland] = await record(harness, row('Portland, Oregon', JAN, 'extracted'));
    await retract(harness, portland!);
    await record(
      harness,
      row('Seattle, Washington', FEB, 'human'),
      row('Portland, Oregon', JUN, 'human'),
      row('Tacoma, Washington', JUL, 'extracted', { conversationId: 'conv-later' }),
    );

    expect(values(await harness.recall({ profile: true }))).toEqual(['Portland, Oregon']);
    const listed = values(await harness.recall({}));
    expect(listed).toContain('Portland, Oregon');
    expect(listed).not.toContain('Seattle, Washington');
  });
});

// ---------------------------------------------------------------------------
// TASK-639 — HUMAN RULING (Vinay, 2026-09-28): HIDE it. The TASK-633 cases
// above all had a RIVAL in the slot. With none, the profile fell back to the
// plain newest row (TASK-602) and recall's drop needed a higher-provenance
// active row to hide under — so a retracted value said again, alone, came
// straight back. A value the person marked never right must never resurface
// on its own; only a person restating it (a `human` row) brings it back.
// ---------------------------------------------------------------------------

describe('@ax/memory — a retracted value re-mentioned with NO rival in its slot', () => {
  it.each([
    ['extraction', 'extracted'],
    ['a model note', 'agent'],
  ] as const)('a re-mention by %s stays hidden in the profile AND recall', async (_label, provenance) => {
    harness = await makeMemoryHarness();
    const [portland] = await record(harness, row('Portland, Oregon', JAN, 'extracted'));
    await retract(harness, portland!);
    await record(harness, row('portland, oregon.', JUN, provenance, { conversationId: 'conv-again' }));

    expect(values(await harness.recall({ profile: true }))).toEqual([]);
    expect(values(await harness.recall({}))).toEqual([]);
    expect(values(await harness.recall({ query: 'Portland, Oregon' }))).toEqual([]);
  });

  it('history marks the lone re-mention overridden, and the profile history agrees', async () => {
    harness = await makeMemoryHarness();
    const [portland] = await record(harness, row('Portland, Oregon', JAN, 'extracted'));
    await retract(harness, portland!);
    await record(harness, row('Portland, Oregon', JUN, 'extracted', { conversationId: 'conv-again' }));

    for (const input of [{ activeOnly: false }, { activeOnly: false, profile: true }]) {
      const out = await harness.recall(input);
      expect(out.statements.map((s) => [s.value, s.closure ?? 'current'])).toEqual(
        expect.arrayContaining([
          ['Portland, Oregon', 'retracted'],
          ['Portland, Oregon', 'overridden'],
        ]),
      );
    }
  });

  it('the person restating it brings it back — and it outlives a later model re-mention', async () => {
    harness = await makeMemoryHarness();
    const [portland] = await record(harness, row('Portland, Oregon', JAN, 'extracted'));
    await retract(harness, portland!);
    await record(harness, row('Portland, Oregon', JUN, 'human'));

    expect(values(await harness.recall({ profile: true }))).toEqual(['Portland, Oregon']);
    expect(values(await harness.recall({}))).toEqual(['Portland, Oregon']);

    await record(harness, row('Portland, Oregon', JUL, 'extracted', { conversationId: 'conv-later' }));
    expect(values(await harness.recall({ profile: true }))).toEqual(['Portland, Oregon']);
  });

  it('a new value in the emptied slot is news, not a re-mention', async () => {
    harness = await makeMemoryHarness();
    const [portland] = await record(harness, row('Portland, Oregon', JAN, 'extracted'));
    await retract(harness, portland!);
    await record(harness, row('Tacoma, Washington', JUN, 'extracted', { conversationId: 'conv-new' }));

    expect(values(await harness.recall({ profile: true }))).toEqual(['Tacoma, Washington']);
    expect(values(await harness.recall({}))).toEqual(['Tacoma, Washington']);
  });

  // TASK-634 (#780): Undo for a Fix leaves the Fix's own row as a plain
  // Forget precisely so it does NOT suppress a later mention of that value,
  // and it clears the never-right bit on the row it restores. Hiding retracted
  // values must not turn either of those back into a suppression. A forward
  // guard: it passes on the pre-TASK-639 code too, and reddens if a later
  // change starts treating a forgotten or reinstated row as retracted.
  it('Undo of a never-right Fix: neither the Fix value nor the restored value is suppressed', async () => {
    harness = await makeMemoryHarness();
    const [seattle] = await record(harness, row('Seattle, Washington', JAN, 'agent'));
    const { id: fixed } = await harness.correct({
      id: seattle!,
      about: 'user',
      relation: 'lives_in',
      value: 'Denver, Colorado',
      reason: 'never-right',
    });
    expect(await harness.uncorrect({ id: fixed, restore: seattle! })).toEqual({ undone: true });
    expect(values(await harness.recall({ profile: true }))).toEqual(['Seattle, Washington']);

    // The model says the Fix's value again: it is news, and the newest wins.
    await record(harness, row('Denver, Colorado', JUN, 'extracted', { conversationId: 'conv-denver' }));
    expect(values(await harness.recall({ profile: true }))).toEqual(['Denver, Colorado']);
    expect(values(await harness.recall({}))).toContain('Denver, Colorado');

    // The restored value is no longer "never right": forgotten, then said
    // again alone, it shows.
    await harness.forget({ ids: [seattle!] });
    await record(harness, row('Seattle, Washington', JUL, 'extracted', { conversationId: 'conv-seattle' }));
    expect(values(await harness.recall({}))).toContain('Seattle, Washington');
  });
});

// ---------------------------------------------------------------------------
// TASK-648 — HUMAN RULING (Vinay, 2026-09-28): the PERSON restating a retracted
// value in their own chat message brings it back; the agent repeating it in
// its reply does not. The observer marks which turn a fact came from
// (`sourceRole`); the row itself stays `extracted`. Driven through the real
// engine and `memory:correct`, so the Fix's human correction is the rival.
// ---------------------------------------------------------------------------

describe('@ax/memory — the person restating a retracted value in chat (TASK-648)', () => {
  /** Denver (extracted) → Fix "never right" → Boston (human). */
  async function fixedNeverRight(h: MemoryHarness): Promise<{ denver: string; boston: string }> {
    const [denver] = await record(h, row('Denver, Colorado', JAN, 'extracted'));
    const { id: boston } = await h.correct({
      id: denver!,
      about: 'user',
      relation: 'lives_in',
      value: 'Boston, Massachusetts',
      reason: 'never-right',
    });
    return { denver: denver!, boston };
  }
  // The Fix's correction is dated NOW (a correction is true from now), so the
  // chat restatement — which the observer dates when it is said — comes after.
  const restated = (role: 'user' | 'assistant'): Row =>
    row('Denver, Colorado', new Date(Date.now() + 60_000).toISOString(), 'extracted', {
      conversationId: 'conv-back',
      sourceTurnId: `turn-${role}`,
      sourceRole: role,
    });

  it("the person's own message brings it back — profile, recall, and a query", async () => {
    harness = await makeMemoryHarness();
    await fixedNeverRight(harness);
    await record(harness, restated('user'));

    expect(values(await harness.recall({ profile: true }))).toEqual(['Denver, Colorado']);
    expect(values(await harness.recall({}))).toContain('Denver, Colorado');
    expect(values(await harness.recall({ query: 'Denver, Colorado' }))).toContain('Denver, Colorado');
  });

  it("the agent's reply repeating it stays hidden", async () => {
    harness = await makeMemoryHarness();
    await fixedNeverRight(harness);
    await record(harness, restated('assistant'));

    expect(values(await harness.recall({ profile: true }))).toEqual(['Boston, Massachusetts']);
    expect(values(await harness.recall({}))).not.toContain('Denver, Colorado');
    expect(values(await harness.recall({ query: 'Denver, Colorado' }))).not.toContain('Denver, Colorado');
  });

  it('history marks the correction, not the restatement, as overridden', async () => {
    harness = await makeMemoryHarness();
    await fixedNeverRight(harness);
    await record(harness, restated('user'));

    const out = await harness.recall({ activeOnly: false, profile: true });
    expect(out.statements.map((s) => [s.value, s.closure ?? 'current'])).toEqual(
      expect.arrayContaining([
        ['Denver, Colorado', 'retracted'],
        ['Denver, Colorado', 'current'],
        ['Boston, Massachusetts', 'overridden'],
      ]),
    );
  });

  it('Forget on the restatement puts the correction back', async () => {
    harness = await makeMemoryHarness();
    await fixedNeverRight(harness);
    const [again] = await record(harness, restated('user'));
    await harness.forget({ ids: [again!] });

    expect(values(await harness.recall({ profile: true }))).toEqual(['Boston, Massachusetts']);
    expect(values(await harness.recall({}))).not.toContain('Denver, Colorado');
  });

  it('a second never-right Fix on the restatement hides it again', async () => {
    harness = await makeMemoryHarness();
    await fixedNeverRight(harness);
    const [again] = await record(harness, restated('user'));
    await harness.correct({
      id: again!,
      about: 'user',
      relation: 'lives_in',
      value: 'Austin, Texas',
      reason: 'never-right',
    });

    expect(values(await harness.recall({ profile: true }))).toEqual(['Austin, Texas']);
    expect(values(await harness.recall({}))).not.toContain('Denver, Colorado');
  });

  it('Undo of the original Fix leaves nothing retracted, so the restatement just shows', async () => {
    harness = await makeMemoryHarness();
    const { denver, boston } = await fixedNeverRight(harness);
    await record(harness, restated('user'));
    expect(await harness.uncorrect({ id: boston, restore: denver })).toEqual({ undone: true });

    expect(values(await harness.recall({ profile: true }))).toEqual(['Denver, Colorado']);
  });

  it('a REPLACED value the person restates is unchanged: their correction still wins', async () => {
    harness = await makeMemoryHarness();
    const [denver] = await record(harness, row('Denver, Colorado', JAN, 'extracted'));
    await harness.correct({
      id: denver!,
      about: 'user',
      relation: 'lives_in',
      value: 'Boston, Massachusetts',
      reason: 'changed',
    });
    await record(harness, restated('user'));

    expect(values(await harness.recall({ profile: true }))).toEqual(['Boston, Massachusetts']);
    expect(values(await harness.recall({}))).not.toContain('Denver, Colorado');
  });
});
