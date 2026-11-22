import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.js';
import { decodeSlackEntities } from '../format.js';
import { postMemoryNotice } from '../memory-notice.js';
import { SlackApiError } from '../slack-api.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { fakeBotToken } from './fake-slack-tokens.js';
import { spellsMention } from './lenient-decoder.js';
import { memoryChannelStore } from './memory-channel-store.js';

/*
  A channel's memory notice (memory-notice.ts, TASK-1203; design §4c): a
  team bot's first turn in a channel tells everyone there, top-level, that
  what it hears is shared with its team. Over the in-memory channel store
  (its claim rules are pinned against Postgres in channel-store.test.ts),
  @ax/agents' and @ax/teams' answers on the bus, and a recording fake Slack.

  What is pinned here: only a claim that wins posts, so a channel is told
  once; a post Slack refuses gives the claim back, so the next turn tries
  again, except in an announcement-only channel (`restricted_action`), where
  the notice goes in the mention's thread instead and the claim is kept;
  nothing here throws, so the turn it runs in goes on; the team is
  named as the person the turn runs as sees it, escaped, else "my team"; and
  every log line carries a stage and a code at most, never a name.
*/

const INSTALL_ID = 'Tq2Lw8vNc5Xr1Bm7Kd4JsA';
const SUPPORT_CH = 'C07SUPPORT1';
const CARE_TEAM = 'team_care';
const SUPPORT: FakeAgent = { id: 'agt_support', displayName: 'Support', visibility: 'team', ownerType: 'team', ownerId: CARE_TEAM };
/** A team admin of the care team: the person the turn runs as. */
const ADA = 'usr_ada';
/** On no team the support agent is on. */
const SAM = 'usr_sam';
const BOT_TOKEN = fakeBotToken('NOTICETESTSECRET');
/** The thread the bot is about to reply in: the mention's. */
const THREAD_TS = '1763035300.000300';
/** A team name that tries to ping, link and break the escaping. */
const HOSTILE = '<!channel> & <@U1> @here';
/** The mark that keeps a reference or a broadcast from working. */
const ZWSP = String.fromCharCode(0x200b);
const NAMED = 'Heads up: what I hear in this channel is shared with everyone on Customer Care, and I may bring it up elsewhere.';
const UNNAMED = 'Heads up: what I hear in this channel is shared with everyone on my team, and I may bring it up elsewhere.';

interface Line {
  level: string;
  msg: string;
  fields: Record<string, string> | undefined;
}

const storeDown = (): PluginError =>
  new PluginError({ code: 'store-unavailable', plugin: 'fake-store', message: 'db down: #support Customer Care' });

function world(
  o: {
    /** Register no teams:list-for-user at all. */
    teams?: boolean;
    /** What the n-th post (1-based) throws, if anything. */
    postFails?: (n: number) => Error | undefined;
    claimFails?: boolean;
    releaseFails?: boolean;
    /** Every log line throws, after it is recorded. */
    logThrows?: boolean;
  } = {},
) {
  const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
  const agents = fakeAgents(bus);
  agents.addAgent(SUPPORT);
  agents.setRole(CARE_TEAM, ADA, 'admin');
  const names = new Map([[CARE_TEAM, 'Customer Care']]);
  const teams: { asked: string[]; fault?: unknown } = { asked: [] };
  if (o.teams !== false) {
    bus.registerService('teams:list-for-user', '@ax/teams', async (_ctx, raw) => {
      const userId = (raw as { userId: string }).userId;
      teams.asked.push(userId);
      if (teams.fault !== undefined) throw teams.fault;
      return {
        teams: agents.teamsOf(userId).map((id) => ({ id, displayName: names.get(id) ?? id, createdBy: ADA, createdAt: new Date(0) })),
      };
    });
  }

  // #support, bound to the support agent's own bot and never told: as a new binding, or one from before the notice.
  const mem = memoryChannelStore();
  mem.rows.set(`${INSTALL_ID}/${SUPPORT_CH}`, {
    installId: INSTALL_ID,
    channelId: SUPPORT_CH,
    agentId: SUPPORT.id,
    connectedByUserId: ADA,
    channelName: 'support',
    createdAt: new Date('2026-11-19T11:00:00Z'),
  });
  const channels = {
    async claimNotice(installId: string, channelId: string, agentId: string): Promise<boolean> {
      if (o.claimFails === true) throw storeDown();
      return mem.store.claimNotice(installId, channelId, agentId);
    },
    async releaseNotice(installId: string, channelId: string, agentId: string): Promise<void> {
      if (o.releaseFails === true) throw storeDown();
      await mem.store.releaseNotice(installId, channelId, agentId);
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

  const ctx = makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: ADA });
  const notice = (over: Partial<{ channelId: string; agentId: string; userId: string }> = {}) =>
    postMemoryNotice(
      { bus, api, channels },
      ctx,
      { installId: INSTALL_ID, channelId: SUPPORT_CH, threadTs: THREAD_TS, agentId: SUPPORT.id, botToken: BOT_TOKEN, userId: ADA, ...over },
      log,
    );
  /** Whether #support's notice is claimed, as the store holds it. */
  const claimed = (): boolean => mem.notices.has(`${INSTALL_ID}/${SUPPORT_CH}`);
  return { agents, names, teams, mem, posts, lines, notice, claimed };
}

