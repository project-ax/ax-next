import { describe, expect, it } from 'vitest';

import {
  dropRementionedSlotRows,
  isRetractedValue,
  needsSlotHistory,
  selectProfileRows,
} from '../profile.js';

// TASK-602 — which row the profile SHOWS when a single-valued slot holds more
// than one active row. Storage rule 3 (`human > agent > extracted`) decides
// what gets CLOSED and is not touched here; this is only the pick.
//
// Ruling (Vinay, 2026-09-27): a person's own edit stays authoritative; among
// everything else the newest value wins — unless it is a re-mention of a value
// the chain already replaced, which is the stale value coming back, not news.

const ABOUT = 'user:alice';

interface Row {
  id: string;
  about: string;
  slot?: string;
  value: string;
  when: string;
  provenance?: string;
  until?: string;
  closedBy?: string;
  sourceRole?: 'user' | 'assistant';
}

function r(id: string, value: string, when: string, provenance: string, extra: Partial<Row> = {}): Row {
  return { id, about: ABOUT, slot: 'lives_in', value, when, provenance, ...extra };
}

const pick = (rows: Row[], history: Row[] = []): string[] =>
  selectProfileRows(rows, 10, history).map((row) => row.value);

describe('selectProfileRows — TASK-602', () => {
  it('a newer extracted value beats an older agent note (the walk: Tacoma over Seattle)', () => {
    const seattle = r('a', 'Seattle, Washington', '2026-09-25T21:31:51.890Z', 'agent');
    const tacoma = r('b', 'Tacoma, Washington', '2026-09-26T00:30:22.000Z', 'extracted');
    expect(pick([seattle, tacoma])).toEqual(['Tacoma, Washington']);
    // Input order must not matter.
    expect(pick([tacoma, seattle])).toEqual(['Tacoma, Washington']);
  });

  it('a newer agent note beats an older extracted value', () => {
    const extracted = r('a', 'Portland', '2026-01-01T00:00:00.000Z', 'extracted');
    const agent = r('b', 'Seattle', '2026-02-01T00:00:00.000Z', 'agent');
    expect(pick([extracted, agent])).toEqual(['Seattle']);
  });

  it("the person's own edit still beats a newer extracted value and a newer agent note", () => {
    const human = r('h', 'Boston', '2023-01-01T00:00:00.000Z', 'human');
    const agent = r('a', 'Denver', '2023-02-01T00:00:00.000Z', 'agent');
    const extracted = r('e', 'Austin', '2023-03-01T00:00:00.000Z', 'extracted');
    expect(pick([human, agent, extracted])).toEqual(['Boston']);
  });

  it('a re-mention of a value the chain already replaced does not count as newer', () => {
    // Portland (extracted, Jan) was replaced by the agent's Seattle (Feb);
    // chat then says "Portland" again (Jun). That is the stale value coming
    // back, so the agent's Seattle keeps the profile.
    const replaced = r('p1', 'Portland', '2026-01-01T00:00:00.000Z', 'extracted', {
      until: '2026-02-01T00:00:00.000Z',
      closedBy: 's',
    });
    const seattle = r('s', 'Seattle', '2026-02-01T00:00:00.000Z', 'agent');
    const again = r('p2', 'portland.', '2026-06-01T00:00:00.000Z', 'extracted');
    expect(pick([seattle, again], [replaced, seattle, again])).toEqual(['Seattle']);
  });

  it('a FORGOTTEN value (closed with no successor) is not a replaced one', () => {
    const forgotten = r('p1', 'Portland', '2026-01-01T00:00:00.000Z', 'extracted', {
      until: '2026-01-15T00:00:00.000Z',
    });
    const seattle = r('s', 'Seattle', '2026-02-01T00:00:00.000Z', 'agent');
    const portland = r('p2', 'Portland', '2026-06-01T00:00:00.000Z', 'extracted');
    expect(pick([seattle, portland], [forgotten, seattle, portland])).toEqual(['Portland']);
  });

  it('a replaced value from a DIFFERENT subject does not make a re-mention', () => {
    const elsewhere = r('x', 'Portland', '2026-01-01T00:00:00.000Z', 'extracted', {
      about: 'user:bob',
      until: '2026-02-01T00:00:00.000Z',
      closedBy: 'y',
    });
    const seattle = r('s', 'Seattle', '2026-02-01T00:00:00.000Z', 'agent');
    const portland = r('p', 'Portland', '2026-06-01T00:00:00.000Z', 'extracted');
    expect(pick([seattle, portland], [elsewhere])).toEqual(['Portland']);
  });

  it('ignores a closed row passed as a candidate — only active rows can be shown', () => {
    // Forgotten (no closedBy), so it is NOT a re-mention: only the
    // active-row filter keeps this newest value off the profile.
    const closed = r('c', 'Tacoma', '2026-09-26T00:00:00.000Z', 'extracted', {
      until: '2026-09-27T00:00:00.000Z',
    });
    const seattle = r('s', 'Seattle', '2026-09-25T00:00:00.000Z', 'agent');
    expect(pick([closed, seattle])).toEqual(['Seattle']);
  });

  it('equal when: the higher provenance wins, then the id — stable across input order', () => {
    const agent = r('a', 'Seattle', '2026-01-01T00:00:00.000Z', 'agent');
    const extracted = r('b', 'Tacoma', '2026-01-01T00:00:00.000Z', 'extracted');
    expect(pick([agent, extracted])).toEqual(['Seattle']);
    expect(pick([extracted, agent])).toEqual(['Seattle']);
  });

  it('two human rows: the newer one wins', () => {
    const older = r('h1', 'Boston', '2023-01-01T00:00:00.000Z', 'human');
    const newer = r('h2', 'Denver', '2023-06-01T00:00:00.000Z', 'human');
    expect(pick([newer, older])).toEqual(['Denver']);
  });
});

