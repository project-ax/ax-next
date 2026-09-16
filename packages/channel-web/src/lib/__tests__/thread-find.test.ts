/**
 * TASK-354 — the find logic behind "what did it say three weeks ago".
 *
 * This is the half of the feature that has to be right character-for-character:
 * the bar reports a COUNT and the renderer paints MARKS, and both read the same
 * `findRanges`. If they ever diverge the reader is told there are four matches
 * and shown three, which is worse than no find at all.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFindIndex,
  findRanges,
  threadFindFields,
} from '@/lib/thread-find';
import type { ThreadMessage } from '@/lib/workspace-api';

describe('findRanges', () => {
  it('finds every occurrence, in order', () => {
    expect(findRanges('deploy, then deploy again', 'deploy')).toEqual([
      { start: 0, end: 6 },
      { start: 13, end: 19 },
    ]);
  });

  it('ignores case in both directions', () => {
    expect(findRanges('Deploy the DEPLOYMENT', 'deploy')).toEqual([
      { start: 0, end: 6 },
      { start: 11, end: 17 },
    ]);
    expect(findRanges('deploy', 'DEPLOY')).toEqual([{ start: 0, end: 6 }]);
  });

  it('does not overlap a match with the one before it', () => {
    // 'aaaa' contains 3 overlapping 'aa' but only 2 that can be painted.
    expect(findRanges('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('treats the query as literal text, not a pattern', () => {
    // A regex build would throw on this, or match the wrong thing.
    expect(findRanges('cost (per run) is .*', '(per run)')).toEqual([
      { start: 5, end: 14 },
    ]);
    expect(findRanges('cost (per run) is .*', '.*')).toEqual([
      { start: 18, end: 20 },
    ]);
  });

  it('returns nothing for an empty query', () => {
    expect(findRanges('anything', '')).toEqual([]);
  });

  it('keeps offsets honest when lowercasing changes the string length', () => {
    /*
      'İ'.toLowerCase() is TWO code units in JS (i + combining dot above), so
      searching a lowercased copy and reporting those offsets against the
      ORIGINAL string slides every later match one character left. The word
      below would highlight "epl" instead of "deploy".
    */
    const haystack = 'İ deploy';
    expect(haystack.toLowerCase().length).toBe(haystack.length + 1);
    const [only] = findRanges(haystack, 'deploy');
    expect(only).toBeDefined();
    expect(haystack.slice(only!.start, only!.end)).toBe('deploy');
  });
});

const thread: ThreadMessage[] = [
  { kind: 'user', id: 'u1', text: 'can you deploy the site' },
  { kind: 'agent', id: 'a1', text: 'deploy done — deploy took 4s', time: '4:12 PM' },
  { kind: 'approval', id: 'p1', decisionId: 'd-deploy' },
  { kind: 'status', id: 'pending-status', text: 'Thinking…' },
  { kind: 'fold', id: 'f1', text: '12 messages folded' },
];

describe('threadFindFields', () => {
  it('reads user and agent turns, and the fold marker', () => {
    expect(threadFindFields(thread).map((f) => f.key)).toEqual(['u1', 'a1', 'f1']);
  });

  it('skips the transient status placeholder', () => {
    // Counting 'Thinking…' would make the total tick up mid-stream and back
    // down when the turn lands — a number that moves on its own.
    expect(threadFindFields(thread).some((f) => f.text === 'Thinking…')).toBe(false);
  });

  it('skips approval cards, whose words live in the decisions queue', () => {
    expect(threadFindFields(thread).some((f) => f.key === 'p1')).toBe(false);
  });

  it('reads a steps turn’s bubble text but not its collapsible detail', () => {
    const withSteps: ThreadMessage[] = [
      {
        kind: 'steps',
        id: 's1',
        text: 'here is what I did',
        time: '4:13 PM',
        stepsLabel: 'four steps',
        steps: ['read the file', 'wrote the file'],
      },
    ];
    expect(threadFindFields(withSteps)).toEqual([
      { key: 's1', text: 'here is what I did' },
    ]);
  });
});

describe('buildFindIndex', () => {
  it('totals every match across the thread', () => {
    // u1 has one 'deploy', a1 has two. The approval card's id contains
    // 'deploy' too and must not be counted.
    expect(buildFindIndex(thread, 'deploy').total).toBe(3);
  });

  it('numbers each field from where its first match falls in the whole thread', () => {
    const { firstMatch } = buildFindIndex(thread, 'deploy');
    expect(firstMatch.get('u1')).toBe(0);
    expect(firstMatch.get('a1')).toBe(1);
    expect(firstMatch.has('f1')).toBe(false);
  });

  it('reports nothing for a blank query', () => {
    expect(buildFindIndex(thread, '').total).toBe(0);
    expect(buildFindIndex(thread, '   ').total).toBe(0);
  });

  it('reports zero — not a crash — when nothing matches', () => {
    const idx = buildFindIndex(thread, 'kubernetes');
    expect(idx.total).toBe(0);
    expect(idx.firstMatch.size).toBe(0);
  });
});
