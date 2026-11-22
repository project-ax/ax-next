import { HookBus, PluginError, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createAgentSlackRoutes, type AgentRoutesDeps } from '../agent-routes.js';
import type { BotChanges } from '../bot-changes.js';
import type { BotRequests } from '../bot-requests.js';
import type { AgentSlackBot, BotReply, Bots } from '../bots.js';
import type { RouteRequest, RouteResponse } from '../http-types.js';
import { ADMIN_BODY_MAX_BYTES, ADMIN_CONNECT_BODY_MAX_BYTES, SLACK_ICON_MAX_BYTES } from '../limits.js';
import type { InstallRow } from '../store.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { pngBase64, pngHeader } from './fake-png.js';
import { CONFIG_REFRESH_PREFIX, fakeConfigAccessToken, fakeConfigRefreshToken } from './fake-slack-tokens.js';
import { memoryChannelStore } from './memory-channel-store.js';

/*
  The agent-settings Slack section, through its route handlers. Who may do
  what is the point: signed out → 401; anyone who can't see the agent → the
  same 404 a missing agent gets; a team member reads without managing (403
  on writes); a team admin of the agent's team manages; workspace-admin
  status never counts; a personal agent is refused before anything else is
  asked. The routes hold no Slack client and no vault (TASK-1186): the
  shared app connects no channel, and whatever reaches Slack goes through
  the bot domains, stubbed here.

  The agent's own bot (TASK-1167), and its Disconnect (TASK-1172), sit
  behind the same gate: its routes are checked here for who gets through and
  what the domain is handed, with a stub domain (bots.test.ts tests the
  domain itself). So does asking an AX admin for it (TASK-1169), with its own
  stub (bot-requests.test.ts tests that domain), and so do renaming the live
  bot and changing its picture (TASK-1171), and its approver's Replace of
  their token and a team admin's Claim (TASK-1173; bot-changes.test.ts tests
  that domain).
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const TEAM_ID = 'T07ABCDEF12';
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
const NAMES: Record<string, string> = {
  [SUPPORT_CH]: 'support-desk',
  [SALES_CH]: 'sales-floor',
};

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
  | '/bot'
  | '/bot/install-url'
  | '/bot/cancel'
  | '/bot/disconnect'
  | '/bot/rename'
  | '/bot/icon'
  | '/bot/replace-token'
  | '/bot/claim'
  | '/bot-request'
  | '/bot-request/cancel';

/** A token pasted into the bot form's refresh-token field, and one of the wrong kind. */
const REFRESH = fakeConfigRefreshToken('ROUTESREFRESHSECRET');
const ACCESS = fakeConfigAccessToken('ROUTESACCESSSECRET');

/** Every route, with a body each write would accept. */
const EVERY_ROUTE: Array<{ method: 'GET' | 'POST'; suffix: Suffix; body?: unknown }> = [
  { method: 'GET', suffix: '' },
  { method: 'POST', suffix: '/bot', body: { botName: 'Support Helper' } },
  { method: 'POST', suffix: '/bot/install-url' },
  // Cancel names the pending bot the page showed (TASK-1173); the domain is a stub, so any well-formed id does.
  { method: 'POST', suffix: '/bot/cancel', body: { installId: OWN_BOT.installId } },
  { method: 'POST', suffix: '/bot/disconnect', body: { installId: OWN_BOT.installId } },
  { method: 'POST', suffix: '/bot/rename', body: { botName: 'Support Helper' } },
  { method: 'POST', suffix: '/bot/icon', body: { iconPng: pngBase64(512, 512) } },
  // The approver's Replace of their token, and a team admin's Claim (TASK-1173).
  { method: 'POST', suffix: '/bot/replace-token', body: { refreshToken: REFRESH } },
  { method: 'POST', suffix: '/bot/claim', body: { installId: OWN_BOT.installId } },
  // Asking an AX admin for the bot instead (TASK-1169).
  { method: 'POST', suffix: '/bot-request', body: { botName: 'Ada Bot' } },
  { method: 'POST', suffix: '/bot-request/cancel', body: {} },
];
const WRITES = EVERY_ROUTE.filter((r) => r.suffix !== '');

/** What the bot domain answers for an agent with no bot and a viewer with no token. */
const NO_BOT: AgentSlackBot = { state: 'none', configTokenStored: false };
/** The live bot as a member reads it: no install id (only those who manage the agent get one, for its Disconnect). */
const LIVE: AgentSlackBot = {
  state: 'live',
  botName: 'Support Helper',
  handle: 'supporthelper',
  approver: 'Grace Hopper',
  approverGone: false,
  viewerIsApprover: false,
  needsClaim: false,
  installId: null,
};

// ── The bot domain, as a stub ───────────────────────────────────────────────

/**
 * bots.ts and bot-changes.ts behind the routes, as stubs: each call is
 * recorded in the one `calls` list (its ctx as the person it acts for), and
 * answers what the test set. `fail` makes every call throw. The routes' own
 * job is who gets through, and what they hand on.
 */
