import { describe, expect, it } from 'vitest';
import { RETRY_AFTER_CAP_MS, RETRY_AFTER_DEFAULT_MS } from '../limits.js';
import { createMentionNames } from '../mention-names.js';
import { SlackApiError } from '../slack-api.js';

const TOKEN = 'xoxb-test';
const TEAM = 'T07TEAM';

function world(answers: Record<string, unknown>, o: { perMessage?: number; max?: number; ttlMs?: number } = {}) {
  let t = 1_000;
  const asked: Array<[string, string]> = [];
  const names = createMentionNames({
    api: {
      async usersInfo(token, id) {
        asked.push([token, id]);
        const a = answers[id];
        if (a instanceof Error) throw a;
        if (a === undefined) throw new SlackApiError('users.info', 'user_not_found');
        return a;
      },
    },
    now: () => t,
    ttlMs: o.ttlMs ?? 1_000,
    max: o.max ?? 10,
    perMessage: o.perMessage ?? 5,
  });
  const lookup = (ids: string[], known: Map<string, string> = new Map(), teamId = TEAM, installId = 'inst-a') =>
    names.lookup({ installId, botToken: TOKEN, teamId, ids, known });
  return { lookup, asked, tick: (ms: number) => (t += ms) };
}

const user = (id: string, name: string) => ({ id, profile: { display_name: name } });
const ids = (asked: Array<[string, string]>): string[] => asked.map(([, id]) => id);

