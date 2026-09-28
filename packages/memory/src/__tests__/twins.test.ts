import { describe, expect, it } from 'vitest';

import {
  dropTwins,
  findActiveExtractedTwin,
  hasActiveTwin,
  hasRetractedTwin,
  isTwin,
  relationKey,
  type PriorRow,
} from '../twins.js';

/**
 * TASK-641 — an extracted statement that restates what the agent (or the
 * person) already saved in the same conversation is a TWIN, and is not stored.
 *
 * The two pairs below are the ones the TASK-629 walk measured on kind: the
 * agent's `memory_note` and the extractor spelled the relation differently
 * only in its separators, and paraphrased the value.
 */

const ME = 'user:user-alice';

function agent(relation: string, value: string, about = ME): PriorRow {
  return { about, relation, value, provenance: 'agent' };
}

describe('relationKey', () => {
  it.each([
    ['product_go_live_date', 'product go-live date'],
    ['relocating_to', 'relocating to'],
    ['Lives_In', '  lives   in '],
    ['a-b_c d', 'a b c d'],
  ])('folds %s and %s to one key', (a, b) => {
    expect(relationKey(a)).toBe(relationKey(b));
  });

  it('keeps different words apart', () => {
    expect(relationKey('relocating_to')).not.toBe(relationKey('relocated_from'));
  });
});

describe('isTwin — the measured walk pairs', () => {
  it('go-live: agent "October 14, 2026" vs extracted "Product go-live moved to October 14"', () => {
    expect(
      isTwin(
        { about: ME, relation: 'product_go_live_date', value: 'Product go-live moved to October 14' },
        agent('product go-live date', 'October 14, 2026'),
      ),
    ).toBe(true);
  });

  it('relocation: agent "Denver, in November 2026" vs extracted "Relocating to Denver in November"', () => {
    expect(
      isTwin(
        { about: ME, relation: 'relocating_to', value: 'Relocating to Denver in November' },
        agent('relocating to', 'Denver, in November 2026'),
      ),
    ).toBe(true);
  });

  it('an identical statement is a twin', () => {
    expect(
      isTwin({ about: ME, relation: 'lives_in', value: 'Boston' }, agent('lives_in', 'Boston')),
    ).toBe(true);
  });

  // A boundary guard for the one-word branch of the two-word rule, not a
  // regression test: it also passes under the old one-shared-word rule.
  it('a one-word value contained in the other is a twin', () => {
    expect(
      isTwin({ about: ME, relation: 'lives_in', value: 'Boston, MA' }, agent('lives in', 'Boston')),
    ).toBe(true);
  });

  it('a human row is a prior too', () => {
    expect(
      isTwin(
        { about: ME, relation: 'lives_in', value: 'Boston' },
        { about: ME, relation: 'lives in', value: 'Boston, MA', provenance: 'human' },
      ),
    ).toBe(true);
  });
});

describe('isTwin — what must NOT match', () => {
  it('a second value of a multi-valued relation is kept', () => {
    expect(
      isTwin({ about: ME, relation: 'likes_artist', value: 'Bjork' }, agent('likes artist', 'Radiohead')),
    ).toBe(false);
  });

  it.each([
    ['goal', 'Learn Spanish', 'Learn French'],
    ['plans_to', 'Visit Japan', 'Visit Peru'],
    ['likes', 'Thai food', 'Italian food'],
  ])('%s: one shared word between two-word values is not enough (%s / %s)', (relation, noted, extracted) => {
    expect(isTwin({ about: ME, relation, value: extracted }, agent(relation, noted))).toBe(false);
  });

  it('words the relation or subject already carry do not count as shared value', () => {
    expect(
      isTwin(
        { about: ME, relation: 'likes', value: 'User likes Bjork' },
        agent('likes', 'User likes Radiohead'),
      ),
    ).toBe(false);
  });

  it('stopwords alone do not make a twin', () => {
    expect(
      isTwin(
        { about: ME, relation: 'plans', value: 'to go to the beach' },
        agent('plans', 'to finish the report'),
      ),
    ).toBe(false);
  });

  it('a different subject is not a twin', () => {
    expect(
      isTwin(
        { about: 'user:user-bob', relation: 'lives_in', value: 'Boston' },
        agent('lives_in', 'Boston'),
      ),
    ).toBe(false);
  });

  it('a different relation is not a twin, even with the same value', () => {
    expect(
      isTwin({ about: ME, relation: 'born_in', value: 'Denver' }, agent('lives in', 'Denver')),
    ).toBe(false);
  });

  it('another EXTRACTED row is not a prior — only a higher tier suppresses', () => {
    expect(
      isTwin(
        { about: ME, relation: 'lives_in', value: 'Boston' },
        { about: ME, relation: 'lives_in', value: 'Boston', provenance: 'extracted' },
      ),
    ).toBe(false);
  });

  it('a prior with no provenance is not trusted as a higher tier', () => {
    expect(
      isTwin(
        { about: ME, relation: 'lives_in', value: 'Boston' },
        { about: ME, relation: 'lives_in', value: 'Boston' },
      ),
    ).toBe(false);
  });

  it('prototype-shaped words are ordinary words', () => {
    expect(
      isTwin(
        { about: ME, relation: 'note', value: 'constructor toString' },
        agent('note', '__proto__ hasOwnProperty'),
      ),
    ).toBe(false);
  });
});

