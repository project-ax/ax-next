import { PluginError } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.js';
import { postMemoryNotice } from '../memory-notice.js';
import { SlackApiError } from '../slack-api.js';
import { fakeBotToken } from './fake-slack-tokens.js';
import { memoryChannelStore } from './memory-channel-store.js';

/*
  A channel's memory notice (memory-notice.ts, TASK-1203; design §4c): a
  team bot's first turn in a channel tells everyone there, top-level, that
  what it hears is shared with anyone who talks to it. Over the in-memory
  channel store (its claim rules are pinned against Postgres in
  channel-store.test.ts) and a recording fake Slack.

  What is pinned here: only a claim that wins posts, so a channel is told
  once; a post Slack refuses gives the claim back, so the next turn tries
  again, except in an announcement-only channel (`restricted_action`), where
  the notice goes in the mention's thread instead and the claim is kept;
  nothing here throws, so the turn it runs in goes on; the notice is one
  fixed line that names no team (and asks the bus nothing); and every log
  line carries a stage and a code at most, never a name.
*/

const INSTALL_ID = 'Tq2Lw8vNc5Xr1Bm7Kd4JsA';
const SUPPORT_CH = 'C07SUPPORT1';
const SUPPORT_AGENT_ID = 'agt_support';
/** The person whose binding it is. */
const ADA = 'usr_ada';
const BOT_TOKEN = fakeBotToken('NOTICETESTSECRET');
/** The thread the bot is about to reply in: the mention's. */
const THREAD_TS = '1763035300.000300';
const NOTICE = 'Heads up: what I hear in this channel is shared with anyone who talks to me, and I may bring it up elsewhere.';

interface Line {
  level: string;
  msg: string;
  fields: Record<string, string> | undefined;
}

const storeDown = (): PluginError =>
  new PluginError({ code: 'store-unavailable', plugin: 'fake-store', message: 'db down: #support' });

function world(
  o: {
    /** What the n-th post (1-based) throws, if anything. */
    postFails?: (n: number) => Error | undefined;
    claimFails?: boolean;
    releaseFails?: boolean;
    /** Every log line throws, after it is recorded. */
    logThrows?: boolean;
  } = {},
) {
  // #support, bound to the support agent's own bot and never told: as a new binding, or one from before the notice.
  const mem = memoryChannelStore();
  mem.rows.set(`${INSTALL_ID}/${SUPPORT_CH}`, {
    installId: INSTALL_ID,
    channelId: SUPPORT_CH,
    agentId: SUPPORT_AGENT_ID,
    connectedByUserId: ADA,
    channelName: 'support',
    createdAt: new Date('2026-11-19T11:00:00Z'),
  });
  /** The stamp each release named. */
  const released: string[] = [];
  const channels = {
    async claimNotice(installId: string, channelId: string, agentId: string): Promise<string | null> {
      if (o.claimFails === true) throw storeDown();
      return mem.store.claimNotice(installId, channelId, agentId);
    },
    async releaseNotice(installId: string, channelId: string, agentId: string, claimed: string): Promise<void> {
      released.push(claimed);
      if (o.releaseFails === true) throw storeDown();
      await mem.store.releaseNotice(installId, channelId, agentId, claimed);
    },
  };

  const posts: Array<{ token: string; channel: string; text: string; threadTs?: string }> = [];
  const api = {
    async postToChannel(token: string, a: { channel: string; text: string; threadTs?: string }): Promise<void> {
      posts.push({ token, ...a });
      const err = o.postFails?.(posts.length);
      if (err !== undefined) throw err;
    },
  };

  const lines: Line[] = [];
  const log = (level: 'info' | 'warn', msg: string, fields?: Record<string, string>): void => {
    lines.push({ level, msg, fields });
    if (o.logThrows === true) throw new Error('log down');
  };

  const notice = (over: Partial<{ channelId: string; agentId: string }> = {}) =>
    postMemoryNotice(
      { api, channels },
      { installId: INSTALL_ID, channelId: SUPPORT_CH, threadTs: THREAD_TS, agentId: SUPPORT_AGENT_ID, botToken: BOT_TOKEN, ...over },
      log,
    );
  /** Whether #support's notice is claimed, as the store holds it. */
  const claimed = (): boolean => mem.notices.has(`${INSTALL_ID}/${SUPPORT_CH}`);
  return { mem, posts, lines, notice, claimed, released };
}

