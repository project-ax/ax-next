import { describe, expect, it } from 'vitest';

import { attributeFacts } from '../attribution.js';
import type { ExtractedFact } from '../extract.js';
import type { IdentifiedTurn } from '../transcript.js';

function turn(turnIndex: number, role: 'user' | 'assistant', content: string): IdentifiedTurn {
  return { turnId: `t${turnIndex}`, turnIndex, role, content };
}

function fact(subject: string, object: string): ExtractedFact {
  return { subject, predicate: 'said', object, validStart: '2026-09-01T00:00:00Z' };
}

const CONTEXT = [
  turn(0, 'user', 'Question three about kayaks on the river.'),
  turn(1, 'assistant', 'Kayaks need a spray skirt on the river.'),
];
const FRESH = [
  turn(2, 'user', 'Question four about canoes.'),
  turn(3, 'assistant', 'Canoes are stable for beginners.'),
];

describe('attributeFacts', () => {
  it('drops a context fact even when it shares an ordinary word with a new turn', () => {
    // "question" appears in both; the context turn still matches better.
    const out = attributeFacts([fact('user', 'Question three about kayaks on the river.')], {
      context: CONTEXT,
      fresh: FRESH,
    });
    expect(out).toEqual({ facts: [], contextOnly: 1 });
  });

  it('gives a tie between a context turn and a new turn to the NEW turn', () => {
    const out = attributeFacts([fact('user', 'kayaks versus canoes')], {
      context: CONTEXT,
      fresh: FRESH,
    });
    expect(out.contextOnly).toBe(0);
    expect(out.facts[0]?.sourceTurnId).toBe('t2');
  });

  it('picks the turn with the most words in common', () => {
    const out = attributeFacts([fact('assistant', 'canoes are stable for beginners')], {
      context: CONTEXT,
      fresh: FRESH,
    });
    expect(out.facts[0]?.sourceTurnId).toBe('t3');
  });

  it('breaks an overlap tie by the speaker role', () => {
    const fresh = [turn(2, 'user', 'Tell me about canoes.'), turn(3, 'assistant', 'Canoes, sure.')];
    expect(attributeFacts([fact('user', 'canoes')], { context: [], fresh }).facts[0]?.sourceTurnId).toBe('t2');
    expect(attributeFacts([fact('assistant', 'canoes')], { context: [], fresh }).facts[0]?.sourceTurnId).toBe('t3');
  });

  it('keeps a paraphrase no turn shares a word with, on the last new turn of its role', () => {
    const out = attributeFacts([fact('user', 'enjoys paddling')], { context: CONTEXT, fresh: FRESH });
    expect(out).toEqual({ facts: [{ ...fact('user', 'enjoys paddling'), sourceTurnId: 't2' }], contextOnly: 0 });
  });

  it('matches a snake_case subject against the prose it came from', () => {
    const fresh = [turn(5, 'user', 'The Boston office opens Monday.'), turn(6, 'assistant', 'Great.')];
    const out = attributeFacts([fact('boston_office', 'Monday')], { context: [], fresh });
    expect(out.facts[0]?.sourceTurnId).toBe('t5');
  });

  it('attributes nothing when there are no new turns', () => {
    expect(attributeFacts([fact('user', 'x')], { context: CONTEXT, fresh: [] })).toEqual({
      facts: [],
      contextOnly: 1,
    });
  });
});
