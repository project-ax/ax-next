import { HookBus, PluginError, makeAgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import {
  agentAccess,
  checkRights,
  connectChannel,
  listAvailableChannels,
  type ChannelDeps,
} from '../channels.js';
import { CHANNEL_LIST_PAGE_LIMIT } from '../limits.js';
import { SlackApiError, type SlackApi, type SlackChannel } from '../slack-api.js';
import type { InstallRow } from '../store.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { fakeBotToken } from './fake-slack-tokens.js';
import { memoryChannelStore } from './memory-channel-store.js';

/*
  The connect core decides who may connect a channel to a team agent, and so
  whose account the channel's outsiders will run as. The rules pinned here:
  someone who can't see the agent learns nothing (a missing agent and a
  forbidden one answer alike); only a team admin of the agent's team manages
  it, and workspace-admin status never counts; a personal agent is refused
  before Slack is asked anything; and a channel is checked (public, live, not
  Slack Connect) BEFORE the bot joins it.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const BOT_TOKEN = fakeBotToken('CHANNELSTESTSECRET');
const INSTALL: InstallRow = {
  installId: INSTALL_ID,
  status: 'active',
  appId: 'A07QF9ZK2MN',
  clientId: '7512345678901.7598765432109',
  botName: 'canopy-works',
  teamId: 'T07ABCDEF12',
  teamName: 'Canopy Works',
  botUserId: 'U07BOTUSER1',
  connectedByUserId: 'usr_installer',
  createdAt: new Date('2026-11-13T10:00:00Z'),
  installedAt: new Date('2026-11-13T10:05:00Z'),
};

const SUPPORT_TEAM = 'team_support';
const SALES_TEAM = 'team_sales';
const SUPPORT: FakeAgent = {
  id: 'agt_support',
  displayName: 'Support',
  visibility: 'team',
  ownerType: 'team',
  ownerId: SUPPORT_TEAM,
};
const SALES: FakeAgent = { id: 'agt_sales', displayName: 'Sales', visibility: 'team', ownerType: 'team', ownerId: SALES_TEAM };
const PATS: FakeAgent = { id: 'agt_pat', displayName: "Pat's agent", visibility: 'personal', ownerType: 'user', ownerId: 'usr_pat' };

const ADA = 'usr_ada'; // a team admin of the support team
const GRACE = 'usr_grace'; // another team admin of the support team
const MEL = 'usr_mel'; // a plain member of the support team
const WILL = 'usr_will'; // a workspace admin, and a plain member of the support team
const OTTO = 'usr_otto'; // in no team
const PAT = 'usr_pat'; // owns a personal agent
const SAM = 'usr_sam'; // a team admin of the sales team

const SUPPORT_CH = 'C07SUPPORT1';
const SALES_CH = 'C07SALES002';
const GENERAL_CH = 'C07GENERAL3';

const ctx = makeAgentContext({ sessionId: 'test', agentId: '', userId: 'system' });

/** A public channel as the Slack client narrows it: live, not shared, the bot not in it. */
function channel(id: string, name: string, over: Partial<SlackChannel> = {}): SlackChannel {
  return {
    id,
    name,
    isChannel: true,
    isPrivate: false,
    isArchived: false,
    isExtShared: false,
    isPendingExtShared: false,
    isMember: false,
    ...over,
  };
}

// ── A fake Slack: the three conversations calls, the rest refused ───────────

function fakeSlack() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  /** What Slack knows, by id. */
  const channels = new Map<string, SlackChannel>();
  /** conversations.list: channels per page, whatever `limit` asks for. */
  let pageSize = 1000;
  const on = {
    info: async (id: string): Promise<SlackChannel> => {
      const found = channels.get(id);
      if (found === undefined) throw new SlackApiError('conversations.info', 'channel_not_found');
      return { ...found };
    },
    join: async (_id: string): Promise<void> => {},
    list: async (a: { cursor?: string; limit: number }) => {
      const all = [...channels.values()];
      const start = a.cursor === undefined ? 0 : Number(a.cursor.slice(1));
      const end = start + pageSize;
      return {
        channels: all.slice(start, end).map((c) => ({ ...c })),
        nextCursor: end < all.length ? `p${end}` : null,
      };
    },
  };
  const notHere = async (): Promise<never> => {
    throw new Error('the connect core never makes this call');
  };
  const api: SlackApi = {
    conversationsInfo: async (token, id) => {
      calls.push({ method: 'conversations.info', args: [token, id] });
      return on.info(id);
    },
    conversationsJoin: async (token, id) => {
      calls.push({ method: 'conversations.join', args: [token, id] });
      return on.join(id);
    },
    conversationsList: async (token, a) => {
      calls.push({ method: 'conversations.list', args: [token, { ...a }] });
      return on.list(a);
    },
    rotateConfigToken: notHere,
    createApp: notHere,
    deleteApp: notHere,
    setAppIcon: notHere,
    oauthAccess: notHere,
    usersInfo: notHere,
    postMessage: notHere,
    postEphemeral: notHere,
    startStream: notHere,
    appendStream: notHere,
    stopStream: notHere,
    addReaction: notHere,
    removeReaction: notHere,
  };
  return {
    api,
    calls,
    channels,
    on,
    setPageSize(n: number): void {
      pageSize = n;
    },
    methods: (): string[] => calls.map((c) => c.method),
  };
}