function stubBots() {
  const calls: Array<{
    method:
      | 'request'
      | 'installUrl'
      | 'cancel'
      | 'disconnect'
      | 'status'
      | 'rename'
      | 'setPicture'
      | 'replaceToken'
      | 'claim';
    input: Record<string, unknown>;
  }> = [];
  const answers: {
    request: BotReply;
    installUrl: BotReply;
    cancel: BotReply;
    disconnect: BotReply;
    status: AgentSlackBot;
    rename: BotReply;
    setPicture: BotReply;
    replaceToken: BotReply;
    claim: BotReply;
  } = {
    request: { status: 200, body: { installUrl: 'https://slack.com/oauth/v2/authorize?state=first', iconSet: true } },
    installUrl: { status: 200, body: { installUrl: 'https://slack.com/oauth/v2/authorize?state=again' } },
    cancel: { status: 200, body: { appDeleted: true } },
    disconnect: { status: 200, body: { appDeleted: true } },
    status: NO_BOT,
    rename: { status: 200, body: { botName: 'Quill Desk' } },
    setPicture: { status: 200, body: {} },
    replaceToken: { status: 200, body: {} },
    claim: { status: 200, body: {} },
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
  // Into the same `calls`, so every "the domain was never asked" covers these too.
  // What the agent's settings may reach of bot-changes.ts: never the Admin › Slack Replace.
  const changes: Pick<BotChanges, 'rename' | 'setPicture' | 'replaceToken' | 'claim'> = {
    rename: async (i) => {
      enter('rename', i);
      return answers.rename;
    },
    setPicture: async (i) => {
      enter('setPicture', i);
      return answers.setPicture;
    },
    replaceToken: async (i) => {
      enter('replaceToken', i);
      return answers.replaceToken;
    },
    claim: async (i) => {
      enter('claim', i);
      return answers.claim;
    },
  };
  return { bots, changes, calls, answers, state };
}

/**
 * bot-requests.ts behind the routes (TASK-1169), as a stub in the same shape:
 * each call recorded, answering what the test set, and `fail` makes every call
 * throw.
 */
function stubRequests() {
  const calls: Array<{ method: 'ask' | 'cancel'; input: Record<string, unknown> }> = [];
  const answers: { ask: BotReply; cancel: BotReply } = {
    ask: { status: 200, body: {} },
    cancel: { status: 200, body: {} },
  };
  const state: { fail: unknown } = { fail: undefined };
  const enter = (method: (typeof calls)[number]['method'], input: object): void => {
    const { ctx, ...rest } = input as { ctx?: { userId: string } } & Record<string, unknown>;
    calls.push({ method, input: ctx === undefined ? rest : { ctxUserId: ctx.userId, ...rest } });
    if (state.fail !== undefined) throw state.fail;
  };
  const requests: Pick<BotRequests, 'ask' | 'cancel'> = {
    ask: async (i) => {
      enter('ask', i);
      return answers.ask;
    },
    cancel: async (i) => {
      enter('cancel', i);
      return answers.cancel;
    },
  };
  return { requests, calls, answers, state };
}

// ── The routes' surroundings ────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function world(o: { workspaceAdminsMayManage?: boolean; authFault?: Error } = {}) {
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
    const user = users.get(userId);
    return user === undefined ? null : { ...user };
  });

  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const memory = memoryChannelStore();
  const state = {
    install: { ...INSTALL } as InstallRow | null,
    /** The agent's own bot (store.ts `botForAgent`, any status): none unless a test sets one. */
    bot: null as InstallRow | null,
    botFault: undefined as unknown,
  };
  /** The agents `botForAgent` was asked about, in order. */
  const botLookups: string[] = [];
  const deps: AgentRoutesDeps = {
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
    logger,
  };
  const bots = stubBots();
  const requests = stubRequests();
  const routes = createAgentSlackRoutes(deps, bots.bots, requests.requests, bots.changes);

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
    memory,
    state,
    botLookups,
    lines,
    routes,
    bots,
    requests,
    call,
    status: (agentId: string, as: TestUser | null = ADA) => reply(call('GET', '', agentId, as)),
    requestBot: (agentId: string, body: unknown, as: TestUser | null = ADA) =>
      reply(call('POST', '/bot', agentId, as, body)),
    askForBot: (agentId: string, body: unknown, as: TestUser | null = ADA) =>
      reply(call('POST', '/bot-request', agentId, as, body)),
  };
}

const NOT_FOUND = { status: 404, body: { error: 'not-found' } };
const FORBIDDEN = { status: 403, body: { error: 'forbidden' } };

/** The bot's first mention in a channel binds it on the bot's own install, to its agent (router.ts). */
const answerOnBot = (w: ReturnType<typeof world>, channelId: string, channelName = NAMES[channelId] ?? channelId) =>
  w.memory.store.upsert({
    installId: OWN_BOT.installId,
    channelId,
    agentId: SUPPORT.id,
    connectedByUserId: GRACE.id,
    channelName,
  });

// ── The routes themselves ───────────────────────────────────────────────────

