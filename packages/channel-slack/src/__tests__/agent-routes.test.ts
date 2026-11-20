import { HookBus, PluginError, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createAgentSlackRoutes } from '../agent-routes.js';
import type { AgentSlackBot, BotReply, Bots } from '../bots.js';
import type { ChannelDeps } from '../channels.js';
import type { RouteRequest, RouteResponse } from '../http-types.js';
import { ADMIN_BODY_MAX_BYTES, ADMIN_CONNECT_BODY_MAX_BYTES } from '../limits.js';
import { createSlackApi } from '../slack-api.js';
import type { InstallRow } from '../store.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { pngBase64 } from './fake-png.js';
import { fakeBotToken, fakeConfigAccessToken, fakeConfigRefreshToken } from './fake-slack-tokens.js';
import { memoryChannelStore } from './memory-channel-store.js';

/*
  The agent-settings Slack section, through its route handlers, the real
  Slack client and a fake Slack Web API. Who may do what is the point:
  signed out → 401; anyone who can't see the agent → the same 404 a missing
  agent gets; a team member reads without managing (403 on writes); a team
  admin of the agent's team manages; workspace-admin status never counts;
  a personal agent is refused before Slack is asked anything.

  The agent's own bot (TASK-1167), and its Disconnect (TASK-1172), sit
  behind the same gate: its routes are checked here for who gets through and
  what the domain is handed, with a stub domain (bots.test.ts tests the
  domain itself).
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const TEAM_ID = 'T07ABCDEF12';
const BOT_TOKEN = fakeBotToken('ROUTESTESTSECRET');
const INSTALL: InstallRow = {
  installId: INSTALL_ID,
  kind: 'shared',
  agentId: null,
  requestedByUserId: null,
  botHandle: null,
  status: 'active',
  appId: 'A07QF9ZK2MN',
  clientId: '7512345678901.7598765432109',
  botName: 'canopy-works',
  teamId: TEAM_ID,
  teamName: 'Canopy Works',
  botUserId: 'U07BOTUSER1',
  connectedByUserId: 'usr_installer',
  createdAt: new Date('2026-11-13T10:00:00Z'),
  configTokenAddedAt: new Date('2026-11-13T10:00:00Z'),
  installedAt: new Date('2026-11-13T10:05:00Z'),
};
/** The Support agent's own bot (TASK-1167), live: Grace asked for it and allowed it. */
const OWN_BOT: InstallRow = {
  ...INSTALL,
  installId: 'Hb7Kq2Lw8vNc5Xr1Bm7KdA',
  kind: 'bot',
  appId: 'A07HELPER01',
  botName: 'Support Helper',
  botUserId: 'U07HELPER01',
  connectedByUserId: 'usr_grace',
  agentId: 'agt_support',
  requestedByUserId: 'usr_grace',
  botHandle: 'supporthelper',
};
/** The same bot before its Allow. */
const PENDING_BOT: InstallRow = {
  ...OWN_BOT,
  status: 'pending',
  teamId: null,
  teamName: null,
  botUserId: null,
  installedAt: null,
  botHandle: null,
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

interface TestUser {
  id: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
}
const person = (id: string, displayName: string | null, isAdmin = false): TestUser => ({
  id,
  displayName,
  email: `${id.slice(4)}@canopyworks.example`,
  isAdmin,
});
const ADA = person('usr_ada', 'Ada Admin'); // a team admin of the support team
const GRACE = person('usr_grace', 'Grace Hopper'); // another team admin of the support team
const NONAME = person('usr_noname', null); // a team admin of the support team with no display name
const MEL = person('usr_mel', 'Mel Member'); // a plain member of the support team
const WILL = person('usr_will', 'Will Wsadmin', true); // a workspace admin, and a plain member of the support team
const WANDA = person('usr_wanda', 'Wanda Wsadmin', true); // a workspace admin in no team
const OTTO = person('usr_otto', 'Otto Outsider'); // in no team
const PAT = person('usr_pat', 'Pat Personal'); // owns a personal agent
const SAM = person('usr_sam', 'Sam Sales'); // a team admin of the sales team
const USERS = [ADA, GRACE, NONAME, MEL, WILL, WANDA, OTTO, PAT, SAM];

const SUPPORT_CH = 'C07SUPPORT1';
const SALES_CH = 'C07SALES002';
const PRIVATE_CH = 'C07PRIVATE1';
const ARCHIVED_CH = 'C07ARCHIVE1';
const SHARED_CH = 'C07SHARED01';
const PENDING_CH = 'C07PENDING1';
const NAMES: Record<string, string> = {
  [SUPPORT_CH]: 'support-desk',
  [SALES_CH]: 'sales-floor',
  [PRIVATE_CH]: 'secret-plans',
  [ARCHIVED_CH]: 'old-news',
  [SHARED_CH]: 'partner-room',
  [PENDING_CH]: 'soon-partners',
};

/**
 * A channel as conversations.info and conversations.list describe it
 * (Slack's documented example's fields), with no `is_member`: Slack's
 * documented answer often leaves it out, which reads as "not a member".
 */
function rawChannel(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const name = NAMES[id] ?? id.toLowerCase();
  return {
    id,
    name,
    is_channel: true,
    is_group: false,
    is_im: false,
    is_mpim: false,
    is_private: false,
    created: 1654868334,
    is_archived: false,
    is_general: false,
    unlinked: 0,
    name_normalized: name,
    is_shared: false,
    is_frozen: false,
    is_org_shared: false,
    is_ext_shared: false,
    is_pending_ext_shared: false,
    pending_shared: [],
    context_team_id: TEAM_ID,
    parent_conversation: null,
    creator: 'U07CREATOR1',
    shared_team_ids: [TEAM_ID],
    pending_connected_team_ids: [],
    topic: { value: '', creator: '', last_set: 0 },
    purpose: { value: '', creator: '', last_set: 0 },
    previous_names: [],
    ...over,
  };
}

// ── A fake Slack Web API behind the real client's fetchImpl ─────────────────

function fakeSlackWeb() {
  const channels = new Map<string, Record<string, unknown>>();
  /** The channels the bot is in. */
  const joined = new Set<string>();
  const sent: Array<{ method: string; form: Record<string, string>; authorization: string | null }> = [];
  /** A method listed here answers this instead. */
  const overrides = new Map<string, () => Response>();
  /** conversations.list: channels per page, whatever `limit` asks for. */
  let pageSize = 1000;

  const answer = (body: Record<string, unknown>): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const ok = (fields: Record<string, unknown> = {}): Response => answer({ ok: true, ...fields });
  const refuse = (error: string): Response => answer({ ok: false, error });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = url.pathname.replace(/^\/api\//, '');
    const form = Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
    sent.push({ method, form, authorization: new Headers(init?.headers).get('authorization') });
    const custom = overrides.get(method);
    if (custom !== undefined) return custom();
    const id = form['channel'] ?? '';
    switch (method) {
      case 'conversations.info': {
        const found = channels.get(id);
        return found === undefined ? refuse('channel_not_found') : ok({ channel: found });
      }
      case 'conversations.list': {
        const all = [...channels.values()];
        const start = form['cursor'] === undefined ? 0 : Number(form['cursor'].slice(1));
        const end = start + pageSize;
        return ok({
          channels: all.slice(start, end),
          response_metadata: { next_cursor: end < all.length ? `p${end}` : '' },
        });
      }
      case 'conversations.join': {
        const found = channels.get(id);
        if (found === undefined) return refuse('channel_not_found');
        if (found['is_archived'] === true) return refuse('is_archived');
        if (found['is_private'] === true) return refuse('method_not_supported_for_channel_type');
        const already = joined.has(id);
        joined.add(id);
        return ok({
          channel: found,
          ...(already ? { warning: 'already_in_channel', response_metadata: { warnings: ['already_in_channel'] } } : {}),
        });
      }
      default:
        return refuse('unknown_method');
    }
  }) as typeof fetch;

  return {
    fetchImpl,
    channels,
    joined,
    sent,
    overrides,
    refuse,
    setPageSize(n: number): void {
      pageSize = n;
    },
    methods: (): string[] => sent.map((s) => s.method),
  };
}

// ── A request and response shaped like @ax/http-server's ───────────────────

interface Answered {
  status: number;
  how: 'json' | 'text' | 'end' | 'redirect' | null;
  body: unknown;
  headers: Record<string, string>;
}

function fakeResponse(): { res: RouteResponse; answer: Answered } {
  const answer: Answered = { status: 200, how: null, body: undefined, headers: {} };
  const finish = (how: NonNullable<Answered['how']>, body?: unknown): void => {
    if (answer.how !== null) throw new Error('response already finished');
    answer.how = how;
    answer.body = body;
  };
  const res: RouteResponse = {
    status(n) {
      answer.status = n;
      return res;
    },
    header(name, value) {
      answer.headers[name.toLowerCase()] = value;
      return res;
    },
    json: (v) => finish('json', v),
    text: (s) => finish('text', s),
    end: () => finish('end'),
    redirect: () => finish('redirect'),
  };
  return { res, answer };
}

