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
  activeMatch,
  buildFindIndex,
  findFieldKey,
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

  it('still matches case-insensitively when only the QUERY expands', () => {
    /*
      Only the haystack's length decides whether offsets survive — it is the
      string they index into. An earlier draft also demanded a length-preserving
      NEEDLE, which bought nothing and cost this match: the haystack here
      lowercases one-for-one, so positions hold, and the expanded query is
      perfectly safe to look for.
    */
    const haystack = 'the i̇ dot';
    expect(haystack.toLowerCase().length).toBe(haystack.length);
    expect('İ'.toLowerCase().length).toBe(2);
    const [only] = findRanges(haystack, 'İ');
    expect(only).toBeDefined();
    expect(haystack.slice(only!.start, only!.end)).toBe('i̇');
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
    expect(threadFindFields(thread).map((f) => f.key)).toEqual([
      findFieldKey(0, 'u1'),
      findFieldKey(1, 'a1'),
      findFieldKey(4, 'f1'),
    ]);
  });

  it('skips the transient status placeholder', () => {
    // Counting 'Thinking…' would make the total tick up mid-stream and back
    // down when the turn lands — a number that moves on its own.
    expect(threadFindFields(thread).some((f) => f.text === 'Thinking…')).toBe(false);
  });

  it('skips approval cards, whose words live in the decisions queue', () => {
    expect(
      threadFindFields(thread).some((f) => f.key.endsWith(':p1')),
    ).toBe(false);
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
      { key: findFieldKey(0, 's1'), text: 'here is what I did' },
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
    expect(firstMatch.get(findFieldKey(0, 'u1'))).toBe(0);
    expect(firstMatch.get(findFieldKey(1, 'a1'))).toBe(1);
    expect(firstMatch.has(findFieldKey(4, 'f1'))).toBe(false);
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

  it('keeps two turns apart even when they carry the same id', () => {
    /*
      The whole count-cannot-drift-from-the-marks argument needs every field to
      have its own key. Ids are unique today, but that invariant lives in four
      other files; keying by POSITION as well makes it unbreakable from here.
      With ids alone, the second row would overwrite the first in `firstMatch`,
      both turns would number their marks from the same base, and the thread
      could show two "current" matches or none.
    */
    const collided: ThreadMessage[] = [
      { kind: 'user', id: 'same', text: 'deploy once' },
      { kind: 'agent', id: 'same', text: 'deploy twice deploy', time: '4:12 PM' },
    ];
    const { total, firstMatch } = buildFindIndex(collided, 'deploy');
    expect(total).toBe(3);
    expect(firstMatch.size).toBe(2);
    expect(firstMatch.get(findFieldKey(0, 'same'))).toBe(0);
    expect(firstMatch.get(findFieldKey(1, 'same'))).toBe(1);
  });
});

describe('activeMatch', () => {
  /*
    `findStep` is a free-running signed counter the bar bumps on next/prev, so
    it runs off both ends and can outlive the total it was counting against —
    a streaming reply changes the thread under an open bar. Wrapping here is
    what stops "next" at the last match dead-ending on a button that has
    stopped working.
  */
  it('wraps off the end and off the front', () => {
    expect(activeMatch(0, 3)).toBe(0);
    expect(activeMatch(2, 3)).toBe(2);
    expect(activeMatch(3, 3)).toBe(0);
    expect(activeMatch(-1, 3)).toBe(2);
    expect(activeMatch(-4, 3)).toBe(2);
  });

  it('stays inside a total that shrank underneath it', () => {
    /*
      The bar must never print "6 of 3": `active` is always in [0, total).
      NOTE for anyone mutation-testing this file — these two assertions are
      GREEN against a naive `step % total` (5 % 3 is 2, 97 % 4 is 1). They pin
      the shrink against dropping the modulo altogether. The assertions that
      catch `step % total` are the NEGATIVE ones above and below.
    */
    expect(activeMatch(5, 3)).toBe(2);
    expect(activeMatch(97, 4)).toBe(1);
    // Negative AND past the end at once: `-5 % 3` is -2 in JS.
    expect(activeMatch(-5, 3)).toBe(1);
  });

  it('says there is nowhere to stand when nothing matched', () => {
    expect(activeMatch(0, 0)).toBe(-1);
    expect(activeMatch(7, 0)).toBe(-1);
    expect(activeMatch(-7, 0)).toBe(-1);
  });
});