describe('dropTwins', () => {
  it('keeps the non-twins in order and counts the twins', () => {
    const statements = [
      { about: ME, relation: 'relocating_to', value: 'Relocating to Denver in November' },
      { about: ME, relation: 'likes_artist', value: 'Bjork' },
      { about: ME, relation: 'product_go_live_date', value: 'Product go-live moved to October 14' },
    ];
    const out = dropTwins(statements, [
      agent('relocating to', 'Denver, in November 2026'),
      agent('product go-live date', 'October 14, 2026'),
      agent('likes artist', 'Radiohead'),
    ]);
    expect(out.kept).toEqual([statements[1]]);
    expect(out.twins).toBe(2);
  });

  it('no priors keeps everything', () => {
    const statements = [{ about: ME, relation: 'lives_in', value: 'Boston' }];
    expect(dropTwins(statements, [])).toEqual({ kept: statements, twins: 0 });
  });

  it('keeps a twin the caller spares, and does not count it (TASK-649)', () => {
    const statements = [
      { about: ME, relation: 'lives_in', value: 'Denver, Colorado' },
      { about: ME, relation: 'relocating_to', value: 'Relocating to Denver in November' },
    ];
    const out = dropTwins(
      statements,
      [agent('lives in', 'Denver, Colorado'), agent('relocating to', 'Denver, in November 2026')],
      (s) => s === statements[0],
    );
    expect(out).toEqual({ kept: [statements[0]], twins: 1 });
  });
});

describe('hasActiveTwin (TASK-649)', () => {
  const s = { about: ME, relation: 'lives_in', value: 'Denver, Colorado' };

  it('an active agent twin counts', () => {
    expect(hasActiveTwin(s, [agent('lives in', 'Denver, Colorado')])).toBe(true);
  });

  it('a closed one alone does not', () => {
    const closed = { ...agent('lives in', 'Denver, Colorado'), until: '2026-09-28T00:00:00Z' };
    expect(hasActiveTwin(s, [closed])).toBe(false);
  });
});

describe('findActiveExtractedTwin — the reverse order (TASK-649)', () => {
  const extracted = (relation: string, value: string, until?: string): PriorRow => ({
    about: ME,
    relation,
    value,
    provenance: 'extracted',
    ...(until !== undefined ? { until } : {}),
  });
  const note = { about: ME, relation: 'relocating to', value: 'Denver, in November 2026' };

  it('finds the active extracted restatement of the note (the walk pair, reversed)', () => {
    const row = extracted('relocating_to', 'Relocating to Denver in November');
    expect(findActiveExtractedTwin(note, [row])).toBe(row);
  });

  it('a closed extracted row does not count', () => {
    const closed = extracted('relocating_to', 'Relocating to Denver in November', '2026-09-28T00:00:00Z');
    expect(findActiveExtractedTwin(note, [closed])).toBeUndefined();
  });

  it('an agent or human row does not count — only an extracted one', () => {
    const human: PriorRow = { ...agent('relocating to', 'Denver, in November 2026'), provenance: 'human' };
    expect(findActiveExtractedTwin(note, [agent('relocating to', 'Denver, in November 2026')])).toBeUndefined();
    expect(findActiveExtractedTwin(note, [human])).toBeUndefined();
  });

  it('a different value, or another subject, is not a twin', () => {
    const artist = { about: ME, relation: 'likes artist', value: 'Radiohead' };
    expect(findActiveExtractedTwin(artist, [extracted('likes_artist', 'Bjork')])).toBeUndefined();
    const bob = { ...extracted('relocating_to', 'Relocating to Denver in November'), about: 'user:bob' };
    expect(findActiveExtractedTwin(note, [bob])).toBeUndefined();
  });
});

describe('hasRetractedTwin — a value the person said was never right (TASK-654)', () => {
  const CLOSED = '2026-09-28T00:00:00Z';
  const retracted = (relation: string, value: string, provenance = 'agent'): PriorRow => ({
    about: ME,
    relation,
    value,
    provenance,
    until: CLOSED,
    neverTrue: true,
  });
  const s = { about: ME, relation: 'relocating_to', value: 'Relocating to Denver in November' };

  it('a never-right row saying the same thing is a retracted twin (the walk pair)', () => {
    expect(hasRetractedTwin(s, [retracted('relocating to', 'Denver, in November 2026')])).toBe(true);
  });

  it('is tier-blind: an extracted row Fixed as never right counts too', () => {
    const row = retracted('relocating to', 'Denver, in November 2026', 'extracted');
    expect(hasRetractedTwin(s, [row])).toBe(true);
  });

  it('a Forget (closed, no never-right mark) is not a retraction', () => {
    const forgotten: PriorRow = { ...agent('relocating to', 'Denver, in November 2026'), until: CLOSED };
    expect(hasRetractedTwin(s, [forgotten])).toBe(false);
  });

  it('an ACTIVE row is not a retraction, whatever it carries', () => {
    const active: PriorRow = { ...agent('relocating to', 'Denver, in November 2026'), neverTrue: true };
    expect(hasRetractedTwin(s, [active])).toBe(false);
  });

  it('a different fact, relation or subject is not a twin', () => {
    expect(hasRetractedTwin(s, [retracted('relocating to', 'Austin, in March 2027')])).toBe(false);
    expect(hasRetractedTwin(s, [retracted('visited', 'Denver, in November 2026')])).toBe(false);
    const bob: PriorRow = { ...retracted('relocating to', 'Denver, in November 2026'), about: 'user:bob' };
    expect(hasRetractedTwin(s, [bob])).toBe(false);
  });
});