type Suffix =
  | ''
  | '/available'
  | '/connect'
  | '/disconnect'
  | '/remember'
  | '/bot'
  | '/bot/install-url'
  | '/bot/cancel'
  | '/bot/disconnect';

/** Every route, with a body each write would accept. */
const EVERY_ROUTE: Array<{ method: 'GET' | 'POST'; suffix: Suffix; body?: unknown }> = [
  { method: 'GET', suffix: '' },
  { method: 'GET', suffix: '/available' },
  { method: 'POST', suffix: '/connect', body: { channelId: SUPPORT_CH } },
  { method: 'POST', suffix: '/disconnect', body: { channelId: SUPPORT_CH } },
  { method: 'POST', suffix: '/remember', body: { channelId: SUPPORT_CH, remember: false } },
  { method: 'POST', suffix: '/bot', body: { botName: 'Support Helper' } },
  { method: 'POST', suffix: '/bot/install-url' },
  { method: 'POST', suffix: '/bot/cancel' },
  { method: 'POST', suffix: '/bot/disconnect', body: { installId: OWN_BOT.installId } },
];
const WRITES = EVERY_ROUTE.filter((r) => r.suffix !== '');

/** A token pasted into the bot form's refresh-token field, and one of the wrong kind. */
const REFRESH = fakeConfigRefreshToken('ROUTESREFRESHSECRET');
const ACCESS = fakeConfigAccessToken('ROUTESACCESSSECRET');
/** What the bot domain answers for an agent with no bot and a viewer with no token. */
const NO_BOT: AgentSlackBot = { state: 'none', configTokenStored: false };

// ── The bot domain, as a stub ───────────────────────────────────────────────

/**
 * bots.ts behind the routes, as a stub: each call is recorded (its ctx as the
 * person it acts for), and answers what the test set. `fail` makes every call
 * throw. The routes' own job is who gets through, and what they hand on.
 */
function stubBots() {
  const calls: Array<{
    method: 'request' | 'installUrl' | 'cancel' | 'disconnect' | 'status';
    input: Record<string, unknown>;
  }> = [];
  const answers: {
    request: BotReply;
    installUrl: BotReply;
    cancel: BotReply;
    disconnect: BotReply;
    status: AgentSlackBot;
  } = {
    request: { status: 200, body: { installUrl: 'https://slack.com/oauth/v2/authorize?state=first', iconSet: true } },
    installUrl: { status: 200, body: { installUrl: 'https://slack.com/oauth/v2/authorize?state=again' } },
    cancel: { status: 200, body: { appDeleted: true } },
    disconnect: { status: 200, body: { appDeleted: true } },
    status: NO_BOT,
  };
  const state: { fail: unknown } = { fail: undefined };
  const enter = (method: (typeof calls)[number]['method'], input: object): void => {
    const { ctx, ...rest } = input as { ctx?: { userId: string } } & Record<string, unknown>;
    calls.push({ method, input: ctx === undefined ? rest : { ctxUserId: ctx.userId, ...rest } });
    if (state.fail !== undefined) throw state.fail;
  };
  const bots: Pick<Bots, 'request' | 'installUrl' | 'cancel' | 'disconnect' | 'status'> = {
    request: async (i) => {
      enter('request', i);
      return answers.request;
    },
    installUrl: async (i) => {
      enter('installUrl', i);
      return answers.installUrl;
    },
    cancel: async (i) => {
      enter('cancel', i);
      return answers.cancel;
    },
    disconnect: async (i) => {
      enter('disconnect', i);
      return answers.disconnect;
    },
    status: async (i) => {
      enter('status', i);
      return answers.status;
    },
  };
  return { bots, calls, answers, state };
}

// ── The routes' surroundings ────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function world(o: { workspaceAdminsMayManage?: boolean; authFault?: Error; getUserFault?: Error } = {}) {
  const bus = new HookBus();
  const people = fakeAgents(bus, o.workspaceAdminsMayManage === true ? { workspaceAdminsMayManage: true } : {});
  for (const agent of [SUPPORT, SALES, PATS]) people.addAgent(agent);
  for (const admin of [ADA, GRACE, NONAME]) people.setRole(SUPPORT_TEAM, admin.id, 'admin');
  for (const member of [MEL, WILL]) people.setRole(SUPPORT_TEAM, member.id, 'member');
  people.setRole(SALES_TEAM, SAM.id, 'admin');

  // Auth's accounts, by id: a test may rename or delete one.
  const users = new Map(USERS.map((u) => [u.id, { ...u }]));
  const userLookups: string[] = [];
  bus.registerService('auth:require-user', '@ax/auth-better', async (_ctx, raw) => {
    if (o.authFault !== undefined) throw o.authFault;
    const { req } = raw as { req: RouteRequest };
    const user = users.get(String(req.headers['x-test-user']));
    if (user === undefined) {
      throw new PluginError({ code: 'unauthenticated', plugin: '@ax/auth-better', message: 'no session' });
    }
    return { user: { ...user } };
  });
  bus.registerService('auth:get-user', '@ax/auth-better', async (_ctx, raw) => {
    const { userId } = raw as { userId: string };
    userLookups.push(userId);
    if (o.getUserFault !== undefined) throw o.getUserFault;
    const user = users.get(userId);
    return user === undefined ? null : { ...user };
  });

  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const slack = fakeSlackWeb();
  for (const id of [SUPPORT_CH, SALES_CH]) slack.channels.set(id, rawChannel(id));
  slack.channels.set(PRIVATE_CH, rawChannel(PRIVATE_CH, { is_channel: false, is_group: true, is_private: true }));
  slack.channels.set(ARCHIVED_CH, rawChannel(ARCHIVED_CH, { is_archived: true }));
  slack.channels.set(SHARED_CH, rawChannel(SHARED_CH, { is_shared: true, is_ext_shared: true }));
  slack.channels.set(PENDING_CH, rawChannel(PENDING_CH, { is_pending_ext_shared: true }));

  const memory = memoryChannelStore();
  const state = {
    install: { ...INSTALL } as InstallRow | null,
    /** The agent's own bot (store.ts `botForAgent`, any status): none unless a test sets one. */
    bot: null as InstallRow | null,
    botFault: undefined as unknown,
  };
  /** The agents `botForAgent` was asked about, in order. */
  const botLookups: string[] = [];
  const deps: ChannelDeps = {
    bus,
    installs: {
      current: async () => (state.install === null ? null : { ...state.install }),
      botForAgent: async (agentId) => {
        botLookups.push(agentId);
        if (state.botFault !== undefined) throw state.botFault;
        return state.bot !== null && state.bot.agentId === agentId ? { ...state.bot } : null;
      },
    },
    channels: memory.store,
    secrets: { get: async (_owner, name) => (name === 'bot-token' ? BOT_TOKEN : null) },
    api: createSlackApi({ fetchImpl: slack.fetchImpl }),
    logger,
  };
  const bots = stubBots();
  const routes = createAgentSlackRoutes(deps, bots.bots);

  async function call(
    method: 'GET' | 'POST',
    suffix: Suffix,
    agentId: string,
    as: TestUser | null,
    body?: unknown,
  ): Promise<Answered> {
    const pattern = `/settings/slack/:agentId${suffix}`;
    const spec = routes.find((r) => r.method === method && r.path === pattern);
    if (spec === undefined) throw new Error(`no route ${method} ${pattern}`);
    const path = `/settings/slack/${encodeURIComponent(agentId)}${suffix}`;
    const raw =
      body === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req: RouteRequest = {
      method,
      path,
      rawPath: path,
      params: { agentId },
      query: {},
      headers: { 'content-type': 'application/json', ...(as !== null ? { 'x-test-user': as.id } : {}) },
      body: raw,
    };
    const { res, answer } = fakeResponse();
    await spec.handler(req, res);
    if (answer.how === null) throw new Error(`${method} ${path} never answered`);
    return answer;
  }

  /** Status and body only. */
  const reply = async (p: Promise<Answered>): Promise<{ status: number; body: unknown }> => {
    const a = await p;
    return { status: a.status, body: a.body };
  };

  return {
    bus,
    people,
    users,
    userLookups,
    slack,
    memory,
    state,
    botLookups,
    lines,
    routes,
    bots,
    call,
    status: (agentId: string, as: TestUser | null = ADA) => reply(call('GET', '', agentId, as)),
    available: (agentId: string, as: TestUser | null = ADA) => reply(call('GET', '/available', agentId, as)),
    connect: (agentId: string, channelId: string, as: TestUser | null = ADA) =>
      reply(call('POST', '/connect', agentId, as, { channelId })),
    disconnect: (agentId: string, channelId: string, as: TestUser | null = ADA) =>
      reply(call('POST', '/disconnect', agentId, as, { channelId })),
    remember: (agentId: string, channelId: string, remember: unknown, as: TestUser | null = ADA) =>
      reply(call('POST', '/remember', agentId, as, { channelId, remember })),
    requestBot: (agentId: string, body: unknown, as: TestUser | null = ADA) =>
      reply(call('POST', '/bot', agentId, as, body)),
  };
}

