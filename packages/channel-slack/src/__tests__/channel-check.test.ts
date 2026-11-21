import { describe, expect, it } from 'vitest';
import { CHANNEL_REFUSED_CODES, createChannelCheck } from '../channel-check.js';
import { connectable } from '../channels.js';
import { SlackApiError, type SlackChannel } from '../slack-api.js';
import { fakeBotToken } from './fake-slack-tokens.js';

const INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const OTHER_INSTALL = 'Tq2Lw8vNc5Xr1Bm7Kd4JsA';
const CH = 'C07SUPPORT1';
const CH2 = 'C07OPSROOM1';
const CH3 = 'C07THIRDCH1';
const TOKEN = fakeBotToken('CHANNELCHECKSECRET');
const OTHER_TOKEN = fakeBotToken('OTHERCHECKSECRET');
const TTL = 60_000;
/** The clock when each test starts. */
const START = 1_000_000;

/** A public, live channel of this workspace, as conversations.info answers once slack-api.ts narrows it. */
function live(id: string, over: Partial<SlackChannel> = {}): SlackChannel {
  return {
    id,
    name: 'general',
    isChannel: true,
    isPrivate: false,
    isArchived: false,
    isExtShared: false,
    isPendingExtShared: false,
    isMember: true,
    ...over,
  };
}

/** What conversations.info does for a channel: answers with it, or throws the Error. */
type Answer = SlackChannel | Error;

/**
 * A check over a fake conversations.info that records each `[token, channel]`
 * it is asked. `at(ms)` sets the clock to `ms` after START.
 */
function setup(answer: (channel: string) => Answer, max = 100) {
  const calls: Array<[string, string]> = [];
  let t = START;
  const check = createChannelCheck({
    api: {
      async conversationsInfo(token, channel) {
        calls.push([token, channel]);
        const out = answer(channel);
        if (out instanceof Error) throw out;
        return out;
      },
    },
    now: () => t,
    ttlMs: TTL,
    max,
  });
  return {
    calls,
    check,
    at(ms: number): void {
      t = START + ms;
    },
  };
}

