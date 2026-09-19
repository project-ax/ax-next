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
  grantFieldKeyBase,
  threadFindFields,
} from '@/lib/thread-find';
import type { ThreadMessage } from '@/lib/workspace-api';
import type { WorkspaceGrant } from '@/lib/workspace-grant-store';
import {
  GRANT_REASSURANCE,
  HOST_WALL_EXPLANATION,
  PACKAGES_LINE,
} from '@/lib/grant-copy';
import {
  decisionFixture,
  resolvedFixture,
} from '@/components/workspace/__tests__/decision-fixture';

function grantFixture(over: Partial<WorkspaceGrant> = {}): WorkspaceGrant {
  return {
    key: 'skill:writer',
    agentId: 'a1',
    conversationId: 'c1',
    request: {
      kind: 'skill',
      skillId: 'writer',
      description: 'Draft outbound emails on your behalf',
      hosts: ['api.resend.com'],
      slots: [],
    },
    ...over,
  };
}

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
    expect(threadFindFields(thread, [], []).map((f) => f.key)).toEqual([
      findFieldKey(0, 'u1'),
      findFieldKey(1, 'a1'),
      findFieldKey(4, 'f1'),
    ]);
  });

  it('skips the transient status placeholder', () => {
    // Counting 'Thinking…' would make the total tick up mid-stream and back
    // down when the turn lands — a number that moves on its own.
    expect(
      threadFindFields(thread, [], []).some((f) => f.text === 'Thinking…'),
    ).toBe(false);
  });

  it('skips an approval turn whose decision never arrived', () => {
    expect(
      threadFindFields(thread, [], []).some((f) => f.key.startsWith(`${findFieldKey(2, 'p1')}:`)),
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
        steps: [
          { text: 'read the file', status: 'done' },
          { text: 'wrote the file', status: 'done' },
        ],
      },
    ];
    expect(threadFindFields(withSteps, [], [])).toEqual([
      { key: findFieldKey(0, 's1'), text: 'here is what I did' },
    ]);
  });

  describe('TASK-390 — an open approval’s visible prose', () => {
    it('indexes summary and detail while the decision is still a question', () => {
      const d = decisionFixture({
        id: 'd-deploy',
        status: 'pending',
        summary: 'Deploy the site?',
        detail: 'This pushes main to production.',
      });
      const base = findFieldKey(2, 'p1');
      expect(threadFindFields(thread, [d], [])).toEqual(
        expect.arrayContaining([
          { key: `${base}:summary`, text: 'Deploy the site?' },
          { key: `${base}:detail`, text: 'This pushes main to production.' },
        ]),
      );
    });

    it('also indexes a STALE decision — still a question, per isOpenDecision', () => {
      const d = decisionFixture({ id: 'd-deploy', status: 'stale', summary: 'Deploy the site?' });
      expect(
        threadFindFields(thread, [d], []).some((f) => f.text === 'Deploy the site?'),
      ).toBe(true);
    });

    it('drops the summary once the decision is resolved — the card no longer shows it', () => {
      // Resolved: the card renders `decisionOutcome(d).line`, not `d.summary`.
      // Indexing `d.summary` here would report a match the reader cannot see.
      const d = resolvedFixture('executed', { id: 'd-deploy', summary: 'Deploy the site?' });
      expect(
        threadFindFields(thread, [d], []).some((f) => f.text === 'Deploy the site?'),
      ).toBe(false);
    });

    it('omits an empty detail rather than indexing a blank field', () => {
      const d = decisionFixture({ id: 'd-deploy', status: 'pending', detail: '' });
      const base = findFieldKey(2, 'p1');
      expect(threadFindFields(thread, [d], []).some((f) => f.key === `${base}:detail`)).toBe(
        false,
      );
    });
  });

  describe('TASK-390 — a grant row’s visible prose', () => {
    it('indexes the title, description, packages line, and reassurance line', () => {
      const g = grantFixture({
        key: 'skill:writer',
        request: {
          kind: 'skill',
          skillId: 'writer',
          description: 'Draft outbound emails on your behalf',
          hosts: ['api.resend.com'],
          slots: [],
          packages: { npm: ['nodemailer'], pypi: [] },
        },
      });
      const base = grantFieldKeyBase('skill:writer');
      expect(threadFindFields([], [], [g])).toEqual([
        { key: `${base}:title`, text: 'Connect Writer' },
        { key: `${base}:description`, text: 'Draft outbound emails on your behalf' },
        { key: `${base}:packages`, text: PACKAGES_LINE },
        { key: `${base}:reassurance`, text: GRANT_REASSURANCE },
      ]);
    });

    it('omits the packages line when the grant declares none', () => {
      const g = grantFixture();
      const base = grantFieldKeyBase(g.key);
      expect(threadFindFields([], [], [g]).some((f) => f.key === `${base}:packages`)).toBe(false);
    });

    it('indexes a host grant’s title and wall explanation, not the reassurance line', () => {
      const g = grantFixture({
        key: 'host:evil.example',
        request: { kind: 'host', host: 'evil.example', sessionId: 's1' },
      });
      const base = grantFieldKeyBase('host:evil.example');
      expect(threadFindFields([], [], [g])).toEqual([
        { key: `${base}:title`, text: 'Allow access to evil.example?' },
        { key: `${base}:explanation`, text: HOST_WALL_EXPLANATION },
      ]);
    });

    it('appends grant fields after every thread field — grants render below the transcript', () => {
      const g = grantFixture();
      const keys = threadFindFields(thread, [], [g]).map((f) => f.key);
      const lastThreadKeyIndex = keys.findIndex((k) => k === findFieldKey(4, 'f1'));
      const firstGrantKeyIndex = keys.findIndex((k) => k.startsWith('grant:'));
      expect(lastThreadKeyIndex).toBeGreaterThanOrEqual(0);
      expect(firstGrantKeyIndex).toBeGreaterThan(lastThreadKeyIndex);
    });

    it('keeps a grant’s keys disjoint from any thread position key', () => {
      // Thread keys are `${index}:${id}` — always digits before the first
      // colon. `grant:` keys never collide because they never start that way.
      const g = grantFixture({ key: '0' });
      const keys = threadFindFields(thread, [], [g]).map((f) => f.key);
      const threadKeys = new Set([findFieldKey(0, 'u1'), findFieldKey(1, 'a1'), findFieldKey(4, 'f1')]);
      for (const k of keys) {
        if (k.startsWith('grant:')) expect(threadKeys.has(k)).toBe(false);
      }
    });
  });
});