const NOT_FOUND = { status: 404, body: { error: 'not-found' } };
const FORBIDDEN = { status: 403, body: { error: 'forbidden' } };

// ── The routes themselves ───────────────────────────────────────────────────

describe('the routes', () => {
  it('serves the section under /settings/slack/:agentId; the writes cap their bodies and keep the CSRF check', () => {
    const w = world();
    expect(
      w.routes.map((r) => ({ method: r.method, path: r.path, bypassCsrf: r.bypassCsrf, maxBodyBytes: r.maxBodyBytes })),
    ).toEqual([
      { method: 'GET', path: '/settings/slack/:agentId', bypassCsrf: undefined, maxBodyBytes: undefined },
      { method: 'GET', path: '/settings/slack/:agentId/available', bypassCsrf: undefined, maxBodyBytes: undefined },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/connect',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/disconnect',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/remember',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      // The agent's own bot (TASK-1167): its request can carry the bot's picture, as Admin › Slack's Connect can.
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES,
      },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot/install-url',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot/cancel',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      // Disconnect the agent's own bot, pending or live (TASK-1172): its body is the install id the page showed.
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot/disconnect',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
    ]);
    for (const r of w.routes) expect(r).not.toHaveProperty('bypassCsrf');
  });
});

// ── Who may do what ─────────────────────────────────────────────────────────

describe('rights', () => {
  it('refuses a signed-out request with 401 on every route, before anything else is asked', async () => {
    const w = world();
    for (const r of EVERY_ROUTE) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, null, r.body);
      expect({ status: a.status, body: a.body }, `${r.method} ${r.suffix}`).toEqual({
        status: 401,
        body: { error: 'unauthenticated' },
      });
    }
    expect(w.people.calls).toEqual([]);
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
    expect(w.bots.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('answers an auth fault with 500 on every route, logged by code alone', async () => {
    const w = world({
      authFault: new PluginError({ code: 'session-store-down', plugin: '@ax/auth-better', message: 'ada@x' }),
    });
    for (const r of EVERY_ROUTE) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, ADA, r.body);
      expect({ status: a.status, body: a.body }).toEqual({ status: 500, body: { error: 'internal' } });
    }
    expect(w.lines).toHaveLength(EVERY_ROUTE.length);
    for (const line of w.lines) {
      expect(line).toEqual({
        level: 'error',
        msg: 'slack_channel_route_failed',
        fields: { stage: 'auth', code: 'session-store-down' },
      });
    }
    expect(w.people.calls).toEqual([]);
  });

  it('gives someone outside the team, a workspace admin outside it, and a missing agent the same 404 everywhere', async () => {
    const w = world();
    for (const r of EVERY_ROUTE) {
      const missing = await w.call(r.method, r.suffix, 'agt_gone', ADA, r.body);
      expect({ status: missing.status, body: missing.body }).toEqual(NOT_FOUND);
      // The whole answer, headers too: nothing tells "exists" from "doesn't".
      expect(await w.call(r.method, r.suffix, SUPPORT.id, OTTO, r.body), `${r.suffix} outsider`).toEqual(missing);
      expect(await w.call(r.method, r.suffix, SUPPORT.id, WANDA, r.body), `${r.suffix} workspace admin`).toEqual(
        missing,
      );
      expect(await w.call(r.method, r.suffix, SUPPORT.id, SAM, r.body), `${r.suffix} other team's admin`).toEqual(
        missing,
      );
    }
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
    expect(w.bots.calls).toEqual([]);
  });

  it('lets a team member read the section without the manage controls, and refuses every write with 403', async () => {
    const w = world();
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toMatchObject({ status: 200 });
    const sent = w.slack.sent.length;
    const before = w.memory.row(INSTALL_ID, SUPPORT_CH);

    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({ status: 200, body: { state: 'ready', canManage: false } });
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, MEL, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual(FORBIDDEN);
    }
    expect(w.slack.sent).toHaveLength(sent);
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toEqual(before);
    // The section read the bot as a non-manager; no write reached the bot domain.
    expect(w.bots.calls.map((c) => c.method)).toEqual(['status']);
  });

  it.each([
    ['an empty object', {}],
    ['allowed as a string', { allowed: 'true' }],
    ['null', null],
  ])('answers 403 on every write, and Slack is asked nothing, when agents answers the manage question with %s', async (_what, answer) => {
    const w = world();
    w.people.answers.set('agents:can-set-shared-credential', answer);
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, ADA, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual(FORBIDDEN);
    }
    const a = await w.call('GET', '/available', SUPPORT.id, ADA);
    expect({ status: a.status, body: a.body }).toEqual(FORBIDDEN);
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
    expect(w.bots.calls).toEqual([]);
    // The section itself still reads, without the manage controls.
    expect(await w.status(SUPPORT.id, ADA)).toMatchObject({ status: 200, body: { state: 'ready', canManage: false } });
  });

  it('never reads a body for someone without rights: a bad or oversized body is the rights answer, not a 400 or 413', async () => {
    const w = world();
    const garbage = 'garbage';
    const oversized = Buffer.from(JSON.stringify({ channelId: SUPPORT_CH, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) }));
    const arrayBody = JSON.stringify([SUPPORT_CH]);
    const extraKey = JSON.stringify({ channelId: SUPPORT_CH, agentId: SALES.id });
    for (const suffix of ['/connect', '/disconnect', '/remember', '/bot', '/bot/disconnect'] as const) {
      for (const body of [garbage, oversized, arrayBody, extraKey]) {
        const label = `${suffix} ${typeof body === 'string' ? body : 'oversized'}`;
        // Not a member of the team (or a workspace admin outside it): as unknown as a missing agent.
        for (const outsider of [OTTO, WANDA]) {
          const a = await w.call('POST', suffix, SUPPORT.id, outsider, body);
          expect({ status: a.status, body: a.body }, `${label} ${outsider.id}`).toEqual(NOT_FOUND);
        }
        // A plain team member can see the agent but not manage it.
        const m = await w.call('POST', suffix, SUPPORT.id, MEL, body);
        expect({ status: m.status, body: m.body }, `${label} member`).toEqual(FORBIDDEN);
        // A personal agent's owner learns it is one, not that the body is bad.
        const p = await w.call('POST', suffix, PATS.id, PAT, body);
        expect({ status: p.status, body: p.body }, `${label} personal`).toEqual({
          status: 409,
          body: { error: 'personal-agent' },
        });
      }
    }
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
    expect(w.bots.calls).toEqual([]);
  });

  it('treats a workspace admin who is a plain member of the team as a member: asked as a non-admin, 403 on writes', async () => {
    // Even under an agents rule that WOULD let a workspace admin through.
    const w = world({ workspaceAdminsMayManage: true });
    expect(await w.status(SUPPORT.id, WILL)).toMatchObject({ status: 200, body: { canManage: false } });
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, WILL, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual(FORBIDDEN);
    }
    const asked = w.people.inputs('agents:can-set-shared-credential');
    expect(asked.length).toBeGreaterThan(0);
    for (const input of asked) expect(input).toEqual({ agentId: SUPPORT.id, actor: { userId: WILL.id, isAdmin: false } });
    expect(w.slack.sent).toEqual([]);
    expect(w.bots.calls.map((c) => c.method)).toEqual(['status']);
  });

  it("lets a team admin of the agent's team manage it", async () => {
    const w = world();
    expect(await w.status(SUPPORT.id, ADA)).toMatchObject({ status: 200, body: { state: 'ready', canManage: true } });
    expect(await w.available(SUPPORT.id, ADA)).toMatchObject({ status: 200 });
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toMatchObject({ status: 200 });
    expect(await w.remember(SUPPORT.id, SUPPORT_CH, false, ADA)).toEqual({ status: 200, body: {} });
    expect(await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 200, body: { removed: true } });
  });

  it('says a personal agent is one, and refuses every write with 409 personal-agent before Slack is asked anything', async () => {
    const w = world();
    expect(await w.status(PATS.id, PAT)).toEqual({
      status: 200,
      body: { state: 'personal-agent', botName: 'canopy-works', answersDms: true },
    });
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, PATS.id, PAT, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual({ status: 409, body: { error: 'personal-agent' } });
    }
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
    // A personal agent has no bot of its own: none is asked about.
    expect(w.bots.calls).toEqual([]);
    // Someone else's personal agent is as unknown as a missing one.
    expect(await w.status(PATS.id, ADA)).toEqual(NOT_FOUND);
  });

  it("says whether a personal agent is the one its owner's DMs reach: the oldest, never naming another", async () => {
    const w = world();
    // PATS is Pat's first personal agent; this one came later.
    const later: FakeAgent = {
      id: 'agt_pat_later',
      displayName: 'Pat later',
      visibility: 'personal',
      ownerType: 'user',
      ownerId: PAT.id,
      createdAt: new Date('2026-10-02T00:00:00.000Z'),
    };
    w.people.agents.set(PATS.id, { ...PATS, createdAt: new Date('2026-10-01T00:00:00.000Z') });
    w.people.addAgent(later);

    expect(await w.status(PATS.id, PAT)).toEqual({
      status: 200,
      body: { state: 'personal-agent', botName: 'canopy-works', answersDms: true },
    });
    // Exactly three keys: the agent a DM does reach is never named.
    expect(await w.status(later.id, PAT)).toEqual({
      status: 200,
      body: { state: 'personal-agent', botName: 'canopy-works', answersDms: false },
    });
    // The same question the DM router asks: Pat's own agents, no teams.
    expect(w.people.inputs('agents:list-for-user')).toEqual([
      { userId: PAT.id, teamIds: [] },
      { userId: PAT.id, teamIds: [] },
    ]);
    // Slack is asked nothing to answer it.
    expect(w.slack.sent).toEqual([]);
  });

  it('answers an agent id no agent could have with 404, without asking agents', async () => {
    const w = world();
    for (const agentId of ['x'.repeat(129), 'agt support', 'agt\nsupport', `agt${String.fromCharCode(0x202e)}x`]) {
      for (const r of EVERY_ROUTE) {
        const a = await w.call(r.method, r.suffix, agentId, ADA, r.body);
        expect({ status: a.status, body: a.body }, JSON.stringify(agentId)).toEqual(NOT_FOUND);
      }
    }
    expect(w.people.calls).toEqual([]);
  });
});