describe('createChannelCheck', () => {
  it("a public, live channel is allowed, asked with the install's token about that channel", async () => {
    const { calls, check } = setup((c) => live(c));
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'allowed' });
    expect(calls).toEqual([[TOKEN, CH]]);
  });

  it('an allowed answer is kept for ttlMs from when it arrived, then asked again', async () => {
    const { calls, check, at } = setup((c) => live(c));
    await check.check(INSTALL, TOKEN, CH);
    at(TTL - 1);
    await check.check(INSTALL, TOKEN, CH);
    expect(calls).toHaveLength(1);
    at(TTL);
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'allowed' });
    expect(calls).toHaveLength(2);
  });

  it('the minute starts when the answer arrives, not when Slack was asked', async () => {
    // Slack takes five seconds to answer, each time.
    let t = START;
    const calls: string[] = [];
    const check = createChannelCheck({
      api: {
        async conversationsInfo(_token, channel) {
          calls.push(channel);
          t += 5_000;
          return live(channel);
        },
      },
      now: () => t,
      ttlMs: TTL,
      max: 100,
    });
    await check.check(INSTALL, TOKEN, CH);
    t = START + 5_000 + TTL - 1;
    await check.check(INSTALL, TOKEN, CH);
    expect(calls).toHaveLength(1);
    t = START + 5_000 + TTL;
    await check.check(INSTALL, TOKEN, CH);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['private', { isPrivate: true }, 'not-public'],
    ['a private group, not a channel', { isChannel: false }, 'not-public'],
    ['archived', { isArchived: true }, 'archived'],
    ['Slack Connect', { isExtShared: true }, 'shared'],
    ['a pending Slack Connect invitation', { isPendingExtShared: true }, 'shared'],
    // More than one at once: the first in channels.ts connectChannel's order names it.
    ['private and archived', { isPrivate: true, isArchived: true }, 'not-public'],
    ['archived and Slack Connect', { isArchived: true, isExtShared: true }, 'archived'],
  ] as const)('a channel Slack describes as %s is refused, and the refusal is never kept', async (_n, over, code) => {
    const { calls, check } = setup((c) => live(c, over));
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'refused', code });
    await check.check(INSTALL, TOKEN, CH);
    expect(calls).toHaveLength(2);
  });

  it.each(['channel_not_found', 'missing_scope'])('Slack answering %s is a refusal, never kept', async (code) => {
    const { calls, check } = setup(() => new SlackApiError('conversations.info', code));
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'refused', code });
    await check.check(INSTALL, TOKEN, CH);
    expect(calls).toHaveLength(2);
  });

  it('CHANNEL_REFUSED_CODES is exactly channel_not_found and missing_scope', () => {
    expect([...CHANNEL_REFUSED_CODES].sort()).toEqual(['channel_not_found', 'missing_scope']);
  });

  it('allowed exactly when channels.ts connectable says so, for every combination of the five flags', async () => {
    let allowed = 0;
    for (let i = 0; i < 32; i += 1) {
      const info = live(CH, {
        isChannel: (i & 1) !== 0,
        isPrivate: (i & 2) !== 0,
        isArchived: (i & 4) !== 0,
        isExtShared: (i & 8) !== 0,
        isPendingExtShared: (i & 16) !== 0,
      });
      const { check } = setup(() => info);
      const result = await check.check(INSTALL, TOKEN, CH);
      expect(result.kind === 'allowed', JSON.stringify(info)).toBe(connectable(info));
      expect(result.kind, JSON.stringify(info)).not.toBe('unknown');
      if (result.kind === 'allowed') allowed += 1;
    }
    // Only a channel with no refusing flag at all: the loop compared something.
    expect(allowed).toBe(1);
  });

  it.each([
    ['a rate limit', new SlackApiError('conversations.info', 'ratelimited'), 'ratelimited'],
    ['a Slack error', new SlackApiError('conversations.info', 'internal_error'), 'internal_error'],
    ['a token Slack refuses', new SlackApiError('conversations.info', 'token_revoked'), 'token_revoked'],
    ['an unreadable answer', new SlackApiError('conversations.info', 'bad-response'), 'bad-response'],
    ['a network failure', new Error('socket hang up'), 'unknown'],
    ['an answer about another channel', live(CH2), 'id-mismatch'],
    // Only Slack's own answer refuses: a refusal deletes a binding.
    [
      "another error carrying a refusal's code",
      Object.assign(new Error('not from Slack'), { code: 'channel_not_found' }),
      'channel_not_found',
    ],
  ] as const)('%s is unknown, and nothing is kept: the next check asks again', async (_n, answer, code) => {
    const { calls, check } = setup(() => answer);
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'unknown', code });
    await check.check(INSTALL, TOKEN, CH);
    expect(calls).toHaveLength(2);
  });

  it('never rejects, even when the client throws before it awaits anything', async () => {
    const check = createChannelCheck({
      api: {
        conversationsInfo: () => {
          throw new Error('thrown before any await');
        },
      },
      now: () => START,
      ttlMs: TTL,
      max: 1,
    });
    await expect(check.check(INSTALL, TOKEN, CH)).resolves.toEqual({ kind: 'unknown', code: 'unknown' });
  });

  it('an expired answer that Slack now fails to give is unknown, never the old allowed', async () => {
    let answer: Answer = live(CH);
    const { calls, check, at } = setup(() => answer);
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'allowed' });
    answer = new SlackApiError('conversations.info', 'internal_error');
    at(TTL);
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'unknown', code: 'internal_error' });
    expect(calls).toHaveLength(2);
  });

  it('answers are kept per install and per channel', async () => {
    const { calls, check } = setup((c) => live(c));
    await check.check(INSTALL, TOKEN, CH);
    await check.check(OTHER_INSTALL, OTHER_TOKEN, CH);
    await check.check(INSTALL, TOKEN, CH2);
    await check.check(INSTALL, TOKEN, CH);
    expect(calls).toEqual([
      [TOKEN, CH],
      [OTHER_TOKEN, CH],
      [TOKEN, CH2],
    ]);
  });

  it('keeps at most max answers, forgetting the oldest first', async () => {
    const { calls, check } = setup((c) => live(c), 2);
    await check.check(INSTALL, TOKEN, CH);
    await check.check(INSTALL, TOKEN, CH2);
    await check.check(INSTALL, TOKEN, CH3);
    expect(calls).toHaveLength(3);
    // Only the oldest went: the second is still kept.
    await check.check(INSTALL, TOKEN, CH2);
    expect(calls).toHaveLength(3);
    await check.check(INSTALL, TOKEN, CH);
    expect(calls).toHaveLength(4);
    await check.check(INSTALL, TOKEN, CH3);
    expect(calls).toHaveLength(4);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('ttlMs and max must be positive integers (%s)', (bad) => {
    const api = { conversationsInfo: async (_token: string, channel: string) => live(channel) };
    expect(() => createChannelCheck({ api, now: () => 0, ttlMs: bad, max: 1 })).toThrow(RangeError);
    expect(() => createChannelCheck({ api, now: () => 0, ttlMs: 1, max: bad })).toThrow(RangeError);
  });
});