describe('buildFindIndex', () => {
  it('totals every match across the thread', () => {
    // u1 has one 'deploy', a1 has two. The approval card's id contains
    // 'deploy' too and must not be counted (no decision supplied for it).
    expect(buildFindIndex(thread, [], [], 'deploy').total).toBe(3);
  });

  it('numbers each field from where its first match falls in the whole thread', () => {
    const { firstMatch } = buildFindIndex(thread, [], [], 'deploy');
    expect(firstMatch.get(findFieldKey(0, 'u1'))).toBe(0);
    expect(firstMatch.get(findFieldKey(1, 'a1'))).toBe(1);
    expect(firstMatch.has(findFieldKey(4, 'f1'))).toBe(false);
  });

  it('reports nothing for a blank query', () => {
    expect(buildFindIndex(thread, [], [], '').total).toBe(0);
    expect(buildFindIndex(thread, [], [], '   ').total).toBe(0);
  });

  it('reports zero — not a crash — when nothing matches', () => {
    const idx = buildFindIndex(thread, [], [], 'kubernetes');
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
    const { total, firstMatch } = buildFindIndex(collided, [], [], 'deploy');
    expect(total).toBe(3);
    expect(firstMatch.size).toBe(2);
    expect(firstMatch.get(findFieldKey(0, 'same'))).toBe(0);
    expect(firstMatch.get(findFieldKey(1, 'same'))).toBe(1);
  });

  describe('TASK-390 — counts what the reader can now see beyond thread turns', () => {
    it('counts an open approval’s summary and a grant’s title in the same total', () => {
      const d = decisionFixture({ id: 'd-deploy', status: 'pending', summary: 'Deploy the site' });
      const g = grantFixture({
        request: {
          kind: 'connector',
          connectorId: 'deploy-bot',
          name: 'Deploy bot',
          hosts: [],
          slots: [],
        },
      });
      // u1 + a1 (3 hits) + approval summary (1) + grant title 'Connect Deploy
      // bot' (1) = 5. The approval's own id ('p1') is never in the haystack.
      expect(buildFindIndex(thread, [d], [g], 'deploy').total).toBe(5);
    });

    it('never counts a resolved decision’s summary or an unrelated grant’s copy', () => {
      const d = resolvedFixture('dismissed', { id: 'd-deploy', summary: 'Deploy the site' });
      const g = grantFixture(); // 'writer' skill — no 'deploy' anywhere in it
      expect(buildFindIndex(thread, [d], [g], 'deploy').total).toBe(3);
    });
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