// ── GET /settings/slack/:agentId ────────────────────────────────────────────

describe('the section', () => {
  it('says no-workspace to anyone who can see the agent while Slack is not connected (or not finished)', async () => {
    for (const install of [null, { ...INSTALL, status: 'pending' as const, teamId: null, teamName: null }]) {
      const w = world();
      w.state.install = install;
      for (const [agentId, as, canManage] of [
        [SUPPORT.id, ADA, true],
        [SUPPORT.id, MEL, false],
        [PATS.id, PAT, false],
      ] as const) {
        expect(await w.status(agentId, as)).toEqual({
          status: 200,
          body: { state: 'no-workspace', canManage, bot: { state: 'none', configTokenStored: false } },
        });
      }
      // Still nothing for someone who can't see it.
      expect(await w.status(SUPPORT.id, OTTO)).toEqual(NOT_FOUND);
    }
  });

  it('no-workspace says whether the person reading manages the agent: a team admin true, a member false, a personal agent false', async () => {
    const noWorkspace = (canManage: boolean) => ({ status: 200, body: { state: 'no-workspace', canManage, bot: NO_BOT } });
    // Even under an agents rule that WOULD let a workspace admin through.
    const w = world({ workspaceAdminsMayManage: true });
    w.state.install = null;
    expect(await w.status(SUPPORT.id, ADA)).toEqual(noWorkspace(true));
    expect(await w.status(SUPPORT.id, GRACE)).toEqual(noWorkspace(true));
    expect(await w.status(SUPPORT.id, MEL)).toEqual(noWorkspace(false));
    // A workspace admin who is a plain member of the team is a member here too.
    expect(await w.status(SUPPORT.id, WILL)).toEqual(noWorkspace(false));
    expect(await w.status(PATS.id, PAT)).toEqual(noWorkspace(false));
    // The manage question the writes ask, as a non-admin.
    expect(w.people.inputs('agents:can-set-shared-credential')).toContainEqual({
      agentId: SUPPORT.id,
      actor: { userId: WILL.id, isAdmin: false },
    });

    // A manage answer that isn't one reads as not managing, never as a manager.
    const junk = world();
    junk.state.install = null;
    junk.people.answers.set('agents:can-set-shared-credential', { allowed: 'true' });
    expect(await junk.status(SUPPORT.id, ADA)).toEqual(noWorkspace(false));
  });

  it('no-workspace with a live bot: a team admin reads canManage true, so the bot can still be disconnected after Slack is', async () => {
    const w = world();
    // As the domain answers a manager: with the install id its Disconnect takes. A member gets null.
    const live: AgentSlackBot = {
      state: 'live',
      botName: 'Support Helper',
      handle: 'supporthelper',
      approver: 'Grace Hopper',
      needsClaim: false,
      installId: OWN_BOT.installId,
    };
    w.bots.answers.status = live;
    // Admin › Slack disconnected the shared app; the agent's own bot stayed.
    w.state.install = null;
    expect(await w.status(SUPPORT.id, ADA)).toEqual({
      status: 200,
      body: { state: 'no-workspace', canManage: true, bot: live },
    });
    w.bots.answers.status = { ...live, installId: null };
    expect(await w.status(SUPPORT.id, MEL)).toEqual({
      status: 200,
      body: { state: 'no-workspace', canManage: false, bot: { ...live, installId: null } },
    });
    // ...and the Disconnect that offers needs no shared app: it reaches the domain.
    const a = await w.call('POST', '/bot/disconnect', SUPPORT.id, ADA, { installId: OWN_BOT.installId });
    expect({ status: a.status, body: a.body }).toEqual({ status: 200, body: { appDeleted: true } });
    expect(w.bots.calls.at(-1)).toEqual({
      method: 'disconnect',
      input: { ctxUserId: ADA.id, actorUserId: ADA.id, agentId: SUPPORT.id, installId: OWN_BOT.installId },
    });
  });

  it("lists the agent's channels, oldest first, with who connected each and its memory switch", async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SUPPORT.id, SALES_CH, GRACE);
    await w.remember(SUPPORT.id, SALES_CH, false, GRACE);
    // Another agent's channel is not this agent's business.
    w.slack.channels.set('C07OTHER001', rawChannel('C07OTHER001'));
    await w.connect(SALES.id, 'C07OTHER001', SAM);

    expect(await w.status(SUPPORT.id, MEL)).toEqual({
      status: 200,
      body: {
        state: 'ready',
        botName: 'canopy-works',
        workspaceName: 'Canopy Works',
        canManage: false,
        channels: [
          { channelId: SUPPORT_CH, name: 'support-desk', remember: true, connectedBy: 'Ada Admin', needsReconnect: false, needsInvite: false },
          { channelId: SALES_CH, name: 'sales-floor', remember: false, connectedBy: 'Grace Hopper', needsReconnect: false, needsInvite: false },
        ],
        bot: { state: 'none', configTokenStored: false },
      },
    });
  });

  it('never shows the connector\'s email: no display name, a deleted account or an auth fault all read "A teammate"', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, NONAME);
    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({ body: { channels: [{ connectedBy: 'A teammate' }] } });

    // Only invisible characters left once cleaned.
    w.users.get(NONAME.id)!.displayName = `${String.fromCharCode(0x202e)}${String.fromCharCode(0x200b)}`;
    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({ body: { channels: [{ connectedBy: 'A teammate' }] } });

    w.users.delete(NONAME.id);
    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({ body: { channels: [{ connectedBy: 'A teammate' }] } });
    expect(w.lines.filter((l) => l.msg === 'slack_channel_route_failed')).toEqual([]);

    const faulty = world({
      getUserFault: new PluginError({ code: 'db-down', plugin: '@ax/auth-better', message: NONAME.email! }),
    });
    await faulty.connect(SUPPORT.id, SUPPORT_CH, ADA);
    const shown = await faulty.status(SUPPORT.id, MEL);
    expect(shown).toMatchObject({ status: 200, body: { channels: [{ connectedBy: 'A teammate' }] } });
    expect(faulty.lines.filter((l) => l.msg === 'slack_channel_route_failed')).toContainEqual({
      level: 'warn',
      msg: 'slack_channel_route_failed',
      fields: { stage: 'connected-by', code: 'db-down' },
    });
    expect(JSON.stringify([shown, faulty.lines])).not.toMatch(/@canopyworks\.example/);
  });

  it('marks a channel needsReconnect once the person who connected it loses the agent', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SUPPORT.id, SALES_CH, GRACE);
    // Ada leaves the support team; Grace stays.
    w.people.setRole(SUPPORT_TEAM, ADA.id, null);

    expect(await w.status(SUPPORT.id, GRACE)).toMatchObject({
      status: 200,
      body: {
        channels: [
          { channelId: SUPPORT_CH, connectedBy: 'Ada Admin', needsReconnect: true },
          { channelId: SALES_CH, connectedBy: 'Grace Hopper', needsReconnect: false },
        ],
      },
    });
    // Asked about the connector, not about whoever is reading the page.
    expect(w.people.inputs('agents:resolve')).toContainEqual({ agentId: SUPPORT.id, userId: ADA.id });
  });

  describe("with the agent's own bot (TASK-1168)", () => {
    /** As a member reads it: no install id (only those who manage the agent get one, for its Disconnect). */
    const LIVE: AgentSlackBot = {
      state: 'live',
      botName: 'Support Helper',
      handle: 'supporthelper',
      approver: 'Grace Hopper',
      needsClaim: false,
      installId: null,
    };
    const channelIds = async (w: ReturnType<typeof world>): Promise<string[]> => {
      const got = await w.status(SUPPORT.id, MEL);
      return (got.body as { channels: Array<{ channelId: string }> }).channels.map((c) => c.channelId);
    };

    it("with its own bot live, lists the shared channels it hasn't answered in yet, each needsInvite and never needsReconnect; one it has answered in leaves the list, and its shared binding stays", async () => {
      const w = world();
      // Connected first: a connect is refused once the bot is live, so this is what really happens.
      await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
      await w.connect(SUPPORT.id, SALES_CH, GRACE);
      w.state.bot = OWN_BOT;
      w.bots.answers.status = LIVE;

      expect(await w.status(SUPPORT.id, MEL)).toEqual({
        status: 200,
        body: {
          state: 'ready',
          botName: 'canopy-works',
          workspaceName: 'Canopy Works',
          canManage: false,
          channels: [
            { channelId: SUPPORT_CH, name: 'support-desk', remember: true, connectedBy: 'Ada Admin', needsReconnect: false, needsInvite: true },
            { channelId: SALES_CH, name: 'sales-floor', remember: true, connectedBy: 'Grace Hopper', needsReconnect: false, needsInvite: true },
          ],
          bot: LIVE,
        },
      });

      // The bot's first mention in a channel binds it on the bot's own install (router.ts).
      await w.memory.store.upsert({
        installId: OWN_BOT.installId,
        channelId: SUPPORT_CH,
        agentId: SUPPORT.id,
        connectedByUserId: 'usr_grace',
        channelName: 'support-desk',
      });
      expect(await channelIds(w)).toEqual([SALES_CH]);
      // Off the list, not deleted: the shared binding is exactly as it was.
      expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SUPPORT.id, connectedByUserId: ADA.id });
    });

    it('a pending bot, no bot, or a live answer whose bot is gone by the route\'s own read: every row needsInvite false', async () => {
      const pairs: Array<[InstallRow | null, AgentSlackBot]> = [
        [
          PENDING_BOT,
          {
            state: 'pending',
            botName: 'Support Helper',
            approver: 'Grace Hopper',
            canContinue: false,
            installId: PENDING_BOT.installId,
          },
        ],
        [null, { state: 'none', configTokenStored: false }],
        [null, LIVE],
      ];
      for (const [bot, answer] of pairs) {
        const w = world();
        await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
        await w.connect(SUPPORT.id, SALES_CH, GRACE);
        w.state.bot = bot;
        w.bots.answers.status = answer;
        const got = await w.status(SUPPORT.id, MEL);
        const rows = (got.body as { channels: Array<{ needsInvite: boolean }> }).channels;
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.needsInvite)).toEqual([false, false]);
      }
    });

    it("a channel waiting for the bot doesn't ask agents about its connector: no outsider runs as them while the bot is live", async () => {
      const w = world();
      await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
      w.people.setRole(SUPPORT_TEAM, ADA.id, null);
      const before = w.people.inputs('agents:resolve').length;
      w.state.bot = OWN_BOT;
      w.bots.answers.status = LIVE;

      expect(await w.status(SUPPORT.id, GRACE)).toMatchObject({
        status: 200,
        body: { channels: [{ channelId: SUPPORT_CH, needsReconnect: false, needsInvite: true }] },
      });
      expect(w.people.inputs('agents:resolve').slice(before)).not.toContainEqual({ agentId: SUPPORT.id, userId: ADA.id });
    });

    it("a store fault reading the agent's own bot (botForAgent) is the route's 500, logged by code alone", async () => {
      const w = world();
      w.state.bot = OWN_BOT;
      w.bots.answers.status = LIVE;
      w.state.botFault = Object.assign(new Error(`relation gone ${SUPPORT_CH}`), { code: '42P01' });
      expect(await w.status(SUPPORT.id, ADA)).toEqual({ status: 500, body: { error: 'internal' } });
      expect(w.lines).toContainEqual({
        level: 'error',
        msg: 'slack_channel_route_failed',
        fields: { stage: 'status', code: '42P01' },
      });
      expect(JSON.stringify(w.lines)).not.toContain(SUPPORT_CH);
    });

    it("a store fault reading the bot's channels (listForAgent on its install) is the route's 500, logged by code alone", async () => {
      const w = world();
      w.state.bot = OWN_BOT;
      w.bots.answers.status = LIVE;
      // Only the bot's install faults: the shared install's read, and the bot lookup itself, work.
      const listForAgent = w.memory.store.listForAgent.bind(w.memory.store);
      w.memory.store.listForAgent = async (installId, agentId) => {
        if (installId === OWN_BOT.installId) {
          throw Object.assign(new Error(`relation gone ${SUPPORT_CH}`), { code: '42P01' });
        }
        return listForAgent(installId, agentId);
      };
      expect(await w.status(SUPPORT.id, ADA)).toEqual({ status: 500, body: { error: 'internal' } });
      expect(w.lines).toContainEqual({
        level: 'error',
        msg: 'slack_channel_route_failed',
        fields: { stage: 'status', code: '42P01' },
      });
      expect(JSON.stringify(w.lines)).not.toContain(SUPPORT_CH);
    });
  });

  it('answers 500, logged by code alone, when the store fails', async () => {
    const w = world();
    w.memory.store.listForAgent = async () => {
      throw Object.assign(new Error(`relation gone ${SUPPORT_CH}`), { code: '42P01' });
    };
    expect(await w.status(SUPPORT.id, ADA)).toEqual({ status: 500, body: { error: 'internal' } });
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'status', code: '42P01' } },
    ]);
  });
});

