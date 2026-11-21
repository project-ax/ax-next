import { describe, expect, it } from 'vitest';
import { CHANNEL_REFUSED_CODES, channelInfoFailure, createChannelCheck } from '../channel-check.js';
import { connectable } from '../channels.js';
import { BOT_SCOPES, DEDICATED_BOT_SCOPES } from '../manifest.js';
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
/** Slack's `provided`: every scope a team agent's own bot holds (all of them are the shared app's too), with and without channels:read. */
const HOLDS = DEDICATED_BOT_SCOPES.join(',');
const LACKS = DEDICATED_BOT_SCOPES.filter((s) => s !== 'channels:read').join(',');
/** Every scope conversations.info takes: what Slack may say is `needed` from a token that holds none of them (unmeasured). */
const EVERY_INFO_SCOPE = 'channels:read,groups:read,mpim:read,im:read';

/** Slack's `missing_scope`, naming what the call needed and what the token holds, as it says them. */
function missingScope(scopes: { needed?: string; provided?: string }): SlackApiError {
  return new SlackApiError('conversations.info', 'missing_scope', undefined, scopes);
}

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

/**
 * A check over a fake conversations.info that answers nothing until the test
 * says: `asks[i].answer(...)` lets the i-th ask's answer arrive, in whatever
 * order the test picks.
 */