// ── The world ───────────────────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function world(o: { workspaceAdminsMayManage?: boolean } = {}) {
  const bus = new HookBus();
  const people = fakeAgents(bus, o);
  for (const agent of [SUPPORT, SALES, PATS]) people.addAgent(agent);
  people.setRole(SUPPORT_TEAM, ADA, 'admin');
  people.setRole(SUPPORT_TEAM, GRACE, 'admin');
  people.setRole(SUPPORT_TEAM, MEL, 'member');
  people.setRole(SUPPORT_TEAM, WILL, 'member');
  people.setRole(SALES_TEAM, SAM, 'admin');

  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const memory = memoryChannelStore();
  const slack = fakeSlack();
  const state = {
    install: { ...INSTALL } as InstallRow | null,
    botToken: BOT_TOKEN as string | null,
    vaultFault: undefined as unknown,
  };
  const deps: ChannelDeps = {
    bus,
    installs: { current: async () => (state.install === null ? null : { ...state.install }) },
    channels: memory.store,
    secrets: {
      get: async (_owner, name) => {
        if (state.vaultFault !== undefined) throw state.vaultFault;
        return name === 'bot-token' ? state.botToken : null;
      },
    },
    api: slack.api,
    logger,
  };
  const connect = (channelId: string, actorUserId = ADA, agentId = SUPPORT.id) =>
    connectChannel(deps, { install: state.install, agentId, channelId, actorUserId });
  return { bus, people, memory, slack, state, deps, lines, connect };
}

// ── agentAccess ─────────────────────────────────────────────────────────────

describe('agentAccess', () => {
  it("is yes for a team agent the person can reach, no for one they can't, agent-gone for one that doesn't exist", async () => {
    const w = world();
    expect(await agentAccess(w.bus, ctx, SUPPORT.id, MEL)).toBe('yes');
    expect(await agentAccess(w.bus, ctx, SUPPORT.id, OTTO)).toBe('no');
    expect(await agentAccess(w.bus, ctx, 'agt_gone', MEL)).toBe('agent-gone');
    // Asked about the person given, never whoever the ctx names.
    expect(w.people.inputs('agents:resolve')).toEqual([
      { agentId: SUPPORT.id, userId: MEL },
      { agentId: SUPPORT.id, userId: OTTO },
      { agentId: 'agt_gone', userId: MEL },
    ]);
  });

  it("is not-team for a personal agent, its own owner's included", async () => {
    const w = world();
    expect(await agentAccess(w.bus, ctx, PATS.id, PAT)).toBe('not-team');
    expect(await agentAccess(w.bus, ctx, PATS.id, ADA)).toBe('no');
  });

  it('is not-team for an answer it cannot vouch for: another agent, or no readable visibility', async () => {
    const team = { id: SUPPORT.id, ownerId: SUPPORT_TEAM, ownerType: 'team', visibility: 'team', displayName: 'Support' };
    const answers: unknown[] = [
      { agent: { ...team, id: SALES.id } },
      { agent: { ...team, visibility: 'TEAM' } },
      { agent: { ...team, visibility: undefined } },
      { agent: null },
      {},
      null,
    ];
    for (const answer of answers) {
      const bus = new HookBus();
      bus.registerService('agents:resolve', '@ax/agents', async () => answer);
      expect(await agentAccess(bus, ctx, SUPPORT.id, MEL), JSON.stringify(answer)).toBe('not-team');
    }
  });

  it('lets any other failure through: an outage is not a refusal', async () => {
    const w = world();
    const outage = new PluginError({ code: 'unavailable', plugin: '@ax/teams', message: 'db down' });
    w.people.faults.set('agents:resolve', outage);
    await expect(agentAccess(w.bus, ctx, SUPPORT.id, MEL)).rejects.toBe(outage);
  });
});