// ── POST …/connect ──────────────────────────────────────────────────────────

describe('connect', () => {
  it('connects a channel for a team admin: Slack is asked about it, the bot joins, and the row comes back', async () => {
    const w = world();
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({
      status: 200,
      body: {
        channel: { channelId: SUPPORT_CH, name: 'support-desk', remember: true, connectedBy: 'Ada Admin', needsReconnect: false, needsInvite: false },
        reconnected: false,
      },
    });
    expect(w.slack.sent).toEqual([
      { method: 'conversations.info', form: { channel: SUPPORT_CH }, authorization: `Bearer ${BOT_TOKEN}` },
      { method: 'conversations.join', form: { channel: SUPPORT_CH }, authorization: `Bearer ${BOT_TOKEN}` },
    ]);
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SUPPORT.id, connectedByUserId: ADA.id });
  });

  it("takes Slack's already_in_channel as a success (its info answer left is_member out)", async () => {
    const w = world();
    w.slack.joined.add(SUPPORT_CH);
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toMatchObject({ status: 200, body: { reconnected: false } });
    expect(w.slack.methods()).toEqual(['conversations.info', 'conversations.join']);
  });

  it('does not join a channel Slack says the bot is in', async () => {
    const w = world();
    w.slack.channels.set(SUPPORT_CH, rawChannel(SUPPORT_CH, { is_member: true }));
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toMatchObject({ status: 200 });
    expect(w.slack.methods()).toEqual(['conversations.info']);
  });

  it.each([
    ['a private channel', PRIVATE_CH, 'not-public'],
    ['an archived channel', ARCHIVED_CH, 'archived'],
    ['a Slack Connect channel', SHARED_CH, 'shared'],
    ['a channel being shared with another workspace', PENDING_CH, 'shared'],
    ['a channel Slack does not show the bot', 'C07UNKNOWN1', 'not-public'],
  ])('refuses %s with 422, and the bot never joins it', async (_what, channelId, reason) => {
    const w = world();
    expect(await w.connect(SUPPORT.id, channelId, ADA)).toEqual({
      status: 422,
      body: { error: 'channel-not-allowed', reason },
    });
    expect(w.slack.methods()).toEqual(['conversations.info']);
    expect(w.memory.rows.size).toBe(0);
  });

  it.each(['conversations.info', 'conversations.join'])(
    'answers an install made before channels (missing_scope from %s) with 409 needs-reconnect',
    async (method) => {
      const w = world();
      w.slack.overrides.set(method, () => w.slack.refuse('missing_scope'));
      expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 409, body: { error: 'needs-reconnect' } });
      expect(w.memory.rows.size).toBe(0);
    },
  );

  it.each(
    ['conversations.info', 'conversations.join'].flatMap((method) =>
      ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'].map((code) => [method, code] as const),
    ),
  )('answers a bot token Slack no longer takes (%s: %s) with 409 needs-reconnect, not "try again"', async (method, code) => {
    const w = world();
    w.slack.overrides.set(method, () => w.slack.refuse(code));
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 409, body: { error: 'needs-reconnect' } });
    expect(w.memory.rows.size).toBe(0);
  });

  it("answers a workspace policy that keeps the bot out (restricted_action) with 422 workspace-policy", async () => {
    const w = world();
    w.slack.overrides.set('conversations.join', () => w.slack.refuse('restricted_action'));
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({
      status: 422,
      body: { error: 'channel-not-allowed', reason: 'workspace-policy' },
    });
    expect(w.memory.rows.size).toBe(0);
  });

  it('answers 404 when the agent is deleted while the channel is bound, and leaves no binding behind', async () => {
    const w = world();
    const write = w.memory.store.upsert;
    w.memory.store.upsert = async (row) => {
      const out = await write(row);
      w.people.agents.delete(SUPPORT.id);
      return out;
    };
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual(NOT_FOUND);
    expect(w.memory.rows.size).toBe(0);
  });

  it("refuses another agent's channel with 409 channel-taken and leaves its binding alone", async () => {
    const w = world();
    expect(await w.connect(SALES.id, SUPPORT_CH, SAM)).toMatchObject({ status: 200 });
    const before = w.memory.row(INSTALL_ID, SUPPORT_CH);
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 409, body: { error: 'channel-taken' } });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toEqual(before);
  });

  it('lets a second team admin reconnect a channel: they become its connector, its memory switch stays', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.remember(SUPPORT.id, SUPPORT_CH, false, ADA);
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, GRACE)).toEqual({
      status: 200,
      body: {
        channel: { channelId: SUPPORT_CH, name: 'support-desk', remember: false, connectedBy: 'Grace Hopper', needsReconnect: false, needsInvite: false },
        reconnected: true,
      },
    });
    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({
      body: { channels: [{ channelId: SUPPORT_CH, connectedBy: 'Grace Hopper', remember: false }] },
    });
  });

  it('answers 409 no-workspace when Slack is not connected, asking Slack nothing', async () => {
    const w = world();
    w.state.install = null;
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 409, body: { error: 'no-workspace' } });
    expect(w.slack.sent).toEqual([]);
  });

  it("answers 409 own-bot while the agent's own bot is live: Slack is asked nothing and nothing is bound; a pending bot connects as before (TASK-1168)", async () => {
    const w = world();
    w.state.bot = OWN_BOT;
    // The code alone: the page that offered the connect is stale, and reading the section again shows the bot.
    expect(await w.connect(SUPPORT.id, SALES_CH, ADA)).toEqual({ status: 409, body: { error: 'own-bot' } });
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.row(INSTALL_ID, SALES_CH)).toBeUndefined();

    w.state.bot = PENDING_BOT;
    expect(await w.connect(SUPPORT.id, SALES_CH, ADA)).toMatchObject({ status: 200 });
    expect(w.memory.row(INSTALL_ID, SALES_CH)).toMatchObject({ agentId: SUPPORT.id, connectedByUserId: ADA.id });
  });

  it('answers 502 slack-error when Slack fails, and binds nothing', async () => {
    const w = world();
    w.slack.overrides.set('conversations.join', () => new Response('', { status: 503 }));
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 502, body: { error: 'slack-error' } });
    expect(w.memory.rows.size).toBe(0);
  });

  it.each([
    ['not JSON', 'channel please'],
    ['an array', [SUPPORT_CH]],
    ['null', null],
    ['no channelId', {}],
    ['a number for channelId', { channelId: 7 }],
    ['an empty channelId', { channelId: '' }],
    ['a channelId with a space', { channelId: 'C07 SUPPORT' }],
    ['a channel reference, not an id', { channelId: `<#${SUPPORT_CH}>` }],
    ['a channelId past 64 characters', { channelId: `C${'7'.repeat(64)}` }],
    ['an unknown key, even one naming another agent', { channelId: SUPPORT_CH, agentId: SALES.id }],
  ])('refuses a connect body that is %s with 400, asking Slack nothing', async (_what, body) => {
    const w = world();
    const a = await w.call('POST', '/connect', SUPPORT.id, ADA, typeof body === 'string' ? body : JSON.stringify(body));
    expect({ status: a.status, body: a.body }).toEqual({ status: 400, body: { error: 'invalid-body' } });
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
  });

  it('refuses a body past the cap with 413 (the route cap is the first line; this is the backstop)', async () => {
    const w = world();
    const big = Buffer.from(JSON.stringify({ channelId: SUPPORT_CH, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) }));
    for (const suffix of ['/connect', '/disconnect', '/remember'] as const) {
      const a = await w.call('POST', suffix, SUPPORT.id, ADA, big);
      expect({ status: a.status, body: a.body }, suffix).toEqual({ status: 413, body: { error: 'body-too-large' } });
    }
    // The bot request's own cap: room for the bot's picture, and not a byte more.
    const bigBot = Buffer.from(
      JSON.stringify({ botName: 'Support Helper', iconPng: 'A'.repeat(ADMIN_CONNECT_BODY_MAX_BYTES) }),
    );
    const a = await w.call('POST', '/bot', SUPPORT.id, ADA, bigBot);
    expect({ status: a.status, body: a.body }).toEqual({ status: 413, body: { error: 'body-too-large' } });
    expect(w.slack.sent).toEqual([]);
    expect(w.bots.calls).toEqual([]);
  });
});