function held() {
  const asks: Array<{ token: string; channel: string; answer: (a: Answer) => void }> = [];
  const check = createChannelCheck({
    api: {
      conversationsInfo: (token, channel) =>
        new Promise<SlackChannel>((resolve, reject) => {
          asks.push({ token, channel, answer: (a) => (a instanceof Error ? reject(a) : resolve(a)) });
        }),
    },
    now: () => START,
    ttlMs: TTL,
    max: 100,
  });
  return { asks, check };
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
    // More than one at once: the first in channels.ts `connectable`'s order names it.
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

  /*
    A bot token keeps its string when its app is reinstalled, but its scopes
    follow the app's configuration then. One that lost `channels:read` reads
    no channel at all: that is about the token, not this channel, so its
    binding must stay. Slack's `provided` (the scopes the token holds) says
    so, whatever `needed` names: nobody has measured `needed` here, and Slack
    may name every scope the method takes. Only an answer without `provided`
    falls back to `needed`.
  */
  it.each([
    ["the token's own scopes lack channels:read, and Slack needs every scope the method takes", { needed: EVERY_INFO_SCOPE, provided: LACKS }],
    ["the token's own scopes lack channels:read, and Slack needs groups:read", { needed: 'groups:read', provided: LACKS }],
    ["the token's own scopes lack channels:read, and Slack names nothing needed", { provided: LACKS }],
    ['Slack says nothing of the scopes the token holds, and needs exactly channels:read', { needed: 'channels:read' }],
    // A scope that merely contains channels:read is not it: the list is read scope by scope.
    ["the token's own scopes hold only a longer scope containing channels:read", { needed: EVERY_INFO_SCOPE, provided: `${LACKS},channels:read.extra` }],
    // The list is read scope by scope, whatever else it names (slack-api.test pins that a hyphen parses).
    ["the token's own scopes lack channels:read and include incoming-webhook", { needed: EVERY_INFO_SCOPE, provided: `${LACKS},incoming-webhook` }],
  ] as const)("a missing_scope where %s is the token's, not the channel's: token-scope, never kept", async (_n, scopes) => {
    const { calls, check } = setup(() => missingScope(scopes));
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'token-scope' });
    await check.check(INSTALL, TOKEN, CH);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['the token holds channels:read, and Slack needs groups:read (a private channel)', { needed: 'groups:read', provided: HOLDS }],
    ['the token holds channels:read, and Slack needs every scope the method takes', { needed: EVERY_INFO_SCOPE, provided: HOLDS }],
    // The token's own scopes decide, whatever Slack says is needed.
    ['the token holds channels:read, though Slack needs exactly channels:read', { needed: 'channels:read', provided: HOLDS }],
    ['Slack says nothing of the scopes at all', {}],
    ['Slack says nothing of the token, and needs groups:read', { needed: 'groups:read' }],
    ['Slack says nothing of the token, and needs channels:read and more', { needed: 'channels:read,groups:read' }],
    ['Slack says nothing of the token, and needs another channels scope', { needed: 'channels:history' }],
  ] as const)('a missing_scope where %s is still a refusal', async (_n, scopes) => {
    const { check } = setup(() => missingScope(scopes));
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'refused', code: 'missing_scope' });
  });

  it("a missing_scope whose `provided` Slack sent but slack-api couldn't read is unknown: neither a refusal nor the token's, and never kept", async () => {
    const { calls, check } = setup(() => missingScope({ needed: EVERY_INFO_SCOPE, provided: '' }));
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'unknown', code: 'missing_scope' });
    await check.check(INSTALL, TOKEN, CH);
    expect(calls).toHaveLength(2);
  });

  it("only missing_scope reads the scopes: a channel_not_found from a token without channels:read is still a refusal", async () => {
    const { check } = setup(
      () => new SlackApiError('conversations.info', 'channel_not_found', undefined, { needed: 'channels:read', provided: LACKS }),
    );
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'refused', code: 'channel_not_found' });
  });

  it("only missing_scope reads the scopes: a channel_not_found whose provided Slack sent but slack-api couldn't read is still a refusal", async () => {
    const { check } = setup(
      () => new SlackApiError('conversations.info', 'channel_not_found', undefined, { needed: 'channels:read', provided: '' }),
    );
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'refused', code: 'channel_not_found' });
  });

  it("a bot holds channels:read, the scope a missing_scope is read against: a token without it is not ours as built; the shared app's token is never checked, as it reads no channel (TASK-1186)", () => {
    expect(DEDICATED_BOT_SCOPES).toContain('channels:read');
    expect(BOT_SCOPES).not.toContain('channels:read');
  });

  // The check reads every failure through channelInfoFailure, the one reading router.ts `bindBotChannel`
  // also uses. This pins the check's side only; the bot's first-bind router tests pin the bind's.
  it("channelInfoFailure is exactly the check's reading of every failure", async () => {
    const failures: Error[] = [
      new SlackApiError('conversations.info', 'channel_not_found'),
      missingScope({}),
      missingScope({ needed: 'groups:read', provided: HOLDS }),
      missingScope({ needed: 'channels:read', provided: HOLDS }),
      missingScope({ needed: EVERY_INFO_SCOPE, provided: LACKS }),
      missingScope({ needed: 'channels:read' }),
      missingScope({ needed: EVERY_INFO_SCOPE, provided: '' }),
      new SlackApiError('conversations.info', 'ratelimited'),
      new SlackApiError('conversations.info', 'token_revoked'),
      new Error('socket hang up'),
      Object.assign(new Error('not from Slack'), { code: 'channel_not_found' }),
    ];
    const kinds = new Set<string>();
    for (const err of failures) {
      const { check } = setup(() => err);
      const read = channelInfoFailure(err);
      kinds.add(read.kind);
      expect(await check.check(INSTALL, TOKEN, CH), err.message).toEqual(read);
    }
    // The list reaches every reading: the comparison compared something.
    expect([...kinds].sort()).toEqual(['refused', 'token-scope', 'unknown']);
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

  // Two turns in one channel ask at once, and Slack's answers arrive out of order.
  it('an allowed answer still on its way when a refusal for that channel lands is not kept', async () => {
    const { asks, check } = held();
    const first = check.check(INSTALL, TOKEN, CH);
    const second = check.check(INSTALL, TOKEN, CH);
    expect(asks).toHaveLength(2);
    asks[1]!.answer(new SlackApiError('conversations.info', 'missing_scope'));
    expect(await second).toEqual({ kind: 'refused', code: 'missing_scope' });
    // It may describe the channel as it was before: its own turn has it, and nothing else does.
    asks[0]!.answer(live(CH));
    expect(await first).toEqual({ kind: 'allowed' });

    const third = check.check(INSTALL, TOKEN, CH);
    expect(asks).toHaveLength(3);
    // Asked after the refusal landed: kept as any answer is.
    asks[2]!.answer(live(CH));
    expect(await third).toEqual({ kind: 'allowed' });
    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'allowed' });
    expect(asks).toHaveLength(3);
  });

  it('a refusal that lands after an allowed answer was kept forgets it', async () => {
    const { asks, check } = held();
    const first = check.check(INSTALL, TOKEN, CH);
    const second = check.check(INSTALL, TOKEN, CH);
    asks[0]!.answer(live(CH));
    expect(await first).toEqual({ kind: 'allowed' });
    asks[1]!.answer(live(CH, { isPrivate: true }));
    expect(await second).toEqual({ kind: 'refused', code: 'not-public' });

    const third = check.check(INSTALL, TOKEN, CH);
    expect(asks).toHaveLength(3);
    asks[2]!.answer(live(CH, { isPrivate: true }));
    expect(await third).toEqual({ kind: 'refused', code: 'not-public' });
  });

  it('only a refusal for the same install and channel does that: a failure, or one for another, changes nothing kept', async () => {
    const { asks, check } = held();
    const kept = check.check(INSTALL, TOKEN, CH);
    const failed = check.check(INSTALL, TOKEN, CH);
    const otherChannel = check.check(INSTALL, TOKEN, CH2);
    const otherInstall = check.check(OTHER_INSTALL, OTHER_TOKEN, CH);
    asks[1]!.answer(new SlackApiError('conversations.info', 'ratelimited'));
    asks[2]!.answer(new SlackApiError('conversations.info', 'channel_not_found'));
    asks[3]!.answer(new SlackApiError('conversations.info', 'missing_scope'));
    expect(await failed).toEqual({ kind: 'unknown', code: 'ratelimited' });
    expect(await otherChannel).toEqual({ kind: 'refused', code: 'channel_not_found' });
    expect(await otherInstall).toEqual({ kind: 'refused', code: 'missing_scope' });
    asks[0]!.answer(live(CH));
    expect(await kept).toEqual({ kind: 'allowed' });

    expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'allowed' });
    expect(asks).toHaveLength(4);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('ttlMs and max must be positive integers (%s)', (bad) => {
    const api = { conversationsInfo: async (_token: string, channel: string) => live(channel) };
    expect(() => createChannelCheck({ api, now: () => 0, ttlMs: bad, max: 1 })).toThrow(RangeError);
    expect(() => createChannelCheck({ api, now: () => 0, ttlMs: 1, max: bad })).toThrow(RangeError);
  });
});