describe('postMemoryNotice', () => {
  it('claimed: one post with the team named, then slack_notice_posted', async () => {
    const w = world();
    await expect(w.notice()).resolves.toBeUndefined();

    // One top-level post in the channel, with the bot's own token: the team as the person the turn runs as sees it.
    expect(w.posts).toEqual([{ token: BOT_TOKEN, channel: SUPPORT_CH, text: NAMED }]);
    expect(w.posts[0]!.text).toBe(COPY.memoryNotice('Customer Care'));
    expect(w.agents.inputs('agents:resolve')).toEqual([{ agentId: SUPPORT.id, userId: ADA }]);
    expect(w.teams.asked).toEqual([ADA]);
    expect(w.claimed()).toBe(true);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_notice_posted', fields: undefined }]);

    // Told once: the next turn's claim loses, and it asks and posts nothing.
    await w.notice();
    expect(w.posts).toHaveLength(1);
    expect(w.teams.asked).toEqual([ADA]);
    expect(w.lines).toHaveLength(1);
  });

  it('not claimed: no team lookup and no post', async () => {
    const w = world();
    // Told already: by an earlier turn, or another replica's.
    w.mem.notices.add(`${INSTALL_ID}/${SUPPORT_CH}`);
    await w.notice();
    // Another agent's binding of the channel, or no binding at all: nothing to claim.
    await w.notice({ agentId: 'agt_other' });
    await w.notice({ channelId: 'C07UNBOUND1' });

    expect(w.posts).toEqual([]);
    expect(w.agents.calls).toEqual([]);
    expect(w.teams.asked).toEqual([]);
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

    expect(w.posts.map((p) => p.text)).toEqual([NAMED]);
    expect(w.claimed()).toBe(false);
    expect(w.lines).toEqual([{ level: 'warn', msg: 'slack_notice_failed', fields: { stage: 'post', code } }]);

    // The next turn claims it again, and this time it goes out.
    await w.notice();
    expect(w.posts.map((p) => p.text)).toEqual([NAMED, NAMED]);
    expect(w.claimed()).toBe(true);
    expect(w.lines.map((l) => l.msg)).toEqual(['slack_notice_failed', 'slack_notice_posted']);
  });

  it("an announcement-only channel (restricted_action): the notice goes in the mention's thread instead, and the claim is kept", async () => {
    const restricted = new SlackApiError('chat.postMessage', 'restricted_action');
    const w = world({ postFails: (n) => (n === 1 ? restricted : undefined) });
    await expect(w.notice()).resolves.toBeUndefined();

    // Top-level first, then the same words in the thread the bot is about to reply in.
    expect(w.posts).toEqual([
      { token: BOT_TOKEN, channel: SUPPORT_CH, text: NAMED },
      { token: BOT_TOKEN, channel: SUPPORT_CH, text: NAMED, threadTs: THREAD_TS },
    ]);
    expect('threadTs' in w.posts[0]!).toBe(false);
    // Slack won't take a top-level post there at any turn, so this one is final: kept, and logged by stage.
    expect(w.claimed()).toBe(true);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_notice_failed', fields: { stage: 'post', code: 'restricted_action' } },
      { level: 'info', msg: 'slack_notice_posted', fields: { stage: 'thread' } },
    ]);
    // The team was looked up once, for both posts.
    expect(w.teams.asked).toEqual([ADA]);

    // The next turn finds it told: no lookup, no post.
    await w.notice();
    expect(w.posts).toHaveLength(2);
    expect(w.teams.asked).toEqual([ADA]);
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
      { level: 'warn', msg: 'slack_notice_failed', fields: { stage: 'post', code: 'restricted_action' } },
      { level: 'warn', msg: 'slack_notice_failed', fields: { stage: 'thread', code: 'ratelimited' } },
    ]);

    // The next turn claims again and posts top-level first, as any first try.
    await w.notice();
    expect(w.posts.map((p) => p.threadTs)).toEqual([undefined, THREAD_TS, undefined]);
    expect(w.claimed()).toBe(true);
    expect(w.lines.map((l) => l.msg)).toEqual(['slack_notice_failed', 'slack_notice_failed', 'slack_notice_posted']);
  });

  it('only restricted_action falls back to the thread: any other refusal posts nothing there', async () => {
    for (const code of ['not_in_channel', 'ratelimited', 'http-503', 'channel_not_found']) {
      const w = world({ postFails: (n) => (n === 1 ? new SlackApiError('chat.postMessage', code) : undefined) });
      await w.notice();
      expect(w.posts.map((p) => p.threadTs), code).toEqual([undefined]);
      expect(w.claimed(), code).toBe(false);
    }
  });

  it('a claim that throws logs stage claim and posts nothing', async () => {
    const w = world({ claimFails: true });
    await expect(w.notice()).resolves.toBeUndefined();

    expect(w.posts).toEqual([]);
    expect(w.agents.calls).toEqual([]);
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

  it("no team name: the 'my team' line", async () => {
    // No teams service: nothing is asked about the agent either.
    const bare = world({ teams: false });
    await bare.notice();
    expect(bare.posts.map((p) => p.text)).toEqual([UNNAMED]);
    expect(bare.posts[0]!.text).toBe(COPY.memoryNotice(null));
    expect(bare.agents.calls).toEqual([]);
    expect(bare.lines).toEqual([{ level: 'info', msg: 'slack_notice_posted', fields: undefined }]);

    // A teams service that fails: logged by its code alone, and the notice still goes out.
    const down = world();
    down.teams.fault = Object.assign(new Error('read ECONNRESET Customer Care'), { code: 'ECONNRESET' });
    await down.notice();
    expect(down.posts.map((p) => p.text)).toEqual([UNNAMED]);
    expect(down.lines).toEqual([
      { level: 'warn', msg: 'slack_team_name_failed', fields: { code: 'ECONNRESET' } },
      { level: 'info', msg: 'slack_notice_posted', fields: undefined },
    ]);

    // Asked as someone the agent isn't visible to: quiet, and "my team".
    const off = world();
    await off.notice({ userId: SAM });
    expect(off.posts.map((p) => p.text)).toEqual([UNNAMED]);
    expect(off.lines.map((l) => l.msg)).toEqual(['slack_notice_posted']);
  });

  it('a hostile team name goes out escaped', async () => {
    const w = world();
    w.names.set(CARE_TEAM, HOSTILE);
    await w.notice();

    const text = w.posts[0]!.text;
    // Escaped, and marked (`shown` puts an invisible mark in each control and broadcast).
    const unmarked = text.split(ZWSP).join('');
    expect(unmarked).toContain('&lt;!channel&gt;');
    expect(text).toContain(ZWSP);
    expect(text).not.toMatch(/<[!@#]/);
    expect(unmarked).not.toMatch(/<[!@#]/);
    expect(unmarked).toContain('everyone on &lt;!channel&gt; &amp; &lt;@U1&gt; @here, and I may');
    // Slack undoes mrkdwn's escapes; even a lenient reader after it finds no mention or broadcast.
    expect(spellsMention(decodeSlackEntities(text))).toBe(false);
  });

  it('log lines carry a stage and a code at most, never a name, an id or a token; a log that throws changes nothing', async () => {
    const w = world({ logThrows: true, postFails: (n) => (n === 1 ? new SlackApiError('chat.postMessage', 'not_in_channel') : undefined) });
    w.teams.fault = Object.assign(new Error(`ECONNRESET ${BOT_TOKEN} Customer Care`), { code: 'ECONNRESET' });
    await expect(w.notice()).resolves.toBeUndefined();
    // The failed post was still given back, though its log line threw: the next turn posts.
    expect(w.claimed()).toBe(false);
    await expect(w.notice()).resolves.toBeUndefined();
    expect(w.posts).toHaveLength(2);
    expect(w.claimed()).toBe(true);

    expect(w.lines.map((l) => l.msg)).toEqual([
      'slack_team_name_failed',
      'slack_notice_failed',
      'slack_team_name_failed',
      'slack_notice_posted',
    ]);
    const all = JSON.stringify(w.lines);
    for (const leak of [BOT_TOKEN, 'Customer', 'Care', 'Support', 'support', 'agt_', 'usr_', CARE_TEAM, 'C07', INSTALL_ID]) {
      expect(all, leak).not.toContain(leak);
    }
  });
});