// ── The agent's own bot (TASK-1167) ─────────────────────────────────────────

describe('the bot routes', () => {
  it('POST /bot: an unknown key, an access token in the refresh field, a null refreshToken, or a bad name is a 400 before the domain', async () => {
    const w = world();
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ['not JSON', 'a bot please', { error: 'invalid-body' }],
      ['an array', JSON.stringify(['Support Helper']), { error: 'invalid-body' }],
      ['null', 'null', { error: 'invalid-body' }],
      ['an unknown key, even one naming another agent', { botName: 'Support Helper', agentId: SALES.id }, { error: 'invalid-body' }],
      ['an access token in the refresh field', { botName: 'Support Helper', refreshToken: ACCESS }, { error: 'invalid-refresh-token' }],
      ['a null refreshToken', { botName: 'Support Helper', refreshToken: null }, { error: 'invalid-refresh-token' }],
      ['an empty refreshToken', { botName: 'Support Helper', refreshToken: '' }, { error: 'invalid-refresh-token' }],
      ['no name', { refreshToken: REFRESH }, { error: 'invalid-bot-name', reason: 'empty' }],
      ['a blank name', { botName: '   ' }, { error: 'invalid-bot-name', reason: 'empty' }],
      ['a name that is not text', { botName: 7 }, { error: 'invalid-bot-name', reason: 'bad-characters' }],
      ['a name Slack refuses', { botName: 'Café Bot' }, { error: 'invalid-bot-name', reason: 'bad-characters' }],
      ['a reserved name', { botName: 'Slack-Bot' }, { error: 'invalid-bot-name', reason: 'reserved' }],
      ['a name past 35 characters', { botName: 'x'.repeat(36) }, { error: 'invalid-bot-name', reason: 'too-long' }],
    ];
    for (const [what, body, error] of cases) {
      const a = await w.call('POST', '/bot', SUPPORT.id, ADA, typeof body === 'string' ? body : JSON.stringify(body));
      expect({ status: a.status, body: a.body }, what).toEqual({ status: 400, body: error });
    }
    expect(w.bots.calls).toEqual([]);
    expect(w.slack.sent).toEqual([]);
  });

  it('POST /bot without refreshToken reaches the domain with null', async () => {
    const w = world();
    expect(await w.requestBot(SUPPORT.id, { botName: '  Support   Helper ' }, GRACE)).toEqual({
      status: 200,
      body: { installUrl: 'https://slack.com/oauth/v2/authorize?state=first', iconSet: true },
    });
    // The name as checkBotName tidied it; no paste, no picture; the person asking, for the agent in the path.
    expect(w.bots.calls).toEqual([
      {
        method: 'request',
        input: {
          ctxUserId: GRACE.id,
          actorUserId: GRACE.id,
          agentId: SUPPORT.id,
          botName: 'Support Helper',
          refreshToken: null,
          icon: null,
        },
      },
    ]);
  });

  it('POST /bot hands the domain a pasted refresh token and the picture as they were checked; a picture that will not do is never a 400', async () => {
    const w = world();
    const png = pngBase64(512, 512);
    expect(await w.requestBot(SUPPORT.id, { botName: 'Support Helper', refreshToken: REFRESH, iconPng: png })).toMatchObject({
      status: 200,
    });
    expect(w.bots.calls[0]?.input).toEqual({
      ctxUserId: ADA.id,
      actorUserId: ADA.id,
      agentId: SUPPORT.id,
      botName: 'Support Helper',
      refreshToken: REFRESH,
      icon: { ok: true, png: Buffer.from(png, 'base64') },
    });
    // The domain skips an unusable picture once the app exists, and logs why.
    expect(await w.requestBot(SUPPORT.id, { botName: 'Support Helper', iconPng: 'not a picture' })).toMatchObject({
      status: 200,
    });
    expect(w.bots.calls[1]?.input['icon']).toEqual({ ok: false, code: 'icon-not-base64' });
  });

  it("answers exactly what the domain answers: its refusals and Slack's", async () => {
    const w = world();
    w.bots.answers.request = { status: 502, body: { error: 'slack-config-token' } };
    expect(await w.requestBot(SUPPORT.id, { botName: 'Support Helper' })).toEqual({
      status: 502,
      body: { error: 'slack-config-token' },
    });
    w.bots.answers.installUrl = { status: 403, body: { error: 'not-approver' } };
    expect(await w.call('POST', '/bot/install-url', SUPPORT.id, ADA)).toMatchObject({
      status: 403,
      body: { error: 'not-approver' },
    });
    w.bots.answers.cancel = { status: 409, body: { error: 'not-pending' } };
    expect(await w.call('POST', '/bot/cancel', SUPPORT.id, ADA)).toMatchObject({
      status: 409,
      body: { error: 'not-pending' },
    });
    // A bot that isn't the one the page showed (gone, or replaced since).
    const shown = { installId: OWN_BOT.installId };
    w.bots.answers.disconnect = { status: 409, body: { error: 'no-bot' } };
    expect(await w.call('POST', '/bot/disconnect', SUPPORT.id, ADA, shown)).toMatchObject({
      status: 409,
      body: { error: 'no-bot' },
    });
    // The rights the domain asked again inside the lock, and an app Slack wouldn't delete.
    w.bots.answers.disconnect = { status: 403, body: { error: 'forbidden' } };
    expect(await w.call('POST', '/bot/disconnect', SUPPORT.id, ADA, shown)).toMatchObject({
      status: 403,
      body: { error: 'forbidden' },
    });
    w.bots.answers.disconnect = { status: 200, body: { appDeleted: false } };
    expect(await w.call('POST', '/bot/disconnect', SUPPORT.id, ADA, shown)).toMatchObject({
      status: 200,
      body: { appDeleted: false },
    });
  });

  it('install-url and cancel reach the domain for a team admin of the agent, and never read a body', async () => {
    const w = world();
    expect(await w.call('POST', '/bot/install-url', SUPPORT.id, GRACE, JSON.stringify({ agentId: SALES.id }))).toMatchObject({
      status: 200,
      body: { installUrl: 'https://slack.com/oauth/v2/authorize?state=again' },
    });
    expect(await w.call('POST', '/bot/cancel', SUPPORT.id, ADA, 'garbage')).toMatchObject({
      status: 200,
      body: { appDeleted: true },
    });
    expect(w.bots.calls).toEqual([
      { method: 'installUrl', input: { actorUserId: GRACE.id, agentId: SUPPORT.id } },
      { method: 'cancel', input: { agentId: SUPPORT.id } },
    ]);
  });

  it('disconnect hands the domain the install id the page showed, for the agent in the path, as the person asking', async () => {
    const w = world();
    const a = await w.call('POST', '/bot/disconnect', SUPPORT.id, ADA, { installId: OWN_BOT.installId });
    expect({ status: a.status, body: a.body }).toEqual({ status: 200, body: { appDeleted: true } });
    // The id as sent, even one the agent's bot doesn't have: whether it names the agent's bot is the domain's to say.
    const g = await w.call('POST', '/bot/disconnect', SUPPORT.id, GRACE, { installId: INSTALL_ID });
    expect({ status: g.status, body: g.body }).toEqual({ status: 200, body: { appDeleted: true } });
    expect(w.bots.calls).toEqual([
      {
        method: 'disconnect',
        input: { ctxUserId: ADA.id, actorUserId: ADA.id, agentId: SUPPORT.id, installId: OWN_BOT.installId },
      },
      {
        method: 'disconnect',
        input: { ctxUserId: GRACE.id, actorUserId: GRACE.id, agentId: SUPPORT.id, installId: INSTALL_ID },
      },
    ]);
  });

  it('disconnect takes { installId } and nothing else: an unknown key, a missing, non-string or malformed id is a 400 before the domain; past the cap a 413', async () => {
    const w = world();
    const id = OWN_BOT.installId;
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ['no body at all (an older page)', Buffer.alloc(0), { error: 'invalid-body' }],
      ['an unknown key', { installId: 'x', extra: 1 }, { error: 'invalid-body' }],
      ['an unknown key beside a good id, even one naming another agent', { installId: id, agentId: SALES.id }, { error: 'invalid-body' }],
      ['not JSON', 'garbage', { error: 'invalid-body' }],
      ['an array', '[]', { error: 'invalid-body' }],
      ['null', 'null', { error: 'invalid-body' }],
      ['bytes that are not UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), { error: 'invalid-body' }],
      ['no installId', {}, { error: 'invalid-install-id' }],
      ['a number', { installId: 42 }, { error: 'invalid-install-id' }],
      ['null for the id', { installId: null }, { error: 'invalid-install-id' }],
      ['an id too short', { installId: 'short' }, { error: 'invalid-install-id' }],
      ['an id one too long', { installId: `${id}A` }, { error: 'invalid-install-id' }],
      ['an id with a character no install id has', { installId: `${'A'.repeat(21)}/` }, { error: 'invalid-install-id' }],
      ['an id with a space around it', { installId: ` ${id}` }, { error: 'invalid-install-id' }],
    ];
    for (const [what, body, error] of cases) {
      const a = await w.call('POST', '/bot/disconnect', SUPPORT.id, ADA, body);
      expect({ status: a.status, body: a.body }, what).toEqual({ status: 400, body: error });
    }
    // http-server's maxBodyBytes refuses it first; the route's own check is the backstop.
    const big = Buffer.from(JSON.stringify({ installId: id, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) }));
    const a = await w.call('POST', '/bot/disconnect', SUPPORT.id, ADA, big);
    expect({ status: a.status, body: a.body }).toEqual({ status: 413, body: { error: 'body-too-large' } });
    expect(w.bots.calls).toEqual([]);
    expect(w.slack.sent).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('a fault in the domain is a 500, logged by its code and the route alone', async () => {
    const w = world();
    w.bots.state.fail = Object.assign(new Error(`vault down holding ${REFRESH}`), { code: 'ECONNRESET' });
    const bodies: Partial<Record<Suffix, unknown>> = {
      '/bot': { botName: 'Support Helper' },
      '/bot/disconnect': { installId: OWN_BOT.installId },
    };
    for (const suffix of ['/bot', '/bot/install-url', '/bot/cancel', '/bot/disconnect'] as const) {
      const a = await w.call('POST', suffix, SUPPORT.id, ADA, bodies[suffix]);
      expect({ status: a.status, body: a.body }, suffix).toEqual({ status: 500, body: { error: 'internal' } });
    }
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-install-url', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-cancel', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-disconnect', code: 'ECONNRESET' } },
    ]);
    expect(JSON.stringify(w.lines)).not.toContain(REFRESH);
  });

  it('the section asks the bot domain as the person reading, says whether they manage and whether the shared bot is live, and shows its answer', async () => {
    const w = world();
    // As the domain answers a manager; a member, who can't disconnect it, gets no install id.
    const live: AgentSlackBot = {
      state: 'live',
      botName: 'Support Helper',
      handle: 'supporthelper',
      approver: 'Grace Hopper',
      needsClaim: false,
      installId: OWN_BOT.installId,
    };
    w.bots.answers.status = { ...live, installId: null };
    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({
      status: 200,
      body: { state: 'ready', canManage: false, bot: { ...live, installId: null } },
    });
    w.bots.answers.status = live;
    // A live bot outlives the shared install: no workspace still shows it.
    w.state.install = null;
    expect(await w.status(SUPPORT.id, ADA)).toEqual({
      status: 200,
      body: { state: 'no-workspace', canManage: true, bot: live },
    });
    w.state.install = { ...INSTALL, status: 'pending', teamId: null, teamName: null };
    expect(await w.status(SUPPORT.id, GRACE)).toEqual({
      status: 200,
      body: { state: 'no-workspace', canManage: true, bot: live },
    });
    expect(w.bots.calls).toEqual([
      {
        method: 'status',
        input: { ctxUserId: MEL.id, viewerUserId: MEL.id, agentId: SUPPORT.id, manages: false, sharedActive: true },
      },
      {
        method: 'status',
        input: { ctxUserId: ADA.id, viewerUserId: ADA.id, agentId: SUPPORT.id, manages: true, sharedActive: false },
      },
      {
        method: 'status',
        input: { ctxUserId: GRACE.id, viewerUserId: GRACE.id, agentId: SUPPORT.id, manages: true, sharedActive: false },
      },
    ]);

    // A personal agent has no bot of its own: its section reads none, and the domain isn't asked.
    expect(await w.status(PATS.id, PAT)).toEqual({
      status: 200,
      body: { state: 'no-workspace', canManage: false, bot: NO_BOT },
    });
    expect(w.bots.calls).toHaveLength(3);
  });
});