describe('the routes', () => {
  it('serves the section under /settings/slack/:agentId; the writes cap their bodies and keep the CSRF check', () => {
    const w = world();
    expect(
      w.routes.map((r) => ({ method: r.method, path: r.path, bypassCsrf: r.bypassCsrf, maxBodyBytes: r.maxBodyBytes })),
    ).toEqual([
      { method: 'GET', path: '/settings/slack/:agentId', bypassCsrf: undefined, maxBodyBytes: undefined },
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
      // Its live bot's name and picture (TASK-1171): a picture's body is the PNG itself, so it has Connect's cap.
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot/rename',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot/icon',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES,
      },
      // Its approver's Replace of their token, and a team admin's Claim (TASK-1173): small bodies, the plain cap.
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot/replace-token',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot/claim',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      // Asking an AX admin for it (TASK-1169): a name and nothing else, so the plain cap.
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot-request',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot-request/cancel',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
    ]);
    for (const r of w.routes) expect(r).not.toHaveProperty('bypassCsrf');
  });

  // TASK-1202 (design §4c): a team agent's memory is shared with its team, so a
  // bot channel has no memory switch, and no route flips one.
  it('mounts no memory switch: no route answers POST …/bot/remember, and no path ends in /remember (TASK-1202)', () => {
    const w = world();
    expect(w.routes.find((r) => r.path === '/settings/slack/:agentId/bot/remember')).toBeUndefined();
    expect(w.routes.filter((r) => r.path.endsWith('/remember'))).toEqual([]);
  });

  // TASK-1203 (design §4c): nor whether it is private. A private channel is
  // remembered like any other, so the settings have nothing to say about it.
  it("a bot channel's row carries no memory switch and no privacy: its id and its name, nothing else (TASK-1202, TASK-1203)", async () => {
    const w = world();
    w.state.bot = OWN_BOT;
    w.bots.answers.status = LIVE;
    await answerOnBot(w, SUPPORT_CH);
    for (const as of [MEL, ADA]) {
      const read = await w.status(SUPPORT.id, as);
      const rows = (read.body as { botChannels: Array<Record<string, unknown>> }).botChannels;
      expect(rows, as.id).toHaveLength(1);
      for (const row of rows) {
        expect('remember' in row, as.id).toBe(false);
        expect(Object.keys(row).sort(), as.id).toEqual(['channelId', 'name']);
      }
    }
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
    expect(w.memory.calls).toEqual([]);
    expect(w.bots.calls).toEqual([]);
    expect(w.requests.calls).toEqual([]);
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
    expect(w.memory.calls).toEqual([]);
    expect(w.bots.calls).toEqual([]);
    expect(w.requests.calls).toEqual([]);
  });

  it('lets a team member read the section without the manage controls, and refuses every write with 403', async () => {
    const w = world();
    // The agent's own bot answered in #support: a binding no member's write may reach.
    w.state.bot = OWN_BOT;
    await answerOnBot(w, SUPPORT_CH);
    const before = w.memory.row(OWN_BOT.installId, SUPPORT_CH);

    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({ status: 200, body: { state: 'ready', canManage: false } });
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, MEL, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual(FORBIDDEN);
    }
    expect(w.memory.row(OWN_BOT.installId, SUPPORT_CH)).toEqual(before);
    // The section read the bot as a non-manager; no write reached the bot domain.
    expect(w.bots.calls.map((c) => c.method)).toEqual(['status']);
    expect(w.requests.calls).toEqual([]);
  });

  it.each([
    ['an empty object', {}],
    ['allowed as a string', { allowed: 'true' }],
    ['null', null],
  ])('answers 403 on every write, and nothing past the rights is asked, when agents answers the manage question with %s', async (_what, answer) => {
    const w = world();
    w.people.answers.set('agents:can-set-shared-credential', answer);
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, ADA, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual(FORBIDDEN);
    }
    expect(w.memory.calls).toEqual([]);
    expect(w.bots.calls).toEqual([]);
    expect(w.requests.calls).toEqual([]);
    // The section itself still reads, without the manage controls.
    expect(await w.status(SUPPORT.id, ADA)).toMatchObject({ status: 200, body: { state: 'ready', canManage: false } });
  });

  it('never reads a body for someone without rights: a bad or oversized body is the rights answer, not a 400 or 413', async () => {
    const w = world();
    const garbage = 'garbage';
    const oversized = Buffer.from(JSON.stringify({ channelId: SUPPORT_CH, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) }));
    const arrayBody = JSON.stringify([SUPPORT_CH]);
    const extraKey = JSON.stringify({ channelId: SUPPORT_CH, agentId: SALES.id });
    for (const suffix of [
      '/bot',
      // Cancel reads the install id the page showed since TASK-1173.
      '/bot/cancel',
      '/bot/disconnect',
      '/bot/rename',
      '/bot/icon',
      '/bot/replace-token',
      '/bot/claim',
      '/bot-request',
    ] as const) {
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
    expect(w.memory.calls).toEqual([]);
    expect(w.bots.calls).toEqual([]);
    expect(w.requests.calls).toEqual([]);
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
    expect(w.bots.calls.map((c) => c.method)).toEqual(['status']);
    expect(w.requests.calls).toEqual([]);
  });

  it("lets a team admin of the agent's team manage it", async () => {
    const w = world();
    expect(await w.status(SUPPORT.id, ADA)).toMatchObject({ status: 200, body: { state: 'ready', canManage: true } });
    expect(await w.requestBot(SUPPORT.id, { botName: 'Support Helper' }, ADA)).toMatchObject({ status: 200 });
  });

  it('says a personal agent is one, and refuses every write with 409 personal-agent before anything else is asked', async () => {
    const w = world();
    expect(await w.status(PATS.id, PAT)).toEqual({
      status: 200,
      body: { state: 'personal-agent', botName: 'canopy-works', answersDms: true },
    });
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, PATS.id, PAT, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual({ status: 409, body: { error: 'personal-agent' } });
    }
    expect(w.memory.calls).toEqual([]);
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
    // A personal agent has no bot of its own: none is asked about, or asked for.
    expect(w.bots.calls).toEqual([]);
    expect(w.requests.calls).toEqual([]);
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

  it("a team agent's status names its team for the viewer when the teams service knows it, and leaves it out otherwise (TASK-1203)", async () => {
    const w = world();
    // No teams service at all: no name, and the answer is what it always was.
    // Exact: no name field of any spelling (a stray `teamName` would fail this).
    expect(await w.status(SUPPORT.id, ADA)).toEqual({ status: 200, body: { state: 'ready', botName: 'canopy-works', workspaceName: 'Canopy Works', canManage: true, bot: NO_BOT } });

    const asked: string[] = [];
    w.bus.registerService('teams:list-for-user', '@ax/teams', async (_ctx, raw) => {
      const userId = (raw as { userId: string }).userId;
      asked.push(userId);
      return {
        teams: w.people
          .teamsOf(userId)
          .map((id) => ({ id, displayName: id === SUPPORT_TEAM ? 'Customer Care' : 'Sales', createdBy: ADA.id, createdAt: new Date(0) })),
      };
    });
    // Exactly the ready answer it always was, plus the name.
    expect(await w.status(SUPPORT.id, ADA)).toEqual({
      status: 200,
      body: {
        state: 'ready',
        botName: 'canopy-works',
        workspaceName: 'Canopy Works',
        canManage: true,
        bot: NO_BOT,
        agentTeamName: 'Customer Care',
      },
    });
    // A plain member sees it too, and the person asked is the viewer.
    expect(await w.status(SUPPORT.id, MEL)).toEqual({
      status: 200,
      body: {
        state: 'ready',
        botName: 'canopy-works',
        workspaceName: 'Canopy Works',
        canManage: false,
        bot: NO_BOT,
        agentTeamName: 'Customer Care',
      },
    });
    expect(asked).toEqual([ADA.id, MEL.id]);

    // Not connected to Slack: the card still shows, so the answer still names the team.
    w.state.install = null;
    expect(await w.status(SUPPORT.id, ADA)).toEqual({
      status: 200,
      body: { state: 'no-workspace', canManage: true, bot: NO_BOT, agentTeamName: 'Customer Care' },
    });

    // A personal agent has no team, and the answer says none.
    w.state.install = { ...INSTALL };
    const personal = await w.status(PATS.id, PAT);
    expect(personal.body).not.toHaveProperty('agentTeamName');
    expect(personal.body).not.toHaveProperty('teamName');
  });

  it("a team name the teams service can't give is left out, and the status still answers (TASK-1203)", async () => {
    const w = world();
    w.bus.registerService('teams:list-for-user', '@ax/teams', async () => {
      throw new Error('boom: Customer Care');
    });
    const out = await w.status(SUPPORT.id, ADA);
    expect(out).toEqual({ status: 200, body: { state: 'ready', botName: 'canopy-works', workspaceName: 'Canopy Works', canManage: true, bot: NO_BOT } });
    // The fault is logged by code only: never the error's words.
    const warned = w.lines.filter((l) => l.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned)).not.toContain('Customer Care');
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
      approverGone: false,
      viewerIsApprover: false,
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

  it('the ready section carries the bot and its channels, and no shared channel list (TASK-1186)', async () => {
    const w = world();
    w.state.bot = OWN_BOT;
    w.bots.answers.status = LIVE;
    // A binding left on the shared install (every boot deletes them, migrations.ts): never listed, never read.
    await w.memory.store.upsert({
      installId: INSTALL_ID,
      channelId: SALES_CH,
      agentId: SUPPORT.id,
      connectedByUserId: ADA.id,
      channelName: 'sales-floor',
    });
    // The bot's first mention in #support-desk bound it on the bot's own install (router.ts).
    await answerOnBot(w, SUPPORT_CH);
    const before = w.memory.calls.length;

    for (const [as, canManage] of [
      [MEL, false],
      [ADA, true],
    ] as const) {
      expect(await w.status(SUPPORT.id, as), as.id).toEqual({
        status: 200,
        body: {
          state: 'ready',
          botName: 'canopy-works',
          workspaceName: 'Canopy Works',
          canManage,
          bot: LIVE,
          botChannels: [{ channelId: SUPPORT_CH, name: 'support-desk' }],
        },
      });
    }
    // One read per section, of the bot's install alone.
    expect(w.memory.calls.slice(before)).toEqual(['listForAgent', 'listForAgent']);
    // Nobody's name is looked up: the section names no connector.
    expect(w.userLookups).toEqual([]);
  });

  it("a store fault reading the agent's own bot (botForAgent) is the route's 500, logged by code alone", async () => {
    const w = world();
    w.state.bot = OWN_BOT;
    w.bots.answers.status = LIVE;
    w.state.botFault = Object.assign(new Error(`relation gone ${SUPPORT_CH}`), { code: '42P01' });
    expect(await w.status(SUPPORT.id, ADA)).toEqual({ status: 500, body: { error: 'internal' } });
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'status', code: '42P01' } },
    ]);
  });

  it("a store fault reading the bot's channels (listForAgent) is the route's 500, logged by code alone", async () => {
    const w = world();
    w.state.bot = OWN_BOT;
    w.bots.answers.status = LIVE;
    w.memory.store.listForAgent = async () => {
      throw Object.assign(new Error(`relation gone ${SUPPORT_CH}`), { code: '42P01' });
    };
    expect(await w.status(SUPPORT.id, ADA)).toEqual({ status: 500, body: { error: 'internal' } });
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'status', code: '42P01' } },
    ]);
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
    // A bot that isn't the one the page showed (gone, or replaced since).
    const shown = { installId: OWN_BOT.installId };
    w.bots.answers.cancel = { status: 409, body: { error: 'not-pending' } };
    expect(await w.call('POST', '/bot/cancel', SUPPORT.id, ADA, shown)).toMatchObject({
      status: 409,
      body: { error: 'not-pending' },
    });
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

  it('install-url reaches the domain for a team admin of the agent, and never reads a body', async () => {
    const w = world();
    expect(await w.call('POST', '/bot/install-url', SUPPORT.id, GRACE, JSON.stringify({ agentId: SALES.id }))).toMatchObject({
      status: 200,
      body: { installUrl: 'https://slack.com/oauth/v2/authorize?state=again' },
    });
    expect(await w.call('POST', '/bot/install-url', SUPPORT.id, ADA, 'garbage')).toMatchObject({ status: 200 });
    // Only the agent in the path, for the person asking: the body named another agent, and was never read.
    expect(w.bots.calls).toEqual([
      { method: 'installUrl', input: { actorUserId: GRACE.id, agentId: SUPPORT.id } },
      { method: 'installUrl', input: { actorUserId: ADA.id, agentId: SUPPORT.id } },
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
    expect(w.lines).toEqual([]);
  });

  it('a fault in the domain is a 500, logged by its code and the route alone', async () => {
    const w = world();
    const fault = Object.assign(new Error(`vault down holding ${REFRESH}`), { code: 'ECONNRESET' });
    w.bots.state.fail = fault;
    w.requests.state.fail = fault;
    const bodies: Partial<Record<Suffix, unknown>> = {
      '/bot': { botName: 'Support Helper' },
      '/bot/cancel': { installId: OWN_BOT.installId },
      '/bot/disconnect': { installId: OWN_BOT.installId },
      '/bot-request': { botName: 'Support Helper' },
    };
    for (const suffix of [
      '/bot',
      '/bot/install-url',
      '/bot/cancel',
      '/bot/disconnect',
      '/bot-request',
      '/bot-request/cancel',
    ] as const) {
      const a = await w.call('POST', suffix, SUPPORT.id, ADA, bodies[suffix]);
      expect({ status: a.status, body: a.body }, suffix).toEqual({ status: 500, body: { error: 'internal' } });
    }
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-install-url', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-cancel', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-disconnect', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-request', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-request-cancel', code: 'ECONNRESET' } },
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
      approverGone: false,
      viewerIsApprover: false,
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

// ── The live bot's name and picture (TASK-1171) ─────────────────────────────

describe("the agent's own bot's name and picture (TASK-1171)", () => {
  /** One POST to the support agent, status and body only. A string or a Buffer goes as it is, anything else as JSON. */
  const post = async (
    w: ReturnType<typeof world>,
    suffix: '/bot/rename' | '/bot/icon',
    body: unknown,
    as: TestUser = ADA,
  ): Promise<{ status: number; body: unknown }> => {
    const a = await w.call('POST', suffix, SUPPORT.id, as, body);
    return { status: a.status, body: a.body };
  };
  /** A body of exactly `bytes` bytes: `{"<key>":"xxx…"}`. */
  const sized = (key: string, bytes: number, fill: string): Buffer => {
    const head = `{"${key}":"`;
    const out = Buffer.from(`${head}${fill.repeat(bytes - head.length - 2)}"}`);
    expect(out.length).toBe(bytes);
    return out;
  };

  it("a team admin's rename reaches the domain with the tidied name and nothing else, and its answer is the route's", async () => {
    const w = world();
    expect(await post(w, '/bot/rename', { botName: '  Quill   Desk ' }, GRACE)).toEqual({
      status: 200,
      body: { botName: 'Quill Desk' },
    });
    // The name as checkBotName tidied it, for the agent in the path: no person, no ctx.
    // The domain uses the bot's approver's token, whoever asked.
    expect(w.bots.calls).toEqual([{ method: 'rename', input: { agentId: SUPPORT.id, botName: 'Quill Desk' } }]);
    // The domain's answer is the answer, whatever it is.
    for (const answer of [
      { status: 409, body: { error: 'bot-name-taken' } },
      { status: 409, body: { error: 'not-live' } },
      { status: 502, body: { error: 'slack-config-token' } },
      { status: 500, body: { error: 'internal' } },
    ]) {
      w.bots.answers.rename = answer;
      expect(await post(w, '/bot/rename', { botName: 'Quill Desk' }), JSON.stringify(answer)).toEqual(answer);
    }
    expect(w.bots.calls).toHaveLength(5);
    expect(w.lines).toEqual([]);
  });

  it('a name the rules refuse is 400 invalid-bot-name with its reason, before the domain', async () => {
    const w = world();
    const cases: Array<[string, unknown, string]> = [
      ['an empty name', { botName: '' }, 'empty'],
      ['a blank name', { botName: '   ' }, 'empty'],
      ['no name', {}, 'empty'],
      ['a null name', { botName: null }, 'empty'],
      ['a name past 35 characters', { botName: 'x'.repeat(36) }, 'too-long'],
      ['a name Slack refuses', { botName: 'Café' }, 'bad-characters'],
      ['a name that is not text', { botName: 42 }, 'bad-characters'],
      ['a reserved name', { botName: 'here' }, 'reserved'],
    ];
    for (const [what, body, reason] of cases) {
      expect(await post(w, '/bot/rename', body), what).toEqual({
        status: 400,
        body: { error: 'invalid-bot-name', reason },
      });
    }
    expect(w.bots.calls).toEqual([]);
  });

  it('a rename body must be an object holding botName alone, within the cap every other write has', async () => {
    const w = world();
    const cases: Array<[string, unknown]> = [
      ['an unknown key, even one naming another agent', { botName: 'Quill Desk', agentId: SALES.id }],
      ['a picture beside the name', { botName: 'Quill Desk', iconPng: pngBase64(512, 512) }],
      ['an array', []],
      ['null', null],
      ['a number', 42],
      ['not JSON', 'garbage'],
    ];
    for (const [what, body] of cases) {
      expect(await post(w, '/bot/rename', body), what).toEqual({ status: 400, body: { error: 'invalid-body' } });
    }
    // The backstop for http-server's cap: one byte past it is a 413; at it, the body is read.
    expect(await post(w, '/bot/rename', sized('botName', ADMIN_BODY_MAX_BYTES + 1, 'x'))).toEqual({
      status: 413,
      body: { error: 'body-too-large' },
    });
    expect(await post(w, '/bot/rename', sized('botName', ADMIN_BODY_MAX_BYTES, 'x'))).toEqual({
      status: 400,
      body: { error: 'invalid-bot-name', reason: 'too-long' },
    });
    expect(w.bots.calls).toEqual([]);
  });

  it("a team admin's picture reaches the domain as the PNG's bytes, and its answer is the route's", async () => {
    const w = world();
    expect(await post(w, '/bot/icon', { iconPng: pngBase64(512, 512) }, GRACE)).toEqual({ status: 200, body: {} });
    // The bytes icon.ts checked, for the agent in the path: no person, no ctx.
    expect(w.bots.calls).toEqual([{ method: 'setPicture', input: { agentId: SUPPORT.id, png: pngHeader(512, 512) } }]);
    expect((w.bots.calls[0]?.input['png'] as Buffer).equals(pngHeader(512, 512))).toBe(true);
    // The largest picture Slack takes fits under the route's cap.
    expect(await post(w, '/bot/icon', { iconPng: pngBase64(2000, 2000, SLACK_ICON_MAX_BYTES) })).toEqual({
      status: 200,
      body: {},
    });
    expect((w.bots.calls[1]?.input['png'] as Buffer).equals(pngHeader(2000, 2000, SLACK_ICON_MAX_BYTES))).toBe(true);
    for (const answer of [
      { status: 409, body: { error: 'not-live' } },
      { status: 502, body: { error: 'slack-app-gone' } },
      { status: 500, body: { error: 'internal' } },
    ]) {
      w.bots.answers.setPicture = answer;
      expect(await post(w, '/bot/icon', { iconPng: pngBase64(512, 512) }), JSON.stringify(answer)).toEqual(answer);
    }
    expect(w.lines).toEqual([]);
  });

  it("a picture that isn't one is 400 invalid-icon with icon.ts's reason, before the domain", async () => {
    const w = world();
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(42)]).toString('base64');
    const cases: Array<[string, unknown, string]> = [
      ['not base64', { iconPng: 'not base64!' }, 'icon-not-base64'],
      ['a data URL, not bare base64', { iconPng: `data:image/png;base64,${pngBase64(512, 512)}` }, 'icon-not-base64'],
      ['no picture', {}, 'icon-not-base64'],
      ['a null picture', { iconPng: null }, 'icon-not-base64'],
      ['a picture that is not text', { iconPng: 42 }, 'icon-not-base64'],
      ['a GIF', { iconPng: gif }, 'icon-not-png'],
      ['a PNG past 1 MiB', { iconPng: pngBase64(512, 512, SLACK_ICON_MAX_BYTES + 1) }, 'icon-too-large'],
      ['a PNG too small', { iconPng: pngBase64(511, 511) }, 'icon-bad-size'],
      ['a PNG that is not square', { iconPng: pngBase64(512, 640) }, 'icon-bad-size'],
    ];
    for (const [what, body, reason] of cases) {
      expect(await post(w, '/bot/icon', body), what).toEqual({ status: 400, body: { error: 'invalid-icon', reason } });
    }
    expect(w.bots.calls).toEqual([]);
  });

  it("a picture body must be an object holding iconPng alone, within Connect's cap", async () => {
    const w = world();
    const png = pngBase64(512, 512);
    const cases: Array<[string, unknown]> = [
      ['an unknown key, even one naming another agent', { iconPng: png, agentId: SALES.id }],
      ['a name beside the picture', { iconPng: png, botName: 'Quill Desk' }],
      ['an array', [png]],
      ['null', null],
      ['not JSON', 'garbage'],
    ];
    for (const [what, body] of cases) {
      expect(await post(w, '/bot/icon', body), what).toEqual({ status: 400, body: { error: 'invalid-body' } });
    }
    // The backstop for http-server's cap: one byte past Connect's cap is a 413; at it, the body is read.
    expect(await post(w, '/bot/icon', sized('iconPng', ADMIN_CONNECT_BODY_MAX_BYTES + 1, 'A'))).toEqual({
      status: 413,
      body: { error: 'body-too-large' },
    });
    expect(await post(w, '/bot/icon', sized('iconPng', ADMIN_CONNECT_BODY_MAX_BYTES, 'A'))).toEqual({
      status: 400,
      body: { error: 'invalid-icon', reason: 'icon-not-base64' },
    });
    expect(w.bots.calls).toEqual([]);
  });

  it('a fault in the domain is a 500, logged by its code and the route alone', async () => {
    const w = world();
    w.bots.state.fail = Object.assign(new Error(`vault down holding ${REFRESH}`), { code: 'ECONNRESET' });
    expect(await post(w, '/bot/rename', { botName: 'Quill Desk' })).toEqual({ status: 500, body: { error: 'internal' } });
    expect(await post(w, '/bot/icon', { iconPng: pngBase64(512, 512) })).toEqual({
      status: 500,
      body: { error: 'internal' },
    });
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-rename', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-icon', code: 'ECONNRESET' } },
    ]);
    const logged = JSON.stringify(w.lines);
    for (const text of [REFRESH, 'vault down', 'Quill Desk', SUPPORT.id, ADA.id]) expect(logged).not.toContain(text);
  });
});