describe('postMemoryNotice', () => {
  it('claimed: one post, then slack_notice_posted', async () => {
    const w = world();
    await expect(w.notice()).resolves.toBeUndefined();

    // One top-level post in the channel, with the bot's own token. It names no team and says "anyone who talks to me".
    expect(w.posts).toEqual([{ token: BOT_TOKEN, channel: SUPPORT_CH, text: NOTICE }]);
    expect(w.posts[0]!.text).toBe(COPY.memoryNotice);
    expect(w.claimed()).toBe(true);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_notice_posted', fields: undefined }]);

    // Told once: the next turn's claim loses, and it posts nothing.
    await w.notice();
    expect(w.posts).toHaveLength(1);
    expect(w.lines).toHaveLength(1);
  });

  it('not claimed: no post', async () => {
    const w = world();
    // Told already: by an earlier turn, or another replica's.
    w.mem.notices.set(`${INSTALL_ID}/${SUPPORT_CH}`, 'an-earlier-claim');
    await w.notice();
    // Another agent's binding of the channel, or no binding at all: nothing to claim.
    await w.notice({ agentId: 'agt_other' });
    await w.notice({ channelId: 'C07UNBOUND1' });

    expect(w.posts).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it.each([
    ['not_in_channel', new SlackApiError('chat.postMessage', 'not_in_channel')],
    ['ratelimited', new SlackApiError('chat.postMessage', 'ratelimited', 30_000)],
    ['http-503', new SlackApiError('chat.postMessage', 'http-503')],
    ['timeout', new SlackApiError('chat.postMessage', 'timeout')],
  ])('a post Slack refuses releases the claim, logs stage post with its code, and resolves: %s', async (code, err) => {
    const w = world({ postFails: (n) => (n === 1 ? err : undefined) });
    await expect(w.notice()).resolves.toBeUndefined();

    expect(w.posts.map((p) => p.text)).toEqual([NOTICE]);
    expect(w.claimed()).toBe(false);
    // Given back by its own claim's stamp, so a newer binding's claim is never the one released.
    expect(w.released).toEqual(['claim-1']);
    expect(w.lines).toEqual([{ level: 'warn', msg: 'slack_notice_failed', fields: { stage: 'post', code } }]);

    // The next turn claims it again, and this time it goes out.
    await w.notice();
    expect(w.posts.map((p) => p.text)).toEqual([NOTICE, NOTICE]);
    expect(w.claimed()).toBe(true);
    expect(w.lines.map((l) => l.msg)).toEqual(['slack_notice_failed', 'slack_notice_posted']);
  });

  it("an announcement-only channel (restricted_action): the notice goes in the mention's thread instead, and the claim is kept", async () => {
    const restricted = new SlackApiError('chat.postMessage', 'restricted_action');
    const w = world({ postFails: (n) => (n === 1 ? restricted : undefined) });
    await expect(w.notice()).resolves.toBeUndefined();

    // Top-level first, then the same words in the thread the bot is about to reply in.
    expect(w.posts).toEqual([
      { token: BOT_TOKEN, channel: SUPPORT_CH, text: NOTICE },
      { token: BOT_TOKEN, channel: SUPPORT_CH, text: NOTICE, threadTs: THREAD_TS },
    ]);
    expect('threadTs' in w.posts[0]!).toBe(false);
    // Slack won't take a top-level post there at any turn, so this one is final: kept, and logged by stage.
    expect(w.claimed()).toBe(true);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_notice_top_level_refused', fields: { code: 'restricted_action' } },
      { level: 'info', msg: 'slack_notice_posted', fields: { stage: 'thread' } },
    ]);

    // The next turn finds it told: no post.
    await w.notice();
    expect(w.posts).toHaveLength(2);
  });

  it('an announcement-only channel whose thread post fails too releases the claim, and the next turn tries again', async () => {
    const w = world({
      postFails: (n) =>
        n === 1
          ? new SlackApiError('chat.postMessage', 'restricted_action')
          : n === 2
            ? new SlackApiError('chat.postMessage', 'ratelimited', 30_000)
            : undefined,
    });
    await expect(w.notice()).resolves.toBeUndefined();

    expect(w.posts.map((p) => p.threadTs)).toEqual([undefined, THREAD_TS]);
    expect(w.claimed()).toBe(false);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_notice_top_level_refused', fields: { code: 'restricted_action' } },
      { level: 'warn', msg: 'slack_notice_failed', fields: { stage: 'thread', code: 'ratelimited' } },
    ]);

    // The next turn claims again and posts top-level first, as any first try.
    await w.notice();
    expect(w.posts.map((p) => p.threadTs)).toEqual([undefined, THREAD_TS, undefined]);
    expect(w.claimed()).toBe(true);
    expect(w.lines.map((l) => l.msg)).toEqual(['slack_notice_top_level_refused', 'slack_notice_failed', 'slack_notice_posted']);
  });

  it.each(['restricted_action', 'restricted_action_thread_only_channel'])(
    'an admins-only refusal (%s) falls back to the thread, and a thread post that lands keeps the claim',
    async (code) => {
      const w = world({ postFails: (n) => (n === 1 ? new SlackApiError('chat.postMessage', code) : undefined) });
      await w.notice();
      expect(w.posts.map((p) => p.threadTs)).toEqual([undefined, THREAD_TS]);
      expect(w.claimed()).toBe(true);
      // Not a failure: the channel was told, in the thread; the refusal's own code is logged, for walk D.
      expect(w.lines).toEqual([
        { level: 'info', msg: 'slack_notice_top_level_refused', fields: { code } },
        { level: 'info', msg: 'slack_notice_posted', fields: { stage: 'thread' } },
      ]);
    },
  );

  it("a read-only channel's refusal is an ordinary one: no thread post, the claim given back", async () => {
    const w = world({
      postFails: (n) => (n === 1 ? new SlackApiError('chat.postMessage', 'restricted_action_read_only_channel') : undefined),
    });
    await w.notice();
    expect(w.posts.map((p) => p.threadTs)).toEqual([undefined]);
    expect(w.claimed()).toBe(false);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_notice_failed', fields: { stage: 'post', code: 'restricted_action_read_only_channel' } },
    ]);
  });

  it('only an admins-only refusal falls back to the thread: any other refusal posts nothing there', async () => {
    for (const code of ['not_in_channel', 'ratelimited', 'http-503', 'channel_not_found', 'restricted', 'not_restricted_action', 'restricted_actions', 'restricted_action_other']) {
      const w = world({ postFails: (n) => (n === 1 ? new SlackApiError('chat.postMessage', code) : undefined) });
      await w.notice();
      expect(w.posts.map((p) => p.threadTs), code).toEqual([undefined]);
      expect(w.claimed(), code).toBe(false);
    }
  });

  it("a failed post releases only its own claim: a binding made again meanwhile keeps the new one's (review F7)", async () => {
    // While turn 1's post is failing, the channel is disconnected and bound again, and the new binding's turn claims.
    const w: ReturnType<typeof world> = world({
      postFails: (n) => {
        if (n !== 1) return undefined;
        const at = `${INSTALL_ID}/${SUPPORT_CH}`;
        const row = w.mem.rows.get(at)!;
        w.mem.rows.delete(at);
        w.mem.notices.delete(at);
        w.mem.rows.set(at, { ...row, createdAt: new Date('2026-11-19T12:00:00Z') });
        w.mem.notices.set(at, 'the-new-binding-claim');
        return new SlackApiError('chat.postMessage', 'http-503');
      },
    });
    await w.notice();
    expect(w.released).toEqual(['claim-1']);
    // The new binding's claim stands: its own turn tells the channel, and nothing tells it twice.
    expect(w.mem.notices.get(`${INSTALL_ID}/${SUPPORT_CH}`)).toBe('the-new-binding-claim');
  });

  it('a claim that throws logs stage claim and posts nothing', async () => {
    const w = world({ claimFails: true });
    await expect(w.notice()).resolves.toBeUndefined();

    expect(w.posts).toEqual([]);
    expect(w.lines).toEqual([{ level: 'warn', msg: 'slack_notice_failed', fields: { stage: 'claim', code: 'store-unavailable' } }]);
  });

  it('a release that throws after a failed post logs stage release and resolves', async () => {
    const w = world({ postFails: () => new SlackApiError('chat.postMessage', 'internal_error'), releaseFails: true });
    await expect(w.notice()).resolves.toBeUndefined();

    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_notice_failed', fields: { stage: 'post', code: 'internal_error' } },
      { level: 'warn', msg: 'slack_notice_failed', fields: { stage: 'release', code: 'store-unavailable' } },
    ]);
    // The claim stays: this binding isn't told until it is made again (accepted: a refusal and a store fault at once).
    expect(w.claimed()).toBe(true);
  });

  it('log lines carry a stage and a code at most, never a name, an id or a token; a log that throws changes nothing', async () => {
    const w = world({ logThrows: true, postFails: (n) => (n === 1 ? new SlackApiError('chat.postMessage', 'not_in_channel') : undefined) });
    await expect(w.notice()).resolves.toBeUndefined();
    // The failed post was still given back, though its log line threw: the next turn posts.
    expect(w.claimed()).toBe(false);
    await expect(w.notice()).resolves.toBeUndefined();
    expect(w.posts).toHaveLength(2);
    expect(w.claimed()).toBe(true);

    expect(w.lines.map((l) => l.msg)).toEqual(['slack_notice_failed', 'slack_notice_posted']);
    const all = JSON.stringify(w.lines);
    for (const leak of [BOT_TOKEN, 'Support', 'support', 'agt_', 'usr_', 'C07', INSTALL_ID]) {
      expect(all, leak).not.toContain(leak);
    }
  });
});