// ── GET …/available ─────────────────────────────────────────────────────────

describe('available', () => {
  it('lists five pages at most, then says truncated; drops Slack Connect, archived and private; marks bound ones', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SALES.id, SALES_CH, SAM);
    for (let i = 10; i < 20; i += 1) w.slack.channels.set(`C07CHAN00${i}`, rawChannel(`C07CHAN00${i}`));
    // 16 channels, 3 a page: the sixth page is never read.
    w.slack.setPageSize(3);
    w.slack.sent.length = 0;

    const listed = await w.available(SUPPORT.id, ADA);
    expect(listed).toEqual({
      status: 200,
      body: {
        truncated: true,
        channels: [
          { channelId: 'C07CHAN0010', name: 'c07chan0010', connected: null },
          { channelId: 'C07CHAN0011', name: 'c07chan0011', connected: null },
          { channelId: 'C07CHAN0012', name: 'c07chan0012', connected: null },
          { channelId: 'C07CHAN0013', name: 'c07chan0013', connected: null },
          { channelId: 'C07CHAN0014', name: 'c07chan0014', connected: null },
          { channelId: 'C07CHAN0015', name: 'c07chan0015', connected: null },
          { channelId: 'C07CHAN0016', name: 'c07chan0016', connected: null },
          { channelId: 'C07CHAN0017', name: 'c07chan0017', connected: null },
          { channelId: 'C07CHAN0018', name: 'c07chan0018', connected: null },
          { channelId: SALES_CH, name: 'sales-floor', connected: 'other-agent' },
          { channelId: SUPPORT_CH, name: 'support-desk', connected: 'this-agent' },
        ],
      },
    });
    expect(w.slack.sent.map((s) => s.form)).toEqual([
      { types: 'public_channel', exclude_archived: 'true', limit: '200' },
      { types: 'public_channel', exclude_archived: 'true', limit: '200', cursor: 'p3' },
      { types: 'public_channel', exclude_archived: 'true', limit: '200', cursor: 'p6' },
      { types: 'public_channel', exclude_archived: 'true', limit: '200', cursor: 'p9' },
      { types: 'public_channel', exclude_archived: 'true', limit: '200', cursor: 'p12' },
    ]);
  });

  it('answers 409 needs-reconnect (missing_scope), 409 no-workspace, and 502 slack-error', async () => {
    const old = world();
    old.slack.overrides.set('conversations.list', () => old.slack.refuse('missing_scope'));
    expect(await old.available(SUPPORT.id, ADA)).toEqual({ status: 409, body: { error: 'needs-reconnect' } });

    const none = world();
    none.state.install = null;
    expect(await none.available(SUPPORT.id, ADA)).toEqual({ status: 409, body: { error: 'no-workspace' } });

    const down = world();
    down.slack.overrides.set('conversations.list', () => new Response('', { status: 500 }));
    expect(await down.available(SUPPORT.id, ADA)).toEqual({ status: 502, body: { error: 'slack-error' } });
  });

  it.each(['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'])(
    'answers a bot token Slack no longer takes (%s) with 409 needs-reconnect',
    async (code) => {
      const w = world();
      w.slack.overrides.set('conversations.list', () => w.slack.refuse(code));
      expect(await w.available(SUPPORT.id, ADA)).toEqual({ status: 409, body: { error: 'needs-reconnect' } });
    },
  );
});