// ── checkRights ─────────────────────────────────────────────────────────────

describe('checkRights', () => {
  it("lets any member of the agent's team view, and only a team admin manage", async () => {
    const w = world();
    const ok = { ok: true, agentId: SUPPORT.id, agentName: 'Support' };
    expect(await checkRights(w.bus, ctx, SUPPORT.id, MEL, 'view')).toEqual(ok);
    expect(await checkRights(w.bus, ctx, SUPPORT.id, MEL, 'manage')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await checkRights(w.bus, ctx, SUPPORT.id, ADA, 'manage')).toEqual(ok);
    // A team admin of ANOTHER team can't even see it.
    expect(await checkRights(w.bus, ctx, SUPPORT.id, SAM, 'manage')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('answers someone outside the team exactly as it answers for an agent that does not exist', async () => {
    const w = world();
    for (const need of ['view', 'manage'] as const) {
      const outsider = await checkRights(w.bus, ctx, SUPPORT.id, OTTO, need);
      expect(outsider).toEqual({ ok: false, reason: 'not-found' });
      expect(await checkRights(w.bus, ctx, 'agt_gone', OTTO, need)).toEqual(outsider);
    }
    // Neither got as far as the manage question.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
  });

  it('asks agents as a non-admin, always: workspace-admin status never manages a channel', async () => {
    // Even under an agents rule that WOULD let a workspace admin through.
    const w = world({ workspaceAdminsMayManage: true });
    expect(await checkRights(w.bus, ctx, SUPPORT.id, WILL, 'manage')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await checkRights(w.bus, ctx, SUPPORT.id, ADA, 'manage')).toMatchObject({ ok: true });
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: WILL, isAdmin: false } },
      { agentId: SUPPORT.id, actor: { userId: ADA, isAdmin: false } },
    ]);
  });

  it("refuses a personal agent as personal-agent to its owner and not-found to anyone else, asking nothing more", async () => {
    const w = world();
    expect(await checkRights(w.bus, ctx, PATS.id, PAT, 'view')).toEqual({ ok: false, reason: 'personal-agent' });
    expect(await checkRights(w.bus, ctx, PATS.id, PAT, 'manage')).toEqual({ ok: false, reason: 'personal-agent' });
    expect(await checkRights(w.bus, ctx, PATS.id, ADA, 'manage')).toEqual({ ok: false, reason: 'not-found' });
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
  });

  it.each([
    ['an empty object', {}],
    ['allowed as a string', { allowed: 'true' }],
    ['allowed as a number', { allowed: 1 }],
    ['null', null],
    ['a bare true', true],
    ['allowed missing beside other keys', { ok: true }],
  ])('refuses manage when the allowed answer is %s: only an explicit true passes', async (_what, answer) => {
    const w = world();
    w.people.answers.set('agents:can-set-shared-credential', answer);
    expect(await checkRights(w.bus, ctx, SUPPORT.id, ADA, 'manage')).toEqual({ ok: false, reason: 'forbidden' });
    // Viewing doesn't ask the manage question at all.
    expect(await checkRights(w.bus, ctx, SUPPORT.id, ADA, 'view')).toMatchObject({ ok: true });
  });

  it('answers not-found for an agent deleted between the two questions', async () => {
    const w = world();
    w.people.faults.set(
      'agents:can-set-shared-credential',
      new PluginError({ code: 'not-found', plugin: '@ax/agents', message: 'gone' }),
    );
    expect(await checkRights(w.bus, ctx, SUPPORT.id, ADA, 'manage')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('lets any other failure of either question through', async () => {
    const outage = new PluginError({ code: 'unavailable', plugin: '@ax/teams', message: 'db down' });
    for (const hook of ['agents:resolve', 'agents:can-set-shared-credential']) {
      const w = world();
      w.people.faults.set(hook, outage);
      await expect(checkRights(w.bus, ctx, SUPPORT.id, ADA, 'manage'), hook).rejects.toBe(outage);
    }
  });
});

// ── connectChannel ──────────────────────────────────────────────────────────

describe('connectChannel', () => {
  it('connects a public channel: conversations.info, then the bot joins, then the binding', async () => {
    const w = world();
    w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk'));

    expect(await w.connect(SUPPORT_CH)).toEqual({
      ok: true,
      reconnected: false,
      binding: {
        installId: INSTALL_ID,
        channelId: SUPPORT_CH,
        agentId: SUPPORT.id,
        connectedByUserId: ADA,
        channelName: 'support-desk',
        remember: true,
        createdAt: expect.any(Date),
      },
    });
    expect(w.slack.calls).toEqual([
      { method: 'conversations.info', args: [BOT_TOKEN, SUPPORT_CH] },
      { method: 'conversations.join', args: [BOT_TOKEN, SUPPORT_CH] },
    ]);
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SUPPORT.id, connectedByUserId: ADA });
  });

  it('binds a channel the bot is already in without joining it again', async () => {
    const w = world();
    w.slack.channels.set(SALES_CH, channel(SALES_CH, 'sales-floor', { isMember: true }));
    expect(await w.connect(SALES_CH)).toMatchObject({ ok: true, reconnected: false });
    expect(w.slack.methods()).toEqual(['conversations.info']);
  });

  it('stores the name cleaned: no bidi override, brackets or newlines reach the binding', async () => {
    const w = world();
    const rlo = String.fromCharCode(0x202e);
    w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, `support${rlo}[x](y)\nnext`));
    const out = await w.connect(SUPPORT_CH);
    expect(out).toMatchObject({ ok: true, binding: { channelName: 'support x y next' } });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)?.channelName).toBe('support x y next');
  });

  it.each([
    ['a private channel', { isPrivate: true }, 'not-public'],
    ['a conversation that is not a channel (a DM, a group DM)', { isChannel: false }, 'not-public'],
    ['an archived channel', { isArchived: true }, 'archived'],
    ['a Slack Connect channel', { isExtShared: true }, 'shared'],
    ['a channel being shared with another workspace', { isPendingExtShared: true }, 'shared'],
    ['a Slack Connect channel the bot is already in', { isExtShared: true, isMember: true }, 'shared'],
  ] as const)('refuses %s before the bot joins, and binds nothing', async (_what, flags, reason) => {
    const w = world();
    w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk', flags));
    expect(await w.connect(SUPPORT_CH)).toEqual({ ok: false, reason });
    expect(w.slack.methods()).toEqual(['conversations.info']);
    expect(w.memory.rows.size).toBe(0);
  });

  it.each([
    ['missing_scope', { ok: false, reason: 'needs-reconnect' }],
    ['channel_not_found', { ok: false, reason: 'not-public' }],
    ['ratelimited', { ok: false, reason: 'slack-error', code: 'ratelimited' }],
    ['http-503', { ok: false, reason: 'slack-error', code: 'http-503' }],
    ['invalid_auth', { ok: false, reason: 'slack-error', code: 'invalid_auth' }],
  ])('conversations.info answering %s: nothing joined, nothing bound', async (code, outcome) => {
    const w = world();
    w.slack.on.info = async () => {
      throw new SlackApiError('conversations.info', code);
    };
    expect(await w.connect(SUPPORT_CH)).toEqual(outcome);
    expect(w.slack.methods()).toEqual(['conversations.info']);
    expect(w.memory.rows.size).toBe(0);
  });

  it.each([
    ['missing_scope', { ok: false, reason: 'needs-reconnect' }],
    ['method_not_supported_for_channel_type', { ok: false, reason: 'not-public' }],
    ['channel_not_found', { ok: false, reason: 'not-public' }],
    ['is_archived', { ok: false, reason: 'archived' }],
    ['ratelimited', { ok: false, reason: 'slack-error', code: 'ratelimited' }],
    ['timeout', { ok: false, reason: 'slack-error', code: 'timeout' }],
  ])('conversations.join answering %s: nothing bound', async (code, outcome) => {
    const w = world();
    w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk'));
    w.slack.on.join = async () => {
      throw new SlackApiError('conversations.join', code);
    };
    expect(await w.connect(SUPPORT_CH)).toEqual(outcome);
    expect(w.memory.rows.size).toBe(0);
  });

  it('reads a Slack code that is also an object key as just another slack-error', async () => {
    // Slack's codes are [a-z_]: `constructor` and `__proto__`, the two
    // lowercase keys every plain object has, are possible codes, and must
    // never be looked up as properties of one.
    for (const code of ['constructor', '__proto__']) {
      for (const step of ['info', 'join'] as const) {
        const w = world();
        w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk'));
        w.slack.on[step] = async () => {
          throw new SlackApiError(`conversations.${step}`, code);
        };
        expect(await w.connect(SUPPORT_CH), `${step} ${code}`).toEqual({ ok: false, reason: 'slack-error', code });
      }
    }
  });

  it('refuses an answer about another channel (id-mismatch): nothing joined, nothing bound', async () => {
    const w = world();
    // Slack answers for #general when asked about #support.
    w.slack.on.info = async () => channel(GENERAL_CH, 'general');
    expect(await w.connect(SUPPORT_CH)).toEqual({ ok: false, reason: 'slack-error', code: 'id-mismatch' });
    expect(w.slack.methods()).toEqual(['conversations.info']);
    expect(w.memory.rows.size).toBe(0);
  });

  it('is no-workspace, without asking Slack, when no install is active or it has no bot token', async () => {
    const pending = world();
    pending.state.install = { ...INSTALL, status: 'pending', teamId: null, teamName: null, botUserId: null };
    const none = world();
    none.state.install = null;
    const tokenless = world();
    tokenless.state.botToken = null;
    for (const w of [pending, none, tokenless]) {
      w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk'));
      expect(await w.connect(SUPPORT_CH)).toEqual({ ok: false, reason: 'no-workspace' });
      expect(w.slack.calls).toEqual([]);
      expect(w.memory.rows.size).toBe(0);
    }
  });

  it("refuses another agent's channel as channel-taken, and leaves that binding as it was", async () => {
    const w = world();
    w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk', { isMember: true }));
    expect(await w.connect(SUPPORT_CH, SAM, SALES.id)).toMatchObject({ ok: true });
    const before = w.memory.row(INSTALL_ID, SUPPORT_CH);

    expect(await w.connect(SUPPORT_CH, ADA, SUPPORT.id)).toEqual({ ok: false, reason: 'channel-taken' });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toEqual(before);
    expect(before).toMatchObject({ agentId: SALES.id, connectedByUserId: SAM });
  });

  it('takes the same agent again as a reconnect: the connector and name change, remember is kept', async () => {
    const w = world();
    w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk', { isMember: true }));
    await w.connect(SUPPORT_CH, ADA);
    await w.memory.store.setRemember(INSTALL_ID, SUPPORT_CH, SUPPORT.id, false);
    w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'help-desk', { isMember: true }));

    expect(await w.connect(SUPPORT_CH, GRACE)).toEqual({
      ok: true,
      reconnected: true,
      binding: expect.objectContaining({ connectedByUserId: GRACE, channelName: 'help-desk', remember: false }),
    });
  });

  it('still answers with what it wrote when a disconnect lands between the bind and its read-back', async () => {
    const w = world();
    w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk', { isMember: true }));
    const read = w.memory.store.get;
    w.memory.store.get = async (installId, channelId) => {
      await w.memory.store.remove(installId, channelId, SUPPORT.id);
      return read(installId, channelId);
    };
    expect(await w.connect(SUPPORT_CH)).toEqual({
      ok: true,
      reconnected: false,
      binding: {
        installId: INSTALL_ID,
        channelId: SUPPORT_CH,
        agentId: SUPPORT.id,
        connectedByUserId: ADA,
        channelName: 'support-desk',
        remember: true,
        createdAt: expect.any(Date),
      },
    });
  });

  it('lets a vault, store or non-Slack failure through', async () => {
    const vault = world();
    const sealed = new PluginError({ code: 'vault-sealed', plugin: '@ax/credentials', message: 'no' });
    vault.state.vaultFault = sealed;
    await expect(vault.connect(SUPPORT_CH)).rejects.toBe(sealed);

    const store = world();
    store.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk', { isMember: true }));
    const down = Object.assign(new Error('relation gone'), { code: '42P01' });
    store.memory.store.upsert = async () => {
      throw down;
    };
    await expect(store.connect(SUPPORT_CH)).rejects.toBe(down);

    const odd = world();
    const bug = new TypeError('not a Slack refusal');
    odd.slack.on.info = async () => {
      throw bug;
    };
    await expect(odd.connect(SUPPORT_CH)).rejects.toBe(bug);
  });

  it('logs each outcome by code alone: the install, the reason, the step, and a Slack code', async () => {
    const w = world();
    w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk'));
    w.slack.channels.set(SALES_CH, channel(SALES_CH, 'sales-floor', { isArchived: true }));
    await w.connect(SUPPORT_CH);
    await w.connect(SUPPORT_CH, GRACE);
    await w.connect(SALES_CH);
    await w.connect(SUPPORT_CH, SAM, SALES.id);
    w.slack.on.join = async () => {
      throw new SlackApiError('conversations.join', 'missing_scope');
    };
    w.slack.channels.set(GENERAL_CH, channel(GENERAL_CH, 'general'));
    await w.connect(GENERAL_CH);
    w.state.install = null;
    await w.connect(GENERAL_CH);

    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_channel_connected', fields: { installId: INSTALL_ID, reconnected: false } },
      { level: 'info', msg: 'slack_channel_connected', fields: { installId: INSTALL_ID, reconnected: true } },
      {
        level: 'info',
        msg: 'slack_channel_refused',
        fields: { installId: INSTALL_ID, reason: 'archived', stage: 'info' },
      },
      {
        level: 'info',
        msg: 'slack_channel_refused',
        fields: { installId: INSTALL_ID, reason: 'channel-taken', stage: 'bind' },
      },
      {
        level: 'warn',
        msg: 'slack_channel_refused',
        fields: { installId: INSTALL_ID, reason: 'needs-reconnect', stage: 'join', code: 'missing_scope' },
      },
      { level: 'info', msg: 'slack_channel_refused', fields: { reason: 'no-workspace', stage: 'install' } },
    ]);
  });
});