describe('createMentionNames (TASK-1190)', () => {
  it('known names cost no call; others are asked once each with the bot token', async () => {
    const w = world({ U1: user('U1', 'Bob'), U2: user('U2', 'Carol') });
    const r = await w.lookup(['U0', 'U1', 'U2', 'U1'], new Map([['U0', 'moss (you)']]));
    expect([...r.names]).toEqual([
      ['U0', 'moss (you)'],
      ['U1', 'Bob'],
      ['U2', 'Carol'],
    ]);
    expect(r.failed).toBe(0);
    expect(w.asked).toEqual([
      [TOKEN, 'U1'],
      [TOKEN, 'U2'],
    ]);
  });

  it('a name is cleaned like a sender name, and an answer about someone else names nobody', async () => {
    const w = world({ U1: user('U1', ' [x](y)\u202E bob '), U2: user('U9', 'Mallory') });
    const r = await w.lookup(['U1', 'U2']);
    expect(r.names.get('U1')).toBe('x y bob');
    expect(r.names.has('U2')).toBe(false);
  });

  it('a failure is counted with its code and never kept; a found name is kept until ttlMs, per workspace', async () => {
    const w = world({ U1: user('U1', 'Bob'), U2: new SlackApiError('users.info', 'internal_error') });
    const first = await w.lookup(['U1', 'U2']);
    expect(first).toMatchObject({ failed: 1, capped: 0, paused: 0, code: 'internal_error' });
    expect(first.names.has('U2')).toBe(false);
    await w.lookup(['U1', 'U2']);
    expect(ids(w.asked)).toEqual(['U1', 'U2', 'U2']);
    await w.lookup(['U1'], new Map(), 'T07OTHER');
    expect(ids(w.asked)).toEqual(['U1', 'U2', 'U2', 'U1']);
    w.tick(999);
    await w.lookup(['U1']);
    expect(ids(w.asked)).toEqual(['U1', 'U2', 'U2', 'U1']);
    w.tick(1);
    await w.lookup(['U1']);
    expect(ids(w.asked)).toEqual(['U1', 'U2', 'U2', 'U1', 'U1']);
  });

  it("a known name beats a kept one: Fern's turn keeps Moss's bot as \"moss\", Moss's own turn still reads (you)", async () => {
    const w = world({ MOSS: user('MOSS', 'moss') });
    await w.lookup(['MOSS']);
    const r = await w.lookup(['MOSS'], new Map([['MOSS', 'moss (you)']]));
    expect(r.names.get('MOSS')).toBe('moss (you)');
    expect(ids(w.asked)).toEqual(['MOSS']);
  });

  it("after a rate limit nobody is asked until Slack's Retry-After has passed; those ids are paused, while known and kept names still resolve", async () => {
    const w = world(
      { A: new SlackApiError('users.info', 'ratelimited', 2_000), B: user('B', 'Bob'), K: user('K', 'Kay') },
      { ttlMs: 60_000 },
    );
    await w.lookup(['K']);
    // A failure finishing first doesn't hide the rate limit's code.
    expect(await w.lookup(['X', 'A'])).toMatchObject({ failed: 2, paused: 0, code: 'ratelimited' });
    w.tick(1_999);
    const paused = await w.lookup(['B', 'C', 'K', 'OWN'], new Map([['OWN', 'moss (you)']]));
    expect(paused).toMatchObject({ failed: 0, capped: 0, paused: 2 });
    expect([...paused.names]).toEqual([
      ['K', 'Kay'],
      ['OWN', 'moss (you)'],
    ]);
    expect(ids(w.asked)).toEqual(['K', 'X', 'A']);
    w.tick(1);
    expect((await w.lookup(['B'])).names.get('B')).toBe('Bob');
    expect(ids(w.asked)).toEqual(['K', 'X', 'A', 'B']);
  });

  it("one install's rate limit never pauses another's lookups, in its own workspace or the same one", async () => {
    const w = world({ A: new SlackApiError('users.info', 'ratelimited', 30_000), B: user('B', 'Bob'), C: user('C', 'Carol') });
    await w.lookup(['A'], new Map(), TEAM, 'inst-a');
    expect(await w.lookup(['B'], new Map(), 'T07OTHER', 'inst-b')).toMatchObject({ failed: 0, capped: 0, paused: 0 });
    expect((await w.lookup(['C'], new Map(), TEAM, 'inst-c')).names.get('C')).toBe('Carol');
    expect(await w.lookup(['C'], new Map(), 'T07FRESH', 'inst-a')).toMatchObject({ paused: 1 });
    expect(ids(w.asked)).toEqual(['A', 'B', 'C']);
  });

  it('at most max installs stay paused, the oldest forgotten first; a NaN Retry-After waits the default', async () => {
    const limited = new SlackApiError('users.info', 'ratelimited', 30_000);
    const w = world({ L: limited, B: user('B', 'Bob') }, { max: 2 });
    await w.lookup(['L'], new Map(), TEAM, 'i1');
    await w.lookup(['L'], new Map(), TEAM, 'i2');
    await w.lookup(['L'], new Map(), TEAM, 'i3');
    // i1 was forgotten when i3 paused; i2 and i3 are still paused.
    expect(await w.lookup(['B'], new Map(), TEAM, 'i1')).toMatchObject({ paused: 0 });
    expect(await w.lookup(['X'], new Map(), TEAM, 'i2')).toMatchObject({ paused: 1 });
    expect(await w.lookup(['X'], new Map(), TEAM, 'i3')).toMatchObject({ paused: 1 });

    const n = world({ L: new SlackApiError('users.info', 'ratelimited', Number.NaN), B: user('B', 'Bob') });
    await n.lookup(['L']);
    expect(await n.lookup(['B'])).toMatchObject({ paused: 1 });
    n.tick(RETRY_AFTER_DEFAULT_MS);
    expect((await n.lookup(['B'])).names.get('B')).toBe('Bob');
  });

  it('a huge Retry-After is capped at RETRY_AFTER_CAP_MS', async () => {
    const w = world({ A: new SlackApiError('users.info', 'ratelimited', 86_400_000), B: user('B', 'Bob') });
    await w.lookup(['A']);
    w.tick(RETRY_AFTER_CAP_MS - 1);
    expect(await w.lookup(['B'])).toMatchObject({ paused: 1 });
    w.tick(1);
    expect((await w.lookup(['B'])).names.get('B')).toBe('Bob');
  });

  it('asks at most perMessage; kept names do not count against it', async () => {
    const answers = Object.fromEntries(['A', 'B', 'C', 'D'].map((id) => [id, user(id, id.toLowerCase())]));
    const w = world(answers, { perMessage: 2 });
    await w.lookup(['A']);
    const r = await w.lookup(['A', 'B', 'C', 'D']);
    expect([...r.names.keys()]).toEqual(['A', 'B', 'C']);
    expect(ids(w.asked)).toEqual(['A', 'B', 'C']);
  });

  it('keeps at most max names, forgetting the oldest', async () => {
    const answers = Object.fromEntries(['A', 'B', 'C'].map((id) => [id, user(id, id)]));
    const w = world(answers, { max: 2 });
    await w.lookup(['A']);
    await w.lookup(['B']);
    await w.lookup(['C']);
    await w.lookup(['B', 'C', 'A']);
    expect(ids(w.asked)).toEqual(['A', 'B', 'C', 'A']);
  });

  it('refuses a bound that is not a positive integer', () => {
    const api = { usersInfo: async (): Promise<unknown> => ({}) };
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createMentionNames({ api, now: () => 0, ttlMs: bad, max: 1, perMessage: 1 })).toThrow(RangeError);
      expect(() => createMentionNames({ api, now: () => 0, ttlMs: 1, max: bad, perMessage: 1 })).toThrow(RangeError);
      expect(() => createMentionNames({ api, now: () => 0, ttlMs: 1, max: 1, perMessage: bad })).toThrow(RangeError);
    }
  });
});