// ── POST …/disconnect and …/remember ────────────────────────────────────────

describe('disconnect and remember', () => {
  it("disconnect removes this agent's channel, and never another agent's", async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SALES.id, SALES_CH, SAM);
    const theirs = w.memory.row(INSTALL_ID, SALES_CH);

    // Ada manages the support agent; the sales channel is not its to remove.
    expect(await w.disconnect(SUPPORT.id, SALES_CH, ADA)).toEqual({ status: 200, body: { removed: false } });
    expect(w.memory.row(INSTALL_ID, SALES_CH)).toEqual(theirs);

    expect(await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 200, body: { removed: true } });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toBeUndefined();
    expect(await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 200, body: { removed: false } });
  });

  it('disconnect still removes a shared channel of an agent whose own bot is live', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    w.state.bot = OWN_BOT;
    const lookups = w.botLookups.length;
    expect(await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 200, body: { removed: true } });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toBeUndefined();
    // Disconnect never asks about the bot.
    expect(w.botLookups).toHaveLength(lookups);
  });

  it("remember flips this agent's switch, and answers 404 not-connected for any other channel", async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SALES.id, SALES_CH, SAM);
    const theirs = w.memory.row(INSTALL_ID, SALES_CH);

    expect(await w.remember(SUPPORT.id, SUPPORT_CH, false, ADA)).toEqual({ status: 200, body: {} });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)?.remember).toBe(false);
    expect(await w.remember(SUPPORT.id, SUPPORT_CH, true, ADA)).toEqual({ status: 200, body: {} });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)?.remember).toBe(true);

    expect(await w.remember(SUPPORT.id, SALES_CH, false, ADA)).toEqual({ status: 404, body: { error: 'not-connected' } });
    expect(w.memory.row(INSTALL_ID, SALES_CH)).toEqual(theirs);
    expect(await w.remember(SUPPORT.id, 'C07NOWHERE1', false, ADA)).toEqual({
      status: 404,
      body: { error: 'not-connected' },
    });
  });

  it('disconnect and remember take no key but their own: an extra one, even naming another agent, is a 400 and changes nothing', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SALES.id, SALES_CH, SAM);
    const mine = w.memory.row(INSTALL_ID, SUPPORT_CH);
    const theirs = w.memory.row(INSTALL_ID, SALES_CH);
    const writes = w.memory.calls.length;
    const cases: Array<{ suffix: '/disconnect' | '/remember'; body: Record<string, unknown> }> = [
      { suffix: '/disconnect', body: { channelId: SUPPORT_CH, agentId: 'agt_other' } },
      { suffix: '/disconnect', body: { channelId: SALES_CH, agentId: SALES.id } },
      { suffix: '/disconnect', body: { channelId: SUPPORT_CH, remember: false } },
      { suffix: '/remember', body: { channelId: SUPPORT_CH, remember: false, agentId: 'agt_other' } },
      { suffix: '/remember', body: { channelId: SALES_CH, remember: false, agentId: SALES.id } },
    ];
    for (const c of cases) {
      const a = await w.call('POST', c.suffix, SUPPORT.id, ADA, JSON.stringify(c.body));
      expect({ status: a.status, body: a.body }, `${c.suffix} ${JSON.stringify(c.body)}`).toEqual({
        status: 400,
        body: { error: 'invalid-body' },
      });
    }
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toEqual(mine);
    expect(w.memory.row(INSTALL_ID, SALES_CH)).toEqual(theirs);
    expect(w.memory.calls).toHaveLength(writes);
  });

  it('remember takes only a boolean', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    for (const remember of ['false', 0, null, undefined]) {
      expect(await w.remember(SUPPORT.id, SUPPORT_CH, remember, ADA), String(remember)).toEqual({
        status: 400,
        body: { error: 'invalid-body' },
      });
    }
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)?.remember).toBe(true);
  });

  it('with Slack not connected, there is nothing to disconnect or remember', async () => {
    const w = world();
    w.state.install = null;
    expect(await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 200, body: { removed: false } });
    expect(await w.remember(SUPPORT.id, SUPPORT_CH, false, ADA)).toEqual({
      status: 404,
      body: { error: 'not-connected' },
    });
  });
});

// ── Logs ────────────────────────────────────────────────────────────────────

describe('logs', () => {
  it('say what happened by code alone: never a channel id or name, an email or a person', async () => {
    const w = world({
      getUserFault: new PluginError({ code: 'db-down', plugin: '@ax/auth-better', message: 'down' }),
    });
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SUPPORT.id, SUPPORT_CH, GRACE);
    await w.connect(SUPPORT.id, ARCHIVED_CH, ADA);
    await w.connect(SALES.id, SUPPORT_CH, SAM);
    await w.status(SUPPORT.id, MEL);
    await w.available(SUPPORT.id, ADA);
    await w.remember(SUPPORT.id, SUPPORT_CH, false, ADA);
    await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA);
    w.slack.overrides.set('conversations.info', () => w.slack.refuse('missing_scope'));
    await w.connect(SUPPORT.id, SALES_CH, ADA);

    expect(w.lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining([
        'slack_channel_connected',
        'slack_channel_refused',
        'slack_channel_disconnected',
        'slack_channel_route_failed',
      ]),
    );
    expect(w.lines).toContainEqual({
      level: 'info',
      msg: 'slack_channel_disconnected',
      fields: { installId: INSTALL_ID },
    });
    const logged = JSON.stringify(w.lines);
    for (const secret of [
      ...Object.keys(NAMES),
      ...Object.values(NAMES),
      ...USERS.flatMap((u) => [u.email!, ...(u.displayName === null ? [] : [u.displayName])]),
      SUPPORT.displayName,
      BOT_TOKEN,
    ]) {
      expect(logged, secret).not.toContain(secret);
    }
  });
});