// ── listAvailableChannels ───────────────────────────────────────────────────

describe('listAvailableChannels', () => {
  it('lists the public channels by name, each marked this-agent, other-agent or free', async () => {
    const w = world();
    w.slack.channels.set(SUPPORT_CH, channel(SUPPORT_CH, 'support-desk', { isMember: true }));
    w.slack.channels.set(SALES_CH, channel(SALES_CH, 'sales-floor', { isMember: true }));
    w.slack.channels.set(GENERAL_CH, channel(GENERAL_CH, 'general'));
    await w.connect(SUPPORT_CH, ADA, SUPPORT.id);
    await w.connect(SALES_CH, SAM, SALES.id);
    w.slack.calls.length = 0;

    expect(await listAvailableChannels(w.deps, SUPPORT.id)).toEqual({
      ok: true,
      truncated: false,
      channels: [
        { channelId: GENERAL_CH, name: 'general', connected: null },
        { channelId: SALES_CH, name: 'sales-floor', connected: 'other-agent' },
        { channelId: SUPPORT_CH, name: 'support-desk', connected: 'this-agent' },
      ],
    });
    expect(w.slack.calls).toEqual([
      { method: 'conversations.list', args: [BOT_TOKEN, { limit: CHANNEL_LIST_PAGE_LIMIT }] },
    ]);
  });

  it('leaves out what can never be connected, cleans every name, and lists an id once', async () => {
    const w = world();
    const rlo = String.fromCharCode(0x202e);
    w.slack.on.list = async () => ({
      channels: [
        channel('C07PRIVATE1', 'secret', { isPrivate: true }),
        channel('C07ARCHIVE1', 'old-news', { isArchived: true }),
        channel('C07SHARED01', 'partners', { isExtShared: true }),
        channel('C07PENDING1', 'soon-partners', { isPendingExtShared: true }),
        channel('D07DIRECT01', 'a-dm', { isChannel: false }),
        channel(SUPPORT_CH, `support${rlo}[desk](x)`),
        channel(SUPPORT_CH, 'support-again'),
      ],
      nextCursor: null,
    });
    expect(await listAvailableChannels(w.deps, SUPPORT.id)).toEqual({
      ok: true,
      truncated: false,
      channels: [{ channelId: SUPPORT_CH, name: 'support desk x', connected: null }],
    });
  });

  it('reads at most five pages of 200, sending each cursor back; a cursor left after the fifth is truncated', async () => {
    const w = world();
    w.slack.setPageSize(2);
    for (let i = 10; i < 22; i += 1) w.slack.channels.set(`C07CHAN00${i}`, channel(`C07CHAN00${i}`, `chan-${i}`));

    const out = await listAvailableChannels(w.deps, SUPPORT.id);
    expect(out).toMatchObject({ ok: true, truncated: true });
    expect(out.ok && out.channels.map((c) => c.name)).toEqual([
      'chan-10',
      'chan-11',
      'chan-12',
      'chan-13',
      'chan-14',
      'chan-15',
      'chan-16',
      'chan-17',
      'chan-18',
      'chan-19',
    ]);
    expect(w.slack.calls.map((c) => c.args[1])).toEqual([
      { limit: 200 },
      { limit: 200, cursor: 'p2' },
      { limit: 200, cursor: 'p4' },
      { limit: 200, cursor: 'p6' },
      { limit: 200, cursor: 'p8' },
    ]);
  });

  it('is not truncated when the last page comes within five', async () => {
    const w = world();
    w.slack.setPageSize(2);
    for (let i = 10; i < 20; i += 1) w.slack.channels.set(`C07CHAN00${i}`, channel(`C07CHAN00${i}`, `chan-${i}`));
    const out = await listAvailableChannels(w.deps, SUPPORT.id);
    expect(out).toMatchObject({ ok: true, truncated: false });
    expect(out.ok && out.channels).toHaveLength(10);
    expect(w.slack.calls).toHaveLength(5);
  });

  it.each([
    ['missing_scope', { ok: false, reason: 'needs-reconnect' }],
    ['ratelimited', { ok: false, reason: 'slack-error', code: 'ratelimited' }],
    ['constructor', { ok: false, reason: 'slack-error', code: 'constructor' }],
  ])('answers conversations.list refusing with %s', async (code, outcome) => {
    const w = world();
    w.slack.on.list = async () => {
      throw new SlackApiError('conversations.list', code);
    };
    expect(await listAvailableChannels(w.deps, SUPPORT.id)).toEqual(outcome);
  });

  it('is no-workspace, without asking Slack, when no install is active or it has no bot token', async () => {
    const none = world();
    none.state.install = null;
    const tokenless = world();
    tokenless.state.botToken = null;
    for (const w of [none, tokenless]) {
      expect(await listAvailableChannels(w.deps, SUPPORT.id)).toEqual({ ok: false, reason: 'no-workspace' });
      expect(w.slack.calls).toEqual([]);
    }
  });
});