// ── The live bot's token, its claim, and Cancel by install id (TASK-1173) ───

describe("the agent's own bot's token, its claim, and Cancel by the page's install id (TASK-1173)", () => {
  /** One POST to the support agent, status and body only. A string or a Buffer goes as it is, anything else as JSON. */
  const post = async (
    w: ReturnType<typeof world>,
    suffix: '/bot/replace-token' | '/bot/claim' | '/bot/cancel',
    body: unknown,
    as: TestUser = ADA,
  ): Promise<{ status: number; body: unknown }> => {
    const a = await w.call('POST', suffix, SUPPORT.id, as, body);
    return { status: a.status, body: a.body };
  };
  /** A body of exactly `bytes` bytes: `{"<key>":"xxx…"}`. */
  const sized = (key: string, bytes: number, fill: string): Buffer => {
    const head = `{"${key}":"`;
    const out = Buffer.from(`${head}${fill.repeat(bytes - head.length - 2)}"}`);
    expect(out.length).toBe(bytes);
    return out;
  };

  it("a team admin's Replace hands the domain the pasted refresh token, the person asking and the agent in the path, and nothing else; its answer is the route's", async () => {
    const w = world();
    expect(await post(w, '/bot/replace-token', { refreshToken: REFRESH }, GRACE)).toEqual({ status: 200, body: {} });
    // Exactly these three. Who asked is only for the domain to compare with the
    // bot's approver; the bot is the agent's, never the body's to name.
    expect(w.bots.calls).toEqual([
      { method: 'replaceToken', input: { actorUserId: GRACE.id, agentId: SUPPORT.id, refreshToken: REFRESH } },
    ]);
    // The domain's answer is the answer, whatever it is.
    for (const answer of [
      { status: 403, body: { error: 'not-approver' } },
      { status: 409, body: { error: 'not-live' } },
      { status: 409, body: { error: 'public-origin-not-https' } },
      { status: 502, body: { error: 'slack-refresh-token' } },
      { status: 502, body: { error: 'slack-not-app-manager' } },
      { status: 502, body: { error: 'slack-error' } },
      { status: 500, body: { error: 'internal' } },
    ]) {
      w.bots.answers.replaceToken = answer;
      expect(await post(w, '/bot/replace-token', { refreshToken: REFRESH }), JSON.stringify(answer)).toEqual(answer);
    }
    expect(w.bots.calls).toHaveLength(8);
    // The route itself logs nothing: the domain does.
    expect(w.lines).toEqual([]);
  });

  it('a Replace body must be an object holding a refresh token alone, within the cap every other write has: anything else is a 400 before the domain', async () => {
    const w = world();
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ['an access token pasted into the refresh field', { refreshToken: ACCESS }, { error: 'invalid-refresh-token' }],
      ['no refresh token', {}, { error: 'invalid-refresh-token' }],
      ['a null refresh token', { refreshToken: null }, { error: 'invalid-refresh-token' }],
      ['a refresh token that is not text', { refreshToken: 42 }, { error: 'invalid-refresh-token' }],
      ['an empty refresh token', { refreshToken: '' }, { error: 'invalid-refresh-token' }],
      ['the prefix alone', { refreshToken: CONFIG_REFRESH_PREFIX }, { error: 'invalid-refresh-token' }],
      ['a refresh token with a space after it', { refreshToken: `${REFRESH} ` }, { error: 'invalid-refresh-token' }],
      [
        'an unknown key beside a good token, even one naming another agent',
        { refreshToken: REFRESH, agentId: SALES.id },
        { error: 'invalid-body' },
      ],
      [
        "an install id beside it: the bot is the agent's, never the body's to name",
        { refreshToken: REFRESH, installId: OWN_BOT.installId },
        { error: 'invalid-body' },
      ],
      ['an array', [REFRESH], { error: 'invalid-body' }],
      ['null', null, { error: 'invalid-body' }],
      ['not JSON', 'garbage', { error: 'invalid-body' }],
      ['bytes that are not UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), { error: 'invalid-body' }],
      ['no body at all', Buffer.alloc(0), { error: 'invalid-body' }],
    ];
    for (const [what, body, error] of cases) {
      expect(await post(w, '/bot/replace-token', body), what).toEqual({ status: 400, body: error });
    }
    // The backstop for http-server's cap: one byte past it is a 413; at it, the body is read.
    expect(await post(w, '/bot/replace-token', sized('refreshToken', ADMIN_BODY_MAX_BYTES + 1, 'x'))).toEqual({
      status: 413,
      body: { error: 'body-too-large' },
    });
    expect(await post(w, '/bot/replace-token', sized('refreshToken', ADMIN_BODY_MAX_BYTES, 'x'))).toEqual({
      status: 400,
      body: { error: 'invalid-refresh-token' },
    });
    // Nothing reached the domain, so no paste reached Slack.
    expect(w.bots.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('Claim and Cancel hand the domain the install id the page showed, for the agent in the path, as the person asking', async () => {
    const w = world();
    expect(await post(w, '/bot/claim', { installId: OWN_BOT.installId }, GRACE)).toEqual({ status: 200, body: {} });
    expect(await post(w, '/bot/cancel', { installId: OWN_BOT.installId }, ADA)).toEqual({
      status: 200,
      body: { appDeleted: true },
    });
    // The id as sent, even one the agent's bot doesn't have: whether it names the agent's bot is the domain's to say.
    expect(await post(w, '/bot/claim', { installId: INSTALL_ID }, ADA)).toEqual({ status: 200, body: {} });
    expect(await post(w, '/bot/cancel', { installId: INSTALL_ID }, GRACE)).toEqual({
      status: 200,
      body: { appDeleted: true },
    });
    // Each domain asks the person's rights again inside the app lock, so it gets the person and their ctx.
    expect(w.bots.calls).toEqual([
      {
        method: 'claim',
        input: { ctxUserId: GRACE.id, actorUserId: GRACE.id, agentId: SUPPORT.id, installId: OWN_BOT.installId },
      },
      {
        method: 'cancel',
        input: { ctxUserId: ADA.id, actorUserId: ADA.id, agentId: SUPPORT.id, installId: OWN_BOT.installId },
      },
      { method: 'claim', input: { ctxUserId: ADA.id, actorUserId: ADA.id, agentId: SUPPORT.id, installId: INSTALL_ID } },
      {
        method: 'cancel',
        input: { ctxUserId: GRACE.id, actorUserId: GRACE.id, agentId: SUPPORT.id, installId: INSTALL_ID },
      },
    ]);
  });

  it('Claim and Cancel take { installId } and nothing else: an unknown key, a missing, non-string or malformed id is a 400 before the domain; past the cap a 413', async () => {
    const w = world();
    const id = OWN_BOT.installId;
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ['no body at all', Buffer.alloc(0), { error: 'invalid-body' }],
      [
        'an unknown key beside a good id, even one naming another agent',
        { installId: id, agentId: SALES.id },
        { error: 'invalid-body' },
      ],
      ['a refresh token beside the id', { installId: id, refreshToken: REFRESH }, { error: 'invalid-body' }],
      ['not JSON', 'garbage', { error: 'invalid-body' }],
      ['an array', [id], { error: 'invalid-body' }],
      ['null', null, { error: 'invalid-body' }],
      ['bytes that are not UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), { error: 'invalid-body' }],
      ['no installId (an older page)', {}, { error: 'invalid-install-id' }],
      ['a number', { installId: 42 }, { error: 'invalid-install-id' }],
      ['null for the id', { installId: null }, { error: 'invalid-install-id' }],
      ['an id of 21 characters', { installId: id.slice(1) }, { error: 'invalid-install-id' }],
      ['an id one too long', { installId: `${id}A` }, { error: 'invalid-install-id' }],
      ['an id with a character no install id has', { installId: `${'A'.repeat(21)}/` }, { error: 'invalid-install-id' }],
      ['an id with a space around it', { installId: ` ${id}` }, { error: 'invalid-install-id' }],
    ];
    for (const suffix of ['/bot/claim', '/bot/cancel'] as const) {
      for (const [what, body, error] of cases) {
        expect(await post(w, suffix, body), `${suffix} ${what}`).toEqual({ status: 400, body: error });
      }
      // The backstop for http-server's cap: one byte past it is a 413; at it, the body is read.
      expect(await post(w, suffix, sized('installId', ADMIN_BODY_MAX_BYTES + 1, 'A')), `${suffix} past the cap`).toEqual({
        status: 413,
        body: { error: 'body-too-large' },
      });
      expect(await post(w, suffix, sized('installId', ADMIN_BODY_MAX_BYTES, 'A')), `${suffix} at the cap`).toEqual({
        status: 400,
        body: { error: 'invalid-install-id' },
      });
    }
    expect(w.bots.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it("answers exactly what the domain answers: a Claim's refusals, and Cancel's", async () => {
    const w = world();
    const shown = { installId: OWN_BOT.installId };
    for (const answer of [
      { status: 409, body: { error: 'claim-not-needed' } },
      { status: 409, body: { error: 'not-live' } },
      { status: 409, body: { error: 'no-bot' } },
      // The rights the domain asked again inside the lock.
      { status: 403, body: { error: 'forbidden' } },
      { status: 409, body: { error: 'personal-agent' } },
      { status: 404, body: { error: 'not-found' } },
    ]) {
      w.bots.answers.claim = answer;
      expect(await post(w, '/bot/claim', shown), JSON.stringify(answer)).toEqual(answer);
    }
    for (const answer of [
      { status: 409, body: { error: 'not-pending' } },
      // An app Slack wouldn't delete.
      { status: 200, body: { appDeleted: false } },
      { status: 403, body: { error: 'forbidden' } },
      { status: 404, body: { error: 'not-found' } },
    ]) {
      w.bots.answers.cancel = answer;
      expect(await post(w, '/bot/cancel', shown), JSON.stringify(answer)).toEqual(answer);
    }
    expect(w.bots.calls).toHaveLength(10);
    expect(w.lines).toEqual([]);
  });

  it("a fault in the domain is a 500, logged by its code and the route alone: never the pasted token or the fault's text", async () => {
    const w = world();
    w.bots.state.fail = Object.assign(new Error(`vault down holding ${REFRESH} for ${OWN_BOT.installId}`), {
      code: 'ECONNRESET',
    });
    expect(await post(w, '/bot/replace-token', { refreshToken: REFRESH })).toEqual({
      status: 500,
      body: { error: 'internal' },
    });
    expect(await post(w, '/bot/claim', { installId: OWN_BOT.installId })).toEqual({
      status: 500,
      body: { error: 'internal' },
    });
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-replace-token', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot-claim', code: 'ECONNRESET' } },
    ]);
    const logged = JSON.stringify(w.lines);
    for (const text of [REFRESH, CONFIG_REFRESH_PREFIX, 'vault down', OWN_BOT.installId, SUPPORT.id, ADA.id]) {
      expect(logged, text).not.toContain(text);
    }
  });
});

// ── Asking an AX admin for the bot (TASK-1169) ──────────────────────────────

describe('the bot request routes', () => {
  it('POST /bot-request: anything but an object with a name is a 400 before the domain; it never takes a token or a picture', async () => {
    const w = world();
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ['not JSON', 'a bot please', { error: 'invalid-body' }],
      ['an array', JSON.stringify(['Ada Bot']), { error: 'invalid-body' }],
      ['null', 'null', { error: 'invalid-body' }],
      ['an empty body', Buffer.alloc(0), { error: 'invalid-body' }],
      ['an unknown key, even one naming another agent', { botName: 'Ada Bot', agentId: SALES.id }, { error: 'invalid-body' }],
      ['a refresh token: an AX admin brings their own', { botName: 'Ada Bot', refreshToken: REFRESH }, { error: 'invalid-body' }],
      ['a picture: the approving admin draws it', { botName: 'Ada Bot', iconPng: pngBase64(512, 512) }, { error: 'invalid-body' }],
      ['no name', {}, { error: 'invalid-bot-name', reason: 'empty' }],
      ['a null name', { botName: null }, { error: 'invalid-bot-name', reason: 'empty' }],
      ['a blank name', { botName: '   ' }, { error: 'invalid-bot-name', reason: 'empty' }],
      ['a name that is not text', { botName: 7 }, { error: 'invalid-bot-name', reason: 'bad-characters' }],
      ['a name Slack refuses', { botName: 'Café Bot' }, { error: 'invalid-bot-name', reason: 'bad-characters' }],
      ['a reserved name', { botName: 'Slack-Bot' }, { error: 'invalid-bot-name', reason: 'reserved' }],
      ['a name past 35 characters', { botName: 'x'.repeat(36) }, { error: 'invalid-bot-name', reason: 'too-long' }],
    ];
    for (const [what, body, error] of cases) {
      const raw = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
      const a = await w.call('POST', '/bot-request', SUPPORT.id, ADA, raw);
      expect({ status: a.status, body: a.body }, what).toEqual({ status: 400, body: error });
    }
    expect(w.requests.calls).toEqual([]);
    expect(w.bots.calls).toEqual([]);
  });

  it('POST /bot-request hands the domain the name as checkBotName tidied it, the person asking, and the agent in the path', async () => {
    const w = world();
    expect(await w.askForBot(SUPPORT.id, { botName: '  Ada   Bot ' }, GRACE)).toEqual({ status: 200, body: {} });
    expect(w.requests.calls).toEqual([
      { method: 'ask', input: { ctxUserId: GRACE.id, actorUserId: GRACE.id, agentId: SUPPORT.id, botName: 'Ada Bot' } },
    ]);
    // Asking is not making: the bot domain isn't asked anything.
    expect(w.bots.calls).toEqual([]);
  });

  it("answers exactly what the domain answers: its refusals, the cancel's included", async () => {
    const w = world();
    w.requests.answers.ask = { status: 409, body: { error: 'bot-requested' } };
    expect(await w.askForBot(SUPPORT.id, { botName: 'Ada Bot' })).toEqual({ status: 409, body: { error: 'bot-requested' } });
    w.requests.answers.ask = { status: 409, body: { error: 'bot-name-taken' } };
    expect(await w.askForBot(SUPPORT.id, { botName: 'Ada Bot' })).toEqual({ status: 409, body: { error: 'bot-name-taken' } });
    w.requests.answers.cancel = { status: 409, body: { error: 'not-requested' } };
    expect(await w.call('POST', '/bot-request/cancel', SUPPORT.id, ADA)).toMatchObject({
      status: 409,
      body: { error: 'not-requested' },
    });
  });

  it('POST /bot-request/cancel reaches the domain for a team admin of the agent, and never reads a body', async () => {
    const w = world();
    expect(await w.call('POST', '/bot-request/cancel', SUPPORT.id, GRACE, 'garbage')).toMatchObject({
      status: 200,
      body: {},
    });
    expect(await w.call('POST', '/bot-request/cancel', SUPPORT.id, ADA, JSON.stringify({ agentId: SALES.id }))).toMatchObject({
      status: 200,
      body: {},
    });
    // Only the agent in the path, whoever cancels it.
    expect(w.requests.calls).toEqual([
      { method: 'cancel', input: { agentId: SUPPORT.id } },
      { method: 'cancel', input: { agentId: SUPPORT.id } },
    ]);
  });
});

// ── The live bot's channels in the section ──────────────────────────────────

describe("the live bot's channels in the section", () => {
  /** A second channel the agent's own bot answers in; its id sorts before #support's. */
  const BOT_ONLY_CH = 'C07ALPHA001';

  it("the section lists the live bot's own channels, oldest first, to managers and members, with or without the shared app; no botChannels without a live bot", async () => {
    const w = world();
    w.state.bot = OWN_BOT;
    w.bots.answers.status = LIVE;
    // The bot answered in #support-desk first, then in #alpha-room.
    await answerOnBot(w, SUPPORT_CH);
    await answerOnBot(w, BOT_ONLY_CH, 'alpha-room');
    const botChannels = [
      { channelId: SUPPORT_CH, name: 'support-desk' },
      { channelId: BOT_ONLY_CH, name: 'alpha-room' },
    ];

    for (const [as, canManage] of [
      [MEL, false],
      [ADA, true],
    ] as const) {
      expect(await w.status(SUPPORT.id, as), as.id).toEqual({
        status: 200,
        body: {
          state: 'ready',
          botName: 'canopy-works',
          workspaceName: 'Canopy Works',
          canManage,
          bot: LIVE,
          botChannels,
        },
      });
    }

    // Admin › Slack disconnected the shared app: the live bot, and its channels, still show.
    w.state.install = null;
    expect(await w.status(SUPPORT.id, MEL)).toEqual({
      status: 200,
      body: { state: 'no-workspace', canManage: false, bot: LIVE, botChannels },
    });

    // A pending bot, no bot, a live answer whose bot is gone by the route's own read, or a bot that
    // went live after the bot domain answered pending: no list. A row never needs a bot the answer
    // doesn't show (TASK-1168's rule).
    const pending: AgentSlackBot = {
      state: 'pending',
      botName: 'Support Helper',
      approver: 'Grace Hopper',
      canContinue: false,
      installId: PENDING_BOT.installId,
    };
    for (const install of [{ ...INSTALL }, null]) {
      for (const [bot, answer] of [
        [PENDING_BOT, pending],
        [null, NO_BOT],
        [null, LIVE],
        [OWN_BOT, pending],
      ] as const) {
        w.state.install = install;
        w.state.bot = bot;
        w.bots.answers.status = answer;
        const got = await w.status(SUPPORT.id, MEL);
        expect(got.status).toBe(200);
        expect(got.body, `${install === null ? 'no-workspace' : 'ready'} ${answer.state}`).not.toHaveProperty('botChannels');
      }
    }
  });
});

// ── Logs ────────────────────────────────────────────────────────────────────

describe('logs', () => {
  it('say what happened by code alone: never a channel id or name, an email or a person', async () => {
    const w = world();
    // The agent's own bot, live, answered in #support-desk and #sales-floor (router.ts).
    w.state.bot = OWN_BOT;
    w.bots.answers.status = LIVE;
    await answerOnBot(w, SUPPORT_CH);
    await answerOnBot(w, SALES_CH);
    await w.status(SUPPORT.id, MEL);
    await w.status(SUPPORT.id, ADA);
    // What went right logs nothing.
    expect(w.lines).toEqual([]);

    // Faults whose own text names a channel, its name, a person and their email: their codes alone are logged.
    const named = `${SUPPORT_CH} ${NAMES[SUPPORT_CH]!} ${ADA.email!} ${ADA.displayName!}`;
    const listForAgent = w.memory.store.listForAgent;
    w.memory.store.listForAgent = async () => {
      throw Object.assign(new Error(named), { code: '42P01' });
    };
    await w.status(SUPPORT.id, ADA);
    w.memory.store.listForAgent = listForAgent;
    w.state.botFault = Object.assign(new Error(named), { code: '57P01' });
    await w.status(SUPPORT.id, ADA);
    w.state.botFault = undefined;
    w.bots.state.fail = Object.assign(new Error(named), { code: 'ECONNRESET' });
    await w.requestBot(SUPPORT.id, { botName: 'Support Helper' }, ADA);

    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'status', code: '42P01' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'status', code: '57P01' } },
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'bot', code: 'ECONNRESET' } },
    ]);
    const logged = JSON.stringify(w.lines);
    for (const secret of [
      ...Object.keys(NAMES),
      ...Object.values(NAMES),
      ...USERS.flatMap((u) => [u.email!, ...(u.displayName === null ? [] : [u.displayName])]),
      SUPPORT.displayName,
    ]) {
      expect(logged, secret).not.toContain(secret);
    }
  });
});