describe('selectProfileRows — a same-value restatement is not a replacement', () => {
  it('an agent note restating the extracted value it closed is not itself a re-mention', () => {
    // Extracted "Seattle" closed by the agent's "Seattle" (same value), then
    // an extracted "Portland" that WAS replaced earlier comes back. The agent's
    // Seattle is fresh; Portland is the re-mention.
    const portlandOld = r('p1', 'Portland', '2025-12-01T00:00:00.000Z', 'extracted', {
      until: '2026-01-01T00:00:00.000Z',
      closedBy: 'e',
    });
    const seattleExtracted = r('e', 'Seattle', '2026-01-01T00:00:00.000Z', 'extracted', {
      until: '2026-02-01T00:00:00.000Z',
      closedBy: 's',
    });
    const seattleAgent = r('s', 'Seattle', '2026-02-01T00:00:00.000Z', 'agent');
    const portlandAgain = r('p2', 'Portland', '2026-06-01T00:00:00.000Z', 'extracted');
    expect(
      pick([seattleAgent, portlandAgain], [portlandOld, seattleExtracted, seattleAgent, portlandAgain]),
    ).toEqual(['Seattle']);
  });
});

describe('selectProfileRows — value comparison stays linear (CodeQL js/polynomial-redos)', () => {
  it('compares a value with a long run of punctuation not at the end in well under a second', () => {
    // A regex like /[.!,;:]+$/ backtracks quadratically on "!!!…!x": every
    // start position scans the whole run before failing at the "x".
    const hostile = `${'!'.repeat(50_000)}x`;
    const replaced = r('p1', hostile, '2026-01-01T00:00:00.000Z', 'extracted', {
      until: '2026-02-01T00:00:00.000Z',
      closedBy: 's',
    });
    const seattle = r('s', 'Seattle', '2026-02-01T00:00:00.000Z', 'agent');
    const again = r('p2', `${hostile}!!`, '2026-06-01T00:00:00.000Z', 'extracted');
    const started = performance.now();
    expect(pick([seattle, again], [replaced, seattle, again])).toEqual(['Seattle']);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// TASK-633 — a value the person said was NEVER right (`neverTrue`, closed with
// no successor) is at least as replaced as one the chain replaced: saying it
// again in chat is the stale value coming back, not news. A person's own
// restatement (a `human` row) is still authoritative and wins its slot.
describe('selectProfileRows — a retracted (never-right) value is a replaced one', () => {
  const retracted = (value = 'Portland'): Row & { neverTrue: boolean } => ({
    ...r('p1', value, '2026-01-01T00:00:00.000Z', 'extracted', { until: '2026-01-15T00:00:00.000Z' }),
    neverTrue: true,
  });

  it('a retracted value re-mentioned later does not win selection', () => {
    const tacoma = r('t', 'Tacoma', '2026-03-01T00:00:00.000Z', 'agent');
    const again = r('p2', 'portland.', '2026-06-01T00:00:00.000Z', 'extracted');
    expect(pick([tacoma, again], [retracted(), tacoma, again])).toEqual(['Tacoma']);
    expect(pick([again, tacoma], [again, tacoma, retracted()])).toEqual(['Tacoma']);
  });

  it('a retracted row passed in `rows` (not `history`) counts too', () => {
    const tacoma = r('t', 'Tacoma', '2026-03-01T00:00:00.000Z', 'agent');
    const again = r('p2', 'Portland', '2026-06-01T00:00:00.000Z', 'agent');
    expect(pick([retracted(), tacoma, again])).toEqual(['Tacoma']);
  });

  it("the person's own restatement of a retracted value wins its slot", () => {
    const tacoma = r('t', 'Tacoma', '2026-03-01T00:00:00.000Z', 'agent');
    const mine = r('h', 'Portland', '2026-06-01T00:00:00.000Z', 'human');
    const later = r('e', 'Tacoma', '2026-07-01T00:00:00.000Z', 'extracted');
    expect(pick([tacoma, mine, later], [retracted(), tacoma, mine, later])).toEqual(['Portland']);
  });

  // TASK-639 ruling (Vinay, 2026-09-28): HIDE it. A value the person said was
  // never right must not resurface on its own — not even through TASK-602's
  // "nothing fresh, show the newest" fallback. Only a person restating it
  // (a `human` row) brings it back.
  it('a lone re-mention of a retracted value is hidden — the slot shows nothing', () => {
    const again = r('p2', 'Portland', '2026-06-01T00:00:00.000Z', 'extracted');
    expect(pick([again], [retracted(), again])).toEqual([]);
    const agentAgain = r('p3', 'portland.', '2026-06-02T00:00:00.000Z', 'agent');
    expect(pick([agentAgain], [retracted(), agentAgain])).toEqual([]);
  });

  it('two re-mentions of a retracted value, nothing else: still hidden', () => {
    const a = r('p2', 'Portland', '2026-06-01T00:00:00.000Z', 'extracted');
    const b = r('p3', 'Portland', '2026-06-02T00:00:00.000Z', 'agent');
    expect(pick([a, b], [retracted(), a, b])).toEqual([]);
  });

  it('the fallback survives for a REPLACED (not retracted) value re-mentioned alone', () => {
    // TASK-602's fallback is narrowed, not removed: a value the chain merely
    // replaced, said again with no rival left, is still shown.
    const replaced = r('p1', 'Portland', '2026-01-01T00:00:00.000Z', 'extracted', {
      until: '2026-02-01T00:00:00.000Z',
      closedBy: 's',
    });
    const seattleForgotten = r('s', 'Seattle', '2026-02-01T00:00:00.000Z', 'agent', {
      until: '2026-03-01T00:00:00.000Z',
    });
    const again = r('p2', 'Portland', '2026-06-01T00:00:00.000Z', 'extracted');
    expect(pick([again], [replaced, seattleForgotten, again])).toEqual(['Portland']);
  });

  it('a re-mentioned retracted value does not fall back past a rival that is itself a re-mention', () => {
    // Every candidate a re-mention: the replaced one may still fall back, the
    // retracted one never does.
    const replaced = r('s1', 'Seattle', '2026-01-01T00:00:00.000Z', 'extracted', {
      until: '2026-02-01T00:00:00.000Z',
      closedBy: 'x',
    });
    const seattleAgain = r('s2', 'Seattle', '2026-05-01T00:00:00.000Z', 'agent');
    const portlandAgain = r('p2', 'Portland', '2026-06-01T00:00:00.000Z', 'extracted');
    expect(
      pick([seattleAgain, portlandAgain], [replaced, retracted(), seattleAgain, portlandAgain]),
    ).toEqual(['Seattle']);
  });

  it('a retracted value restated by the person alone shows', () => {
    const mine = r('h', 'Portland', '2026-06-01T00:00:00.000Z', 'human');
    expect(pick([mine], [retracted(), mine])).toEqual(['Portland']);
  });

  it('a reinstated row (neverTrue cleared, no successor) reads as forgotten, not replaced', () => {
    const reinstatedThenForgotten = r('p1', 'Portland', '2026-01-01T00:00:00.000Z', 'extracted', {
      until: '2026-01-15T00:00:00.000Z',
    });
    const tacoma = r('t', 'Tacoma', '2026-03-01T00:00:00.000Z', 'agent');
    const again = r('p2', 'Portland', '2026-06-01T00:00:00.000Z', 'extracted');
    expect(pick([tacoma, again], [reinstatedThenForgotten, tacoma, again])).toEqual(['Portland']);
  });

  it('an ACTIVE row carrying neverTrue is not treated as retracted (only a closed one is)', () => {
    const odd = { ...r('p1', 'Portland', '2026-01-01T00:00:00.000Z', 'extracted'), neverTrue: true };
    const tacoma = r('t', 'Tacoma', '2026-03-01T00:00:00.000Z', 'agent');
    const again = r('p2', 'Portland', '2026-06-01T00:00:00.000Z', 'extracted');
    expect(pick([tacoma, again], [odd, tacoma, again])).toEqual(['Portland']);
  });
});

// TASK-648 ruling (Vinay, 2026-09-28): a retracted (never-right) value restated
// in the PERSON's OWN chat message resurfaces. The extracted row stays
// `extracted` (no faked human row); what marks it is `sourceRole: 'user'` —
// the observer's record of which turn it came from. The agent repeating the
// value in its reply (`sourceRole: 'assistant'`) does not bring it back, and a
// REPLACED (not retracted) value re-mentioned behaves exactly as before.
describe('the person restating a retracted value in chat (TASK-648)', () => {
  const retracted = (value = 'Denver'): Row & { neverTrue: boolean } => ({
    ...r('d1', value, '2026-01-01T00:00:00.000Z', 'extracted', { until: '2026-01-15T00:00:00.000Z' }),
    neverTrue: true,
  });
  // The Fix that retracted Denver always writes the person's correction.
  const boston = r('b', 'Boston', '2026-01-15T00:00:00.000Z', 'human');
  const said = (
    role: 'user' | 'assistant' | undefined,
    provenance = 'extracted',
    value = 'denver.',
  ): Row => r('d2', value, '2026-06-01T00:00:00.000Z', provenance, role !== undefined ? { sourceRole: role } : {});

  it("the person's own restatement beats the older correction in the profile", () => {
    const mine = said('user');
    expect(pick([boston, mine], [retracted(), boston, mine])).toEqual(['denver.']);
    expect(pick([mine, boston], [mine, boston, retracted()])).toEqual(['denver.']);
  });

  it('with no rival left, the restatement shows alone', () => {
    const mine = said('user');
    expect(pick([mine], [retracted(), mine])).toEqual(['denver.']);
  });

  it("the agent's reply repeating it stays hidden — beside the correction and alone", () => {
    const theirs = said('assistant');
    expect(pick([boston, theirs], [retracted(), boston, theirs])).toEqual(['Boston']);
    expect(pick([theirs], [retracted(), theirs])).toEqual([]);
  });

  it('only an EXTRACTED row speaks for a turn: an agent note carrying a user source stays hidden', () => {
    const note = said('user', 'agent');
    expect(pick([boston, note], [retracted(), boston, note])).toEqual(['Boston']);
    expect(pick([note], [retracted(), note])).toEqual([]);
  });

  it('a row with no known speaker (legacy, or no word overlap) stays hidden', () => {
    const unknown = said(undefined);
    expect(pick([boston, unknown], [retracted(), boston, unknown])).toEqual(['Boston']);
    expect(pick([unknown], [retracted(), unknown])).toEqual([]);
  });

  it("a person's correction made AFTER the restatement still wins", () => {
    const mine = said('user');
    const later = r('h2', 'Austin', '2026-07-01T00:00:00.000Z', 'human');
    expect(pick([mine, later], [retracted(), mine, later])).toEqual(['Austin']);
  });

  it('a REPLACED (not retracted) value restated by the person is unchanged', () => {
    const replaced = r('d1', 'Denver', '2026-01-01T00:00:00.000Z', 'extracted', {
      until: '2026-01-15T00:00:00.000Z',
      closedBy: 'b',
    });
    const mine = said('user');
    // Under a correction: the correction wins, as before.
    expect(pick([boston, mine], [replaced, boston, mine])).toEqual(['Boston']);
    // Under a newer non-human value: not news, the rival wins, as before.
    const tacoma = r('t', 'Tacoma', '2026-03-01T00:00:00.000Z', 'agent');
    expect(pick([tacoma, mine], [replaced, tacoma, mine])).toEqual(['Tacoma']);
    // Alone: TASK-602's fallback shows it, as before.
    expect(pick([mine], [replaced, mine])).toEqual(['denver.']);
  });

  it('a user-sourced row whose value was never retracted gets no lift over a correction', () => {
    const mine = said('user', 'extracted', 'Chicago');
    expect(pick([boston, mine], [retracted(), boston, mine])).toEqual(['Boston']);
  });

  it('recall keeps the restatement and still drops the agent echo', () => {
    const mine = said('user');
    expect(dropRementionedSlotRows([boston, mine], [retracted(), boston, mine])).toEqual([boston, mine]);
    expect(dropRementionedSlotRows([mine], [retracted(), mine])).toEqual([mine]);
    const theirs = said('assistant');
    expect(dropRementionedSlotRows([boston, theirs], [retracted(), boston, theirs])).toEqual([boston]);
    expect(dropRementionedSlotRows([theirs], [retracted(), theirs])).toEqual([]);
  });

  it('recall: a REPLACED value restated by the person under a correction is still dropped', () => {
    const replaced = r('d1', 'Denver', '2026-01-01T00:00:00.000Z', 'extracted', {
      until: '2026-01-15T00:00:00.000Z',
      closedBy: 'b',
    });
    const mine = said('user');
    expect(dropRementionedSlotRows([boston, mine], [replaced, boston, mine])).toEqual([boston]);
  });

  it('needsSlotHistory: a user-sourced row beside a human row needs the chain read', () => {
    // Without the history the pick cannot see the retraction, and the human
    // correction would win by rule 1.
    expect(needsSlotHistory([boston, said('user') as never])).toBe(true);
    expect(needsSlotHistory([boston, said('assistant') as never])).toBe(false);
    expect(needsSlotHistory([boston])).toBe(false);
  });
});

// TASK-649 — the write-time twin check asks the same question the read side's
// `restatedByPerson` does: is this value retracted in its chain?
describe('isRetractedValue', () => {
  const closed = '2026-09-01T00:00:00Z';
  const chain = [
    { about: ABOUT, slot: 'lives_in', value: 'Denver, Colorado', until: closed, neverTrue: true },
    { about: ABOUT, slot: 'lives_in', value: 'Portland', until: closed, closedBy: 'x' },
    { about: ABOUT, slot: 'lives_in', value: 'Boston, Massachusetts' },
  ];

  it('a never-right value is retracted — case and trailing punctuation aside', () => {
    expect(isRetractedValue(chain, ABOUT, 'lives_in', 'denver, colorado.')).toBe(true);
  });

  it('a replaced, an active, or an unknown value is not', () => {
    expect(isRetractedValue(chain, ABOUT, 'lives_in', 'Portland')).toBe(false);
    expect(isRetractedValue(chain, ABOUT, 'lives_in', 'Boston, Massachusetts')).toBe(false);
    expect(isRetractedValue(chain, ABOUT, 'lives_in', 'Austin')).toBe(false);
  });

  it('only in its own (about, slot) chain', () => {
    expect(isRetractedValue(chain, 'user:bob', 'lives_in', 'Denver, Colorado')).toBe(false);
    expect(isRetractedValue(chain, ABOUT, 'works_at', 'Denver, Colorado')).toBe(false);
  });
});
